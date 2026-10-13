/**
 * SSE 连接管理器
 *
 * 两类事件源：
 * - `session/event`（持久、有 seq）：turn/step 边界、user/assistant 消息、工具调用。
 *   可通过 `lastSeq` 从持久日志回放，实现断线续传。
 * - `agent/assistant-stream`（进程内、无 seq）：模型流式增量，用于打字机效果。
 *   不持久，仅在线推送；客户端按 attemptId 聚合，收到 assistant/message 后以持久事件为准。
 */
export class SSEManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    // 连接池：sessionId -> Set of connection
    this.connections = new Map()
    // 全局连接计数
    this.globalConnectionCount = 0

    // 持久事件（含 seq，可回放）
    this.ctx.on('session/event', (session, event) => {
      this.handleSessionEvent(session, event)
    })

    // 流式增量（作用域过滤：根作用域监听者能看到所有 agent）
    this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.handleAssistantStream(agent, frame)
    })

    // 会话销毁：agent 已不存在，连接上不会再来任何事件。
    // 不主动关闭的话，客户端会一直挂在一条永不结束的流上（只有 keepalive），
    // 直到 TCP 超时或用户重连 —— 而重连会 404。
    // 该事件与 `session/event` 走同一套 scoped dispatch（dsh-session 的
    // `collectSessionCallbacks` + `ctx.events.dispatch`），根作用域能收到。
    this.ctx.on('session/disposed', (session) => {
      this.dropSession(session?.id, 'session-disposed')
    })

    // 交付物就绪（进程内事件，无 seq）：导出类工具已落盘，通知前端凭 fileId 下载
    this.ctx.on('dsh-agent-gateway/delivery', ({ sessionId, fileId, fileName, bytes }) => {
      const connections = this.connections.get(sessionId)
      if (!connections || connections.size === 0) {
        return
      }
      for (const conn of connections) {
        this.deliver(conn, { type: 'delivery/ready', fileId, fileName, bytes }, null)
      }
    })
  }

  // ==================== 事件接收 ====================

  /**
   * 处理持久 session 事件并推送给相应连接
   */
  handleSessionEvent(session, event) {
    const connections = this.connections.get(session.id)
    if (!connections || connections.size === 0) {
      return
    }

    const sseEvent = this.transformEventToSSE(event)
    if (!sseEvent) {
      return
    }

    for (const conn of connections) {
      conn.lastSeq = event.seq
      this.deliver(conn, sseEvent, event.seq)
    }
  }

  /**
   * 处理流式增量并推送给相应连接
   */
  handleAssistantStream(agent, frame) {
    const sessionId = agent.session?.id
    if (!sessionId) {
      return
    }
    const connections = this.connections.get(sessionId)
    if (!connections || connections.size === 0) {
      return
    }

    let payload
    if (frame.type === 'start') {
      payload = {
        type: 'assistant/stream-start',
        attemptId: frame.attemptId,
        revision: frame.revision,
        turn: frame.turn,
        step: frame.step,
      }
    } else if (frame.type === 'chunk') {
      // 只透传文本增量；reasoning / tool-call 增量暂不展开
      if (frame.chunk?.type !== 'text-delta') {
        return
      }
      payload = {
        type: 'text-delta',
        attemptId: frame.attemptId,
        index: frame.index,
        delta: frame.chunk.text,
      }
    } else if (frame.type === 'end') {
      payload = {
        type: 'assistant/stream-end',
        attemptId: frame.attemptId,
        outcome: frame.outcome?.kind,
      }
    } else {
      return
    }

    for (const conn of connections) {
      this.deliver(conn, payload, null)
    }
  }

  /**
   * 将持久 session 事件转换为 SSE 事件
   */
  transformEventToSSE(event) {
    switch (event.type) {
      case 'turn/start':
        return { type: 'turn/start', turnId: event.data.turn, seq: event.seq }

      case 'turn/end':
        return { type: 'turn/end', turnId: event.data.turn, reason: event.data.reason, seq: event.seq }

      case 'step/start':
        return { type: 'step/start', turn: event.data.turn, step: event.data.step, seq: event.seq }

      case 'step/end':
        return { type: 'step/end', turn: event.data.turn, step: event.data.step, seq: event.seq }

      case 'tool/call':
        return {
          type: 'tool/call',
          turn: event.data.turn,
          step: event.data.step,
          callId: event.data.callId,
          name: event.data.name,
          seq: event.seq,
        }

      case 'user/message':
        // 事件数据本身即 UserMessage。
        // 只透传真实用户提问：同类型事件还会承载 agent-instructions / runtime-context /
        // skill 目录等框架合成注入，既非对话内容也不该出宿主。
        if (event.data?.source?.kind !== 'user') {
          return null
        }
        return {
          type: 'user/message',
          content: this.extractMessageContent(event.data),
          seq: event.seq,
        }

      case 'assistant/message':
        return {
          type: 'assistant/message',
          content: this.extractMessageContent(event.data.message),
          interrupted: event.data.interrupted === true,
          seq: event.seq,
        }

      default:
        return null
    }
  }

  /**
   * 提取消息文本内容
   */
  extractMessageContent(message) {
    if (!message || !Array.isArray(message.content)) {
      return ''
    }
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  // ==================== 连接管理 ====================

  /**
   * 创建新的 SSE 连接
   * @param {object} sessionInfo - 会话信息（由 SessionManager 提供）
   * @param {import('node:http').ServerResponse} res
   * @param {number} lastSeq - 客户端已收到的最后一个 seq，-1 表示不要回放
   */
  createConnection(sessionInfo, res, lastSeq = -1) {
    const { sessionId, principal, agentId } = sessionInfo

    // 检查全局连接数限制
    if (this.globalConnectionCount >= this.config.maxConnections) {
      return { error: 'Max global connections reached' }
    }

    // 检查单用户连接数限制
    if (this.getUserConnectionCount(principal) >= this.config.maxConnectionsPerUser) {
      return { error: 'Max connections per user reached' }
    }

    const connection = {
      res,
      principal,
      agentId,
      sessionId,
      lastSeq,
      createdAt: Date.now(),
      // 回放期间到达的实时事件先入队，避免与快照交错乱序
      replaying: false,
      pending: [],
      closed: false,
    }

    if (!this.connections.has(sessionId)) {
      this.connections.set(sessionId, new Set())
    }
    this.connections.get(sessionId).add(connection)
    this.globalConnectionCount++

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // 反向代理下禁止缓冲
      'X-Accel-Buffering': 'no',
    })
    // 断线后客户端重连间隔（ms）
    res.write('retry: 3000\n\n')

    this.replayFromLog(connection, sessionInfo, lastSeq)

    this.writeSSE(connection, { type: 'connected', sessionId, lastSeq: connection.lastSeq })

    const keepAliveInterval = setInterval(() => {
      if (!res.destroyed) {
        res.write(': keepalive\n\n')
      } else {
        clearInterval(keepAliveInterval)
      }
    }, 30000)

    const onClose = () => {
      clearInterval(keepAliveInterval)
      this.removeConnection(sessionId, connection)
    }
    res.on('close', onClose)
    res.on('error', onClose)

    this.ctx.logger?.info(
      `[dsh-agent-gateway] SSE connected session=${sessionId} total=${this.globalConnectionCount}`,
    )

    return { success: true, connection }
  }

  /**
   * 从持久日志回放 lastSeq 之后的事件（断线续传）
   */
  replayFromLog(connection, sessionInfo, lastSeq) {
    const session = sessionInfo.agent?.session
    if (!session || typeof session.snapshotEvents !== 'function') {
      return
    }

    // 回放期间先缓冲实时事件（本函数同步执行，仅为防御性设计）
    connection.replaying = true
    let replayedThrough = lastSeq
    try {
      if (lastSeq >= 0) {
        for (const event of session.snapshotEvents(lastSeq + 1)) {
          const sseEvent = this.transformEventToSSE(event)
          if (sseEvent) {
            connection.lastSeq = event.seq
            replayedThrough = event.seq
            this.writeSSE(connection, sseEvent, event.seq)
          }
        }
      }
    } finally {
      connection.replaying = false
      // 冲刷回放期间缓冲的实时事件（回放已覆盖的 seq 跳过）
      const buffered = connection.pending
      connection.pending = []
      for (const item of buffered) {
        if (item.seq !== null && item.seq <= replayedThrough) {
          continue
        }
        this.writeSSE(connection, item.payload, item.seq)
      }
    }
  }

  /**
   * 投递一条事件到连接（回放期间入队）
   */
  deliver(connection, payload, seq) {
    if (connection.closed || connection.res.destroyed) {
      return
    }
    if (connection.replaying) {
      connection.pending.push({ payload, seq })
      return
    }
    this.writeSSE(connection, payload, seq)
  }

  /**
   * 写入一条 SSE 事件，并执行背压保护
   */
  writeSSE(connection, payload, seq = null) {
    const { res } = connection
    if (res.destroyed) {
      return
    }

    // 背压保护：客户端读得太慢时主动断开，避免内存无界增长
    if (res.writableLength > this.config.maxQueueSize) {
      this.ctx.logger?.warn(
        `[dsh-agent-gateway] SSE client too slow, dropping session=${connection.sessionId} buffered=${res.writableLength}`,
      )
      this.removeConnection(connection.sessionId, connection)
      res.destroy()
      return
    }

    try {
      const prefix = seq === null ? '' : `id: ${seq}\n`
      res.write(`${prefix}data: ${JSON.stringify(payload)}\n\n`)
    } catch (err) {
      this.ctx.logger?.error(`[dsh-agent-gateway] failed to send SSE event: ${err.message}`)
    }
  }

  /**
   * 移除连接
   */
  removeConnection(sessionId, connection) {
    if (connection.closed) {
      return
    }
    connection.closed = true

    const connections = this.connections.get(sessionId)
    if (connections) {
      connections.delete(connection)
      if (connections.size === 0) {
        this.connections.delete(sessionId)
      }
    }
    this.globalConnectionCount--
    this.ctx.logger?.info(
      `[dsh-agent-gateway] SSE disconnected session=${sessionId} total=${this.globalConnectionCount}`,
    )
  }

  /**
   * 主动关闭某个会话的全部连接
   *
   * 与 `removeConnection` 的区别：这里会真正结束 HTTP 响应。先投递一条
   * `session/closed` 让客户端知道是服务端主动收流（而不是网络抖动），
   * 再摘除连接、关闭 socket —— 否则客户端看到的是「连接断了」，会按
   * `retry: 3000` 去重连，而重连只会拿到 404。
   *
   * @param {string} sessionId - 会话 ID
   * @param {string} reason - 关闭原因（随事件下发给客户端）
   */
  dropSession(sessionId, reason = 'session-disposed') {
    const connections = this.connections.get(sessionId)
    if (!connections || connections.size === 0) {
      return
    }
    // 复制一份再遍历：removeConnection 会就地修改这个 Set
    for (const connection of [...connections]) {
      this.writeSSE(connection, { type: 'session/closed', reason })
      this.removeConnection(sessionId, connection)
      if (!connection.res.destroyed) {
        connection.res.end()
      }
    }
    this.ctx.logger?.info(
      `[dsh-agent-gateway] SSE dropped session=${sessionId} reason=${reason}`,
    )
  }

  /**
   * 获取用户的连接数
   */
  getUserConnectionCount(principal) {
    let count = 0
    for (const connections of this.connections.values()) {
      for (const conn of connections) {
        if (conn.principal === principal) {
          count++
        }
      }
    }
    return count
  }

  /** 供 `/readyz` 观测 */
  get stats() {
    return {
      connections: this.globalConnectionCount,
      sessions: this.connections.size,
      maxConnections: this.config.maxConnections,
      maxConnectionsPerUser: this.config.maxConnectionsPerUser,
    }
  }

  /**
   * 关闭所有连接
   */
  closeAll() {
    for (const connections of this.connections.values()) {
      for (const conn of connections) {
        conn.closed = true
        if (!conn.res.destroyed) {
          conn.res.end()
        }
      }
    }
    this.connections.clear()
    this.globalConnectionCount = 0
  }
}

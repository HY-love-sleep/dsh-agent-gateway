import crypto from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { TurnGate } from './turn-gate.js'
import { DeliveryManager } from './deliveries.js'

/**
 * 解析工具收敛白名单（`tools.allowedTools`）。
 *
 * 空数组 = 不收敛（放开全部工具）。本插件是通用网关，不内置任何具体工具名；
 * 屏蔽 bash / 通用文件读写等宿主能力属于部署侧策略，由配置注入。
 *
 * @param {object} config - 插件配置
 * @returns {string[]}
 */
export function resolveAllowedTools(config) {
  const list = config?.tools?.allowedTools
  if (!Array.isArray(list)) {
    return []
  }
  return list.filter((name) => typeof name === 'string' && name.length > 0)
}

/**
 * 解析需要拦截落盘的「导出类工具」名单（`deliveries.fileTools`）。
 *
 * 命中工具的结果约定为 JSON 文本 `{ok, file_name, file_base64}`：成功时把文件
 * 落盘为会话交付物，并用不含 base64 的确认文本替换结果（使 base64 既不进模型
 * 请求也不进会话日志）。空数组 = 关闭该能力。
 *
 * @param {object} config - 插件配置
 * @returns {string[]}
 */
export function resolveExportTools(config) {
  const list = config?.deliveries?.fileTools
  if (!Array.isArray(list)) {
    return []
  }
  return list.filter((name) => typeof name === 'string' && name.length > 0)
}

/**
 * 构造一条 user-role 消息。
 *
 * DSH 的 `createUserMessage()` 位于 `@deepseek-ai/dsh-llm`；本插件不引入该依赖
 * （避免 workspace 与宿主 dsh 的包版本错配），因此按同一形状就地构造：
 * 实现上它就是 `{ id: brandString(randomUUID()), role: 'user', content, source }`
 * 再深冻结，`brandString` 为恒等函数。inbox 侧只校验 `id` 在待处理队列中唯一。
 */
function createUserMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 会话管理器：负责确定性身份路由、会话创建/恢复、归属校验
 */
export class SessionManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    // 记录活跃会话：sessionId -> { principal, agentId, agent, handle, ... }
    this.activeSessions = new Map()
    // 全局 turn 准入门（配置项 `concurrency.maxGlobalTurns`）
    this.turns = new TurnGate(config.concurrency.maxGlobalTurns)
    // 会话交付物（导出类工具落盘 + 下载登记）
    this.deliveries = new DeliveryManager(ctx, () => this.workspaceRoot())
    // 会话级 userToken 暂存：sessionId -> 用户令牌（敏感，仅内存持有，严禁落日志/响应/审计）
    this.userTokenBySession = new Map()
    // 删除单飞：sessionId -> Promise，见 deleteSession
    this.deletions = new Map()
  }

  /** 供 `/readyz` 观测 */
  get stats() {
    return {
      activeSessions: this.activeSessions.size,
      turns: this.turns.stats,
      ...this.deliveries.stats,
      deleting: this.deletions.size,
    }
  }



  /**
   * workspace 根目录
   */
  workspaceRoot() {
    return `${process.cwd()}/.dsh/home/workspaces/sessions`
  }

  /**
   * 推导 workspace 路径（新结构：基于 sessionId）
   * @param {string} sessionId - UUID 格式的会话 ID
   * @returns {string} 绝对路径
   */
  deriveWorkspacePath(sessionId) {
    return resolve(this.workspaceRoot(), sessionId)
  }

  /**
   * 校验 principal 格式（fail-closed）
   * @param {string} principal - 待校验的 principal
   * @returns {boolean} 是否合法
   */
  validatePrincipal(principal) {
    if (!principal || typeof principal !== 'string') {
      return false
    }
    // 长度限制：1-256 字符
    if (principal.length < 1 || principal.length > 256) {
      return false
    }
    // 只允许字母、数字、下划线、连字符、@、.、:
    if (!/^[a-zA-Z0-9_\-@.:]+$/.test(principal)) {
      return false
    }
    return true
  }

  /**
   * 解析并校验 preset 名称（防止客户端自选或提升 preset）
   * @param {string} agentId - URL 中的 agent ID
   * @returns {string|null} preset 名称，如果不在白名单则返回 null
   */
  resolvePreset(agentId) {
    const presetName = this.config.agentPresets[agentId]
    if (!presetName) {
      return null
    }
    return presetName
  }

  /**
   * 创建或恢复会话
   * @param {string} sessionId - UUID 格式的会话 ID
   * @param {string} principal - 用户身份标识
   * @param {string} agentId - 智能体 ID
   * @returns {Promise<SessionInfo>}
   */
  async createOrResumeSession(sessionId, principal, agentId) {
    // 检查是否已经存在活跃会话
    const existing = this.activeSessions.get(sessionId)
    if (existing) {
      return {
        sessionId,
        agent: existing.agent,
        handle: existing.handle,
        presetName: existing.presetName,
        createdAt: existing.createdAt,
      }
    }

    // 解析 preset
    const presetName = this.resolvePreset(agentId)
    if (!presetName) {
      throw new Error(`Unknown agent ID: ${agentId}`)
    }

    // 创建 workspace 目录
    const workspacePath = this.deriveWorkspacePath(sessionId)
    await mkdir(workspacePath, { recursive: true })

    // 注意：setup 的返回值会被工厂当作 publication commit 调用（`(await setup())?.commit()`），
    // 因此这里必须返回 undefined，不能把挂载结果透传出去。
    const setup = async (agentCtx) => {
      await this.composeAgent(agentCtx, presetName)
    }

    // 复用 / 恢复 / 新建
    let handle
    let agent = this.ctx.agents.get(sessionId)
    if (agent) {
      // 该 session 已被本进程其它路径发布：直接沿用，但不持有 disposer
      handle = undefined
    } else if (await this.hasPersistedSession(sessionId)) {
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup,
      })
      agent = handle.agent
    } else {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: workspacePath, agentPreset: presetName },
        agentOptions: this.agentOptions(),
        setup,
      })
      agent = handle.agent
    }

    // 记录活跃会话（handle 是唯一 teardown 能力，必须留存）
    let markClosed
    const sessionInfo = {
      sessionId,
      principal,
      agentId,
      presetName,
      workspacePath,
      agent,
      handle,
      createdAt: Date.now(),
      // 待执行的轮次（**尚未**进入 dsh inbox）：{ message, mode }
      pending: [],
      // 已上传但尚未被任何一轮引用的附件：{ name, attachmentId, path }
      uploaded: [],
      // 单会话串行：同一时刻只允许一个 drain 循环在跑
      draining: false,
      // 会话被删除后置位，用于打断仍在等待许可/等待空闲的循环
      closed: false,
      // `closed` 的 promise 形态，供 Promise.race 使用
      closedPromise: new Promise((resolve) => {
        markClosed = resolve
      }),
      markClosed: () => {
        sessionInfo.closed = true
        markClosed()
      },
    }
    this.activeSessions.set(sessionId, sessionInfo)
    return sessionInfo
  }

  /**
   * setup 阶段的 agent 组合：挂载 preset + 工具收敛
   * @param {object} agentCtx - agent 的 scoped context
   * @param {string} presetName - preset id
   */
  async composeAgent(agentCtx, presetName) {
    const preset = await this.ctx.agentPresets.mount(agentCtx, presetName)
    // 工具收敛：仅在配置了白名单时收敛（空数组 = 放开全部）
    const allowedTools = resolveAllowedTools(this.config)
    if (allowedTools.length > 0) {
      agentCtx.tools.restrict({ allow: allowedTools })
    }
    // 导出类工具结果拦截：命中工具的 base64 落盘为交付物，避免其进入模型请求与会话日志
    this.installExportSink(agentCtx)
    this.ctx.logger?.info(
      allowedTools.length > 0
        ? `[dsh-agent-gateway] agent composed from preset "${preset?.id ?? presetName}", tools restricted to: ${allowedTools.join(', ')}`
        : `[dsh-agent-gateway] agent composed from preset "${preset?.id ?? presetName}", tools unrestricted`,
    )
  }

  /**
   * 在 agent 作用域上注册 `tools/post-execute` 监听，拦截导出类工具的结果。
   *
   * 命中工具（`deliveries.fileTools`）的结果约定为 JSON 文本：
   * `{ok:true, file_name, file_base64}`（失败时 `{ok:false, error}`）。
   * 落盘失败时 fail-open：保留原结果，不把一次成功的导出变成错误。
   * 未配置任何导出工具时不注册监听。
   *
   * @param {object} agentCtx - agent 的 scoped context
   */
  installExportSink(agentCtx) {
    const fileTools = resolveExportTools(this.config)
    if (fileTools.length === 0) {
      return
    }
    agentCtx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (!fileTools.includes(exec.name) || result.isError) {
        return decision
      }
      const text = result.content
        ?.filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n') ?? ''
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        return decision
      }
      if (!payload?.ok || typeof payload.file_base64 !== 'string') {
        return decision
      }

      const sessionId = exec.agent?.session?.id ?? exec.agent?.id
      const data = Buffer.from(payload.file_base64, 'base64')
      const fileName = typeof payload.file_name === 'string' && payload.file_name.length > 0
        ? payload.file_name
        : 'download.bin'
      try {
        const saved = await this.deliveries.save(sessionId, data, fileName)
        const notice = JSON.stringify({
          ok: true,
          file_name: saved.fileName,
          file_id: saved.fileId,
          message: '文件已生成，可凭 file_id 经交付物端点下载',
        })
        return { kind: 'accept', content: [{ type: 'text', text: notice }] }
      } catch (err) {
        this.ctx.logger?.warn(
          `[dsh-agent-gateway] persist export result failed session=${sessionId}: ${err?.message || String(err)}`,
        )
        return decision
      }
    })
  }

  /**
   * 本次创建/恢复使用的模型路由
   *
   * `ctx.agents.create()` **不会**自动套用 `agentDefaultModel`——该服务只声明
   * 「未显式指定模型的 Agent 的默认选择」，由调用方自行读取并传入
   * `agentOptions`。不传的话 agent 起来后第一次请求就会以
   * `has no provider/model` 结束（turn/end reason.kind === 'error'）。
   * 这与 `dsh-api-session-controller` 的 `agentOptions()` 做法一致。
   *
   * @returns {{provider: string, model: string}|undefined}
   */
  agentOptions() {
    const selection = this.ctx.agentDefaultModel?.currentSelection()
    if (!selection?.provider || !selection?.model) {
      return undefined
    }
    return { provider: selection.provider, model: selection.model }
  }

  /**
   * 该 session 是否已有持久化日志（决定 resume 还是 create）
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<boolean>}
   */
  async hasPersistedSession(sessionId) {
    const persistence = this.ctx.sessionPersistence
    if (!persistence || typeof persistence.stat !== 'function') {
      return false
    }
    try {
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      return false
    }
  }

  /**
   * 获取活跃会话
   * @param {string} sessionId - 会话 ID
   * @returns {SessionInfo | undefined}
   */
  getSession(sessionId) {
    return this.activeSessions.get(sessionId)
  }

  /**
   * 绑定会话级 userToken（仅内存持有；不写日志）
   * @param {string} sessionId
   * @param {string} token
   * @returns {boolean} 是否写入
   */
  setUserToken(sessionId, token) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return false
    }
    if (typeof token !== 'string' || token.length === 0) {
      return false
    }
    this.userTokenBySession.set(sessionId, token)
    return true
  }

  /**
   * 读取会话级 userToken（供 sessionUserToken 服务暴露给工具插件）
   * @param {string} sessionId
   * @returns {string|undefined}
   */
  getUserToken(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return undefined
    }
    return this.userTokenBySession.get(sessionId)
  }

  /**
   * 释放会话级内存状态（插件卸载时由 index.js 调用）。
   *
   * 仅清理本进程内的敏感/临时映射：userToken 暂存与删除单飞表；agent handle、
   * workspace 与持久化产物由框架和持久化层负责回收，这里不越权处理。
   */
  dispose() {
    this.userTokenBySession.clear()
    this.deletions.clear()
  }

  /**
   * 投递一轮用户消息
   *
   * 非阻塞：消息进的是**网关自己的**队列，执行由 `drainSession` 在拿到全局
   * 许可后驱动。这样 HTTP 层可以立刻回 202，而排队期间的消息既不是 agent 状态
   * 也不在 dsh inbox 中，取消/超时语义都简单。
   *
   * `steer` 的两条路径是有意分开的：
   * - agent 正在跑 → 直接插进 inbox（这正是 steer 的意义：在最近的 step 边界生效）。
   *   它不占新许可，因为它是**注入到已有轮次**，不产生额外的并发活动。
   * - agent 空闲 → steer 会新开一轮，与 `queue` 等价，因此走同一条门控路径。
   *
   * @param {object} sessionInfo - 会话信息
   * @param {string} text - 用户消息文本
   * @param {'queue'|'steer'} mode - 投递模式
   * @param {string} [documentType] - 文档类型（仅写作类智能体）：由网关组装进
   *        固定格式指令，指示模型加载对应模板 skill
   * @returns {{queued: boolean, closed?: boolean}} 是否进入了网关队列
   */
  submitTurn(sessionInfo, text, mode = 'queue', documentType) {
    // 请求拿到 sessionInfo 之后、投递之前会话可能已被删除；
    // 此时消息没有任何人会执行它，如实回给调用方而不是静默吞掉。
    if (sessionInfo.closed) {
      return { queued: false, closed: true }
    }

    text = this.composeTurnText(sessionInfo, text, documentType)
    const message = createUserMessage(text)

    if (mode === 'steer' && sessionInfo.agent.status === 'running') {
      sessionInfo.agent.steer(message)
      return { queued: false }
    }

    const item = { message, mode }

    if (!this.config.concurrency.serialPerSession) {
      // 不做单会话串行：每轮各自取许可。注意 `whenIdle()` 是 agent 级的，
      // 并发轮次会在同一个空闲点一起释放许可（保守但不会泄漏）。
      void this.runTurn(sessionInfo, item)
      return { queued: false }
    }

    sessionInfo.pending.push(item)
    void this.drainSession(sessionInfo)
    return { queued: true }
  }

  /**
   * 组装实际注入会话的轮次文本：附件提示 + 用户原文 + document_type 固定指令。
   *
   * 附件一旦被本轮引用即从 `uploaded` 清空，不重复提示。
   *
   * @param {object} sessionInfo - 会话信息
   * @param {string} text - 用户原文
   * @param {string} [documentType] - 文档类型
   * @returns {string}
   */
  composeTurnText(sessionInfo, text, documentType) {
    const parts = []
    if (sessionInfo.uploaded.length > 0) {
      const lines = sessionInfo.uploaded
        .map(file => `- ${file.name}（只读路径：${file.path}）`)
        .join('\n')
      parts.push(
        '用户上传了以下附件，可用 read 工具按只读路径读取，结合附件完成任务：',
        lines,
      )
      sessionInfo.uploaded.length = 0
    }
    parts.push(text)
    if (documentType) {
      parts.push(
        `[系统指定参数]\n文档类型（document_type）：${documentType}\n`
        + '请立即加载该文档类型对应的模板 skill，并严格按模板完成本次写作。',
      )
    }
    return parts.join('\n\n')
  }

  /**
   * 登记一个已上传、待下一轮引用的附件
   * @param {object} sessionInfo - 会话信息
   * @param {{name: string, attachmentId: string, path: string}} file - 附件信息
   */
  registerUploaded(sessionInfo, file) {
    sessionInfo.uploaded.push(file)
  }

  /**
   * 单会话串行排空：同一会话的轮次严格按序执行，一次只有一轮在跑
   *
   * 不会漏掉并发提交：`submitTurn` 的 push 是同步的，而本循环只在 `await`
   * 处让出执行权，所以「循环判定队列为空」到「`draining` 复位」之间没有
   * 可插入的窗口 —— 要么 push 发生在判定之前（本轮就会取到），要么发生在
   * `draining` 复位之后（新一次 `drainSession` 会启动）。
   *
   * @param {object} sessionInfo - 会话信息
   */
  async drainSession(sessionInfo) {
    if (sessionInfo.draining) {
      // 已有循环在跑，它会看到刚 push 进来的消息
      return
    }
    sessionInfo.draining = true
    try {
      while (sessionInfo.pending.length > 0 && !sessionInfo.closed) {
        // 先出队再执行：执行失败时宁可丢一轮，也不要重复投递同一条消息
        await this.runTurn(sessionInfo, sessionInfo.pending.shift())
      }
    } finally {
      sessionInfo.draining = false
    }
  }

  /**
   * 取许可 → 投递 → 等该会话空闲 → 释放许可
   * @param {object} sessionInfo - 会话信息
   * @param {{message: object, mode: string}} item - 待投递的消息
   */
  async runTurn(sessionInfo, item) {
    if (!item) {
      return
    }
    const release = await this.turns.acquire()
    try {
      if (sessionInfo.closed) {
        return
      }
      if (item.mode === 'steer') {
        sessionInfo.agent.steer(item.message)
      } else {
        sessionInfo.agent.followup(item.message)
      }
      await this.waitIdle(sessionInfo)
    } catch (err) {
      this.ctx.logger?.warn(
        `[dsh-agent-gateway] turn failed session=${sessionInfo.sessionId}: ${err?.stack || err?.message || String(err)}`,
      )
    } finally {
      release()
    }
  }

  /**
   * 等待该会话空闲，并在会话被删除时立刻放弃等待
   *
   * 不设这一层的话，一个卡住的 agent 会永久占住一个许可（`whenIdle()` 只有在
   * agent 真正回到 idle 时才 resolve），全局并发上限会被慢慢耗尽。
   *
   * @param {object} sessionInfo - 会话信息
   */
  waitIdle(sessionInfo) {
    return Promise.race([sessionInfo.agent.whenIdle(), sessionInfo.closedPromise])
  }

  /**
   * 取消当前轮次（保留排队中的 inbox）
   *
   * `cancel` 的 cause 之所以冻结，是防一类「取消即丢 turn/end」的失效：
   * 工具若把 dsh 的 cancel signal 直接透传给 `fetch`，undici 在 abort 时会执行
   * `Error.captureStackTrace(reason)`，给这个普通对象挂上一个**非枚举**的 `stack`；
   * agent-loop 随后把它原样写进 `turn/end {reason: {kind:'aborted', reason}}`，
   * 而 session 的 JSON 校验（`snapshotJsonValue`/`enumerableStringKeys`）拒绝任何带
   * 非枚举自有属性的对象 → append 抛 "carries non-JSON-serializable data" →
   * 该 turn 永远没有 closer，SSE 也收不到 turn/end（只剩一条 agent/error）。
   * 根因应在工具侧修掉（调用外部 HTTP 时用私有 AbortController，不把 dsh 的
   * reason 交给 undici）；此处冻结是纵深防御，且
   * `AgentCancelCause` 在类型上本就是 readonly，冻结与契约一致。
   *
   * @param {object} sessionInfo - 会话信息
   */
  cancelTurn(sessionInfo) {
    sessionInfo.agent.cancel(Object.freeze({ kind: 'user' }), { keepInbox: true })
  }

  /**
   * 获取会话的对话历史
   *
   * 直接读 session 的持久事件日志（append-origin 消息边界）。
   *
   * `user/message` 会同时承载三类内容：真实用户提问（`source.kind === 'user'`）、
   * 框架合成的上下文注入（agent-instructions / runtime-context / skill 目录等）、
   * 以及 goal 续跑轮次。对话历史只应暴露第一类，其余是提示词内部结构，
   * 对 Java 后端没有意义且会泄漏宿主配置。
   *
   * @param {object} sessionInfo - 会话信息对象
   * @returns {Array} 历史记录数组
   */
  getHistory(sessionInfo) {
    const session = sessionInfo.agent?.session
    if (!session) {
      return []
    }

    const history = []
    for (const event of session.snapshotEvents()) {
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') {
          continue
        }
        history.push({
          role: 'user',
          content: this.extractMessageContent(event.data),
          timestamp: event.time,
        })
      } else if (event.type === 'assistant/message') {
        history.push({
          role: 'assistant',
          content: this.extractMessageContent(event.data.message),
          timestamp: event.time,
        })
      }
    }
    return history
  }

  /**
   * 从消息对象中提取文本内容
   * @param {object} message - 消息对象
   * @returns {string} 文本内容
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

  /**
   * 删除会话（单飞去重）
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<{released: boolean, purged: boolean, workspacePurged: boolean}>}
   */
  async deleteSession(sessionId) {
    // 单飞去重
    if (this.deletions.has(sessionId)) {
      return this.deletions.get(sessionId)
    }

    const deletion = this._doDelete(sessionId)
    this.deletions.set(sessionId, deletion)

    try {
      return await deletion
    } finally {
      this.deletions.delete(sessionId)
    }
  }

  /**
   * 实际的删除逻辑
   */
  async _doDelete(sessionId) {
    const sessionInfo = this.activeSessions.get(sessionId)
    let released = false
    let purged = false
    let workspacePurged = false

    // 交付物元数据先失效：磁盘文件在第 3 步随 workspace 一并删除
    this.deliveries.dropSession(sessionId)
    // 会话级 userToken 同步失效，避免会话删除后仍被查询工具读到
    this.userTokenBySession.delete(sessionId)

    // 1. dispose agent handle
    if (sessionInfo) {
      try {
        await sessionInfo.handle.dispose()
        this.activeSessions.delete(sessionId)
        released = true
      } catch (err) {
        this.ctx.logger?.error(`[SessionManager] dispose failed: ${err.message}`)
      }
    }

    // 2. 清理持久化产物（日志目录）
    try {
      const { sessionPersistence } = this.ctx
      const logPath = sessionPersistence.resolveCurrentLog(sessionId)
      if (logPath) {
        await rm(dirname(logPath), { recursive: true, force: true })
        purged = true
      }
    } catch (err) {
      this.ctx.logger?.error(`[SessionManager] purge logs failed: ${err.message}`)
    }

    // 3. 清理 workspace
    try {
      const wsPath = this.deriveWorkspacePath(sessionId)
      const sessionsRoot = this.workspaceRoot()

      // 路径安全检查
      if (!wsPath.startsWith(sessionsRoot + sep)) {
        throw new Error('Invalid workspace path')
      }
      if (wsPath === sessionsRoot) {
        throw new Error('Cannot delete sessions root')
      }

      await rm(wsPath, { recursive: true, force: true })
      workspacePurged = true
    } catch (err) {
      this.ctx.logger?.error(`[SessionManager] purge workspace failed: ${err.message}`)
    }

    return { released, purged, workspacePurged }
  }

  /**
   * 删除会话的 workspace 目录
   *
   * 这是一次 `rm -rf`，而被删路径里含 URL 传入的 agentId，所以这里做两道防线：
   *
   * 1. **包含性断言** —— 路径必须落在 `workspaceRoot()` 之内。`path.resolve`
   *    会先吃掉 `..`，因此 `agentId = '../../../../etc'` 这类构造在这里就被拦下。
   * 2. 不跟随符号链接 —— `rm` 对 symlink 本身执行 unlink，不会顺着它删到目标
   *    （Node 的 `rm` 语义如此），所以不需要额外处理，但不能改成手工递归遍历。
   *
   * 调用方（`handleDeleteSession`）另外会先用 `resolvePreset` 校验 agentId，
   * 这里的断言是纵深防御：删除类操作值得两道锁。
   *
   * @param {string} workspacePath - workspace 绝对路径
   * @returns {Promise<boolean>} 是否执行了删除
   */
  async purgeWorkspace(workspacePath) {
    if (!workspacePath) {
      return false
    }
    const root = resolve(this.workspaceRoot())
    const target = resolve(workspacePath)
    if (target === root || !target.startsWith(`${root}${sep}`)) {
      throw new Error(`refusing to purge path outside workspace root: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
    return true
  }

  /**
   * 删除会话的持久化产物（后端私有布局，见 deleteSession 注释）
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<boolean>} 是否删除了产物
   */
  async purgePersistedSession(sessionId) {
    const persistence = this.ctx.sessionPersistence
    if (!persistence || typeof persistence.resolveCurrentLog !== 'function') {
      return false
    }
    const logPath = await persistence.resolveCurrentLog(sessionId)
    if (!logPath) {
      return false
    }
    // 每个 session 独占一个目录（内含 session.lock + 日志文件）
    await rm(dirname(logPath), { recursive: true, force: true })
    return true
  }
}

/**
 * 注册 HTTP/WebSocket 路由
 */
export function registerRoutes(ctx, config, sessionManager, registry, auditLogger, sseManager) {
  const { webServer } = ctx
  const basePath = normalizeBasePath(config.http.basePath)

  // ==================== 探针与能力路由 ====================

  // GET /healthz - 健康检查
  webServer.register({
    kind: 'exact',
    path: '/healthz',
    handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    },
  })

  // GET /readyz - 就绪检查
  //
  // 只暴露本进程**自己**掌握的真值：会话数、turn 准入门水位、SSE 连接水位。
  // 不在这里探 LLM / 外部知识库 —— 那是每次轮次实打实会走的链路，一个探针
  // 既不能代表它们的可用性（模型路由是按 preset 选的），探活失败反而会把本
  // 进程摘掉，得不偿失。上游依赖的健康由 `/healthz`（活）与本路由（容量）之外
  // 的监控体系负责。
  webServer.register({
    kind: 'exact',
    path: '/readyz',
    handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ready',
        ...sessionManager.stats,
        sessions: registry.stats,
        sse: sseManager.stats,
      }))
    },
  })

  // GET {basePath}/capabilities - 能力清单
  webServer.register({
    kind: 'exact',
    path: `${basePath}/capabilities`,
    handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        version: 'v1',
        protocol: 'dsh-agent-gateway',
        agents: Object.keys(config.agentPresets),
      }))
    },
  })

  // ==================== 会话管理路由 ====================

  // 通用处理器：认证 + 路由分发
  const sessionRouteHandler = async (req, res) => {
    try {
      ctx.emit('dsh-agent-gateway/request', { method: req.method, url: req.url })

      // 1. 鉴权
      if (!authenticateRequest(req, config)) {
        auditLogger?.logAuthFailed(req.socket.remoteAddress, 'invalid_token')
        return sendError(res, 401, 'Unauthorized')
      }

      // 2. 路由解析
      const parsed = parseSessionRoute(req.url, req.method, basePath)
      if (!parsed) {
        return sendError(res, 404, 'Not found')
      }

      const { principal, agentId, sessionId, action } = parsed

      // 会话级终端用户令牌透传：仅在会话归属校验通过后暂存，
      // 避免伪造 sessionId 撑爆暂存表、或跨 principal 覆盖他人令牌
      const userToken = extractUserToken(req, config.auth.userTokenHeader)
      if (userToken && sessionId && action !== 'deleteSession' && registry.verify(sessionId, principal, agentId)) {
        sessionManager.setUserToken(sessionId, userToken)
      }

      // 3. 路由分发
      if (action === 'createSession') {
        await handleCreateSession(req, res, ctx, config, sessionManager, registry, principal, agentId, auditLogger, userToken)
      } else if (action === 'listSessions') {
        await handleListSessions(req, res, ctx, registry, principal, agentId)
      } else if (action === 'deleteSession') {
        await handleDeleteSession(req, res, ctx, sessionManager, registry, sseManager, principal, agentId, sessionId, auditLogger)
      } else if (action === 'getHistory') {
        await handleGetHistory(req, res, ctx, sessionManager, registry, principal, agentId, sessionId)
      } else if (action === 'createTurn') {
        await handleCreateTurn(req, res, ctx, config, sessionManager, registry, principal, agentId, sessionId, auditLogger)
      } else if (action === 'cancelTurn') {
        await handleCancelTurn(req, res, ctx, sessionManager, registry, principal, agentId, sessionId)
      } else if (action === 'getEvents') {
        await handleGetEvents(req, res, ctx, sessionManager, registry, principal, agentId, sessionId, sseManager)
      } else if (action === 'uploadAttachment') {
        await handleUploadAttachment(req, res, ctx, config, sessionManager, registry, principal, agentId, sessionId)
      } else if (action === 'getDelivery') {
        await handleGetDelivery(req, res, ctx, sessionManager, registry, principal, agentId, sessionId, parsed.fileId)
      } else {
        return sendError(res, 404, 'Not found')
      }
    } catch (err) {
      ctx.emit('dsh-agent-gateway/error', { error: err, url: req.url })
      ctx.logger?.error(`[dsh-agent-gateway] unhandled route error on ${req.method} ${req.url}: ${err.stack || err.message}`)
      // 错误最小披露：不暴露内部细节
      return sendError(res, 500, 'Server request failed')
    }
  }

  // 注册所有会话相关路由（使用 prefix 匹配）
  // 注意：根据 WebServer 类型定义，path 应该没有尾部斜杠
  webServer.register({
    kind: 'prefix',
    path: `${basePath}/users`,
    handler: sessionRouteHandler,
  })
}

// ==================== 辅助函数 ====================

/**
 * 归一化路由前缀：补前导 /、去掉尾部 /；空值回退到默认 '/v1'。
 */
function normalizeBasePath(raw) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : '/v1'
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.replace(/\/+$/, '') || ''
}

/**
 * 转义正则元字符（把路由前缀安全拼进正则）
 */
function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 服务间认证
 */
function authenticateRequest(req, config) {
  if (!config.auth.serviceToken) {
    return true // 如果未配置 token，则跳过认证（开发模式）
  }

  const authHeader = req.headers['authorization']
  if (!authHeader) {
    return false
  }

  const token = authHeader.replace(/^Bearer\s+/i, '')
  return token === config.auth.serviceToken
}

/**
 * 从请求中提取终端用户令牌：优先名为 `headerName` 的请求头（string 或 string[] 取首个非空），
 * 兼容 `Cookie: ...; <headerName>=<token>; ...`。
 * 返回值为调用方的完整凭证，调用方**不得**写入日志/响应/审计。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [headerName] 请求头名，默认 'x-user-token'
 * @returns {string|undefined}
 */
export function extractUserToken(req, headerName = 'x-user-token') {
  const headers = req?.headers
  if (!headers) {
    return undefined
  }

  const name = String(headerName || 'x-user-token').toLowerCase()

  const headerValue = headers[name]
  if (typeof headerValue === 'string') {
    const trimmed = headerValue.trim()
    if (trimmed) {
      return trimmed
    }
  } else if (Array.isArray(headerValue)) {
    for (const item of headerValue) {
      if (typeof item === 'string' && item.trim()) {
        return item.trim()
      }
    }
  }

  const cookie = headers['cookie']
  if (typeof cookie === 'string' && cookie) {
    for (const segment of cookie.split(';')) {
      const eq = segment.indexOf('=')
      if (eq === -1) {
        continue
      }
      if (segment.slice(0, eq).trim() !== name) {
        continue
      }
      const value = segment.slice(eq + 1).trim()
      if (value) {
        return value
      }
    }
  }

  return undefined
}

/**
 * 解析会话相关路由
 * @returns {{ principal: string, agentId: string, action: string } | null}
 */
function parseSessionRoute(url, method, basePath) {
  // 剥离 query string
  const pathname = url.split('?', 1)[0]

  const pattern = new RegExp(`^${escapeRegExp(basePath)}/users/([^/]+)/agents/([^/]+)/(.+)`)
  const match = pathname.match(pattern)
  if (!match) {
    return null
  }

  const [, principalEncoded, agentIdEncoded, path] = match

  // URL 解码参数
  const principal = decodeURIComponent(principalEncoded)
  const agentId = decodeURIComponent(agentIdEncoded)

  // 创建会话
  if (method === 'POST' && path === 'sessions') {
    return { principal, agentId, action: 'createSession' }
  }

  // 列出会话
  if (method === 'GET' && path === 'sessions') {
    return { principal, agentId, action: 'listSessions' }
  }

  // 会话操作：/sessions/:sessionId/...
  const sessionMatch = path.match(/^sessions\/([^/]+)\/(.+)$/)
  if (sessionMatch) {
    const [, sessionId, subPath] = sessionMatch

    if (method === 'POST' && subPath === 'turns') {
      return { principal, agentId, sessionId, action: 'createTurn' }
    }
    if (method === 'DELETE' && subPath === 'turns') {
      return { principal, agentId, sessionId, action: 'cancelTurn' }
    }
    if (method === 'GET' && subPath === 'history') {
      return { principal, agentId, sessionId, action: 'getHistory' }
    }
    if (method === 'GET' && subPath === 'events') {
      return { principal, agentId, sessionId, action: 'getEvents' }
    }

    // 附件上传：POST /sessions/:sessionId/attachments
    if (method === 'POST' && subPath === 'attachments') {
      return { principal, agentId, sessionId, action: 'uploadAttachment' }
    }
  }

  // 交付物下载：/sessions/:sessionId/deliveries/:fileId
  const deliveryMatch = path.match(/^sessions\/([^/]+)\/deliveries\/([^/]+)$/)
  if (deliveryMatch && method === 'GET') {
    const [, sessionId, fileId] = deliveryMatch
    return { principal, agentId, sessionId, fileId, action: 'getDelivery' }
  }

  // 删除会话：/sessions/:sessionId
  const deleteMatch = path.match(/^sessions\/([^/]+)$/)
  if (deleteMatch && method === 'DELETE') {
    const [, sessionId] = deleteMatch
    return { principal, agentId, sessionId, action: 'deleteSession' }
  }

  return null
}

/**
 * 发送错误响应
 */
function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ==================== 路由处理器 ====================

/**
 * POST {basePath}/users/:u/agents/:agent/sessions
 */
async function handleCreateSession(req, res, ctx, config, sessionManager, registry, principal, agentId, auditLogger, userToken) {
  try {
    // 1. 校验
    if (!sessionManager.validatePrincipal(principal)) {
      return sendError(res, 400, 'Invalid principal')
    }
    if (!sessionManager.resolvePreset(agentId)) {
      return sendError(res, 404, 'Unknown agent ID')
    }

    // 2. 检查会话数限制并创建
    let sessionId
    try {
      sessionId = await registry.create(principal, agentId)
    } catch (err) {
      if (err.message === 'Session limit reached') {
        auditLogger?.logSessionLimitReached(principal, agentId, registry.list(principal, agentId).length, config.sessions.maxPerIdentity)
        return sendError(res, 409, 'Session limit reached')
      }
      throw err
    }

    // 3. 创建 agent 实例
    const sessionInfo = await sessionManager.createOrResumeSession(sessionId, principal, agentId)

    if (userToken) {
      sessionManager.setUserToken(sessionId, userToken)
    }

    auditLogger?.logSessionCreated(principal, agentId, sessionId)

    sendJson(res, {
      sessionId,
      principal,
      agentId,
      presetName: sessionInfo.presetName,
      createdAt: sessionInfo.createdAt,
    }, 201)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to create session')
  }
}

/**
 * GET {basePath}/users/:u/agents/:agent/sessions
 */
async function handleListSessions(req, res, ctx, registry, principal, agentId) {
  try {
    const sessions = registry.list(principal, agentId)
    sendJson(res, {
      sessions,
      total: sessions.length,
      limit: registry.stats.limit,
    }, 200)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to list sessions')
  }
}

/**
 * 会话定位：优先取进程内活跃会话；若进程重启后仅剩持久化日志，
 * 则按需 resume 回来。增加归属校验和孤儿清理。
 */
async function requireSession(sessionManager, registry, sessionId, principal, agentId) {
  // 1. 归属校验
  if (!registry.verify(sessionId, principal, agentId)) {
    return null
  }

  // 2. 获取或恢复会话
  let session = sessionManager.getSession(sessionId)
  if (session) {
    // 更新活动时间
    registry.updateActivity(sessionId)
    return session
  }

  // 3. 按需恢复
  try {
    const { sessionPersistence } = sessionManager.ctx
    const hasPersistedSession = await sessionPersistence.hasPersistedSession?.(sessionId) ?? false

    if (!hasPersistedSession) {
      // 孤儿记录：registry 有但底层资源不存在
      await registry.delete(sessionId)
      return null
    }

    session = await sessionManager.createOrResumeSession(sessionId, principal, agentId)
    registry.updateActivity(sessionId)
    return session
  } catch (err) {
    // 底层资源损坏或不存在
    if (err.message.includes('Session data not found') || err.message.includes('not found')) {
      await registry.delete(sessionId)
      return null
    }
    throw err
  }
}

/**
 * 把内部错误映射为对外的状态码（错误最小披露，不暴露内部细节）
 */
function sendMappedError(ctx, res, err, fallbackMessage) {
  ctx.logger?.error(`[dsh-agent-gateway] ${fallbackMessage}: ${err.stack || err.message}`)
  const message = err.message || ''
  if (message.startsWith('Invalid principal')) {
    return sendError(res, 400, 'Invalid principal')
  }
  if (message.startsWith('Unknown agent ID')) {
    return sendError(res, 404, 'Unknown agent ID')
  }
  return sendError(res, 500, fallbackMessage)
}

/**
 * DELETE {basePath}/users/:u/agents/:agent/sessions/:sessionId
 */
async function handleDeleteSession(req, res, ctx, sessionManager, registry, sseManager, principal, agentId, sessionId, auditLogger) {
  try {
    if (!sessionManager.validatePrincipal(principal)) {
      return sendError(res, 400, 'Invalid principal')
    }
    // agentId 会被拼进 workspace 路径后整体删除，必须先过白名单
    // （其余路由通过 requireSession 间接校验，删除路径不经过 requireSession）
    if (!sessionManager.resolvePreset(agentId)) {
      return sendError(res, 404, 'Unknown agent ID')
    }
    // 验证会话归属
    if (!registry.verify(sessionId, principal, agentId)) {
      return sendError(res, 404, 'Session not found')
    }
    const result = await sessionManager.deleteSession(sessionId)
    // 从 registry 移除
    await registry.delete(sessionId)
    // 兜底收流：正常路径上 `handle.dispose()` 会派发 `session/disposed`，
    // SSEManager 据此关闭连接；但那依赖 dsh 的事件派发，且会话没有 handle
    // （agent 由本进程其它路径发布）时根本不会派发。`dropSession` 幂等，
    // 这里显式调用一次，让「删除会话 ⇒ 流一定结束」成为网关自己的保证。
    sseManager?.dropSession(sessionId, 'session-deleted')
    auditLogger?.logSessionDeleted(principal, agentId, sessionId)
    sendJson(res, { success: true, ...result }, 200)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to delete session')
  }
}

/**
 * GET {basePath}/users/:u/agents/:agent/sessions/:sessionId/history
 */
async function handleGetHistory(req, res, ctx, sessionManager, registry, principal, agentId, sessionId) {
  try {
    const sessionInfo = await requireSession(sessionManager, registry, sessionId, principal, agentId)
    if (!sessionInfo) {
      return sendError(res, 404, 'Session not found')
    }

    const history = sessionManager.getHistory(sessionInfo)
    sendJson(res, { sessionId: sessionInfo.sessionId, history }, 200)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to get history')
  }
}

/**
 * POST {basePath}/users/:u/agents/:agent/sessions/:sessionId/turns
 */
async function handleCreateTurn(req, res, ctx, config, sessionManager, registry, principal, agentId, sessionId, auditLogger) {
  try {
    // 1. 解析请求体
    const body = await readJsonBody(req, config.request.maxBodySize)
    const { message, mode = 'queue', document_type: rawDocumentType } = body

    if (typeof message !== 'string' || message.length === 0) {
      return sendError(res, 400, 'Missing message')
    }
    if (mode !== 'queue' && mode !== 'steer') {
      return sendError(res, 400, 'Invalid mode')
    }

    // document_type 采用白名单校验（fail-closed）：只有配置里声明的类型才能注入，
    // 且只在配置声明的写作类智能体上生效。
    let documentType
    if (rawDocumentType !== undefined) {
      const allowedTypes = config.writing?.documentTypes ?? []
      const writingAgents = config.writing?.agents ?? []
      if (allowedTypes.length === 0) {
        return sendError(res, 400, 'document_type is not supported')
      }
      if (writingAgents.length > 0 && !writingAgents.includes(agentId)) {
        return sendError(res, 400, 'document_type is only supported by writing agents')
      }
      documentType = resolveDocumentType(rawDocumentType, allowedTypes)
      if (!documentType) {
        return sendError(res, 400, 'Unsupported document_type')
      }
    }

    // 2. 获取会话（重启后按需从持久化恢复）
    const sessionInfo = await requireSession(sessionManager, registry, sessionId, principal, agentId)
    if (!sessionInfo) {
      return sendError(res, 404, 'Session not found')
    }

    // 3. 投递消息（同步方法：仅入网关队列，不等待轮次结束）
    const submitted = sessionManager.submitTurn(sessionInfo, message, mode, documentType)
    if (submitted.closed) {
      // 会话在解析到投递之间被删掉了
      return sendError(res, 404, 'Session not found')
    }

    auditLogger?.logTurnCreated(principal, agentId, sessionInfo.sessionId, mode, message.length)
    sendJson(res, { success: true, sessionId: sessionInfo.sessionId, mode, queued: submitted.queued }, 202)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to create turn')
  }
}

/**
 * DELETE {basePath}/users/:u/agents/:agent/sessions/:sessionId/turns
 */
async function handleCancelTurn(req, res, ctx, sessionManager, registry, principal, agentId, sessionId) {
  try {
    const sessionInfo = await requireSession(sessionManager, registry, sessionId, principal, agentId)
    if (!sessionInfo) {
      return sendError(res, 404, 'Session not found')
    }

    sessionManager.cancelTurn(sessionInfo)
    sendJson(res, { success: true, sessionId: sessionInfo.sessionId }, 202)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to cancel turn')
  }
}

/**
 * GET {basePath}/users/:u/agents/:agent/sessions/:sessionId/events
 */
async function handleGetEvents(req, res, ctx, sessionManager, registry, principal, agentId, sessionId, sseManager) {
  try {
    const sessionInfo = await requireSession(sessionManager, registry, sessionId, principal, agentId)
    if (!sessionInfo) {
      return sendError(res, 404, 'Session not found')
    }

    // 解析 lastSeq 查询参数（断线续传）
    const url = new URL(req.url, `http://${req.headers.host}`)
    const lastSeq = url.searchParams.get('lastSeq')
    const lastSeqNum = lastSeq ? parseInt(lastSeq, 10) : -1

    // 创建 SSE 连接
    const result = sseManager.createConnection(sessionInfo, res, lastSeqNum)

    if (result.error) {
      return sendError(res, 503, result.error)
    }

    // 连接已建立，res 将保持打开状态直到客户端断开
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to get events')
  }
}

/**
 * POST {basePath}/users/:u/agents/:agent/sessions/:sessionId/attachments?name=xx
 *
 * 薄附件上传：请求体为 application/octet-stream 原始字节（与 dsh 原生
 * uploadFileBinary 路由一致，dsh 无 multipart 解析器），字节交
 * ctx.attachments 内容寻址存储，网关不管理落盘。
 * 返回的只读路径登记到会话，下一轮消息会提示模型按需读取。
 */
async function handleUploadAttachment(req, res, ctx, config, sessionManager, registry, principal, agentId, sessionId) {
  try {
    const sessionInfo = await requireSession(sessionManager, registry, sessionId, principal, agentId)
    if (!sessionInfo) {
      return sendError(res, 404, 'Session not found')
    }

    const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (mediaType !== 'application/octet-stream') {
      return sendError(res, 415, 'Content-Type must be application/octet-stream')
    }
    const url = new URL(req.url, `http://${req.headers.host}`)
    const name = url.searchParams.get('name') ?? undefined
    if (!name) {
      return sendError(res, 400, 'Missing name query parameter')
    }

    const data = await readRawBody(req, config.request.maxBodySize)
    const attachments = ctx.get('attachments')
    if (!attachments) {
      return sendError(res, 503, 'Attachment service unavailable')
    }
    const ref = await attachments.saveFile({ data, name })
    const path = attachments.fileHostPath(ref)

    sessionManager.registerUploaded(sessionInfo, {
      name: ref.name,
      attachmentId: ref.attachmentId,
      path,
    })

    sendJson(res, {
      success: true,
      attachmentId: ref.attachmentId,
      name: ref.name,
      bytes: ref.bytes,
      path,
    }, 201)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to upload attachment')
  }
}

/**
 * GET {basePath}/users/:u/agents/:agent/sessions/:sessionId/deliveries/:fileId
 *
 * 交付物下载：经归属校验后流式返回 .docx。
 */
async function handleGetDelivery(req, res, ctx, sessionManager, registry, principal, agentId, sessionId, fileId) {
  try {
    const sessionInfo = await requireSession(sessionManager, registry, sessionId, principal, agentId)
    if (!sessionInfo) {
      return sendError(res, 404, 'Session not found')
    }

    const record = sessionManager.deliveries.get(fileId)
    if (!record || record.sessionId !== sessionId) {
      return sendError(res, 404, 'Delivery not found')
    }

    const encodedName = encodeURIComponent(record.fileName)
      .replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': record.bytes,
      'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store',
    })

    const stream = sessionManager.deliveries.openStream(fileId)
    stream.on('error', (err) => {
      ctx.logger?.error(`[dsh-agent-gateway] delivery stream failed: ${err.message}`)
      res.destroy()
    })
    stream.pipe(res)
  } catch (err) {
    sendMappedError(ctx, res, err, 'Failed to get delivery')
  }
}

/**
 * document_type 白名单校验：客户端只能选择配置中声明的类型
 * （`writing.documentTypes`，属于部署侧策略，不在插件内硬编码）
 *
 * @param {unknown} value 客户端传入的原始值
 * @param {string[]} allowedTypes 允许的类型清单
 * @returns {string|null}
 */
function resolveDocumentType(value, allowedTypes) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return allowedTypes.includes(trimmed) ? trimmed : null
}

/**
 * 读取原始请求体并施加大小上限
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxSize
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks, size)))
    req.on('error', reject)
  })
}

/**
 * 读取 JSON 请求体
 */
function readJsonBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (err) {
        reject(new Error('Invalid JSON'))
      }
    })

    req.on('error', reject)
  })
}

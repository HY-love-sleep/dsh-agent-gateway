import { Config } from './lib/config.js'
import { registerRoutes } from './lib/routes.js'
import { SessionManager } from './lib/session-manager.js'
import { SessionRegistry } from './lib/session-registry.js'
import { AuditLogger } from './lib/audit-logger.js'
import { SSEManager } from './lib/sse-manager.js'
import { installConsoleExporter } from './lib/log-export.js'

export const name = 'dsh-agent-gateway'
export { Config }
export const inject = ['agents', 'webServer', 'agentPresets', 'sessionPersistence', 'agentDefaultModel']

export async function apply(ctx, config) {
  const logger = ctx.logger

  // 终端日志 sink（dsh 0.1.3 未提供，见 lib/log-export.js 说明）
  if (config.observability.consoleExporter) {
    installConsoleExporter(ctx, config.observability.level, config.observability.colors)
  }

  // agent 运行期错误与状态迁移（框架 dispatch 事件，无持久化，仅在线可观测）
  ctx.on('agent/error', ({ turn, step, error }) => {
    logger?.error(
      `[dsh-agent-gateway] agent error turn=${turn} step=${step}: ${error?.stack || error?.message || String(error)}`,
    )
  })
  ctx.on('agent/status', ({ agent, status }) => {
    logger?.debug(`[dsh-agent-gateway] agent ${agent?.id} status=${status}`)
  })

  // 初始化审计日志
  const auditLogger = new AuditLogger(config, logger)

  // 初始化会话管理器
  const sessionManager = new SessionManager(ctx, config)

  // 初始化会话注册表
  const sessionRegistry = new SessionRegistry(ctx, config)
  await sessionRegistry.init()
  ctx.logger?.info('[dsh-agent-gateway] SessionRegistry initialized')

  // 初始化 SSE 管理器
  const sseManager = new SSEManager(ctx, config.sse)

  // 注册 HTTP/WebSocket 路由
  registerRoutes(ctx, config, sessionManager, sessionRegistry, auditLogger, sseManager)

  logger?.info(`[dsh-agent-gateway] HTTP routes registered under ${config.http.basePath}`)

  // 会话级上下文服务：供工具插件按 sessionId 精确读取终端用户令牌
  // （只读、不暴露可枚举旁路；随插件卸载自动释放）
  const disposeSessionContext = ctx.provide('sessionUserToken', {
    getUserToken(sessionId) {
      return sessionManager.getUserToken(sessionId)
    },
  })

  // 卸载时释放服务提供的值，并清理 SSE 连接与会话级内存状态
  ctx.on('dispose', () => {
    disposeSessionContext()
    sessionManager.dispose()
    sseManager.closeAll()
  })
}

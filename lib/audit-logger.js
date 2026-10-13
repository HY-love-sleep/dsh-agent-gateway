/**
 * 审计日志记录器
 */
export class AuditLogger {
  constructor(config, logger) {
    this.enabled = config.audit.enabled
    this.logger = logger
  }

  /**
   * 记录审计日志
   * @param {object} event - 审计事件
   * @param {string} event.principal - 用户身份
   * @param {string} event.agentId - 智能体 ID
   * @param {string} event.action - 操作类型
   * @param {string} event.result - 操作结果
   * @param {object} event.metadata - 额外元数据
   */
  log(event) {
    if (!this.enabled) {
      return
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      principal: event.principal,
      agentId: event.agentId,
      action: event.action,
      result: event.result,
      metadata: event.metadata || {},
    }

    // TODO: 持久化到审计日志存储（文件、数据库等）
    this.logger?.info(`[audit] ${JSON.stringify(logEntry)}`)
  }

  /**
   * 记录会话创建
   */
  logSessionCreated(principal, agentId, sessionId) {
    this.log({
      principal,
      agentId,
      action: 'session.created',
      result: 'success',
      metadata: { sessionId },
    })
  }

  /**
   * 记录会话删除
   */
  logSessionDeleted(principal, agentId, sessionId) {
    this.log({
      principal,
      agentId,
      action: 'session.deleted',
      result: 'success',
      metadata: { sessionId },
    })
  }

  /**
   * 记录消息投递
   */
  logTurnCreated(principal, agentId, sessionId, mode, messageLength) {
    this.log({
      principal,
      agentId,
      action: 'turn.created',
      result: 'success',
      metadata: { sessionId, mode, messageLength },
    })
  }

  /**
   * 记录认证失败
   */
  logAuthFailed(ip, reason) {
    this.log({
      principal: 'unknown',
      agentId: 'unknown',
      action: 'auth.failed',
      result: 'failure',
      metadata: { ip, reason },
    })
  }

  /**
   * 记录访问被拒绝
   */
  logAccessDenied(principal, agentId, reason) {
    this.log({
      principal,
      agentId,
      action: 'access.denied',
      result: 'failure',
      metadata: { reason },
    })
  }

  /**
   * 记录会话数达到上限
   */
  logSessionLimitReached(principal, agentId, current, limit) {
    this.log({
      principal,
      agentId,
      action: 'session.limit_reached',
      result: 'failure',
      metadata: { current, limit },
    })
  }

  /**
   * 记录会话归属校验失败
   */
  logSessionOwnershipViolation(sessionId, principal, agentId, requestedBy) {
    this.log({
      principal,
      agentId,
      action: 'session.ownership_violation',
      result: 'failure',
      metadata: { sessionId, requestedBy },
    })
  }
}

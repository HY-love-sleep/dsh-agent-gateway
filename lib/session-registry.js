import crypto from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * SessionRegistry：管理 sessionId ↔ (principal, agentId) 映射
 */
export class SessionRegistry {
  #ctx
  #config
  #registryPath

  // 主索引：sessionId → metadata
  #sessions = new Map()

  // 反向索引：identityKey → Set<sessionId>
  #byIdentity = new Map()

  // 并发创建锁：identityKey → Promise
  #createLocks = new Map()

  // 脏标记（用于批量持久化）
  #dirty = false
  #persistTimer = null

  constructor(ctx, config) {
    this.#ctx = ctx
    this.#config = config
    this.#registryPath = resolve(process.cwd(), '.dsh/home/sessions/registry.json')
  }

  // Getter/Setter for test support
  get _registryPath() {
    return this.#registryPath
  }

  set _registryPath(path) {
    this.#registryPath = path
  }

  /**
   * 异步初始化（必须在使用前调用）
   */
  async init() {
    await this.#load()
  }

  /**
   * 启动时加载 registry.json
   */
  async #load() {
    try {
      const data = await readFile(this.#registryPath, 'utf-8')
      const parsed = JSON.parse(data)

      for (const [sessionId, meta] of Object.entries(parsed.sessions || {})) {
        this.#sessions.set(sessionId, meta)

        const key = this.#identityKey(meta.principal, meta.agentId)
        if (!this.#byIdentity.has(key)) {
          this.#byIdentity.set(key, new Set())
        }
        this.#byIdentity.get(key).add(sessionId)
      }

      this.#ctx.logger?.info(`[SessionRegistry] loaded ${this.#sessions.size} sessions`)
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 首次启动，registry 不存在
        this.#ctx.logger?.info('[SessionRegistry] no existing registry, starting fresh')
        return
      }

      // JSON 解析失败 → registry 损坏
      this.#ctx.logger?.error(`[SessionRegistry] registry.json corrupted: ${err.message}, starting fresh`)

      // 备份损坏文件
      try {
        await rename(this.#registryPath, `${this.#registryPath}.corrupted.${Date.now()}`)
      } catch {}
    }
  }

  /**
   * 原子持久化到 registry.json
   */
  async #persist() {
    const data = {
      sessions: Object.fromEntries(this.#sessions),
    }

    // 确保目录存在
    await mkdir(dirname(this.#registryPath), { recursive: true })

    // 原子写入：tmp → rename
    const tmp = `${this.#registryPath}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await rename(tmp, this.#registryPath)
  }

  /**
   * 创建会话，返回 UUID sessionId
   * 若超出上限则抛 Error('Session limit reached')
   */
  async create(principal, agentId) {
    const key = this.#identityKey(principal, agentId)

    // 并发控制：等待该 identity 的其他创建操作完成
    while (this.#createLocks.has(key)) {
      await this.#createLocks.get(key)
    }

    // 获取锁
    let unlock
    const lock = new Promise(resolve => { unlock = resolve })
    this.#createLocks.set(key, lock)

    try {
      // 检查数量限制
      const existing = this.#byIdentity.get(key) || new Set()
      if (existing.size >= this.#config.sessions.maxPerIdentity) {
        throw new Error('Session limit reached')
      }

      // 生成 UUID
      const sessionId = crypto.randomUUID()

      // 存储映射
      this.#sessions.set(sessionId, {
        principal,
        agentId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      })

      // 更新反向索引
      if (!this.#byIdentity.has(key)) {
        this.#byIdentity.set(key, new Set())
      }
      this.#byIdentity.get(key).add(sessionId)

      // 立即持久化（关键操作）
      await this.#persist()

      return sessionId
    } finally {
      // 释放锁
      this.#createLocks.delete(key)
      unlock()
    }
  }

  /**
   * 验证 sessionId 是否属于指定的 (principal, agentId)
   */
  verify(sessionId, principal, agentId) {
    const meta = this.#sessions.get(sessionId)
    if (!meta) return false
    return meta.principal === principal && meta.agentId === agentId
  }

  /**
   * 列出指定 (principal, agentId) 的所有会话，按 createdAt 降序
   */
  list(principal, agentId) {
    const key = this.#identityKey(principal, agentId)
    const sessionIds = this.#byIdentity.get(key) || new Set()

    return Array.from(sessionIds)
      .map(id => {
        const meta = this.#sessions.get(id)
        return {
          sessionId: id,
          createdAt: meta.createdAt,
          lastActivityAt: meta.lastActivityAt,
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 删除会话记录（幂等）
   */
  async delete(sessionId) {
    const meta = this.#sessions.get(sessionId)
    if (!meta) return false

    // 从主索引删除
    this.#sessions.delete(sessionId)

    // 从反向索引删除
    const key = this.#identityKey(meta.principal, meta.agentId)
    const set = this.#byIdentity.get(key)
    if (set) {
      set.delete(sessionId)
      if (set.size === 0) {
        this.#byIdentity.delete(key)
      }
    }

    // 立即持久化（关键操作）
    await this.#persist()

    return true
  }

  /**
   * 更新最后活动时间（批量延迟写入）
   */
  updateActivity(sessionId) {
    const meta = this.#sessions.get(sessionId)
    if (!meta) return

    meta.lastActivityAt = Date.now()
    this.#schedulePersist()
  }

  /**
   * 调度批量持久化（5 秒后）
   */
  #schedulePersist() {
    this.#dirty = true

    if (!this.#persistTimer) {
      this.#persistTimer = setTimeout(async () => {
        if (this.#dirty) {
          await this.#persist()
          this.#dirty = false
        }
        this.#persistTimer = null
      }, 5000)
      // 不让延迟写入拖住进程退出（否则测试 afterEach 清理目录后，
      // 定时器仍会重建目录并落盘）
      this.#persistTimer.unref?.()
    }
  }

  /**
   * 身份键：拼接 principal 和 agentId（使用 \0 分隔）
   */
  #identityKey(principal, agentId) {
    return `${principal}\0${agentId}`
  }

  /** 供 /readyz 观测 */
  get stats() {
    return {
      total: this.#sessions.size,
      limit: this.#config.sessions.maxPerIdentity,
    }
  }
}

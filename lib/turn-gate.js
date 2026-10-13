/**
 * Turn 准入门：一个 FIFO 信号量，限制全局同时在跑的 agent 轮次。
 *
 * 为什么需要它：`POST /turns` 是**非阻塞**的（立刻回 202，轮次在后台跑），
 * 因此入队速率与执行速率解耦 —— 没有门控时，任意数量的用户都能同时把
 * 模型调用推到上限，把宿主打满。门控把「排队」和「执行」分开：
 * 等待许可的消息留在网关自己的队列里，**不进 dsh 的 inbox**，自然也就不是
 * 可达状态，谈不上超时或取消。
 *
 * 许可的覆盖范围由调用方决定（见 `SessionManager.runTurn`）：从消息投递到
 * `agent.whenIdle()` 返回为止。dsh 的 `whenIdle()` 是 agent 级的可见性，
 * 观测不到单个 turn 的边界，所以许可实际覆盖的是「该 agent 这一段活动」——
 * 对「限制宿主并发」这个目的来说这正是想要的粒度。
 */
export class TurnGate {
  /**
   * @param {number} limit - 全局并发上限（至少 1）
   */
  constructor(limit) {
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
    this.running = 0
    this.waiters = []
  }

  /** 供 `/readyz` 观测 */
  get stats() {
    return { running: this.running, limit: this.limit, waiting: this.waiters.length }
  }

  /**
   * 取一个许可；超出上限时排队直到有人释放
   * @returns {Promise<() => void>} 释放函数（幂等，重复调用无副作用）
   */
  acquire() {
    if (this.running < this.limit) {
      this.running++
      return Promise.resolve(this.makeRelease())
    }
    // FIFO：许可直接在释放点交接给队首，不经过 running 计数，
    // 否则被唤醒者还要和后来者重新竞争，等待时间无界。
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /**
   * 生成一个一次性释放函数
   * @returns {() => void}
   */
  makeRelease() {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const next = this.waiters.shift()
      if (next === undefined) {
        this.running--
      } else {
        next(this.makeRelease())
      }
    }
  }
}

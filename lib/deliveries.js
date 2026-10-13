import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/**
 * 会话交付物管理器：把「导出类工具」（deliveries.fileTools 配置）产出的字节
 * 落盘为绑定 sessionId 的交付物，并登记下载所需的元数据。
 *
 * 存储位置：<sessionsRoot>/<sessionId>/deliveries/<fileId>。
 * 文件落在会话 workspace 之内，删除会话时随 workspace 一并清除，
 * 这里只需在删除会话时清理内存元数据。
 */
export class DeliveryManager {
  /**
   * @param {object} ctx - 插件根 context
   * @param {() => string} sessionsRoot - 会话 workspace 根目录提供函数
   */
  constructor(ctx, sessionsRoot) {
    this.ctx = ctx
    this.sessionsRoot = sessionsRoot
    // fileId -> { sessionId, fileName, bytes, createdAt, path }
    this.meta = new Map()
  }

  /**
   * 保存一份交付物
   * @param {string} sessionId - 所属会话 ID
   * @param {Buffer} data - 文件字节
   * @param {string} fileName - 对外文件名
   * @returns {Promise<{fileId: string, sessionId: string, fileName: string, bytes: number, createdAt: number}>}
   */
  async save(sessionId, data, fileName) {
    const root = resolve(this.sessionsRoot())
    const dir = resolve(root, sessionId, 'deliveries')
    if (!dir.startsWith(root + sep)) {
      throw new Error('Invalid deliveries path')
    }
    await mkdir(dir, { recursive: true })

    const fileId = crypto.randomUUID()
    // 以 fileId 作为磁盘名，原始文件名只存在元数据中，避免文件名净化与碰撞问题
    const path = resolve(dir, fileId)
    await writeFile(path, data)

    const createdAt = Date.now()
    this.meta.set(fileId, { sessionId, fileName, bytes: data.byteLength, createdAt, path })

    // 通知在线 SSE 连接（SSEManager 监听）
    this.ctx.emit('dsh-agent-gateway/delivery', {
      sessionId,
      fileId,
      fileName,
      bytes: data.byteLength,
    })

    return { fileId, sessionId, fileName, bytes: data.byteLength, createdAt }
  }

  /**
   * 获取交付物元数据
   * @param {string} fileId - 交付物 ID
   * @returns {{sessionId: string, fileName: string, bytes: number, createdAt: number, path: string}|undefined}
   */
  get(fileId) {
    return this.meta.get(fileId)
  }

  /**
   * 打开交付物字节流
   * @param {string} fileId - 交付物 ID
   * @returns {import('node:fs').ReadStream}
   */
  openStream(fileId) {
    const record = this.meta.get(fileId)
    if (!record) {
      throw new Error('Delivery not found')
    }
    return createReadStream(record.path)
  }

  /**
   * 删除会话时清理元数据（磁盘文件随 workspace 删除）
   * @param {string} sessionId - 会话 ID
   */
  dropSession(sessionId) {
    for (const [fileId, record] of this.meta) {
      if (record.sessionId === sessionId) {
        this.meta.delete(fileId)
      }
    }
  }

  /** 供 /readyz 观测 */
  get stats() {
    return { deliveries: this.meta.size }
  }
}

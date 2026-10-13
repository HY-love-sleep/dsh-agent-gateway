import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SessionRegistry } from './session-registry.js'

const TEST_ROOT = resolve(process.cwd(), '.dsh/home-test-registry')

describe('SessionRegistry', () => {
  let registry
  let ctx
  let config

  beforeEach(async () => {
    // 清理测试目录
    await rm(TEST_ROOT, { recursive: true, force: true })
    await mkdir(TEST_ROOT, { recursive: true })

    ctx = {
      logger: {
        info: () => {},
        error: () => {},
        warn: () => {},
      },
    }

    config = {
      sessions: {
        maxPerIdentity: 3,  // 测试用小上限
      },
    }

    // 覆盖 registry 路径到测试目录
    registry = new SessionRegistry(ctx, config)
    registry._registryPath = resolve(TEST_ROOT, 'registry.json')
    await registry.init()
  })

  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true })
  })

  describe('create', () => {
    it('should create session and return UUID', async () => {
      const sessionId = await registry.create('org:dept:alice', 'agent1')

      // UUID 格式校验
      assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      // 验证归属
      assert.strictEqual(registry.verify(sessionId, 'org:dept:alice', 'agent1'), true)
    })

    it('should enforce session limit', async () => {
      // 创建 3 个会话（达到上限）
      await registry.create('org:dept:alice', 'agent1')
      await registry.create('org:dept:alice', 'agent1')
      await registry.create('org:dept:alice', 'agent1')

      // 第 4 个应该失败
      await assert.rejects(
        () => registry.create('org:dept:alice', 'agent1'),
        { message: 'Session limit reached' }
      )
    })

    it('should handle concurrent creates correctly', async () => {
      // 并发创建 5 个，只有 3 个成功
      const results = await Promise.allSettled([
        registry.create('org:dept:bob', 'agent1'),
        registry.create('org:dept:bob', 'agent1'),
        registry.create('org:dept:bob', 'agent1'),
        registry.create('org:dept:bob', 'agent1'),
        registry.create('org:dept:bob', 'agent1'),
      ])

      const fulfilled = results.filter(r => r.status === 'fulfilled')
      const rejected = results.filter(r => r.status === 'rejected')

      assert.strictEqual(fulfilled.length, 3)
      assert.strictEqual(rejected.length, 2)
    })

    it('should allow different identities independently', async () => {
      // alice 和 bob 各自有独立的上限
      await registry.create('org:dept:alice', 'agent1')
      await registry.create('org:dept:alice', 'agent1')
      await registry.create('org:dept:alice', 'agent1')

      // bob 仍然可以创建
      const sessionId = await registry.create('org:dept:bob', 'agent1')
      assert.ok(sessionId)
    })
  })

  describe('verify', () => {
    it('should return true for correct ownership', async () => {
      const sessionId = await registry.create('org:dept:alice', 'agent1')
      assert.strictEqual(registry.verify(sessionId, 'org:dept:alice', 'agent1'), true)
    })

    it('should return false for wrong principal', async () => {
      const sessionId = await registry.create('org:dept:alice', 'agent1')
      assert.strictEqual(registry.verify(sessionId, 'org:dept:bob', 'agent1'), false)
    })

    it('should return false for wrong agentId', async () => {
      const sessionId = await registry.create('org:dept:alice', 'agent1')
      assert.strictEqual(registry.verify(sessionId, 'org:dept:alice', 'agent2'), false)
    })

    it('should return false for non-existent session', async () => {
      assert.strictEqual(registry.verify('non-existent-uuid', 'org:dept:alice', 'agent1'), false)
    })
  })

  describe('list', () => {
    it('should return empty array for no sessions', () => {
      const sessions = registry.list('org:dept:alice', 'agent1')
      assert.deepStrictEqual(sessions, [])
    })

    it('should list sessions in descending createdAt order', async () => {
      const id1 = await registry.create('org:dept:alice', 'agent1')
      await new Promise(resolve => setTimeout(resolve, 10))  // 确保时间戳不同
      const id2 = await registry.create('org:dept:alice', 'agent1')

      const sessions = registry.list('org:dept:alice', 'agent1')

      assert.strictEqual(sessions.length, 2)
      assert.strictEqual(sessions[0].sessionId, id2)  // 最新的在前
      assert.strictEqual(sessions[1].sessionId, id1)
      assert.ok(sessions[0].createdAt)
      assert.ok(sessions[0].lastActivityAt)
    })

    it('should not return sessions from other identities', async () => {
      await registry.create('org:dept:alice', 'agent1')
      await registry.create('org:dept:bob', 'agent1')

      const aliceSessions = registry.list('org:dept:alice', 'agent1')
      assert.strictEqual(aliceSessions.length, 1)
    })
  })

  describe('delete', () => {
    it('should delete session and return true', async () => {
      const sessionId = await registry.create('org:dept:alice', 'agent1')

      const result = await registry.delete(sessionId)

      assert.strictEqual(result, true)
      assert.strictEqual(registry.verify(sessionId, 'org:dept:alice', 'agent1'), false)
      assert.strictEqual(registry.list('org:dept:alice', 'agent1').length, 0)
    })

    it('should be idempotent (deleting non-existent returns false)', async () => {
      const result = await registry.delete('non-existent-uuid')
      assert.strictEqual(result, false)
    })

    it('should allow creating new session after delete', async () => {
      // 达到上限
      await registry.create('org:dept:alice', 'agent1')
      await registry.create('org:dept:alice', 'agent1')
      const id3 = await registry.create('org:dept:alice', 'agent1')

      // 删除一个
      await registry.delete(id3)

      // 可以再创建
      const newId = await registry.create('org:dept:alice', 'agent1')
      assert.ok(newId)
    })
  })

  describe('persistence', () => {
    it('should persist sessions and reload on restart', async () => {
      const id1 = await registry.create('org:dept:alice', 'agent1')
      const id2 = await registry.create('org:dept:bob', 'agent2')

      // 模拟重启：创建新实例
      const registry2 = new SessionRegistry(ctx, config)
      registry2._registryPath = resolve(TEST_ROOT, 'registry.json')
      await registry2.init()

      // 验证数据恢复
      assert.strictEqual(registry2.verify(id1, 'org:dept:alice', 'agent1'), true)
      assert.strictEqual(registry2.verify(id2, 'org:dept:bob', 'agent2'), true)
      assert.strictEqual(registry2.list('org:dept:alice', 'agent1').length, 1)
      assert.strictEqual(registry2.stats.total, 2)
    })

    it('should handle corrupted registry gracefully', async () => {
      // 写入损坏的 JSON
      await mkdir(TEST_ROOT, { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(resolve(TEST_ROOT, 'registry.json'), '{invalid json', 'utf-8')

      // 应该能启动（从空 registry 开始）
      const registry2 = new SessionRegistry(ctx, config)
      registry2._registryPath = resolve(TEST_ROOT, 'registry.json')
      await registry2.init()

      assert.strictEqual(registry2.stats.total, 0)
    })
  })

  describe('updateActivity', () => {
    it('should update lastActivityAt', async () => {
      const sessionId = await registry.create('org:dept:alice', 'agent1')

      const before = registry.list('org:dept:alice', 'agent1')[0].lastActivityAt

      await new Promise(resolve => setTimeout(resolve, 10))
      registry.updateActivity(sessionId)

      const after = registry.list('org:dept:alice', 'agent1')[0].lastActivityAt

      assert.ok(after > before)
    })
  })
})

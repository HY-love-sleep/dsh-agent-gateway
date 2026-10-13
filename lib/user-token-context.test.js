import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from './session-manager.js'
import { extractUserToken } from './routes.js'

/**
 * 会话级 userToken 暂存与提取的单测。
 *
 * userToken 是终端用户的全量权限令牌（敏感）：本测试仅以占位值验证读写/清理语义，
 * 断言其不出现在 stats（即不进入可观测面）。
 */
function makeCtx() {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
  }
}

const config = { concurrency: { maxGlobalTurns: 1, serialPerSession: true } }

describe('extractUserToken', () => {
  it('从默认请求头 x-user-token 读取（string）', () => {
    assert.strictEqual(extractUserToken({ headers: { 'x-user-token': 'T' } }), 'T')
  })

  it('请求头为数组时取首个非空值', () => {
    assert.strictEqual(extractUserToken({ headers: { 'x-user-token': ['', 'T2'] } }), 'T2')
  })

  it('可按配置指定请求头名', () => {
    assert.strictEqual(extractUserToken({ headers: { 'x-custom-token': 'T' } }, 'x-custom-token'), 'T')
    assert.strictEqual(extractUserToken({ headers: { 'x-user-token': 'T' } }, 'x-custom-token'), undefined)
  })

  it('从 Cookie 中解析同名令牌', () => {
    assert.strictEqual(extractUserToken({ headers: { cookie: 'a=1; x-user-token=T; b=2' } }), 'T')
  })

  it('Cookie 带多余空格时仍能解析', () => {
    assert.strictEqual(extractUserToken({ headers: { cookie: 'a=1;  x-user-token = T ; b=2' } }), 'T')
  })

  it('无令牌时返回 undefined', () => {
    assert.strictEqual(extractUserToken({ headers: { cookie: 'a=1; b=2' } }), undefined)
    assert.strictEqual(extractUserToken({ headers: {} }), undefined)
  })

  it('令牌为空串时返回 undefined', () => {
    assert.strictEqual(extractUserToken({ headers: { 'x-user-token': '' } }), undefined)
    assert.strictEqual(extractUserToken({ headers: { cookie: 'x-user-token=' } }), undefined)
  })

  it('入参缺失 headers 时不抛异常', () => {
    assert.strictEqual(extractUserToken({}), undefined)
    assert.strictEqual(extractUserToken(undefined), undefined)
  })
})

describe('SessionManager userToken 暂存', () => {
  it('写入后可读取', () => {
    const mgr = new SessionManager(makeCtx(), config)
    assert.strictEqual(mgr.setUserToken('s1', 'T'), true)
    assert.strictEqual(mgr.getUserToken('s1'), 'T')
  })

  it('未写入的 sessionId 返回 undefined', () => {
    const mgr = new SessionManager(makeCtx(), config)
    assert.strictEqual(mgr.getUserToken('s-unknown'), undefined)
  })

  it('非法值拒绝写入，且读取为 undefined', () => {
    const mgr = new SessionManager(makeCtx(), config)
    for (const bad of ['', undefined, null, 123, {}, '']) {
      assert.strictEqual(mgr.setUserToken('s2', bad), false)
    }
    assert.strictEqual(mgr.setUserToken('', 'T'), false)
    assert.strictEqual(mgr.getUserToken('s2'), undefined)
  })

  it('删除会话后清除暂存', async () => {
    const mgr = new SessionManager(makeCtx(), config)
    mgr.setUserToken('s1', 'T')
    await mgr.deleteSession('s1')
    assert.strictEqual(mgr.getUserToken('s1'), undefined)
  })

  it('敏感值不外泄到 stats', () => {
    const mgr = new SessionManager(makeCtx(), config)
    mgr.setUserToken('s1', 'T')
    assert.ok(!JSON.stringify(mgr.stats).includes('T'))
  })

  it('dispose 清空暂存（插件卸载时）', () => {
    const mgr = new SessionManager(makeCtx(), config)
    mgr.setUserToken('s1', 'T')
    mgr.dispose()
    assert.strictEqual(mgr.getUserToken('s1'), undefined)
  })
})
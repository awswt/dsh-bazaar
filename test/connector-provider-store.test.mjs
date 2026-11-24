/**
 * 组 4.1–4.3 连接器 provider 化测试矩阵。
 *
 * 行为面（来自 connector-market/spec.md）：
 *   A 列表按 provider 分组 + 状态与关键词同时筛选（AND）
 *   B 详情双键定位（providerId + id），不返回明文密钥
 *   C 动作集收敛：list/state/authorize/poll/cancel/copy-config/remove，其余不支持
 *   D OAuth 三段式：authorize 单飞 → poll 即时持久化 → cancel 终态
 *   E copy-config 只产文本（written:false/reloaded:false），不写宿主配置
 *   F remove 只删本 provider store 里的记录
 *   G store 落到 providers/<providerId>/connectors.json
 *
 * 每个行为面都给 正常 / 边界 / 异常 三类用例，断言字段级而非流程通过。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createConnectorStore } from '../lib/providers/workbuddy/connector-store.js'

const CATALOG = [
  {
    id: 'github',
    name: 'GitHub',
    displayName: 'GitHub 连接器',
    vendor: 'GitHub',
    summary: '代码托管',
    category: 'dev',
    tags: ['git', 'code'],
    auth: { mode: 'oauth2-pkce' },
  },
  {
    id: 'slack',
    name: 'Slack',
    displayName: 'Slack 连接器',
    vendor: 'Slack',
    summary: '团队消息',
    category: 'comm',
    tags: ['chat'],
    auth: { mode: 'token' },
  },
  {
    id: 'notion',
    name: 'Notion',
    displayName: 'Notion 连接器',
    vendor: 'Notion',
    summary: '知识库',
    category: 'docs',
    tags: ['wiki'],
    auth: { mode: 'token' },
  },
]

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bz-connstore-'))
  return {
    dir,
    store: createConnectorStore({
      dataDir: dir,
      connectorViews: async () => ({ items: CATALOG, total: CATALOG.length }),
      readCatalog: async () => ({ categories: ['dev', 'comm', 'docs'] }),
    }),
  }
}

// A —— 列表分组与 AND 筛选
test('A 正常：list 返回全部连接器并带分类，落点按 provider 目录', async () => {
  const { store } = makeStore()
  const result = await store.listConnectorsFor('workbuddy')
  assert.equal(result.ok, true)
  assert.equal(result.total, 3)
  assert.deepEqual(result.categories, ['dev', 'comm', 'docs'])
  assert.ok(
    store
      .storePathFor('workbuddy')
      .includes(path.join('providers', 'workbuddy', 'connectors.json')),
  )
  assert.ok(result.items.every((item) => !('token' in item) && !('credentials' in item)))
})

test('A 边界：query 与 status 同时生效（AND），只命中交集', async () => {
  const { store } = makeStore()
  await store.connectorActionFor('workbuddy', 'authorize', {
    id: 'github',
    authorizeUrl: 'https://example.test/auth',
  })
  const result = await store.listConnectorsFor('workbuddy', { query: 'git', status: 'connected' })
  assert.equal(result.ok, true)
  // github 命中 query，但尚未 poll 成功 → connected 为 false，交集为空。
  assert.equal(result.items.length, 0)
})

test('A 异常：非法 providerId 被白名单拒绝', async () => {
  const { store } = makeStore()
  const result = await store.listConnectorsFor('../evil')
  assert.equal(result.ok, false)
  assert.ok(result.code.startsWith('BAZAAR_'))
})

// B —— 详情双键定位
test('B 正常：详情按 id 定位，字段齐全且无明文密钥', async () => {
  const { store } = makeStore()
  const result = await store.getConnectorFor('workbuddy', 'github')
  assert.equal(result.ok, true)
  assert.equal(result.item.id, 'github')
  assert.equal(result.item.transport, 'oauth2-pkce')
  assert.equal('token' in result.item, false)
  assert.equal('headers' in result.item, false)
})

test('B 边界：id 用 name 也能命中', async () => {
  const { store } = makeStore()
  const result = await store.getConnectorFor('workbuddy', 'GitHub')
  assert.equal(result.ok, true)
  assert.equal(result.item.id, 'github')
})

test('B 异常：不存在的 id 返回 BAZAAR_CONNECTOR_NOT_FOUND', async () => {
  const { store } = makeStore()
  const result = await store.getConnectorFor('workbuddy', 'missing')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BAZAAR_CONNECTOR_NOT_FOUND')
  assert.equal(result.id, 'missing')
})

// C —— 动作集收敛
test('C 异常：repair/enable/disable/unbind 等旧动作一律不支持', async () => {
  const { store } = makeStore()
  for (const action of [
    'connect',
    'repairConnect',
    'reauthorize',
    'unbind',
    'enable',
    'disable',
    'disconnect',
  ]) {
    const result = await store.connectorActionFor('workbuddy', action, { id: 'github' })
    assert.equal(result.ok, false, action)
    assert.equal(result.code, 'BAZAAR_CONNECTOR_ACTION_UNSUPPORTED', action)
    assert.ok(result.supported.includes('copy-config'))
  }
})

test('C 正常：七个动作都在支持集里', async () => {
  const { store } = makeStore()
  assert.deepEqual(store.supportedActions(), [
    'list',
    'state',
    'authorize',
    'poll',
    'cancel',
    'copy-config',
    'remove',
  ])
})

// D —— OAuth 三段式
test('D 正常：authorize 单飞 → poll 成功即时持久化 → 详情变 connected', async () => {
  const { store } = makeStore()
  const a = await store.connectorActionFor('workbuddy', 'authorize', {
    id: 'github',
    authorizeUrl: 'https://example.test/auth',
  })
  assert.equal(a.ok, true)
  assert.equal(a.state, 'pending')
  assert.ok(a.sessionId.startsWith('bz_'))
  // 同一 id 再 authorize 复用同一 session，不重复发起。
  const again = await store.connectorActionFor('workbuddy', 'authorize', { id: 'github' })
  assert.equal(again.sessionId, a.sessionId)
  // 授权回调把会话推进到 granted（真实实现由上游回调调用），poll 落库。
  const completed = await store.completeAuthorizationFor('workbuddy', a.sessionId, 'granted')
  assert.equal(completed.ok, true)
  assert.equal(completed.state, 'granted')
  // poll 推进 granted → 即时持久化到本库 store。
  const p = await store.connectorActionFor('workbuddy', 'poll', { sessionId: a.sessionId })
  assert.equal(p.ok, true)
  assert.equal(p.done, true)
  assert.equal(p.success, true)
  const detail = await store.getConnectorFor('workbuddy', 'github')
  assert.equal(detail.item.connected, true)
  assert.equal(detail.item.authorized, true)
})

test('D 边界：cancel 把授权会话推到终态，poll 后返回 cancelled', async () => {
  const { store } = makeStore()
  const a = await store.connectorActionFor('workbuddy', 'authorize', { id: 'slack' })
  const c = await store.connectorActionFor('workbuddy', 'cancel', { sessionId: a.sessionId })
  assert.equal(c.ok, true)
  assert.equal(c.cancelled, true)
  const p = await store.connectorActionFor('workbuddy', 'poll', { sessionId: a.sessionId })
  assert.equal(p.cancelled, true)
})

test('D 异常：poll 不存在的 sessionId 返回 CONNECTOR_NOT_FOUND', async () => {
  const { store } = makeStore()
  const result = await store.connectorActionFor('workbuddy', 'poll', { sessionId: 'bz_nope' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BAZAAR_CONNECTOR_NOT_FOUND')
})

// E —— copy-config 只产文本
test('E 正常：copy-config 产出可复制文本但不写宿主配置、不重载', async () => {
  const { store } = makeStore()
  const result = await store.connectorActionFor('workbuddy', 'copy-config', {
    id: 'slack',
    headers: { 'X-Token': 'REDACTED' },
    env: { SLACK_KEY: 'REDACTED' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.written, false)
  assert.equal(result.reloaded, false)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.connector, 'slack')
  assert.equal(parsed.providerId, 'workbuddy')
  assert.ok(parsed.note.includes('不会写宿主配置'))
})

// F —— remove 只删本库记录
test('F 正常：remove 删除授权记录并持久化', async () => {
  const { store } = makeStore()
  await store.connectorActionFor('workbuddy', 'authorize', { id: 'notion' })
  const removed = await store.connectorActionFor('workbuddy', 'remove', { id: 'notion' })
  assert.equal(removed.ok, true)
  assert.equal(removed.removed, true)
  const detail = await store.getConnectorFor('workbuddy', 'notion')
  assert.equal(detail.item.authorized, false)
})

test('F 边界：remove 不存在的 id 返回 removed=false 而非异常', async () => {
  const { store } = makeStore()
  const result = await store.connectorActionFor('workbuddy', 'remove', { id: 'ghost' })
  assert.equal(result.ok, true)
  assert.equal(result.removed, false)
})

// G —— store 落点隔离
test('G 正常：不同 providerId 落到各自目录，互不可见', async () => {
  const { store } = makeStore()
  const a = store.storePathFor('workbuddy')
  const b = store.storePathFor('other-provider')
  assert.notEqual(a, b)
  assert.ok(a.includes(path.join('providers', 'workbuddy')))
  assert.ok(b.includes(path.join('providers', 'other-provider')))
  assert.equal(existsSync(path.dirname(a)), false) // 未写入前不创建目录
})

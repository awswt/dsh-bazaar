/**
 * 专家域测试矩阵（任务 3.8，专家域独立成组）。
 *
 * 与 provider-contract*.test.mjs 的分工：那些文件钉契约形状、注册时序与派发判定；本文件钉
 * 的是**分组返回层在真实链路里的行为**——两个 provider 同时点亮时的并列、单库故障的隔离、
 * 跨库同名限定前缀、以及双键详情与非法分页这几条 spec 明写的判定。
 *
 * 所有 provider 都是离线假实现（不联网、不写盘），唯一一处出网是「双源降级」用例里的本地
 * 假 HTTP server：它验证的是「门户挂了回落到公开快照」这条真实分支，而不是打真实市场。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'
import { createDomainViews } from '../lib/provider/domains.js'
import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createWorkbuddyProvider } from '../lib/providers/workbuddy/index.js'
import { MarketClient } from '../lib/providers/workbuddy/market.js'
import { SessionManager } from '../lib/session.js'
import { tempDirSync } from './temp.mjs'

/**
 * 会话适配器：同时满足注册表（clearProvider）与活跃集（readActive/writeActive）两个注入点。
 * readActive 对「从未写过」的会话返回 undefined——活跃集靠这个区分「用户还没选」与
 * 「用户选了空」，组 3.4 的真 SessionManager 是同一语义。
 */
function sessionAdapter() {
  const state = new Map()
  return {
    state,
    async readActive(sessionId) {
      const partition = state.get(sessionId)
      return partition === undefined ? undefined : partition.activeProviders
    },
    async writeActive(sessionId, ids) {
      const partition = state.get(sessionId) ?? {}
      state.set(sessionId, { ...partition, activeProviders: ids.slice() })
      return { ok: true, activeProviders: ids.slice() }
    },
    async clearProvider(providerId) {
      for (const [sessionId, partition] of state) {
        const next = { ...partition }
        next.activeProviders = (partition.activeProviders ?? []).filter(function (id) {
          return id !== providerId
        })
        state.set(sessionId, next)
      }
      return { ok: true, providerId }
    },
  }
}

/** 一套完整链路：注册表 + 活跃集 + 派发 + 分组视图，共用同一个会话适配器。 */
function wiring() {
  const session = sessionAdapter()
  const registry = createProviderRegistry({ session })
  const active = createActiveProviderSet(registry, { session, defaultProvider: '' })
  const dispatcher = createDomainDispatcher(registry, {
    resolveActive: function (sessionId) {
      return active.activeFor(sessionId)
    },
  })
  const views = createDomainViews({ registry, active, dispatcher })
  return { session, registry, active, dispatcher, views }
}

/**
 * 离线专家 provider。calls 记录每次取数，用来断言「未激活的库一次都没被请求」——
 * 这是 spec 的硬要求，只看返回里没有该组是测不出来的（可能是取完再过滤）。
 */
function expertProvider(id, options = {}) {
  const calls = []
  const items = options.items ?? []
  const capabilities = options.capabilities ?? { expertMarket: true }
  const impl = {}
  if (capabilities.memoryMarket === true) {
    // 只声明记忆市场的库也必须过契约校验：声明了域就得给出该域的必需方法。
    impl.memoryMarket = {
      async listMemorySkills() {
        return { items: [], total: 0 }
      },
      async searchMemory(params) {
        calls.push(['searchMemory', params])
        return { items: [], total: 0 }
      },
    }
  }
  if (capabilities.expertMarket === true) {
    impl.expertMarket = {
      async listExperts(params) {
        calls.push(['listExperts', params])
        if (options.failure !== undefined) return options.failure
        const filtered = items.filter(function (item) {
          if (
            params.categoryId !== undefined &&
            params.categoryId !== null &&
            params.categoryId !== ''
          ) {
            if (item.categoryId !== params.categoryId) return false
          }
          if (typeof params.query === 'string' && params.query !== '') {
            const haystack = [item.id, item.displayName, item.profession].filter(Boolean).join(' ')
            return haystack.toLowerCase().includes(params.query.toLowerCase())
          }
          return true
        })
        return { items: filtered, total: filtered.length, source: options.source ?? 'stub' }
      },
      async getExpert(params) {
        calls.push(['getExpert', params])
        if (options.failure !== undefined) return options.failure
        const hit = items.find(function (item) {
          return item.id === params.id
        })
        if (hit === undefined) {
          return { ok: false, code: CODES.EXPERT_NOT_FOUND, message: id + ' 里没有 ' + params.id }
        }
        return { item: hit }
      },
    }
  }
  return {
    calls,
    apiVersion: 1,
    id,
    displayName: options.displayName ?? id + ' 库',
    capabilities,
    impl,
  }
}

/** 只有面板那一侧需要的 SessionManager 依赖：没有 agent 时 selectExpert 不挂子插件。 */
function managerWith(views, bundles) {
  const dataDir = tempDirSync('bazaar-expert-domain-')
  return new SessionManager({
    ctx: {
      agents: {
        get: function () {
          return undefined
        },
        list: function () {
          return []
        },
      },
      skills: {
        async list() {
          return []
        },
        async snapshot() {
          return { skills: [], complete: true }
        },
        async get() {
          return undefined
        },
        registerProvider() {
          return function () {}
        },
      },
    },
    market: {},
    bundles: bundles ?? {},
    config: { dataDir },
    getViews: function () {
      return views
    },
  })
}

test('专家列表按 providerId 分组并列，组顺序与活跃集一致，未激活的库一次都没被请求', async () => {
  const w = wiring()
  const beta = expertProvider('beta', {
    items: [
      { id: 'b1', displayName: '同名专家', categoryId: 'eng' },
      { id: 'b2', displayName: '乙库独有', categoryId: 'eng' },
    ],
  })
  const alpha = expertProvider('alpha', {
    items: [{ id: 'a1', displayName: '同名专家', categoryId: 'eng' }],
  })
  const idle = expertProvider('idle', { items: [{ id: 'i1', displayName: '空闲库专家' }] })
  await w.registry.register(beta)
  await w.registry.register(alpha)
  await w.registry.register(idle)
  await w.session.writeActive('s1', ['beta', 'alpha'])

  const listed = await w.views.listExperts({ sessionId: 's1' })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.deepEqual(
    listed.groups.map(function (group) {
      return group.providerId
    }),
    ['beta', 'alpha'],
  )
  assert.deepEqual(listed.activeProviders, ['beta', 'alpha'])
  assert.equal(
    listed.groups.every(function (group) {
      return group.status === 'ok'
    }),
    true,
  )
  assert.equal(idle.calls.length, 0, '未激活的库不该产生任何一次取数')

  // 每组条目的 providerId 等于所属组的 id；跨库同名加限定前缀，唯一名不加。
  const betaItems = listed.groups[0].items
  assert.equal(betaItems[0].providerId, 'beta')
  assert.equal(betaItems[0].qualifiedName, 'beta 库 · 同名专家')
  assert.equal(betaItems[0].id, 'b1', '前缀不许改真实 id')
  assert.equal(betaItems[1].qualifiedName, '乙库独有')
  assert.equal(listed.groups[1].items[0].qualifiedName, 'alpha 库 · 同名专家')
})

test('单库取数失败只把该库标成错误态，其它库照常返回', async () => {
  const w = wiring()
  const broken = expertProvider('broken', {
    failure: { ok: false, code: CODES.MARKET_UNAVAILABLE, message: '门户与快照都不可用' },
  })
  const healthy = expertProvider('healthy', { items: [{ id: 'h1', displayName: '健康库专家' }] })
  await w.registry.register(broken)
  await w.registry.register(healthy)
  await w.session.writeActive('s1', ['broken', 'healthy'])

  const listed = await w.views.listExperts({ sessionId: 's1' })
  assert.equal(listed.ok, true, '一家库挂了不许让整表失败')
  const [first, second] = listed.groups
  assert.equal(first.providerId, 'broken')
  assert.equal(first.status, 'error')
  assert.equal(first.code, CODES.MARKET_UNAVAILABLE)
  assert.equal(typeof first.message, 'string')
  assert.deepEqual(first.items, [])
  assert.equal(second.status, 'ok')
  assert.equal(second.items.length, 1)
})

test('未声明 expertMarket 的库标成 undeclared，不是错误态', async () => {
  const w = wiring()
  const memoryOnly = expertProvider('memory-only', { capabilities: { memoryMarket: true } })
  await w.registry.register(memoryOnly)
  await w.session.writeActive('s1', ['memory-only'])
  const listed = await w.views.listExperts({ sessionId: 's1' })
  assert.equal(listed.ok, true)
  assert.equal(listed.groups[0].status, 'undeclared')
  assert.equal(listed.groups[0].code, CODES.CAPABILITY_UNDECLARED)
  assert.equal(memoryOnly.calls.length, 0)
})

test('活跃集为空时返回空分组，不是错误', async () => {
  const w = wiring()
  await w.registry.register(expertProvider('alpha'))
  const listed = await w.views.listExperts({ sessionId: 'never-selected' })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.groups, [])
  assert.deepEqual(listed.items, [])
})

test('专家详情按 providerId + id 双键定位：缺 providerId 被拦、未注册不产生出网、查不到是 EXPERT_NOT_FOUND', async () => {
  const w = wiring()
  const alpha = expertProvider('alpha', { items: [{ id: 'writer', displayName: '写手' }] })
  await w.registry.register(alpha)

  const missing = await w.views.getExpert({ id: 'writer' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, CODES.PROVIDER_REQUIRED)
  assert.equal(missing.field, 'providerId')

  const unknown = await w.views.getExpert({ providerId: 'ghost', id: 'writer' })
  assert.equal(unknown.code, CODES.PROVIDER_UNKNOWN)
  assert.equal(alpha.calls.length, 0, '未注册的库不该被请求')

  const hit = await w.views.getExpert({ providerId: 'alpha', id: 'writer' })
  assert.equal(hit.ok, true)
  assert.equal(hit.item.providerId, 'alpha')
  assert.equal(hit.item.providerDisplayName, 'alpha 库')
  assert.equal(hit.item.qualifiedName, '写手')

  const notFound = await w.views.getExpert({ providerId: 'alpha', id: 'nobody' })
  assert.equal(notFound.code, CODES.EXPERT_NOT_FOUND)
})

test('非法分页参数被拦下并指明字段，不静默用默认值', async () => {
  const w = wiring()
  await w.registry.register(expertProvider('alpha', { items: [{ id: 'a1', displayName: '甲' }] }))
  await w.session.writeActive('s1', ['alpha'])

  const zeroPage = await w.views.listExperts({ sessionId: 's1', page: 0 })
  assert.equal(zeroPage.ok, false)
  assert.equal(zeroPage.code, CODES.PARAM_INVALID)
  assert.equal(zeroPage.field, 'page')

  const badSize = await w.views.listExperts({ sessionId: 's1', pageSize: 'many' })
  assert.equal(badSize.code, CODES.PARAM_INVALID)
  assert.equal(badSize.field, 'pageSize')
})

test('关键词与分类同时生效，单库空结果不清空其它库', async () => {
  const w = wiring()
  const alpha = expertProvider('alpha', {
    items: [
      { id: 'a1', displayName: '逆向专家', categoryId: 'sec' },
      { id: 'a2', displayName: '前端专家', categoryId: 'web' },
    ],
  })
  const beta = expertProvider('beta', {
    items: [{ id: 'b1', displayName: '前端专家乙', categoryId: 'web' }],
  })
  await w.registry.register(alpha)
  await w.registry.register(beta)
  await w.session.writeActive('s1', ['alpha', 'beta'])

  const listed = await w.views.listExperts({ sessionId: 's1', query: '逆向', categoryId: 'sec' })
  assert.equal(listed.ok, true)
  assert.equal(listed.groups[0].items.length, 1, '关键词与分类同时生效')
  assert.equal(listed.groups[0].items[0].id, 'a1')
  assert.equal(listed.groups[1].status, 'ok', '另一库的空结果是空态，不是故障')
  assert.deepEqual(listed.groups[1].items, [])
  assert.equal(listed.groups.length, 2, '单库空结果不许把另一组挤掉')
})

test('在线门户失败时回落到公开快照，分组仍标成 ok 并带 warning', async () => {
  const server = http.createServer(function (request, response) {
    if (request.url === '/expert_center.json') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          version: '1.0.0',
          categories: [],
          experts: [
            {
              id: 'snap-1',
              plugin: 'snap-plugin',
              displayName: { zh: '快照专家' },
              profession: { zh: '快照工程师' },
              categoryId: 'eng',
            },
          ],
        }),
      )
      return
    }
    response.statusCode = 404
    response.end('not found')
  })
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  try {
    const market = new MarketClient({
      baseUrl: 'http://127.0.0.1:' + port,
      cacheDir: tempDirSync('bazaar-expert-snapshot-'),
      allowHosts: ['127.0.0.1'],
      allowInsecureLoopback: true,
    })
    const provider = createWorkbuddyProvider({
      portal: {
        async listExperts() {
          throw new Error('portal is down')
        },
        async getExpert() {
          throw new Error('portal is down')
        },
      },
      market,
      config: { allowHosts: ['127.0.0.1'], allowInsecureLoopback: true },
    })
    const w = wiring()
    await w.registry.register(provider)
    await w.session.writeActive('s1', ['workbuddy'])
    const listed = await w.views.listExperts({ sessionId: 's1' })
    assert.equal(listed.ok, true, JSON.stringify(listed))
    const group = listed.groups[0]
    assert.equal(group.status, 'ok')
    assert.equal(group.source, 'cos', '门户失败必须落到快照')
    assert.equal(group.items[0].id, 'snap-1')
    assert.equal(typeof group.warning, 'string')
  } finally {
    server.close()
  }
})

test('选择专家必须带 providerId：缺参、未激活库、未注册库三种情况都被拦下', async () => {
  const w = wiring()
  const alpha = expertProvider('alpha', {
    items: [{ id: 'writer', displayName: '写手', prompt: '你是写手。', skills: [] }],
  })
  const demo = expertProvider('demo', {
    items: [{ id: 'demo-writer', displayName: '示例写手', prompt: '你是示例写手。', skills: [] }],
  })
  await w.registry.register(alpha)
  await w.registry.register(demo)
  const manager = managerWith(w.views)

  await assert.rejects(
    function () {
      return manager.selectExpert('s1', 'writer')
    },
    function (error) {
      return error.code === CODES.PROVIDER_REQUIRED
    },
  )

  // 活跃集是会话自己的持久化状态，写它必须走 SessionManager.writeActive——
  // 注册表那份适配器只管派发时的可见性，不会替会话记住选择。
  await manager.writeActive('s1', ['alpha'])
  await assert.rejects(
    function () {
      return manager.selectExpert('s1', 'demo-writer', { providerId: 'demo' })
    },
    function (error) {
      return error.code === CODES.PROVIDER_REQUIRED && String(error.message).includes('活跃集')
    },
  )
  assert.equal(demo.calls.length, 0, '被拦下的选择不该去库里取数')
})

test('选择只写自己分区、同库重复选择幂等、失败不留半份状态', async () => {
  const w = wiring()
  const alpha = expertProvider('alpha', {
    items: [{ id: 'writer', displayName: '写手', prompt: '你是写手。', skills: [] }],
  })
  const demo = expertProvider('demo', {
    items: [
      { id: 'demo-writer', displayName: '示例写手', prompt: '你是示例写手。', skills: [] },
      { id: 'demo-ghost', displayName: '不存在', prompt: 'x', skills: [] },
    ],
  })
  await w.registry.register(alpha)
  await w.registry.register(demo)
  const manager = managerWith(w.views)

  // 两个库都先在活跃集里，才谈得上「各写各的分区」。
  await manager.writeActive('s1', ['alpha', 'demo'])
  await manager.selectExpert('s1', 'writer', { providerId: 'alpha' })
  const both = await manager.selectExpert('s1', 'demo-writer', { providerId: 'demo' })
  assert.deepEqual(both.activeProviders, ['alpha', 'demo'])
  assert.equal(both.experts.length, 2)
  const alphaBefore = both.experts.find(function (entry) {
    return entry.providerId === 'alpha'
  })

  // 同库重复选择：分区内容不变，不出现重复条目。
  const again = await manager.selectExpert('s1', 'demo-writer', { providerId: 'demo' })
  assert.equal(again.experts.length, 2)
  const alphaAfter = again.experts.find(function (entry) {
    return entry.providerId === 'alpha'
  })
  assert.equal(alphaAfter.id, alphaBefore.id, '另一库的选择不该被改写')
  assert.equal(alphaAfter.displayName, alphaBefore.displayName)
  assert.equal(alphaAfter.source, alphaBefore.source)

  // 失败的选择：revision 不前进，分区回到原值。
  const revisionBefore = again.revision
  await assert.rejects(
    function () {
      return manager.selectExpert('s1', 'nobody', { providerId: 'demo' })
    },
    function (error) {
      return error.code === CODES.EXPERT_NOT_FOUND
    },
  )
  const afterFailure = manager.view('s1')
  assert.equal(afterFailure.revision, revisionBefore)
  assert.equal(afterFailure.experts.length, 2)
})
/**
 * 内置库的专家可能已经下载到本地插件目录。市场快照只收录上架条目，门户又需要登录，
 * 因此「快照里查不到」不等于「本机没有」——离线用户必须还能选中自己装过的专家。
 */
test('内置库在市场上查不到时回落到本地插件目录，第三方的查不到仍报 EXPERT_NOT_FOUND', async () => {
  const w = wiring()
  const builtin = expertProvider('workbuddy', {
    items: [],
    failure: { ok: false, code: CODES.EXPERT_NOT_FOUND, message: 'expert not found: local-only' },
  })
  const thirdParty = expertProvider('acme', {
    items: [],
    failure: { ok: false, code: CODES.EXPERT_NOT_FOUND, message: 'expert not found: local-only' },
  })
  await w.registry.register(builtin)
  await w.registry.register(thirdParty)

  const listed = []
  const bundles = {
    async listLocal() {
      return [
        {
          id: 'local-only',
          plugin: 'local-only',
          agentName: 'local-only',
          displayName: '本地专家',
          source: 'local',
          path: '/tmp/local-only',
        },
      ]
    },
    async ensure(expert) {
      listed.push(expert.id)
      return {
        version: '1.0.0',
        displayName: expert.displayName,
        root: expert.path,
        prompt: '本地专家的说明。',
        skills: [],
        source: 'local',
      }
    },
  }
  const manager = managerWith(w.views, bundles)
  await manager.writeActive('s1', ['workbuddy', 'acme'])

  const view = await manager.selectExpert('s1', 'local-only', { providerId: 'workbuddy' })
  assert.deepEqual(listed, ['local-only'], '本地命中后只解包一次，不再走市场')
  const entry = view.experts.find(function (item) {
    return item.providerId === 'workbuddy'
  })
  assert.equal(entry.id, 'local-only')
  assert.equal(entry.displayName, '本地专家')
  assert.equal(entry.source, 'local')

  // 第三方库没有本地目录：它说查不到就是查不到，不能借内置库的本地清单兜底。
  await assert.rejects(
    function () {
      return manager.selectExpert('s1', 'local-only', { providerId: 'acme' })
    },
    function (error) {
      return error.code === CODES.EXPERT_NOT_FOUND
    },
  )
})

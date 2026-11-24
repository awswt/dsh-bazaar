/**
 * 「当前 provider 集合是唯一取值来源」的用例（任务 2.6 的 spec 场景）。
 *
 * 持久化用注入的假适配器（真 saveState 分组属 3.4），这里证判定本身：空态不回落、
 * 配置错误才回落且必须发提示、写入整笔原子、四条入口读到同一集合。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createActiveProviderSet } from '../lib/provider/active-set.js'

const fn = async function () {
  return {}
}

function stack(config = {}) {
  const notices = []
  const persisted = new Map()
  const session = {
    async clearProvider(id) {
      return { ok: true, providerId: id }
    },
    async readActive(sessionId) {
      return persisted.get(sessionId)
    },
    async writeActive(sessionId, ids) {
      persisted.set(sessionId, ids.slice())
      return { ok: true }
    },
  }
  const registry = createProviderRegistry({ session: session })
  const active = createActiveProviderSet(registry, {
    defaultProvider: config.defaultProvider,
    session: session,
    onNotice: (notice) => notices.push(notice),
  })
  return { registry: registry, active: active, notices: notices, persisted: persisted }
}

async function withTwo(setup) {
  for (const pair of [
    ['workbuddy', 'WorkBuddy 专家库'],
    ['demo', '示例库'],
  ]) {
    await setup.registry.register({
      apiVersion: 1,
      id: pair[0],
      displayName: pair[1],
      capabilities: { expertMarket: true },
      impl: { expertMarket: { listExperts: fn, getExpert: fn } },
    })
  }
}

test('defaultProvider 默认空：新会话活跃集为空，未传 provider 的调用被拦下', async () => {
  const setup = stack()
  await withTwo(setup)
  assert.deepEqual(await setup.active.activeFor('s1'), [], '新会话必须为空，而不是拿注册顺序的首个')
  const failure = await setup.active.resolveProvider('s1', undefined)
  assert.equal(failure.ok, false)
  assert.equal(failure.code, CODES.PROVIDER_REQUIRED)
  assert.ok(failure.message.includes('尚未选择专家库'), failure.message)
  // registered 只是可选项列表，不是回落结果：一条数据都不该返回。
  assert.deepEqual(failure.activeProviders, [])
  assert.deepEqual(failure.registered, ['workbuddy', 'demo'])
  assert.deepEqual(setup.notices, [], '空默认值不是配置错误，不该发提示')
})

test('defaultProvider 指向未注册 id：报 PROVIDER_UNKNOWN 并回落首个已注册，且发提示', async () => {
  const setup = stack({ defaultProvider: 'ghost' })
  await withTwo(setup)
  assert.deepEqual(await setup.active.activeFor('s1'), ['workbuddy'])
  assert.equal(setup.notices.length, 1)
  assert.equal(setup.notices[0].code, CODES.PROVIDER_UNKNOWN)
  assert.equal(setup.notices[0].providerId, 'ghost')
  assert.equal(setup.notices[0].fallback, 'workbuddy')
  assert.ok(setup.notices[0].message.includes('ghost'), setup.notices[0].message)
  const resolved = await setup.active.resolveProvider('s1', undefined)
  assert.equal(resolved.providerId, 'workbuddy')
  assert.equal(resolved.source, 'session')
})

test('注册表为空时不编造回落目标', async () => {
  const setup = stack({ defaultProvider: 'ghost' })
  assert.deepEqual(await setup.active.activeFor('s1'), [])
  assert.equal(setup.notices[0].fallback, undefined)
  assert.ok(setup.notices[0].message.includes('注册表为空'), setup.notices[0].message)
})

test('defaultProvider 非法 id 也走回落并指明原因', async () => {
  const setup = stack({ defaultProvider: '../evil' })
  await withTwo(setup)
  assert.deepEqual(await setup.active.activeFor('s1'), ['workbuddy'])
  assert.equal(setup.notices[0].code, CODES.PROVIDER_INVALID_ID)
})

test('合法 defaultProvider 直接成为活跃集，不发提示', async () => {
  const setup = stack({ defaultProvider: 'demo' })
  await withTwo(setup)
  assert.deepEqual(await setup.active.activeFor('s1'), ['demo'])
  assert.deepEqual(setup.notices, [])
})

test('显式清空活跃集是合法写入，回到空态而不是错误', async () => {
  const setup = stack()
  await withTwo(setup)
  const first = await setup.active.setActive('s1', ['workbuddy', 'demo'])
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(first.activeProviders, ['workbuddy', 'demo'])
  const cleared = await setup.active.setActive('s1', [])
  assert.equal(cleared.ok, true)
  assert.deepEqual(cleared.activeProviders, [])
  assert.deepEqual(await setup.active.activeFor('s1'), [])
  assert.deepEqual(setup.persisted.get('s1'), [])
})

test('写入活跃集整笔原子：含未注册或非法 id 时一笔都不落', async () => {
  const setup = stack()
  await withTwo(setup)
  const unknown = await setup.active.setActive('s1', ['workbuddy', 'ghost'])
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, CODES.PROVIDER_UNKNOWN)
  assert.equal(unknown.field, 'activeProviders[1]')
  assert.equal(setup.persisted.get('s1'), undefined, '被拒的写入不该留下半份')
  const illegal = await setup.active.setActive('s1', ['../workbuddy'])
  assert.equal(illegal.code, CODES.PROVIDER_INVALID_ID)
  assert.equal((await setup.active.setActive('s1', 'workbuddy')).code, CODES.PARAM_INVALID)
  assert.equal((await setup.active.setActive(undefined, [])).field, 'sessionId')
  const dedup = await setup.active.setActive('s1', ['workbuddy', 'workbuddy'])
  assert.deepEqual(dedup.activeProviders, ['workbuddy'])
})

test('持久化失败不报成功', async () => {
  const registry = createProviderRegistry({
    session: {
      async clearProvider(id) {
        return { ok: true, providerId: id }
      },
    },
  })
  await registry.register({
    apiVersion: 1,
    id: 'workbuddy',
    displayName: 'WorkBuddy 专家库',
    capabilities: { expertMarket: true },
    impl: { expertMarket: { listExperts: fn, getExpert: fn } },
  })
  const active = createActiveProviderSet(registry, {
    session: {
      async readActive() {
        return undefined
      },
      async writeActive() {
        return undefined
      },
    },
  })
  const failure = await active.setActive('s1', ['workbuddy'])
  assert.equal(failure.ok, false)
  assert.ok(failure.message.includes('未返回结果'), failure.message)
})

test('面板、工具、命令、路由读同一份集合', async () => {
  const setup = stack()
  await withTwo(setup)
  await setup.active.setActive('s1', ['workbuddy', 'demo'])
  const described = await setup.active.describeProviders('s1')
  assert.deepEqual(
    described.items.map((p) => [p.id, p.active]),
    [
      ['workbuddy', true],
      ['demo', true],
    ],
  )
  assert.deepEqual(described.activeProviders, ['workbuddy', 'demo'])
  // 两库都活跃时不代选：四个入口必须一致地要求显式 provider。
  assert.equal((await setup.active.resolveProvider('s1', undefined)).code, CODES.PROVIDER_REQUIRED)
  assert.equal((await setup.active.resolveProvider('s1', 'demo')).providerId, 'demo')
  await setup.active.setActive('s1', ['demo'])
  assert.equal((await setup.active.resolveProvider('s1', undefined)).providerId, 'demo')
  assert.deepEqual(
    (await setup.active.describeProviders('s1')).items.map((p) => [p.id, p.active]),
    [
      ['workbuddy', false],
      ['demo', true],
    ],
  )
})

test('providers 列举带 capabilities 与 active，且不含 impl', async () => {
  const setup = stack()
  await withTwo(setup)
  await setup.active.setActive('s1', ['demo'])
  const described = await setup.active.describeProviders('s1')
  assert.equal(described.defaultProvider, '')
  const demo = described.items.find((p) => p.id === 'demo')
  assert.deepEqual(Object.keys(demo).sort(), [
    'active',
    'apiVersion',
    'capabilities',
    'displayName',
    'id',
  ])
  assert.equal(JSON.stringify(described).includes('impl'), false)
})

test('注销一个库时把它从各会话活跃集剔除，其它库原样保留', async () => {
  const setup = stack()
  await withTwo(setup)
  await setup.active.setActive('s1', ['workbuddy', 'demo'])
  await setup.active.setActive('s2', ['demo'])
  const cleared = await setup.active.clearProvider('demo')
  assert.equal(cleared.ok, true)
  assert.deepEqual(cleared.cleared.sort(), ['s1', 's2'])
  assert.deepEqual(await setup.active.activeFor('s1'), ['workbuddy'])
  assert.deepEqual(await setup.active.activeFor('s2'), [])
})

test('注册表接线成同一实例：unregister 走 active-set 的 clearProvider 时分区被清', async () => {
  const setup = stack()
  await withTwo(setup)
  await setup.active.setActive('s1', ['workbuddy', 'demo'])
  // 注册表侧的注销用注入的 session.clearProvider；把 active-set 当适配器接上即可闭合。
  const linked = createProviderRegistry({ session: setup.active })
  for (const provider of setup.registry.list()) {
    await linked.register({ ...provider, impl: setup.registry.getRecord(provider.id).impl })
  }
  const result = await linked.unregister('demo')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(
    await setup.active.activeFor('s1'),
    ['workbuddy'],
    '注销后该会话不再向 demo 派发',
  )
})

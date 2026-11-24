/**
 * provider 契约测试矩阵（任务 2.8）。
 *
 * 与 2.1–2.6 的分工：那些文件各自钉住一个模块（契约形状、注册表时序、派发判定、活跃集、
 * 目录隔离）。本文件钉的是**跨模块的那条缝**：把两个真实存在的 provider（内置 workbuddy
 * 与契约样例 minimal-example）同时放进一套注册表 + 活跃集 + 会话适配器，看它们是否真的
 * 互不可见、注销是否只清自己那份。
 *
 * 为什么必须用「真 provider」而不是再造一对假契约：假契约的隔离是免费的——它们本来就
 * 不共享任何东西。真 provider 才带得出问题：内置库的 impl 包着 portal/market/connectors
 * 闭包，样例库读同目录的 JSON，两者的凭据名、数据目录、缓存根都从 id 推导，推导写歪一处
 * 就会出现「A 库的请求打到 B 库的凭据」。
 *
 * 六类错误路径在这一层只验证「注册被拒且不留痕」：错误码文本由 2.1/2.3 的用例逐字断言，
 * 这里断言的是拒绝之后注册表、会话分区、磁盘目录三处都必须干净。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createMinimalProvider } from '../examples/minimal-provider/index.mjs'
import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { API_VERSION } from '../lib/provider/contract.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'
import { CODES } from '../lib/provider/errors.js'
import { credentialNameFor, providerLayout, resolveCredentialName } from '../lib/provider/paths.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import {
  PROVIDER_ID as BUILTIN_ID,
  createWorkbuddyProvider,
} from '../lib/providers/workbuddy/index.js'

const EXAMPLE_ID = 'minimal-example'

const fn = async function () {
  return { items: [], total: 0 }
}

function contractOf(id, capabilities = undefined) {
  const caps = capabilities ?? { expertMarket: true }
  const impl = { expertMarket: { listExperts: fn, getExpert: fn } }
  return {
    apiVersion: API_VERSION,
    id: id,
    displayName: id + ' 专家库',
    capabilities: caps,
    impl: impl,
  }
}

/**
 * 会话适配器：同时满足注册表（clearProvider）与活跃集（readActive/writeActive）两个注入点，
 * 并按 providerId 分区存 experts/skills —— 组 3.4 的真 saveState 就是这个形状。
 */
function sessionState(seed = undefined) {
  const state = new Map()
  for (const [sessionId, partition] of Object.entries(seed ?? {})) {
    state.set(sessionId, structuredClone(partition))
  }
  const cleared = []
  return {
    state: state,
    cleared: cleared,
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
      cleared.push(providerId)
      for (const [sessionId, partition] of state) {
        const next = { ...partition }
        next.activeProviders = (partition.activeProviders ?? []).filter(function (id) {
          return id !== providerId
        })
        for (const group of ['experts', 'skills']) {
          if (next[group] === undefined) continue
          next[group] = { ...next[group] }
          delete next[group][providerId]
        }
        // 其它库的条目必须原样留着：注销一家的代价只能是它自己那一份。
        state.set(sessionId, next)
      }
      return { ok: true, providerId: providerId }
    },
  }
}

/** 一套完整链路：注册表 + 活跃集 + 域派发，会话适配器共用同一个实例。 */
function wiring(seedBaseDir = undefined) {
  const session = sessionState()
  const events = []
  const registry = createProviderRegistry({
    session: session,
    onChange: function (event) {
      events.push(event)
    },
  })
  const baseDir = seedBaseDir ?? mkdtempSync(path.join(tmpdir(), 'bazaar-matrix-'))
  const activeProviders = createActiveProviderSet(registry, {
    session: session,
    defaultProvider: '',
  })
  const dispatcher = createDomainDispatcher(registry, {
    resolveActive: function () {
      return []
    },
  })
  /** 与 lib/index.js 的 ctx.bazaar.providers.unregister 同序：先删表项，成功后再清活跃集。 */
  async function unregister(providerId) {
    const result = await registry.unregister(providerId)
    if (result.ok === true) await activeProviders.clearProvider(providerId)
    return result
  }
  return {
    registry: registry,
    session: session,
    events: events,
    activeProviders: activeProviders,
    dispatcher: dispatcher,
    unregister: unregister,
    baseDir: baseDir,
  }
}

/** 内置 provider 用一对最小假数据源：不联网，返回体里带来源标记，便于分辨是谁的答案。 */
function builtinWithFakeSources() {
  return createWorkbuddyProvider({
    portal: {
      async listExperts(params) {
        return {
          items: [{ id: 'wb-portal-1', name: '门户专家', query: params.query }],
          total: 1,
          source: 'portal',
        }
      },
      async getExpert(id) {
        return { id: id, name: '门户专家' }
      },
      async listSkills() {
        return { items: [], total: 0 }
      },
    },
    config: { allowHosts: ['www.workbuddy.cn'] },
  })
}

test('六类错误路径：注册被拒且注册表、会话分区、磁盘目录三处都不留痕', async () => {
  const cases = [
    {
      label: '契约版本不符',
      candidate: function () {
        return { ...contractOf('bad-version'), apiVersion: 2 }
      },
      code: CODES.PROVIDER_API_VERSION,
    },
    {
      label: '必填字段缺失',
      candidate: function () {
        const candidate = contractOf('no-display-name')
        delete candidate.displayName
        return candidate
      },
      code: CODES.PARAM_INVALID,
      extra: function (failure) {
        return failure.field === 'displayName'
      },
    },
    {
      label: '非法 id（路径穿越）',
      candidate: function () {
        return contractOf('../escape')
      },
      code: CODES.PROVIDER_INVALID_ID,
    },
    {
      label: '行为面方法缺失',
      candidate: function () {
        return {
          ...contractOf('no-method'),
          impl: { expertMarket: { listExperts: fn } },
        }
      },
      code: CODES.PROVIDER_IMPL_MISSING,
      extra: function (failure) {
        return failure.method === 'getExpert' && failure.domain === 'expertMarket'
      },
    },
  ]

  for (const entry of cases) {
    const setup = wiring()
    const failure = await setup.registry.register(entry.candidate())
    assert.equal(failure.ok, false, entry.label + ' 必须被拒')
    assert.equal(failure.code, entry.code, entry.label + ': ' + failure.message)
    if (entry.extra !== undefined) assert.ok(entry.extra(failure), entry.label + ' 的 details 不全')
    // 被拒的注册不能留下任何可观察的痕迹。
    assert.deepEqual(setup.registry.ids(), [], entry.label + ' 之后注册表必须为空')
    assert.deepEqual(setup.events, [], entry.label + ' 不该通知界面重算')
    assert.deepEqual(setup.session.cleared, [], entry.label + ' 不该触碰会话分区')
    assert.equal(
      existsSync(path.join(setup.baseDir, 'providers')),
      false,
      entry.label + ' 之后不能新建 provider 目录',
    )
  }
})

test('重复注册被拒，既有条目与它的实现对象都不被替换', async () => {
  const setup = wiring()
  await setup.registry.register(builtinWithFakeSources())
  const original = setup.registry.getRecord(BUILTIN_ID)

  const duplicate = await setup.registry.register(builtinWithFakeSources())
  assert.equal(duplicate.code, CODES.PROVIDER_DUPLICATE)
  assert.equal(setup.registry.getRecord(BUILTIN_ID), original, 'impl 引用必须原样保留')
  assert.equal(setup.registry.get(BUILTIN_ID).provider.displayName, original.displayName)
  assert.deepEqual(
    setup.events.map(function (event) {
      return event.type
    }),
    ['registered'],
  )
})

test('注销后同名重注按全新注册处理，活跃集不含它（需用户重新选择）', async () => {
  const setup = wiring()
  await setup.registry.register(contractOf('acme'))
  await setup.activeProviders.setActive('session-1', ['acme'])
  assert.deepEqual(await setup.activeProviders.activeFor('session-1'), ['acme'])

  const removed = await setup.unregister('acme')
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.equal(setup.registry.get('acme').code, CODES.PROVIDER_UNKNOWN)
  // 注销把会话里的引用一并清掉，否则面板会继续向一个不存在的库派发。
  assert.deepEqual(await setup.activeProviders.activeFor('session-1'), [])

  const again = await setup.registry.register(contractOf('acme'))
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(setup.registry.list().length, 1)
  assert.deepEqual(
    await setup.activeProviders.activeFor('session-1'),
    [],
    '重注册是新库，不能被旧的会话选择自动激活',
  )
  // 新的库没被选中时，代选必须报 REQUIRED 而不是悄悄用上它。
  const resolved = await setup.activeProviders.resolveProvider('session-1', undefined)
  assert.equal(resolved.code, CODES.PROVIDER_REQUIRED)
})

test('内置库与样例库并存：凭据名、数据目录、缓存三处互不可见', async () => {
  const setup = wiring()
  await setup.registry.register(builtinWithFakeSources())
  await setup.registry.register(createMinimalProvider())
  assert.deepEqual(setup.registry.ids(), [BUILTIN_ID, EXAMPLE_ID])

  // 凭据名各推各的，且互相反查得到对方（因此跨读能被拒）。
  const builtinRef = credentialNameFor(BUILTIN_ID)
  const exampleRef = credentialNameFor(EXAMPLE_ID)
  assert.equal(builtinRef.name, 'BAZAAR_WORKBUDDY_TOKEN')
  assert.equal(exampleRef.name, 'BAZAAR_MINIMAL_EXAMPLE_TOKEN')
  assert.notEqual(builtinRef.name, exampleRef.name)
  const known = setup.registry.ids()
  const crossRead = resolveCredentialName({
    providerId: BUILTIN_ID,
    credentialRef: exampleRef.name,
    knownProviderIds: known,
  })
  assert.equal(crossRead.code, CODES.PARAM_INVALID)
  assert.equal(crossRead.ownerProviderId, EXAMPLE_ID)

  // 四个落点各在各的子树里，互不为前缀。
  const builtinLayout = providerLayout(setup.baseDir, BUILTIN_ID)
  const exampleLayout = providerLayout(setup.baseDir, EXAMPLE_ID)
  for (const key of ['root', 'accounts', 'vault', 'cache', 'connectorsFile']) {
    const left = builtinLayout[key]
    const right = exampleLayout[key]
    assert.notEqual(left, right, key + ' 不能撞车')
    assert.equal(left.startsWith(right), false, key + ' 不能落在对方的子树里')
    assert.equal(right.startsWith(left), false, key + ' 不能反向嵌套')
  }
  assert.ok(builtinLayout.accounts.includes(BUILTIN_ID))
  assert.equal(builtinLayout.accounts.includes(EXAMPLE_ID), false)

  // 派发层的隔离：同一份请求打两库，各自只看到自己的数据来源。
  const builtinListed = await setup.dispatcher.call({
    providerId: BUILTIN_ID,
    domain: 'expertMarket',
    method: 'listExperts',
    params: { query: '专家' },
  })
  const exampleListed = await setup.dispatcher.call({
    providerId: EXAMPLE_ID,
    domain: 'expertMarket',
    method: 'listExperts',
    params: { query: '示例' },
  })
  assert.equal(builtinListed.ok, true, JSON.stringify(builtinListed))
  assert.equal(builtinListed.source, 'portal')
  assert.equal(exampleListed.ok, true, JSON.stringify(exampleListed))
  assert.equal(exampleListed.source, 'local-json')
  assert.equal(JSON.stringify(builtinListed).includes('demo-writer'), false)
  assert.equal(JSON.stringify(exampleListed).includes('wb-portal-1'), false)
})

test('两库并存时未声明的域按库各判：样例库没有技能域，内置库有', async () => {
  const setup = wiring()
  await setup.registry.register(builtinWithFakeSources())
  await setup.registry.register(createMinimalProvider())

  const exampleSkills = await setup.dispatcher.call({
    providerId: EXAMPLE_ID,
    domain: 'skillMarket',
    method: 'listSkills',
    params: {},
  })
  assert.equal(exampleSkills.code, CODES.CAPABILITY_UNDECLARED)
  assert.equal(exampleSkills.providerId, EXAMPLE_ID)
  assert.deepEqual(exampleSkills.declared, ['expertMarket'])

  // 内置库声明了技能域：同一方法在它身上不该被「未声明」拦下。
  const builtinSkills = await setup.dispatcher.call({
    providerId: BUILTIN_ID,
    domain: 'skillMarket',
    method: 'listSkills',
    params: {},
  })
  assert.notEqual(builtinSkills.code, CODES.CAPABILITY_UNDECLARED)
  assert.equal(builtinSkills.ok, true, JSON.stringify(builtinSkills))
})

test('注销内置库只清它自己的分区，样例库的会话条目与派发原样保留', async () => {
  const setup = wiring()
  await setup.registry.register(builtinWithFakeSources())
  await setup.registry.register(createMinimalProvider())
  await setup.activeProviders.setActive('session-1', [BUILTIN_ID, EXAMPLE_ID])
  // 模拟组 3.4 的分区形状：两家库各自有 experts 与 skills 条目。
  setup.session.state.set('session-1', {
    activeProviders: [BUILTIN_ID, EXAMPLE_ID],
    experts: { [BUILTIN_ID]: 'wb-portal-1', [EXAMPLE_ID]: 'demo-writer' },
    skills: { [BUILTIN_ID]: ['wb-skill'], [EXAMPLE_ID]: ['demo-skill'] },
    revision: 7,
  })

  const removed = await setup.unregister(BUILTIN_ID)
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.deepEqual(setup.session.cleared, [BUILTIN_ID], '只允许清除被注销的那一家')

  const partition = setup.session.state.get('session-1')
  assert.deepEqual(partition.activeProviders, [EXAMPLE_ID])
  assert.deepEqual(partition.experts, { [EXAMPLE_ID]: 'demo-writer' })
  assert.deepEqual(partition.skills, { [EXAMPLE_ID]: ['demo-skill'] })
  assert.equal(partition.revision, 7, '注销不该改动别的分区字段')

  // 旧路由/旧页签指向已注销的库时，必须拿到明确的 UNKNOWN，而不是空成功。
  const gone = await setup.dispatcher.call({
    providerId: BUILTIN_ID,
    domain: 'expertMarket',
    method: 'listExperts',
    params: {},
  })
  assert.equal(gone.code, CODES.PROVIDER_UNKNOWN)
  assert.deepEqual(gone.registered, [EXAMPLE_ID])

  const stillThere = await setup.dispatcher.call({
    providerId: EXAMPLE_ID,
    domain: 'expertMarket',
    method: 'getExpert',
    params: { id: 'demo-writer' },
  })
  assert.equal(stillThere.ok, true, JSON.stringify(stillThere))
  assert.equal(stillThere.item.id, 'demo-writer')
})

test('list / get / register / unregister 对同一集合观察一致', async () => {
  const setup = wiring()
  await setup.registry.register(builtinWithFakeSources())
  await setup.registry.register(createMinimalProvider())

  const listed = setup.registry.list()
  assert.deepEqual(
    listed.map(function (provider) {
      return provider.id
    }),
    setup.registry.ids(),
  )
  for (const provider of listed) {
    const single = setup.registry.get(provider.id)
    assert.equal(single.ok, true)
    // get 与 list 的同一项必须逐字段相等：两处各凑一次对象就会漂。
    assert.deepEqual(single.provider, provider)
    assert.equal(
      Object.prototype.hasOwnProperty.call(provider, 'impl'),
      false,
      '声明面投影不得带 impl',
    )
  }

  const removed = await setup.registry.unregister(BUILTIN_ID)
  assert.equal(removed.ok, true)
  assert.deepEqual(setup.registry.ids(), [EXAMPLE_ID])
  assert.equal(setup.registry.get(BUILTIN_ID).code, CODES.PROVIDER_UNKNOWN)
  assert.equal(setup.registry.get(EXAMPLE_ID).ok, true)
  // providers 动作读的是 describeProviders：它与注册表必须是同一份集合。
  const described = await setup.activeProviders.describeProviders('session-1')
  assert.deepEqual(
    described.items.map(function (item) {
      return item.id
    }),
    [EXAMPLE_ID],
  )
})

test('派发层不吞 provider 自己的失败信封，也不把成功体套成两层 ok', async () => {
  const setup = wiring()
  // 不给 portal/market：内置库的专家域此刻只有 MARKET_UNAVAILABLE 一条路可走。
  await setup.registry.register(createWorkbuddyProvider({}))
  const failure = await setup.dispatcher.call({
    providerId: BUILTIN_ID,
    domain: 'expertMarket',
    method: 'listExperts',
    params: {},
  })
  assert.equal(failure.ok, false)
  assert.equal(failure.code, CODES.MARKET_UNAVAILABLE)
  assert.equal(failure.domain, 'expertMarket')
  // provider 自己写的失败信封被原样透传，派发层不补字段也不重排：若在这里补 providerId，
  // 「provider 说自己缺什么」和「边界层说 provider 违约」两种信封就分不出来了。
  assert.equal(Object.prototype.hasOwnProperty.call(failure, 'providerId'), false)

  // 抛异常才由边界层兜：那时 providerId/domain/method 三样必须补齐，否则日志里查不到是谁炸的。
  await setup.registry.register({
    ...contractOf('boom'),
    impl: {
      expertMarket: {
        async listExperts() {
          throw new Error('上游炸了')
        },
        getExpert: fn,
      },
    },
  })
  const thrown = await setup.dispatcher.call({
    providerId: 'boom',
    domain: 'expertMarket',
    method: 'listExperts',
    params: {},
  })
  assert.equal(thrown.code, CODES.PROVIDER_THROWN)
  assert.equal(thrown.providerId, 'boom')
  assert.equal(thrown.domain, 'expertMarket')
  assert.equal(thrown.method, 'listExperts')
  assert.ok(thrown.message.includes('上游炸了'), thrown.message)

  await setup.registry.register(createMinimalProvider())
  const success = await setup.dispatcher.call({
    providerId: EXAMPLE_ID,
    domain: 'expertMarket',
    method: 'getExpert',
    params: { id: 'demo-analyst' },
  })
  assert.equal(success.ok, true)
  // 只有一层 ok：provider 返回 {item}，派发层在它前面补 ok，不该出现 ok 覆盖 payload 的情况。
  assert.equal(success.item.id, 'demo-analyst')
  assert.equal(typeof success.item.prompt, 'string')
})

/**
 * 域入口判定的用例（任务 2.4 的三个 spec 场景 + 三条入口判定一致）。
 *
 * 全部离线：provider 的 impl 是本地假函数，不起 HTTP、不碰磁盘。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'

function buildRegistry(active = undefined) {
  const session = {
    async clearProvider(id) {
      return { ok: true, providerId: id }
    },
  }
  const registry = createProviderRegistry({ session: session })
  const dispatcher = createDomainDispatcher(
    registry,
    active === undefined ? undefined : { resolveActive: () => active },
  )
  return { registry: registry, dispatcher: dispatcher }
}

/**
 * demo 只声明专家市场（对照组：未声明的域必须被拦）；
 * full 五域齐备，其中故意安排「空数据」「抛异常」「带码失败」三种返回，供各场景取用。
 */
async function registerTwo(setup) {
  await setup.registry.register({
    apiVersion: 1,
    id: 'demo',
    displayName: '示例库',
    capabilities: { expertMarket: true },
    impl: {
      expertMarket: {
        async listExperts() {
          return { items: [{ id: 'e1' }], total: 1, source: 'cos' }
        },
        async getExpert() {
          return { item: { id: 'e1' } }
        },
      },
    },
  })
  await setup.registry.register({
    apiVersion: 1,
    id: 'full',
    displayName: '全能力库',
    capabilities: {
      expertMarket: true,
      skillMarket: true,
      memoryMarket: true,
      connectorMarket: true,
      account: true,
    },
    impl: {
      expertMarket: {
        async listExperts(params) {
          return { items: [], total: 0, source: 'portal', sawQuery: params.query ?? null }
        },
        async getExpert() {
          return { item: null }
        },
      },
      skillMarket: {
        async listSkills() {
          return { items: [], total: 0 }
        },
        async installSkill(params) {
          return {
            ok: false,
            code: CODES.SKILL_SLUG_INVALID,
            message: 'slug 不合法',
            skillId: params.skillId,
          }
        },
      },
      memoryMarket: {
        async listMemorySkills() {
          throw new Error('宿主没装记忆插件')
        },
        async searchMemory() {
          throw Object.assign(new Error('需要登录'), { code: CODES.MARKET_AUTH_REQUIRED })
        },
      },
      connectorMarket: {
        async listConnectors() {
          return { items: [], total: 0, categories: [] }
        },
        async getConnector() {
          return { ok: false, code: CODES.CONNECTOR_NOT_FOUND, message: '没有这个连接器' }
        },
        async connectorAction() {
          return { action: 'list', result: [] }
        },
      },
      account: {
        async listAccounts() {
          return { own: [], all: [], pending: [], summary: '未登录' }
        },
        async accountAction() {
          return { action: 'list', result: [] }
        },
      },
    },
  })
}

test('未声明的域调用被拦下，信息含 providerId 与域名', async () => {
  const setup = buildRegistry()
  await registerTwo(setup)
  for (const domain of ['skillMarket', 'memoryMarket', 'connectorMarket', 'account']) {
    const failure = await setup.dispatcher.call({
      providerId: 'demo',
      domain: domain,
      method: 'listSkills',
    })
    assert.equal(failure.ok, false, domain + ' 不该被放行')
    assert.equal(failure.code, CODES.CAPABILITY_UNDECLARED)
    assert.equal(failure.providerId, 'demo')
    assert.equal(failure.domain, domain)
    assert.ok(failure.message.includes('demo') && failure.message.includes(domain), failure.message)
    // 顺带给出该库实际声明了什么，免得调用方在两个库之间反复试探。
    assert.deepEqual(failure.declared, ['expertMarket'])
  }
})

test('已声明但无数据走正常空态，不是错误', async () => {
  const setup = buildRegistry()
  await registerTwo(setup)
  const empty = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'skillMarket',
    method: 'listSkills',
    params: {},
  })
  assert.equal(empty.ok, true, JSON.stringify(empty))
  assert.deepEqual(empty.items, [])
  assert.equal(empty.total, 0)
  const accounts = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'account',
    method: 'listAccounts',
    params: {},
  })
  assert.equal(accounts.ok, true)
  assert.deepEqual(accounts.own, [])
  assert.notEqual(accounts.code, CODES.CAPABILITY_UNDECLARED)
})

test('面板、工具、路由三条入口共用同一判定，结论一致', async () => {
  const setup = buildRegistry(['demo'])
  await registerTwo(setup)
  const request = { providerId: 'demo', domain: 'connectorMarket', method: 'listConnectors' }
  const viaTool = setup.dispatcher.check(request)
  const viaRoute = await setup.dispatcher.call(request)
  const viaPanel = setup.dispatcher.available('demo', 'connectorMarket')
  assert.equal(viaTool.code, CODES.CAPABILITY_UNDECLARED)
  assert.equal(viaRoute.code, CODES.CAPABILITY_UNDECLARED)
  assert.equal(viaPanel, false)
  assert.equal(viaTool.providerId, viaRoute.providerId)
  assert.equal(viaTool.domain, viaRoute.domain)
  assert.equal(viaTool.message, viaRoute.message, '同一拒因必须给同一句话，不能两处各写一套文案')
  const okRequest = { providerId: 'demo', domain: 'expertMarket', method: 'listExperts' }
  assert.equal(setup.dispatcher.check(okRequest).ok, true)
  assert.equal((await setup.dispatcher.call(okRequest)).ok, true)
  assert.equal(setup.dispatcher.available('demo', 'expertMarket'), true)
})

test('缺 provider 时给 PROVIDER_REQUIRED 而不是静默回落首个已注册库', async () => {
  const noActive = buildRegistry([])
  await registerTwo(noActive)
  const failure = await noActive.dispatcher.call({ domain: 'expertMarket', method: 'listExperts' })
  assert.equal(failure.code, CODES.PROVIDER_REQUIRED)
  assert.ok(failure.message.includes('providers'), '引导错误要说清下一步动作')
  assert.deepEqual(failure.activeProviders, [])
  // 多个活跃库时同样不代选。
  const many = buildRegistry(['demo', 'full'])
  await registerTwo(many)
  assert.equal(
    (await many.dispatcher.call({ domain: 'expertMarket', method: 'listExperts' })).code,
    CODES.PROVIDER_REQUIRED,
  )
  // 唯一活跃库时按它派发（这是「读同一份集合」，不是回落注册顺序）。
  const one = buildRegistry(['full'])
  await registerTwo(one)
  assert.equal(
    (await one.dispatcher.call({ domain: 'skillMarket', method: 'listSkills' })).ok,
    true,
  )
})

test('活跃集里的未注册库给 PROVIDER_UNKNOWN 并列出可选项', async () => {
  const setup = buildRegistry(['ghost'])
  await registerTwo(setup)
  const failure = await setup.dispatcher.call({ domain: 'expertMarket', method: 'listExperts' })
  assert.equal(failure.code, CODES.PROVIDER_UNKNOWN)
  assert.deepEqual(failure.registered, ['demo', 'full'])
})

test('契约外的额外方法不可达', async () => {
  const setup = buildRegistry()
  await registerTwo(setup)
  const failure = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'expertMarket',
    method: 'rankExperts',
  })
  assert.equal(failure.code, CODES.PARAM_INVALID)
  assert.equal(failure.field, 'method')
  assert.deepEqual(failure.allowed, ['listExperts', 'getExpert'])
})

test('provider 抛异常折成信封而不穿透，带 code 的业务失败原码透传', async () => {
  const setup = buildRegistry()
  await registerTwo(setup)
  const thrown = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'memoryMarket',
    method: 'listMemorySkills',
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.code, CODES.PROVIDER_THROWN)
  assert.ok(thrown.message.includes('记忆插件'), thrown.message)
  assert.deepEqual(
    { providerId: thrown.providerId, domain: thrown.domain, method: thrown.method },
    { providerId: 'full', domain: 'memoryMarket', method: 'listMemorySkills' },
  )
  const coded = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'memoryMarket',
    method: 'searchMemory',
    params: { query: 'x' },
  })
  assert.equal(coded.code, CODES.MARKET_AUTH_REQUIRED, '既有码不能被折算成新码，否则诊断会指错地方')
  const domainFailure = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'skillMarket',
    method: 'installSkill',
    params: { skillId: 's' },
  })
  assert.equal(domainFailure.code, CODES.SKILL_SLUG_INVALID)
  assert.equal(domainFailure.skillId, 's')
})

test('入参以单个普通对象传给实现，缺省补空对象', async () => {
  const setup = buildRegistry()
  await registerTwo(setup)
  const passed = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'expertMarket',
    method: 'listExperts',
    params: { query: 'rust' },
  })
  assert.equal(passed.sawQuery, 'rust')
  const defaulted = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'expertMarket',
    method: 'listExperts',
  })
  assert.equal(defaulted.sawQuery, null, 'params 缺省时实现收到空对象，而不是 undefined')
  const badParams = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'expertMarket',
    method: 'listExperts',
    params: 'rust',
  })
  assert.equal(badParams.code, CODES.PARAM_INVALID)
  assert.equal(badParams.field, 'params')
})

test('未知域名与非对象请求在进实现前被拒', async () => {
  const setup = buildRegistry()
  await registerTwo(setup)
  const unknownDomain = await setup.dispatcher.call({
    providerId: 'full',
    domain: 'whatever',
    method: 'listExperts',
  })
  assert.equal(unknownDomain.code, CODES.PARAM_INVALID)
  assert.equal(unknownDomain.field, 'domain')
  assert.deepEqual(unknownDomain.allowed, [
    'expertMarket',
    'skillMarket',
    'memoryMarket',
    'connectorMarket',
    'account',
  ])
  assert.equal((await setup.dispatcher.call('nope')).field, 'request')
  assert.equal(
    (await setup.dispatcher.call({ providerId: 'full', domain: 'expertMarket' })).field,
    'method',
  )
})

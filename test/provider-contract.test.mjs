/**
 * provider 契约校验的用例（任务 2.1 的三条 spec 场景）。
 *
 * 全部离线、纯函数级：只喂声明对象，不碰磁盘也不起 HTTP server。注册表侧的矩阵
 * （重复注册、注销后重注、分区清除、三入口一致）在 2.3 与 2.8 的用例里。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  API_VERSION,
  CAPABILITY_DOMAINS,
  PROVIDER_ID_PATTERN,
  REQUIRED_METHODS,
  declarationOf,
  declaresDomain,
  methodSurface,
  normalizeCapabilities,
  validateContract,
} from '../lib/provider/contract.js'
import { CODES, fail, isFailure, ok, toEnvelope } from '../lib/provider/errors.js'

const fn = async function () {
  return { items: [], total: 0 }
}

/** 五域全声明全实现的完整契约；各用例在它身上做单点删改。 */
function fullContract() {
  return {
    apiVersion: API_VERSION,
    id: 'demo',
    displayName: '示例专家库',
    capabilities: {
      expertMarket: true,
      skillMarket: true,
      memoryMarket: true,
      connectorMarket: true,
      account: true,
    },
    impl: {
      expertMarket: { listExperts: fn, getExpert: fn },
      skillMarket: { listSkills: fn, installSkill: fn },
      memoryMarket: { listMemorySkills: fn, searchMemory: fn },
      connectorMarket: { listConnectors: fn, getConnector: fn, connectorAction: fn },
      account: { listAccounts: fn, accountAction: fn },
    },
  }
}

function expectFailure(candidate, code) {
  const result = validateContract(candidate)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, code)
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.length > 0, 'a failure must explain itself')
  return result
}

test('apiVersion 必须是 1，被拒的 id 不占位', () => {
  assert.equal(API_VERSION, 1)
  assert.equal(
    expectFailure({ ...fullContract(), apiVersion: 2 }, CODES.PROVIDER_API_VERSION).apiVersion,
    2,
  )
  // 字符串版本与缺失同样拒：形状不确定的对象不能进注册表，逐域容忍等于持有未知形状。
  expectFailure({ ...fullContract(), apiVersion: '1' }, CODES.PROVIDER_API_VERSION)
  const noVersion = fullContract()
  delete noVersion.apiVersion
  expectFailure(noVersion, CODES.PROVIDER_API_VERSION)
  assert.equal(validateContract(fullContract()).ok, true, '被拒的 id 必须仍可被完整注册占用')
})

test('缺失的必填字段要在文案里点名', () => {
  for (const field of ['id', 'displayName', 'capabilities']) {
    const candidate = fullContract()
    delete candidate[field]
    const failure = expectFailure(candidate, CODES.PARAM_INVALID)
    assert.equal(failure.field, field)
    assert.ok(failure.message.includes(field), failure.message)
  }
  // 空串与 null 也算缺失：displayName 为空会让页签标题变成空白。
  assert.equal(
    expectFailure({ ...fullContract(), displayName: '' }, CODES.PARAM_INVALID).field,
    'displayName',
  )
  assert.equal(
    expectFailure({ ...fullContract(), capabilities: null }, CODES.PARAM_INVALID).field,
    'capabilities',
  )
})

test('capabilities 归一为五键布尔表，未知能力键一律拒', () => {
  const declared = validateContract({
    apiVersion: API_VERSION,
    id: 'demo',
    displayName: '示例专家库',
    capabilities: { expertMarket: true },
    impl: { expertMarket: { listExperts: fn, getExpert: fn } },
  })
  assert.equal(declared.ok, true)
  assert.equal(declared.record.capabilities.expertMarket, true)
  for (const domain of ['skillMarket', 'memoryMarket', 'connectorMarket', 'account']) {
    assert.equal(declared.record.capabilities[domain], false, domain + ' 必须是显式 false')
  }
  assert.deepEqual(Object.keys(declared.record.capabilities), CAPABILITY_DOMAINS.slice())
  assert.deepEqual(normalizeCapabilities(undefined), {
    expertMarket: false,
    skillMarket: false,
    memoryMarket: false,
    connectorMarket: false,
    account: false,
  })
  // 拼错的 expertmarket 若被静默忽略，等价于那条域没声明：表现是界面少一块，而不是注册失败。
  const typo = expectFailure(
    { ...fullContract(), capabilities: { expertmarket: true } },
    CODES.PARAM_INVALID,
  )
  assert.ok(typo.field.startsWith('capabilities.'), typo.field)
  assert.deepEqual(typo.allowed, CAPABILITY_DOMAINS.slice())
  // 非布尔值同样拒：truthy 的 1 不能当 true 用，界面读的是三态布尔表。
  expectFailure({ ...fullContract(), capabilities: { expertMarket: 1 } }, CODES.PARAM_INVALID)
})

test('providerId 白名单是路径穿越的第一道防线', () => {
  assert.equal(PROVIDER_ID_PATTERN.source, '^[a-z][a-z0-9-]{0,31}$')
  for (const id of [
    '../workbuddy',
    'WorkBuddy',
    'work_buddy',
    'a'.repeat(33),
    '1abc',
    '-abc',
    '',
  ]) {
    const failure = expectFailure({ ...fullContract(), id }, CODES.PROVIDER_INVALID_ID)
    assert.ok(failure.message.includes('providerId'), failure.message)
  }
  for (const id of ['a', 'workbuddy', 'my-lib-2', 'z'.repeat(32)]) {
    assert.equal(validateContract({ ...fullContract(), id }).ok, true, id + ' 必须放行')
  }
  // 非字符串的 id 也走 INVALID_ID：它是路径片段，判定只留一处，不分两条码。
  expectFailure({ ...fullContract(), id: 42 }, CODES.PROVIDER_INVALID_ID)
})

test('声明了的域要求方法，未声明的域一概不要求', () => {
  const onlyExperts = validateContract({
    apiVersion: API_VERSION,
    id: 'demo',
    displayName: '示例专家库',
    capabilities: { expertMarket: true },
    impl: { expertMarket: { listExperts: fn, getExpert: fn } },
  })
  assert.equal(onlyExperts.ok, true, '未声明的域不能反过来成为拒绝理由')

  const missingInstall = fullContract()
  delete missingInstall.impl.skillMarket.installSkill
  const failure = expectFailure(missingInstall, CODES.PROVIDER_IMPL_MISSING)
  assert.equal(failure.providerId, 'demo')
  assert.equal(failure.domain, 'skillMarket')
  assert.equal(failure.method, 'installSkill')
  // spec 要求同时指明 providerId、域与方法名：三者都要出现在文案里，不能只进信封。
  for (const needle of ['demo', 'skillMarket', 'installSkill']) {
    assert.ok(failure.message.includes(needle), failure.message)
  }

  assert.equal(
    expectFailure({ ...fullContract(), impl: undefined }, CODES.PROVIDER_IMPL_MISSING).domains
      .length,
    5,
  )
  const nullDomain = fullContract()
  nullDomain.impl.account = null
  assert.equal(expectFailure(nullDomain, CODES.PROVIDER_IMPL_MISSING).domain, 'account')
  const notAFunction = fullContract()
  notAFunction.impl.connectorMarket.connectorAction = 'async'
  const givenFailure = expectFailure(notAFunction, CODES.PROVIDER_IMPL_MISSING)
  assert.equal(givenFailure.method, 'connectorAction')
  // 文案给的是「收到的类型」而不是收到的值：provider 的实现对象可能带凭据闭包，不打印值本身。
  assert.ok(givenFailure.message.includes('string'), givenFailure.message)
})

test('五域必需方法集合就是 apiVersion 1 的公开 ABI', () => {
  assert.deepEqual(REQUIRED_METHODS.expertMarket, ['listExperts', 'getExpert'])
  assert.deepEqual(REQUIRED_METHODS.skillMarket, ['listSkills', 'installSkill'])
  assert.deepEqual(REQUIRED_METHODS.memoryMarket, ['listMemorySkills', 'searchMemory'])
  assert.deepEqual(REQUIRED_METHODS.connectorMarket, [
    'listConnectors',
    'getConnector',
    'connectorAction',
  ])
  assert.deepEqual(REQUIRED_METHODS.account, ['listAccounts', 'accountAction'])
  assert.deepEqual(Object.keys(REQUIRED_METHODS), CAPABILITY_DOMAINS.slice())
  // 少写一个字母也不能放行：installSkills 这种手误必须被点名成 installSkill 缺失。
  const renamed = fullContract()
  renamed.impl.skillMarket.installSkills = renamed.impl.skillMarket.installSkill
  delete renamed.impl.skillMarket.installSkill
  assert.equal(expectFailure(renamed, CODES.PROVIDER_IMPL_MISSING).method, 'installSkill')
})

test('额外方法可注册，但不进入契约承诺的方法面', () => {
  const withExtra = fullContract()
  withExtra.impl.expertMarket.rankExperts = fn
  const record = validateContract(withExtra).record
  assert.equal(typeof record.impl.expertMarket.rankExperts, 'function', '实现对象要完整保留')
  assert.deepEqual(methodSurface(record).expertMarket, ['listExperts', 'getExpert'])
  assert.equal(Object.prototype.hasOwnProperty.call(methodSurface(record), 'rankExperts'), false)
  assert.equal(Object.keys(methodSurface(record)).length, CAPABILITY_DOMAINS.length)
  assert.equal(declaresDomain(record, 'account'), true)
  assert.equal(declaresDomain(record, 'nonexistentDomain'), false)
  assert.equal(declaresDomain(undefined, 'account'), false)
})

test('declarationOf 投影声明面且不泄漏 impl', () => {
  const record = validateContract(fullContract()).record
  const declaration = declarationOf(record)
  assert.equal(Object.prototype.hasOwnProperty.call(declaration, 'impl'), false)
  assert.deepEqual(Object.keys(declaration).sort(), [
    'apiVersion',
    'capabilities',
    'displayName',
    'id',
  ])
  assert.notEqual(declaration.capabilities, record.capabilities, '投影必须是副本')
  declaration.capabilities.account = false
  assert.equal(record.capabilities.account, true, '改投影不应动到 record')
  const projected = declarationOf(
    validateContract({
      ...fullContract(),
      icon: 'star.svg',
      allowHosts: ['example.test'],
      allowInsecureLoopback: true,
      credentialRef: 'BAZAAR_DEMO_TOKEN',
    }).record,
  )
  assert.equal(projected.icon, 'star.svg')
  assert.deepEqual(projected.allowHosts, ['example.test'])
  assert.equal(projected.allowInsecureLoopback, true)
  assert.equal(projected.credentialRef, 'BAZAAR_DEMO_TOKEN')
  // 可选字段形状不合法要拒而不是静默忽略：allowHosts 写错若被忽略，跑的就是默认白名单。
  // 空数组是合法声明（语义 = 不放行任何 host，注册后调用一律 HOST_DENIED）；
  // 要拒的是形状不合法：给了字符串、或数组里混进非字符串。
  assert.equal(validateContract({ ...fullContract(), allowHosts: [] }).ok, true)
  assert.equal(
    expectFailure({ ...fullContract(), allowHosts: 'example.test' }, CODES.PARAM_INVALID).field,
    'allowHosts',
  )
  expectFailure({ ...fullContract(), allowHosts: ['ok', 42] }, CODES.PARAM_INVALID)
  expectFailure({ ...fullContract(), allowInsecureLoopback: 'yes' }, CODES.PARAM_INVALID)
  expectFailure({ ...fullContract(), credentialRef: '' }, CODES.PARAM_INVALID)
})

test('信封层保留原码，并把抛异常的 provider 记成契约违约', () => {
  const coded = Object.assign(new Error('rate limited'), { code: CODES.MARKET_RATE_LIMITED })
  const context = { providerId: 'demo', domain: 'expertMarket', method: 'listExperts' }
  const kept = toEnvelope(coded, context)
  assert.equal(kept.code, CODES.MARKET_RATE_LIMITED, '既有码不能被折算成新码，否则诊断会指错地方')
  assert.equal(kept.providerId, 'demo')
  assert.equal(kept.domain, 'expertMarket')
  assert.equal(kept.method, 'listExperts')
  const breach = toEnvelope(new Error('upstream exploded'), context)
  assert.equal(breach.code, CODES.PROVIDER_THROWN)
  assert.equal(breach.message, 'upstream exploded')
  assert.deepEqual(toEnvelope(new Error('x')), {
    ok: false,
    code: CODES.PROVIDER_THROWN,
    message: 'x',
  })
  assert.equal(toEnvelope(undefined).code, CODES.PROVIDER_THROWN)
  // 错误自带的 details 一并平铺，方便路由层直接回给前端。
  const withDetails = Object.assign(new Error('bad page'), {
    code: CODES.PARAM_INVALID,
    details: { field: 'page' },
  })
  assert.equal(toEnvelope(withDetails).field, 'page')
  assert.equal(isFailure(kept), true)
  assert.equal(isFailure(ok({ items: [] })), false)
  assert.equal(isFailure({ ok: false }), false, '缺码缺文案的对象不算契约形状的信封')
  assert.deepEqual(ok(), { ok: true })
  assert.deepEqual(ok(['a']), { ok: true, items: ['a'] })
  assert.deepEqual(ok('text'), { ok: true, result: 'text' })
  assert.deepEqual(ok({ items: [], total: 0, source: 'cos' }), {
    ok: true,
    items: [],
    total: 0,
    source: 'cos',
  })
  assert.deepEqual(fail(CODES.PROVIDER_UNKNOWN, 'no such provider', { id: 'x' }), {
    ok: false,
    code: CODES.PROVIDER_UNKNOWN,
    message: 'no such provider',
    id: 'x',
  })
  // 码表纪律：全部码都以 BAZAAR_ 开头，且 1.0.0 移除的两个连接器码不得复活。
  for (const [key, value] of Object.entries(CODES)) {
    assert.ok(value.startsWith('BAZAAR_'), key + ' 必须带 BAZAAR_ 前缀')
    assert.notEqual(value, 'BAZAAR_CONNECTOR_MISSING')
    assert.notEqual(value, 'BAZAAR_CONNECTOR_NO_TOKEN')
  }
})

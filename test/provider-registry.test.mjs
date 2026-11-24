/**
 * 注册表四方法的用例（任务 2.3 的 spec 场景）。
 *
 * 会话分区用注入的假写入口验证（真 saveState 的分组形状在组 3.4 落地，届时由 lib/index.js
 * 接线）。这里要证的是注册表自己的时序与原子性：清除与改表在同一条串行链上、清除失败则
 * 整笔作废。对着真文件的分区断言放在 3.4 的矩阵里，两处口径不同不重复计。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'

const fn = async function () {
  return {}
}

function contractOf(id, capabilities = undefined) {
  const caps = capabilities ?? { expertMarket: true }
  const impl = { expertMarket: { listExperts: fn, getExpert: fn } }
  if (caps.skillMarket === true) impl.skillMarket = { listSkills: fn, installSkill: fn }
  return { apiVersion: 1, id: id, displayName: id + ' 专家库', capabilities: caps, impl: impl }
}

/** 假会话写入口：记录每次清除的 providerId，可控失败。 */
function fakeSession(failFor = undefined) {
  const calls = []
  return {
    calls: calls,
    async clearProvider(providerId) {
      calls.push(providerId)
      if (failFor !== undefined && failFor.includes(providerId)) {
        return { ok: false, code: CODES.PARAM_INVALID, message: '会话状态文件不可写' }
      }
      return { ok: true, providerId: providerId }
    },
  }
}

function wired(failFor = undefined) {
  const session = fakeSession(failFor)
  const events = []
  const registry = createProviderRegistry({
    session: session,
    onChange: (event) => events.push(event),
  })
  return { registry: registry, session: session, events: events }
}

test('同 id 重复注册被拒且不覆盖既有条目', async () => {
  const wiredSet = wired()
  const first = await wiredSet.registry.register(contractOf('workbuddy'))
  assert.equal(first.ok, true, JSON.stringify(first))
  const replacement = contractOf('workbuddy')
  replacement.displayName = '第二次注册的名字'
  const second = await wiredSet.registry.register(replacement)
  assert.equal(second.ok, false)
  assert.equal(second.code, CODES.PROVIDER_DUPLICATE)
  assert.ok(second.message.includes('workbuddy'), second.message)
  // 原有记录保持不变：热更新重复注册不能把正在被会话引用的 impl 换掉。
  const observed = wiredSet.registry.get('workbuddy')
  assert.equal(observed.ok, true)
  assert.equal(observed.provider.displayName, 'workbuddy 专家库')
  assert.equal(wiredSet.registry.list().length, 1)
})

test('未接线会话写入口时拒绝注销，而不是留下悬空分区', async () => {
  const registry = createProviderRegistry()
  await registry.register(contractOf('demo'))
  const failure = await registry.unregister('demo')
  assert.equal(failure.ok, false)
  assert.equal(failure.code, CODES.PARAM_INVALID)
  assert.equal(failure.field, 'session')
  assert.equal(registry.get('demo').ok, true, '被拒的注销不该动到集合')
})

test('注销在同一临界区内清除会话分区，且只清该库', async () => {
  const wiredSet = wired()
  await wiredSet.registry.register(contractOf('workbuddy'))
  await wiredSet.registry.register(contractOf('demo'))
  const result = await wiredSet.registry.unregister('demo')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(wiredSet.session.calls, ['demo'], '只允许清除被注销的那一库')
  assert.equal(wiredSet.registry.get('demo').ok, false)
  assert.equal(wiredSet.registry.get('workbuddy').ok, true)
})

test('会话清除失败时整笔作废，provider 仍在集合里', async () => {
  const wiredSet = wired(['demo'])
  await wiredSet.registry.register(contractOf('demo'))
  const failure = await wiredSet.registry.unregister('demo')
  assert.equal(failure.ok, false)
  assert.ok(failure.message.includes('不可写'), failure.message)
  assert.deepEqual(wiredSet.session.calls, ['demo'])
  // 表里保留它，才能避免出现「已注销但会话仍指向它」，那会让面板继续向该库派发请求。
  assert.equal(wiredSet.registry.get('demo').ok, true)
  assert.equal(wiredSet.registry.list().length, 1)
})

test('注销后同名重新注册按全新注册放行', async () => {
  const wiredSet = wired()
  await wiredSet.registry.register(contractOf('demo'))
  await wiredSet.registry.unregister('demo')
  const again = await wiredSet.registry.register(
    contractOf('demo', { expertMarket: true, skillMarket: true }),
  )
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(wiredSet.registry.list().length, 1)
  assert.equal(wiredSet.registry.list()[0].capabilities.skillMarket, true)
})

test('list / get / getRecord / ids 对同一集合观察一致', async () => {
  const wiredSet = wired()
  await wiredSet.registry.register(contractOf('alpha'))
  await wiredSet.registry.register(contractOf('beta'))
  await wiredSet.registry.unregister('alpha')
  assert.deepEqual(
    wiredSet.registry.list().map((p) => p.id),
    ['beta'],
  )
  assert.deepEqual(wiredSet.registry.ids(), ['beta'])
  assert.equal(wiredSet.registry.get('alpha').code, CODES.PROVIDER_UNKNOWN)
  assert.equal(wiredSet.registry.get('beta').ok, true)
  // get/list 只给声明面投影：impl 是上游闭包与凭据链，不得出现在对外结果里。
  assert.equal(
    Object.prototype.hasOwnProperty.call(wiredSet.registry.get('beta').provider, 'impl'),
    false,
  )
  assert.equal(Object.prototype.hasOwnProperty.call(wiredSet.registry.list()[0], 'impl'), false)
  assert.equal(
    JSON.stringify(wiredSet.registry.list()).includes('listExperts'),
    false,
    '列举结果必须可安全序列化',
  )
  // 内部口拿得到 impl，供编排层按域派发。
  assert.equal(typeof wiredSet.registry.getRecord('beta').impl.expertMarket.listExperts, 'function')
  assert.equal(wiredSet.registry.getRecord('alpha'), undefined)
})

test('注册失败不产生半登记状态', async () => {
  const wiredSet = wired()
  const bad = await wiredSet.registry.register({ ...contractOf('demo'), apiVersion: 2 })
  assert.equal(bad.code, CODES.PROVIDER_API_VERSION)
  assert.equal(wiredSet.registry.get('demo').code, CODES.PROVIDER_UNKNOWN)
  assert.deepEqual(wiredSet.registry.ids(), [])
  assert.deepEqual(wiredSet.events, [], '失败的注册不该通知界面重算页签')
  const missingImpl = await wiredSet.registry.register({ ...contractOf('demo'), impl: {} })
  assert.equal(missingImpl.code, CODES.PROVIDER_IMPL_MISSING)
  assert.deepEqual(wiredSet.registry.ids(), [])
})

test('变更通知覆盖注册与注销，且监听器抛错不改变注册结果', async () => {
  const events = []
  const registry = createProviderRegistry({
    session: fakeSession(),
    onChange(event) {
      events.push(event)
      throw new Error('监听器内部炸了')
    },
  })
  const registered = await registry.register(contractOf('demo'))
  assert.equal(registered.ok, true, '通知失败不回滚已完成的登记')
  const unregistered = await registry.unregister('demo')
  assert.equal(unregistered.ok, true)
  assert.deepEqual(
    events.map((e) => e.type),
    ['registered', 'unregistered'],
  )
  assert.equal(events[0].provider.id, 'demo')
  assert.equal(events[1].providerId, 'demo')
})

test('并发写请求串行执行，交错不会留下半状态', async () => {
  const wiredSet = wired()
  const batch = await Promise.all([
    wiredSet.registry.register(contractOf('a1')),
    wiredSet.registry.register(contractOf('a2')),
    wiredSet.registry.unregister('a1'),
    wiredSet.registry.register(contractOf('a1')),
  ])
  assert.equal(batch[0].ok, true)
  assert.equal(batch[1].ok, true)
  assert.equal(batch[2].ok, true)
  // 第 4 笔排在第 3 笔之后：同一 id 的「注销再注册」必须成立，而不是撞成 DUPLICATE。
  assert.equal(batch[3].ok, true, JSON.stringify(batch[3]))
  assert.deepEqual(wiredSet.registry.ids(), ['a2', 'a1'])
  assert.deepEqual(wiredSet.session.calls, ['a1'])
})

test('declares 区分未注册与已注册未声明', async () => {
  const wiredSet = wired()
  await wiredSet.registry.register(contractOf('demo'))
  assert.equal(wiredSet.registry.declares('demo', 'expertMarket').declared, true)
  assert.equal(wiredSet.registry.declares('demo', 'skillMarket').declared, false)
  assert.equal(wiredSet.registry.declares('ghost', 'expertMarket').code, CODES.PROVIDER_UNKNOWN)
})

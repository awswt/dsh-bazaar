/**
 * 目录与凭据隔离的用例（任务 2.5 的 spec 场景）。
 *
 * 这里证的是「推导口」：路径与凭据名恒由 providerId 算出来，注册表不外泄他人的名字或路径，
 * lib/auth.js 的取值来源也走同一处。真正落盘的目录搬迁（accounts / connectors.json / cache）
 * 分别由 3.4、4.1、4.5 接线——它们的断言对着真文件下，本文件只对着推导口下，两处口径不重复。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { CODES } from '../lib/provider/errors.js'
import {
  credentialNameFor,
  ownedProviderIdOf,
  providerDir,
  providerLayout,
  resolveCredentialName,
  safeJoin,
} from '../lib/provider/paths.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { resolveAuth, describeAuth, AuthError } from '../lib/auth.js'

const BASE = path.resolve('/dsh', 'bazaar')

test('凭据名恒由 providerId 推导，连字符转下划线并大写', () => {
  assert.equal(credentialNameFor('workbuddy').name, 'BAZAAR_WORKBUDDY_TOKEN')
  assert.equal(credentialNameFor('my-lib-2').name, 'BAZAAR_MY_LIB_2_TOKEN')
  assert.equal(credentialNameFor('a').name, 'BAZAAR_A_TOKEN')
  // 非法 id 不给凭据名：否则一个越界 id 会得到一个看起来合法的凭据。
  assert.equal(credentialNameFor('../workbuddy').code, CODES.PROVIDER_INVALID_ID)
  assert.equal(credentialNameFor('WorkBuddy').code, CODES.PROVIDER_INVALID_ID)
})

test('四个落点恒由 providerId 推导，调用方无法指定目录', () => {
  const layout = providerLayout(BASE, 'workbuddy')
  assert.equal(layout.ok, true)
  const root = path.join(BASE, 'providers', 'workbuddy')
  assert.deepEqual(
    {
      accounts: layout.accounts,
      vault: layout.vault,
      cache: layout.cache,
      connectors: layout.connectorsFile,
    },
    {
      accounts: path.join(root, 'accounts'),
      vault: path.join(root, 'vault'),
      cache: path.join(root, 'cache'),
      connectors: path.join(root, 'connectors.json'),
    },
  )
  // 第二家库完全落在自己的子树里，两处推导不可能撞车。
  const other = providerLayout(BASE, 'other-lib')
  assert.equal(other.root, path.join(BASE, 'providers', 'other-lib'))
  for (const value of [other.accounts, other.vault, other.cache, other.connectorsFile]) {
    assert.ok(value.startsWith(other.root), value)
    assert.equal(value.includes('workbuddy'), false, '另一家库的路径里不该出现 workbuddy')
  }
})

test('以 A 的身份读 B 的凭据被拒绝，且 A 自己的凭据不受影响', () => {
  const known = ['workbuddy', 'beta']
  const cross = resolveCredentialName({
    providerId: 'workbuddy',
    credentialRef: 'BAZAAR_BETA_TOKEN',
    knownProviderIds: known,
  })
  assert.equal(cross.ok, false)
  assert.equal(cross.code, CODES.PARAM_INVALID)
  assert.equal(cross.ownerProviderId, 'beta')
  assert.ok(cross.message.includes('workbuddy') && cross.message.includes('beta'), cross.message)
  assert.equal(
    resolveCredentialName({ providerId: 'workbuddy', knownProviderIds: known }).name,
    'BAZAAR_WORKBUDDY_TOKEN',
  )
  // 自定义名允许：只要它不是别人的推导名，就是该 provider 自己的命名空间。
  assert.equal(
    resolveCredentialName({
      providerId: 'workbuddy',
      credentialRef: 'BAZAAR_CUSTOM_TOKEN',
      knownProviderIds: known,
    }).name,
    'BAZAAR_CUSTOM_TOKEN',
  )
  assert.equal(ownedProviderIdOf('BAZAAR_CUSTOM_TOKEN', known), undefined)
  // 不静默回落：credentialRef 形状非法要报错，否则「我明明配了 credentialRef」查不出来。
  assert.equal(
    resolveCredentialName({ providerId: 'workbuddy', credentialRef: 'beta-secret' }).code,
    CODES.PARAM_INVALID,
  )
})

test('lib/auth.js 的凭据取值来源改走推导口', async () => {
  const asked = []
  const sources = {
    credentials: {
      async resolve(name) {
        asked.push(name)
        // 只有推导出来的名字才对得上号：fixture 故意不认识别人的凭据名，跨库读取会自然落空。
        return name === 'BAZAAR_MY_LIB_2_TOKEN' ? { value: 'tok' } : undefined
      },
      async describe(name) {
        asked.push(name)
        return { configured: false, source: 'none', writable: false, name: name }
      },
    },
  }
  // 不给 credentialRef，只给 providerId：名字必须被推导出来，而不是取某个字面量默认值。
  const auth = await resolveAuth({ mode: 'bearer', providerId: 'my-lib-2' }, sources)
  assert.deepEqual(asked, ['BAZAAR_MY_LIB_2_TOKEN'])
  assert.equal(auth.header, 'Authorization')
  await describeAuth({ mode: 'bearer', providerId: 'my-lib-2' }, sources)
  assert.deepEqual(asked, ['BAZAAR_MY_LIB_2_TOKEN', 'BAZAAR_MY_LIB_2_TOKEN'])

  // 缺凭据仍是原来的 AUTH_MISSING，且信息里出现的是推导名（供用户去配对的凭据）。
  await assert.rejects(
    () => resolveAuth({ mode: 'bearer', providerId: 'ghost' }, sources),
    (error) =>
      error instanceof AuthError &&
      error.code === 'BAZAAR_AUTH_MISSING' &&
      error.message.includes('BAZAAR_GHOST_TOKEN'),
  )

  // 跨库取凭据在 auth 层同样是硬失败，而不是回落到自己的名字。
  await assert.rejects(
    () =>
      resolveAuth(
        {
          mode: 'bearer',
          providerId: 'workbuddy',
          credentialRef: 'BAZAAR_BETA_TOKEN',
          knownProviderIds: ['workbuddy', 'beta'],
        },
        sources,
      ),
    (error) =>
      error instanceof AuthError &&
      error.code === CODES.PARAM_INVALID &&
      error.message.includes('beta'),
  )
})

test('注册表不向任何 provider 传递他人的名字或路径', async () => {
  const registry = createProviderRegistry({
    session: {
      async clearProvider(id) {
        return { ok: true, providerId: id }
      },
    },
  })
  const fn = async function () {
    return {}
  }
  const implOf = function (seen) {
    return {
      apiVersion: 1,
      id: seen,
      displayName: seen + ' 库',
      capabilities: { expertMarket: true },
      impl: {
        expertMarket: {
          async listExperts() {
            return seen
          },
          getExpert: fn,
        },
      },
    }
  }
  await registry.register(implOf('workbuddy'))
  await registry.register(implOf('beta'))
  const listed = JSON.stringify(registry.list())
  // 列举/查询结果里只有各自的声明面：既没有别人的 id，也没有别人的凭据名或目录。
  for (const needle of ['accounts', 'vault', 'cache', 'BAZAAR_']) {
    assert.equal(listed.includes(needle), false, '列举结果不该出现路径或凭据片段：' + needle)
  }
  assert.equal(listed.includes('impl'), false)
  // 每个 provider 的 impl 只能看到自己的 id：派发时传的是各自的 record，不共享上下文。
  assert.equal(await registry.getRecord('workbuddy').impl.expertMarket.listExperts({}), 'workbuddy')
  assert.equal(await registry.getRecord('beta').impl.expertMarket.listExperts({}), 'beta')
  // 越界取路径仍然被拦：beta 拼不出 workbuddy 的目录。
  assert.equal(safeJoin(BASE, 'beta', '..', 'workbuddy', 'vault').ok, false)
  assert.equal(providerDir(BASE, 'workbuddy').ok, true)
})

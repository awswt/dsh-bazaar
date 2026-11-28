import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { WorkBuddyConnector } from '../lib/connector.js'
import { createAccountService } from '../lib/wb-accounts.js'
import { createAccountStore } from '../lib/wb-vault.js'
import { tempDir } from './temp.mjs'

const API = '/v2/plugin'
const HOUR = 3_600_000

/** 假 fetch：分派三个端点，记录调用。返回真实 Response 以走到 `.text()`。 */
function makeFetch(handler) {
  const impl = async (url, init = {}) => {
    const answer = await handler({
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    })
    if (answer instanceof Error) throw answer
    const payload =
      answer?.body === undefined
        ? '{}'
        : typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body)
    return new Response(payload, {
      status: answer?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return impl
}

/** 一个已经“网页确认完成”的上游：state → token → account。 */
function signedInFetch(account = { uid: 'uid-1', nickname: '一号' }) {
  return makeFetch((record) => {
    if (record.url.includes('/auth/state'))
      return {
        body: {
          code: 0,
          data: { state: 'state-1', authUrl: 'https://www.codebuddy.cn/login?state=state-1' },
        },
      }
    if (record.url.includes('/auth/token')) {
      return {
        body: {
          code: 0,
          data: {
            accessToken: 'tok-new',
            refreshToken: 'ref-new',
            expiresIn: 3600,
            domain: 'www.codebuddy.cn',
          },
        },
      }
    }
    if (record.url.endsWith(`${API}/account`)) return { body: { code: 0, data: account } }
    return { status: 404, body: {} }
  })
}

async function makeService(options = {}) {
  const home = options.home ?? (await tempDir())
  const accountsDir =
    options.accountsDir ?? path.join(home, 'bazaar', 'providers', 'workbuddy', 'accounts')
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir,
    fetchImpl: options.refreshFetchImpl,
    now: options.now,
  })
  const service = createAccountService({
    connector,
    fetchImpl: options.fetchImpl,
    now: options.now,
  })
  return { home, accountsDir, connector, service }
}

test('poll stores the single credential in this plugin own store', async () => {
  const { service, connector, accountsDir } = await makeService({
    fetchImpl: signedInFetch(),
    refreshFetchImpl: makeFetch(() => ({ body: { code: 0, data: {} } })),
  })
  const started = await service.start()
  assert.match(started.loginId, /^bz_/)
  assert.equal(started.region, 'cn')

  const outcome = await service.poll(started.loginId)
  assert.equal(outcome.done, true)
  assert.equal(outcome.account.nickname, '一号')
  assert.equal(outcome.account.region, 'cn')

  const names = await fs.readdir(path.join(accountsDir, 'cn'))
  assert.equal(names.filter((name) => name.endsWith('.json')).length, 1)
  const list = await connector.ownAccounts()
  assert.equal(list.length, 1)
  assert.equal(list[0].hasRefreshToken, true)
})

test('poll reports a storage failure instead of pretending the sign-in was saved', async () => {
  const home = await tempDir()
  const blocked = path.join(home, 'blocked')
  await fs.writeFile(blocked, 'not a directory')
  const { service } = await makeService({ home, accountsDir: blocked, fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  const outcome = await service.poll(started.loginId)
  assert.equal(outcome.done, true)
  assert.match(outcome.error, /signed in, but the account could not be stored/)
})

test('poll forwards the region so a cross-tab poll cannot kill the sign-in', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  const wrong = await service.poll(started.loginId, { region: 'global' })
  assert.equal(wrong.done, true)
  assert.match(wrong.error, /another region tab/)
  assert.equal(service.pending().length, 1)
  const right = await service.poll(started.loginId, { region: 'cn' })
  assert.equal(right.done, true)
  assert.equal(right.account.uid, 'uid-1')
})

test('list summary isolates completely from any external workbuddy-vault directory', async () => {
  const home = await tempDir()
  const externalVault = path.join(home, 'workbuddy-vault')
  await fs.mkdir(path.join(externalVault, 'cn'), { recursive: true })
  await fs.writeFile(
    path.join(externalVault, 'cn', 'legacy.json'),
    JSON.stringify({
      accountId: 'legacy-1',
      account: { uid: 'uid-legacy', nickname: '外部旧账号' },
      auth: {
        accessToken: 'tok-legacy',
        refreshToken: 'ref-legacy',
        expiresAt: Math.floor((Date.now() + HOUR) / 1000),
        domain: 'www.workbuddy.cn',
      },
    }),
  )
  const { service } = await makeService({ home, fetchImpl: signedInFetch() })
  // 未在本插件登录前：即使外部目录有文件，list 也必须为 0
  const before = await service.list()
  assert.equal(before.summary.count, 0)
  assert.equal(before.all.length, 0)

  const started = await service.start()
  await service.poll(started.loginId)

  const view = await service.list()
  assert.equal(view.own.length, 1)
  assert.equal(view.all.length, 1)
  assert.equal(view.summary.ownCount, 1)
  assert.equal(view.summary.count, 1)
  assert.equal(view.summary.usableCount, 1)
  assert.equal(view.summary.dir.endsWith(path.join('providers', 'workbuddy', 'accounts')), true)
  assert.equal('vaultCount' in view.summary, false)
  assert.equal('source' in view.summary, false)
  assert.equal('importLegacy' in service, false)
})

test('list survives having no account source at all', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  const view = await service.list()
  assert.deepEqual(view.own, [])
  assert.deepEqual(view.all, [])
  assert.equal(view.summary.count, 0)
  assert.equal('source' in view.summary, false)
})

test('refresh only touches this plugin own store and supports default current credential', async () => {
  const refreshFetch = makeFetch(() => ({
    body: {
      code: 0,
      data: { accessToken: 'tok-rotated', refreshToken: 'ref-rotated', expiresIn: 7200 },
    },
  }))
  const { service, connector } = await makeService({
    fetchImpl: signedInFetch(),
    refreshFetchImpl: refreshFetch,
  })
  const started = await service.start()
  const signed = await service.poll(started.loginId)

  // 不传 accountId 时默认刷新当前唯一凭证
  const refreshed = await service.refresh()
  assert.equal(refreshed.hasToken, true)
  const raw = await connector.store.raw(signed.account.accountId)
  assert.equal(raw.auth.accessToken, 'tok-rotated')

  await assert.rejects(
    () => service.refresh('legacy-1'),
    /account not found in this plugin's own store/,
  )
})

test('refresh reports an upstream failure instead of returning a stale token', async () => {
  const refreshFetch = makeFetch(() => ({
    status: 401,
    body: { code: 12153, msg: 'token format error' },
  }))
  const { service } = await makeService({
    fetchImpl: signedInFetch(),
    refreshFetchImpl: refreshFetch,
  })
  const started = await service.start('cn')
  const signed = await service.poll(started.loginId)
  await assert.rejects(() => service.refresh(signed.account.accountId), /refresh failed \(12153\)/)
})

test('refresh and remove reject explicit empty string accountId', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  await assert.rejects(() => service.refresh(''), /accountId is required/)
  await assert.rejects(() => service.remove(''), /accountId is required/)
})

test('remove clears the active credential', async () => {
  const { service, connector } = await makeService({ fetchImpl: signedInFetch() })
  const first = await service.poll((await service.start()).loginId)
  const removed = await service.remove(first.account.accountId)
  assert.equal(removed.removed, true)
  assert.deepEqual(await connector.ownAccounts(), [])
  assert.equal((await service.remove(first.account.accountId)).removed, false)
})

test('the service does not leak a token through list() or pending()', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  await service.poll((await service.start('cn')).loginId)
  const view = await service.list()
  const text = JSON.stringify({
    own: view.own,
    all: view.all,
    summary: view.summary,
    pending: view.pending,
  })
  assert.equal(text.includes('tok-new'), false)
  assert.equal(text.includes('ref-new'), false)
  assert.equal(text.includes('state-1'), false)
})

test('cancel drops a pending sign-in without storing anything', async () => {
  const { service, connector } = await makeService({ fetchImpl: signedInFetch() })
  const started = await service.start()
  assert.equal(service.cancel(started.loginId), true)
  assert.deepEqual(service.pending(), [])
  assert.deepEqual(await connector.ownAccounts(), [])
  assert.equal(service.cancel(started.loginId), false)
})

test('start defaults to cn when region is omitted or empty for zero-form web auth', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  for (const omitted of [undefined, null, '']) {
    const started = await service.start(omitted)
    assert.equal(started.region, 'cn')
    assert.match(started.verificationUri, /^https:\/\/www\.codebuddy\.cn\/login/)
  }
})

test('start echoes any invalid explicit region with BAZAAR_PARAM_INVALID', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  for (const bad of ['mars', 'CN', ' cn ']) {
    const rejected = await service.start(bad)
    assert.equal(rejected.code, 'BAZAAR_PARAM_INVALID', bad)
    assert.equal(rejected.field, 'region')
    assert.deepEqual(rejected.admitted, ['cn', 'global'])
    assert.ok(rejected.error.includes(bad), 'error must quote the received value: ' + rejected.error)
    assert.equal(rejected.region, undefined)
  }
})

test('start surfaces an upstream failure as a value, not an exception', async () => {
  const fetchImpl = makeFetch(() => new Error('ECONNREFUSED'))
  const { service } = await makeService({ fetchImpl })
  const started = await service.start()
  assert.match(started.error, /could not reach/)
  assert.deepEqual(service.pending(), [])
})

test('createAccountService requires a connector', () => {
  assert.throws(() => createAccountService({}), /requires a connector/)
})

test('the store behind the service can be swapped for a plain object in tests', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const connector = {
    store,
    async saveAccount(account) {
      return store.save(account)
    },
    async ownAccounts() {
      return store.all()
    },
    async accounts() {
      return (await store.all()).map((item) => ({ ...item, source: 'own' }))
    },
    async status() {
      return { source: 'own', own: { dir } }
    },
    async refreshAccount() {
      return { refreshed: true }
    },
  }
  const service = createAccountService({ connector, fetchImpl: signedInFetch() })
  const started = await service.start()
  const outcome = await service.poll(started.loginId)
  assert.equal(outcome.done, true)
  assert.equal((await service.list()).own.length, 1)
  assert.deepEqual(await service.refresh(outcome.account.accountId), { refreshed: true })
})

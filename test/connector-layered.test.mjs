import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { WorkBuddyConnector } from '../lib/connector.js'
import { tempDir } from './temp.mjs'

const HOUR = 3_600_000

function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const record = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} }
    calls.push(record)
    const answer = await handler(record)
    if (answer instanceof Error) throw answer
    const payload =
      typeof answer?.body === 'string' ? answer.body : JSON.stringify(answer?.body ?? {})
    return new Response(payload, {
      status: answer?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

/** 造一份外部插件风格的 workbuddy-vault 文件，用于反向验证本插件绝不触碰或读取它。 */
async function writeExternalVault(vaultDir, region, name, overrides = {}) {
  const dir = path.join(vaultDir, region)
  await fs.mkdir(dir, { recursive: true })
  const record = {
    version: 1,
    accountId: overrides.accountId ?? `${region}-external`,
    account: {
      uid: overrides.uid ?? `uid-${region}`,
      nickname: overrides.nickname ?? `${region} 外部账号`,
      uin: '123',
    },
    auth: {
      accessToken: overrides.accessToken ?? `tok-external-${region}`,
      refreshToken: overrides.refreshToken ?? 'ref-external',
      expiresAt: overrides.expiresAt ?? Math.floor((Date.now() + HOUR) / 1000),
      domain: overrides.domain ?? (region === 'global' ? 'www.workbuddy.ai' : 'www.workbuddy.cn'),
    },
  }
  const file = path.join(dir, name)
  await fs.writeFile(file, JSON.stringify(record))
  return { file, record }
}

test('反向安全隔离：即使 ~/.dsh/workbuddy-vault 存在有效凭证或兄弟插件已装，自有目录为空时绝不读取外部凭证', async () => {
  const home = await tempDir()
  const externalVault = path.join(home, 'workbuddy-vault')
  await writeExternalVault(externalVault, 'cn', 'old.json', { accessToken: 'tok-ext-cn' })
  await writeExternalVault(externalVault, 'global', 'g.json', { accessToken: 'tok-ext-global' })
  await fs.writeFile(
    path.join(externalVault, 'flat.json'),
    JSON.stringify({
      accountId: 'flat-1',
      account: { uid: 'uid-flat', nickname: '扁平外部' },
      auth: { accessToken: 'tok-flat', expiresAt: Math.floor((Date.now() + HOUR) / 1000) },
    }),
  )
  const siblingPlugin = path.join(
    home,
    'profiles',
    'desktop',
    'node_modules',
    'dsh-connect-workbuddy',
  )
  await fs.mkdir(siblingPlugin, { recursive: true })
  await fs.writeFile(
    path.join(siblingPlugin, 'package.json'),
    JSON.stringify({ name: 'dsh-connect-workbuddy', version: '9.9.9' }),
  )

  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'bazaar', 'providers', 'workbuddy', 'accounts'),
  })

  // 反向控制：外部目录确实有文件，但本插件必须 100% 视而不见
  assert.equal((await fs.readdir(path.join(externalVault, 'cn'))).length, 1)
  assert.equal(await connector.resolveToken({}), undefined)
  assert.equal(await connector.resolveFreshToken({}), undefined)
  assert.deepEqual(await connector.accounts(), [])
  assert.deepEqual(await connector.ownAccounts(), [])

  const status = await connector.status()
  assert.equal(status.tokenAvailable, false)
  assert.equal(status.accountCount, 0)
  assert.equal(status.usableAccountCount, 0)
  assert.equal(status.source, 'none')
  assert.equal('vaultPresent' in status, false)
  assert.equal('vaultDir' in status, false)
  assert.equal('installed' in status, false)
  assert.equal('connector' in status, false)
  assert.equal('detectInstalled' in connector, false)
})

test('自有单凭证存储：保存后 source 为 own，再次登录自动覆盖旧凭证', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
  })
  await connector.saveAccount({
    uid: 'uid-1',
    nickname: '第一张',
    region: 'cn',
    accessToken: 'tok-first',
    refreshToken: 'ref-first',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
  })
  const firstHit = await connector.resolveToken({})
  assert.equal(firstHit.token, 'tok-first')
  assert.equal(firstHit.source, 'own')

  await connector.saveAccount({
    uid: 'uid-2',
    nickname: '第二张',
    region: 'cn',
    accessToken: 'tok-second',
    refreshToken: 'ref-second',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
  })
  const rows = await connector.accounts()
  assert.equal(rows.length, 1, '单凭证模型下始终只保留最新 1 份凭证')
  assert.equal(rows[0].source, 'own')
  assert.equal(rows[0].hasRefreshToken, true)
  const secondHit = await connector.resolveToken({})
  assert.equal(secondHit.token, 'tok-second')
})

test('resolveToken respects explicit region filter and returns undefined for unmatched region', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({ dshHome: home, accountsDir: path.join(home, 'own') })
  await connector.saveAccount({
    uid: 'uid-cn',
    accessToken: 'tok-cn',
    refreshToken: 'ref-cn',
    region: 'cn',
    expiresAtMs: Date.now() + HOUR,
  })
  assert.equal((await connector.resolveToken({ region: 'cn' })).token, 'tok-cn')
  assert.equal(await connector.resolveToken({ region: 'global' }), undefined)
  assert.equal(await connector.resolveToken({ region: 'nope' }), undefined)
})

test('resolveFreshToken refreshes an own account that is about to expire', async () => {
  const home = await tempDir()
  const refreshFetch = makeFetch(() => ({
    body: {
      code: 0,
      data: { accessToken: 'tok-rotated', refreshToken: 'ref-rotated', expiresIn: 3600 },
    },
  }))
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch,
    refreshSkewMs: 120_000,
  })
  const saved = await connector.saveAccount({
    uid: 'uid-own',
    accessToken: 'tok-stale',
    refreshToken: 'ref-own',
    region: 'cn',
    expiresAtMs: Date.now() + 30_000,
    domain: 'www.codebuddy.cn',
  })

  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.refreshed, true)
  assert.equal(hit.token, 'tok-rotated')
  const raw = await connector.store.raw(saved.accountId)
  assert.equal(raw.auth.accessToken, 'tok-rotated')
  assert.equal(raw.auth.refreshToken, 'ref-rotated')
})

test('resolveFreshToken leaves a healthy token alone', async () => {
  const refreshFetch = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'never' } } }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch,
  })
  await connector.saveAccount({
    uid: 'uid-own',
    accessToken: 'tok-good',
    refreshToken: 'ref',
    region: 'cn',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
  })
  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.refreshed, false)
  assert.equal(hit.token, 'tok-good')
  assert.equal(refreshFetch.calls.length, 0)
})

test('resolveFreshToken keeps a still-valid token when the refresh fails', async () => {
  const refreshFetch = makeFetch(() => ({
    status: 401,
    body: { code: 12153, msg: 'token format error' },
  }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch,
    refreshSkewMs: 120_000,
  })
  await connector.saveAccount({
    uid: 'uid-own',
    accessToken: 'tok-alive',
    refreshToken: 'ref',
    region: 'cn',
    expiresAtMs: Date.now() + 60_000,
    domain: 'www.codebuddy.cn',
  })
  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.refreshed, false)
  assert.equal(hit.token, 'tok-alive')
  assert.match(hit.refreshError, /refresh failed \(12153\)/)
})

test('resolveFreshToken throws when the token is dead and cannot be refreshed', async () => {
  const refreshFetch = makeFetch(() => ({ status: 401, body: { code: 12153, msg: 'nope' } }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch,
    refreshSkewMs: 120_000,
  })
  await connector.saveAccount({
    uid: 'uid-own',
    accessToken: 'tok-dead',
    refreshToken: 'ref',
    region: 'cn',
    expiresAtMs: Date.now() - 60_000,
    refreshExpiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
  })
  await assert.rejects(() => connector.resolveFreshToken({}), /市场认证凭证已过期且自动续期失败/)
})

test('refreshAccount rotates an own credential on demand and rejects an unknown id', async () => {
  const refreshFetch = makeFetch(() => ({
    body: {
      code: 0,
      data: { accessToken: 'tok-manual', refreshToken: 'ref-manual', expiresIn: 7200 },
    },
  }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch,
  })
  const saved = await connector.saveAccount({
    uid: 'uid-own',
    accessToken: 'tok-start',
    refreshToken: 'ref-start',
    region: 'cn',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
  })
  const rotated = await connector.refreshAccount(saved.accountId)
  assert.equal(rotated.hasToken, true)
  assert.equal((await connector.store.raw(saved.accountId)).auth.accessToken, 'tok-manual')

  await assert.rejects(() => connector.refreshAccount('nope'), /account not found: nope/)
})

test('refreshAccount refuses an account that has no refresh token', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home,
    accountsDir: path.join(home, 'own'),
    fetchImpl: makeFetch(() => ({ body: {} })),
  })
  const saved = await connector.saveAccount({
    uid: 'uid-own',
    accessToken: 'tok',
    refreshToken: '',
    region: 'cn',
    expiresAtMs: Date.now() + HOUR,
  })
  await assert.rejects(() => connector.refreshAccount(saved.accountId), /不含 refresh token/)
})

test('status reports own single credential without leaking any secret', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({ dshHome: home, accountsDir: path.join(home, 'own') })
  await connector.saveAccount({
    uid: 'uid-own',
    nickname: '自己的',
    accessToken: 'tok-own-secret-1234',
    refreshToken: 'ref-own-secret-5678',
    region: 'cn',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
  })

  const status = await connector.status()
  assert.equal(status.accountCount, 1)
  assert.equal(status.usableAccountCount, 1)
  assert.equal(status.tokenAvailable, true)
  assert.equal(status.source, 'own')
  assert.equal(status.own.count, 1)
  assert.equal(status.own.usableCount, 1)
  assert.equal(status.accounts.length, 1)
  assert.equal(JSON.stringify(status).includes('tok-own-secret-1234'), false)
  assert.equal(JSON.stringify(status).includes('ref-own-secret-5678'), false)
})

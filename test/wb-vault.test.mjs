import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  accountIdOf,
  createAccountStore,
  describeAccount,
  normalizeExpiry,
} from '../lib/wb-vault.js'

import { tempDir } from './temp.mjs'

const HOUR = 3_600_000

function credential(overrides = {}) {
  return {
    uid: 'uid-demo',
    nickname: '不等时间',
    region: 'cn',
    accessToken: 'tok-demo',
    refreshToken: 'ref-demo',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
    ...overrides,
  }
}

test('normalizeExpiry treats values below 1e12 as seconds', () => {
  assert.equal(normalizeExpiry(1_700_000_000), 1_700_000_000_000)
  assert.equal(normalizeExpiry(1_700_000_000_500), 1_700_000_000_500)
  assert.equal(normalizeExpiry('1700000000'), 1_700_000_000_000)
  assert.equal(normalizeExpiry(0), 0)
  assert.equal(normalizeExpiry(-5), 0)
  assert.equal(normalizeExpiry('nope'), 0)
  assert.equal(normalizeExpiry(undefined), 0)
})

test('accountIdOf hashes the uid so a directory listing cannot leak it', () => {
  const id = accountIdOf('uid-demo')
  assert.match(id, /^[0-9a-f]{24}$/)
  assert.equal(id.includes('uid-demo'), false)
  assert.equal(accountIdOf('uid-demo'), id)
  assert.notEqual(accountIdOf(''), accountIdOf(''))
  assert.match(accountIdOf(undefined), /^[0-9a-f]{24}$/)
})

test('describeAccount never exposes a token', () => {
  const view = describeAccount({
    accountId: 'a1',
    region: 'cn',
    account: { uid: 'uid-demo', nickname: '不等时间', uin: '123' },
    auth: {
      accessToken: 'tok-secret',
      refreshToken: 'ref-secret',
      expiresAt: Math.floor((Date.now() + HOUR) / 1000),
      domain: 'www.codebuddy.cn',
    },
  })
  const text = JSON.stringify(view)
  assert.equal(text.includes('tok-secret'), false)
  assert.equal(text.includes('ref-secret'), false)
  assert.equal(view.hasToken, true)
  assert.equal(view.hasRefreshToken, true)
  assert.equal(view.usable, true)
  assert.equal(view.expired, false)
})

test('describeAccount calls an expired token usable when the refresh token still works', () => {
  const now = 1_700_000_000_000
  const view = describeAccount(
    {
      accountId: 'a1',
      account: { uid: 'u' },
      auth: {
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Math.floor((now - HOUR) / 1000),
        refreshExpiresAt: Math.floor((now + HOUR) / 1000),
      },
    },
    now,
  )
  assert.equal(view.expired, true)
  assert.equal(view.refreshExpired, false)
  assert.equal(view.usable, true)
})

test('describeAccount refuses to call a tokenless record usable', () => {
  const view = describeAccount(
    { accountId: 'a1', account: {}, auth: { refreshToken: 'ref' } },
    Date.now(),
  )
  assert.equal(view.hasToken, false)
  assert.equal(view.usable, false)
})

test('createAccountStore requires a dir or a dataDir and defaults to providers/<id>/accounts', async () => {
  assert.throws(() => createAccountStore({}), /requires a dir or a dataDir/)
  const dataDir = await tempDir()
  const store = createAccountStore({ dataDir, providerId: 'workbuddy' })
  assert.equal(store.root, path.join(dataDir, 'providers', 'workbuddy', 'accounts'))
})

test('createAccountStore saves a credential with private permissions', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const saved = await store.save(credential())

  assert.match(saved.accountId, /^[0-9a-f]{24}$/)
  assert.equal(saved.nickname, '不等时间')
  assert.equal(saved.region, 'cn')
  assert.equal(saved.usable, true)
  const file = path.join(dir, 'cn', `${saved.accountId}.json`)
  const stat = await fs.stat(file)
  const record = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(record.version, 1)
  assert.equal(record.account.uid, 'uid-demo')
  assert.equal(record.auth.accessToken, 'tok-demo')
  assert.equal(typeof record.refreshedAtMs, 'number')
  assert.equal('file' in record, false)
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0)
})

test('createAccountStore reuses the same file when the same uid signs in again', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const first = await store.save(credential({ accessToken: 'tok-old' }))
  const second = await store.save(credential({ accessToken: 'tok-new' }))
  assert.equal(second.accountId, first.accountId)
  const names = await fs.readdir(path.join(dir, 'cn'))
  assert.deepEqual(names, [`${first.accountId}.json`])
  const resolved = await store.resolve({})
  assert.equal(resolved.token, 'tok-new')
})

test('createAccountStore enforces single-credential replacement across uids and regions', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const first = await store.save(credential({ uid: 'uid-old', nickname: '旧账号', accessToken: 'tok-1' }))
  // 反向控制：保存第一条后磁盘真有该文件
  assert.equal((await store.all()).length, 1)
  assert.equal((await fs.readdir(path.join(dir, 'cn'))).includes(`${first.accountId}.json`), true)

  // 保存第二个同区域不同 uid 账号：自动清除第一条文件，只剩唯一凭证
  const second = await store.save(credential({ uid: 'uid-new', nickname: '新账号', accessToken: 'tok-2' }))
  assert.deepEqual(await fs.readdir(path.join(dir, 'cn')), [`${second.accountId}.json`])
  assert.equal((await store.all()).length, 1)
  assert.equal((await store.resolve({})).token, 'tok-2')

  // 再保存一个跨区域凭证：cn 目录下的旧文件同样被清理，全库始终唯一
  const third = await store.save(
    credential({ uid: 'uid-global', nickname: '国际', region: 'global', domain: 'www.workbuddy.ai', accessToken: 'tok-3' }),
  )
  assert.deepEqual(await fs.readdir(path.join(dir, 'cn')), [])
  assert.deepEqual(await fs.readdir(path.join(dir, 'global')), [`${third.accountId}.json`])
  const all = await store.all()
  assert.equal(all.length, 1)
  assert.equal(all[0].accountId, third.accountId)
  assert.equal((await store.resolve({})).token, 'tok-3')
})

test('createAccountStore resolves matching region and rejects non-matching explicit region', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential({ uid: 'u1', accessToken: 'tok-cn', region: 'cn', domain: 'www.codebuddy.cn' }))

  const cn = await store.resolve({ region: 'cn' })
  assert.equal(cn.token, 'tok-cn')
  assert.equal(cn.region, 'cn')
  assert.equal(cn.base, 'https://www.codebuddy.cn')
  assert.equal((await store.resolve({})).token, 'tok-cn')
  assert.equal(await store.resolve({ region: 'global' }), undefined)
  assert.equal(await store.resolve({ region: 'nope' }), undefined)
})

test('createAccountStore can resolve an expired account only when asked', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(
    credential({
      accessToken: 'tok-dead',
      expiresAtMs: Date.now() - HOUR,
      refreshToken: '',
      refreshExpiresAtMs: 0,
    }),
  )
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.resolve({}), undefined)
  const forced = await store.resolve({ includeExpired: true })
  assert.equal(forced.token, 'tok-dead')
})

test('createAccountStore updates only the fields it is given', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const saved = await store.save(credential())
  await store.update(saved.accountId, {
    accessToken: 'tok-rotated',
    expiresAtMs: Date.now() + HOUR * 3,
  })
  const raw = await store.raw(saved.accountId)
  assert.equal(raw.auth.accessToken, 'tok-rotated')
  assert.equal(raw.auth.refreshToken, 'ref-demo')
  assert.equal(raw.account.nickname, '不等时间')
  assert.equal(raw.auth.domain, 'www.codebuddy.cn')
})

test('createAccountStore refuses to update an unknown account', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await assert.rejects(
    () => store.update('missing', { accessToken: 'x' }),
    /account not found: missing/,
  )
})

test('createAccountStore removes an account by id or wildcard and invalidates cache', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const saved = await store.save(credential())
  assert.equal(await store.remove(saved.accountId), true)
  assert.equal(await store.remove(saved.accountId), false)
  assert.deepEqual(await store.all(), [])
  assert.equal(await store.resolve({}), undefined)

  // 通配 '*' 一键清空唯一凭证
  await store.save(credential({ uid: 'uid-2', accessToken: 'tok-2' }))
  assert.equal(await store.remove('*'), true)
  assert.equal(await store.remove('*'), false)
  assert.deepEqual(await store.all(), [])
})

test('createAccountStore reports a single-credential summary without leaking tokens', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential({ uid: 'u1' }))
  await store.save(credential({ uid: 'u2', region: 'global', domain: 'www.workbuddy.ai' }))
  const summary = await store.summary()
  assert.equal(summary.count, 1)
  assert.equal(summary.usableCount, 1)
  assert.deepEqual(summary.regions, ['global'])
  assert.equal(summary.dir, dir)
  assert.equal(JSON.stringify(summary).includes('tok-demo'), false)
})

test('createAccountStore skips dotfiles and unreadable records instead of failing', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential())
  await fs.writeFile(path.join(dir, 'cn', 'broken.json'), '{not json')
  await fs.writeFile(
    path.join(dir, 'cn', '.hidden.json'),
    JSON.stringify({ accountId: 'x', auth: { accessToken: 'tok' } }),
  )
  const all = await store.all()
  assert.equal(all.length, 1)
})

test('createAccountStore serialises concurrent saves with credential lock', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const results = await Promise.all([
    store.save(credential({ accessToken: 'tok-a' })),
    store.save(credential({ accessToken: 'tok-b' })),
    store.save(credential({ accessToken: 'tok-c' })),
  ])
  assert.equal(new Set(results.map((item) => item.accountId)).size, 1)
  const raw = await store.raw(results[0].accountId)
  assert.equal(['tok-a', 'tok-b', 'tok-c'].includes(raw.auth.accessToken), true)
  const names = await fs.readdir(path.join(dir, 'cn'))
  assert.equal(names.filter((name) => name.startsWith('.lock')).length, 0)
  assert.equal(names.filter((name) => name.includes('.tmp-')).length, 0)
})

test('createAccountStore breaks a stale lock instead of hanging forever', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir, lockTimeoutMs: 400, lockStaleMs: 1 })
  const lockDir = path.join(dir, '.lock', 'credential')
  await fs.mkdir(lockDir, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(lockDir, old, old)
  const saved = await store.save(credential())
  assert.equal(saved.usable, true)
})

test('createAccountStore fails loudly when a live lock never clears', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir, lockTimeoutMs: 120, lockStaleMs: 60_000 })
  const lockDir = path.join(dir, '.lock', 'credential')
  await fs.mkdir(lockDir, { recursive: true })
  await assert.rejects(
    () => store.save(credential()),
    /another account operation is still running/,
  )
})

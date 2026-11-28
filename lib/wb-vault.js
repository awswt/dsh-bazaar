/**
 * 本插件独占的 Provider 单凭证存储库：`<dataDir>/providers/<providerId>/accounts/<region>/<accountId>.json`。
 *
 * 设计约束：
 *   - 彻底与外部插件隔离，不探测、不读取、不导入任何外部 vault 目录；
 *   - 单凭证模型：每个 Provider 仅维护唯一一份市场访问凭证，新认证落盘后自动清理同库旧凭证文件；
 *   - 文件权限 0600，目录 0700；
 *   - `list()` / `all()` / `summary()` 绝不返回明文 token，仅返回布尔状态与到期时间；
 *   - 明文 token 只在 `resolve()` 与 `raw()` 内部读取供请求头注入或续期使用。
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { baseForRegion, regionOfDomain } from './wb-login.js'

const RECORD_VERSION = 1
const LOCK_STALE_MS = 2 * 60 * 1000
const LOCK_TIMEOUT_MS = 10 * 1000
const LOCK_RETRY_MS = 40

const REGION_ORDER = ['cn', 'global']

function nowMs() {
  return Date.now()
}

/** 上游可能给秒也可能给毫秒；1e12 是分界。 */
export function normalizeExpiry(value) {
  const numeric = typeof value === 'string' ? Number(value) : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 1e12 ? numeric : numeric * 1000
}

/**
 * accountId：稳定、可做文件名、不泄露 uid 原文。
 */
export function accountIdOf(uid) {
  const text = String(uid ?? '').trim()
  if (text === '') return randomUUID().replaceAll('-', '').slice(0, 24)
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

/** 脱敏后的对外视图：没有任何 token 字段。 */
export function describeAccount(record, now = nowMs()) {
  const expiresAt = normalizeExpiry(record?.auth?.expiresAt)
  const refreshExpiresAt = normalizeExpiry(record?.auth?.refreshExpiresAt)
  const hasToken = typeof record?.auth?.accessToken === 'string' && record.auth.accessToken !== ''
  const hasRefresh = typeof record?.auth?.refreshToken === 'string' && record.auth.refreshToken !== ''
  return {
    accountId: String(record?.accountId ?? ''),
    uid: String(record?.account?.uid ?? ''),
    nickname: String(record?.account?.nickname ?? ''),
    uin: String(record?.account?.uin ?? ''),
    avatarUrl: typeof record?.account?.avatarUrl === 'string' ? record.account.avatarUrl : null,
    region: String(record?.region ?? ''),
    domain: String(record?.auth?.domain ?? ''),
    expiresAt: expiresAt > 0 ? expiresAt : 0,
    refreshExpiresAt: refreshExpiresAt > 0 ? refreshExpiresAt : 0,
    expired: expiresAt > 0 ? expiresAt <= now : true,
    refreshExpired: refreshExpiresAt > 0 ? refreshExpiresAt <= now : false,
    hasToken,
    hasRefreshToken: hasRefresh,
    usable: hasToken && (expiresAt === 0 || expiresAt > now || (hasRefresh && (refreshExpiresAt === 0 || refreshExpiresAt > now))),
    refreshedAtMs: Number(record?.refreshedAtMs ?? 0) || 0,
    file: typeof record?.file === 'string' ? record.file : undefined,
  }
}

async function acquireLock(lockDir, options = {}) {
  const timeoutMs = Number(options.lockTimeoutMs ?? LOCK_TIMEOUT_MS)
  const staleMs = Number(options.lockStaleMs ?? LOCK_STALE_MS)
  const force = options.force === true
  let forced = false
  const deadline = nowMs() + timeoutMs
  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false, mode: 0o700 })
      await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: nowMs() }), { encoding: 'utf8', mode: 0o600 })
      return { acquired: true, forced }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stat
      try {
        stat = await fs.stat(lockDir)
      } catch {
        continue
      }
      const stale = nowMs() - stat.mtimeMs > staleMs
      if (stale || (force && forced === false)) {
        try {
          await fs.rm(lockDir, { recursive: true, force: true })
        } catch {
          // Someone else may have removed it between stat and rm.
        }
        if (!stale) forced = true
        continue
      }
      if (nowMs() > deadline) throw new Error(`another account operation is still running (${lockDir})`)
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function releaseLock(lockDir) {
  try {
    await fs.rm(lockDir, { recursive: true, force: true })
  } catch {
    // A leftover lock is broken by the stale window; not worth failing a write.
  }
}

/**
 * Provider 单凭证存储库。
 *
 * 默认落在 `<dataDir>/providers/<providerId>/accounts/`；显式传 `dir` 时直接使用 `dir`（供单测注入）。
 */
export function createAccountStore(options = {}) {
  const explicitDir = String(options.dir ?? '')
  const dataDir = String(options.dataDir ?? '')
  if (explicitDir === '' && dataDir === '') throw new Error('createAccountStore requires a dir or a dataDir')
  const providerId = String(options.providerId ?? 'workbuddy').trim() || 'workbuddy'
  const root = explicitDir !== '' ? explicitDir : path.join(dataDir, 'providers', providerId, 'accounts')
  const now = options.now ?? nowMs
  let cache = null

  const fileOf = (region, accountId) => path.join(root, region, `${accountId}.json`)
  const lockRoot = () => path.join(root, '.lock')

  async function readAll() {
    const accounts = []
    for (const region of REGION_ORDER) {
      const dir = path.join(root, region)
      let names
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        if (name.startsWith('.')) continue
        const file = path.join(dir, name)
        let record
        try {
          record = JSON.parse(await fs.readFile(file, 'utf8'))
        } catch {
          continue
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
        const recordRegion = typeof record.region === 'string' ? record.region.trim() : ''
        if (recordRegion !== '' && recordRegion !== region) continue
        accounts.push({ ...record, region, file })
      }
    }
    accounts.sort((a, b) => Number(b?.refreshedAtMs ?? 0) - Number(a?.refreshedAtMs ?? 0) || normalizeExpiry(b?.auth?.expiresAt) - normalizeExpiry(a?.auth?.expiresAt))
    return accounts
  }

  async function load() {
    if (cache !== null) return cache
    cache = await readAll()
    return cache
  }

  function invalidate() {
    cache = null
  }

  /** 单凭证收敛：删除本库中除 keepFile 之外的所有旧凭证文件。 */
  async function purgeOtherRecords(keepFile) {
    for (const region of REGION_ORDER) {
      const dir = path.join(root, region)
      let names
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue
        const candidate = path.join(dir, name)
        if (path.resolve(candidate) === path.resolve(keepFile)) continue
        await fs.rm(candidate, { force: true }).catch(() => undefined)
      }
    }
  }

  async function writeRecord(record, { replaceAll = false } = {}) {
    const region = String(record.region ?? regionOfDomain(record?.auth?.domain))
    const accountId = String(record.accountId ?? '')
    if (accountId === '') throw new Error('cannot write an account without an accountId')
    const dir = path.join(root, region)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const target = fileOf(region, accountId)
    const temp = `${target}.tmp-${process.pid}-${nowMs().toString(36)}`
    const body = { ...record, version: RECORD_VERSION, refreshedAtMs: nowMs() }
    delete body.file
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, target)
    if (replaceAll === true) {
      await purgeOtherRecords(target)
    }
    invalidate()
    return { ...body, region, file: target }
  }

  return {
    root,

    /** 保存唯一市场认证凭证（自动覆盖同库旧凭证）。返回脱敏视图。 */
    async save(input) {
      const uid = String(input?.uid ?? '').trim()
      if (uid === '') throw new Error('cannot save an account without a uid')
      const region = String(input?.region ?? regionOfDomain(input?.domain))
      const accountId = String(input?.accountId ?? accountIdOf(uid))
      await fs.mkdir(lockRoot(), { recursive: true, mode: 0o700 })
      const lock = await acquireLock(path.join(lockRoot(), 'credential'), options)
      try {
        const record = await writeRecord(
          {
            accountId,
            region,
            account: {
              uid,
              ...typeof input?.nickname === 'string' && input.nickname !== '' ? { nickname: input.nickname } : {},
              ...typeof input?.uin === 'string' && input.uin !== '' ? { uin: input.uin } : {},
              ...typeof input?.avatarUrl === 'string' && input.avatarUrl !== '' ? { avatarUrl: input.avatarUrl } : {},
            },
            auth: {
              accessToken: String(input?.accessToken ?? ''),
              refreshToken: String(input?.refreshToken ?? ''),
              expiresAt: normalizeExpiry(input?.expiresAtMs ?? input?.expiresAt),
              refreshExpiresAt: normalizeExpiry(input?.refreshExpiresAtMs ?? input?.refreshExpiresAt),
              domain: String(input?.domain ?? ''),
              ...typeof input?.enterpriseId === 'string' && input.enterpriseId !== '' ? { enterpriseId: input.enterpriseId } : {},
            },
          },
          { replaceAll: true },
        )
        return { ...describeAccount(record, now()), forced: lock.forced }
      } finally {
        await releaseLock(path.join(lockRoot(), 'credential'))
      }
    },

    /** 脱敏列表。默认只返回可用凭证，`includeExpired` 才含已过期项。 */
    async list(options_ = {}) {
      const all = await load()
      const items = all.map(record => describeAccount(record, now()))
      return options_.includeExpired === true ? items : items.filter(item => item.usable)
    },

    /** 全量视图（单凭证下最多 1 条）。 */
    async all() {
      return (await load()).map(record => describeAccount(record, now()))
    },

    /** 取当前可用凭证。返回的 `token` 是明文，仅用于注入请求头。 */
    async resolve(options_ = {}) {
      const all = await load()
      const wanted = options_.region
      const candidates = all
        .map(record => ({ record, view: describeAccount(record, now()) }))
        .filter(item => item.view.hasToken)
        .filter(item => wanted === undefined || item.view.region === wanted)
        .filter(item => options_.includeExpired === true || item.view.usable)
        .sort((a, b) => b.view.expiresAt - a.view.expiresAt)
      const chosen = candidates[0]
      if (chosen === undefined) return undefined
      return {
        token: String(chosen.record.auth?.accessToken ?? ''),
        refreshToken: String(chosen.record.auth?.refreshToken ?? ''),
        accountId: chosen.view.accountId,
        uid: chosen.view.uid,
        nickname: chosen.view.nickname,
        region: chosen.view.region,
        domain: chosen.view.domain,
        expiresAt: chosen.view.expiresAt,
        base: baseForRegion(chosen.view.region, undefined),
      }
    },

    /** 读一条完整记录（含 token），只给刷新用。 */
    async raw(accountId) {
      const all = await load()
      if (accountId === undefined || accountId === null) return all[0]
      return all.find(record => describeAccount(record, now()).accountId === accountId)
    },

    /** 把刷新结果写回。找不到账号就抛错。 */
    async update(accountId, patch) {
      const existing = await this.raw(accountId)
      if (existing === undefined) throw new Error(`account not found: ${accountId}`)
      const region = String(existing.region ?? regionOfDomain(existing?.auth?.domain))
      await fs.mkdir(lockRoot(), { recursive: true, mode: 0o700 })
      const lock = await acquireLock(path.join(lockRoot(), 'credential'), options)
      try {
        const record = await writeRecord({
          ...existing,
          accountId,
          region,
          account: existing.account ?? {},
          auth: {
            ...existing.auth ?? {},
            ...typeof patch?.accessToken === 'string' ? { accessToken: patch.accessToken } : {},
            ...typeof patch?.refreshToken === 'string' && patch.refreshToken !== '' ? { refreshToken: patch.refreshToken } : {},
            ...patch?.expiresAtMs !== undefined ? { expiresAt: normalizeExpiry(patch.expiresAtMs) } : {},
            ...patch?.refreshExpiresAtMs !== undefined ? { refreshExpiresAt: normalizeExpiry(patch.refreshExpiresAtMs) } : {},
            ...typeof patch?.domain === 'string' && patch.domain !== '' ? { domain: patch.domain } : {},
          },
        })
        return { ...describeAccount(record, now()), forced: lock.forced }
      } finally {
        await releaseLock(path.join(lockRoot(), 'credential'))
      }
    },

    /** 删除指定凭证；若传 '*' 则清空当前唯一凭证。 */
    async remove(accountId) {
      const all = await load()
      if (accountId === '*') {
        if (all.length === 0) return false
        for (const item of all) {
          await fs.rm(item.file, { force: true }).catch(() => undefined)
        }
        invalidate()
        return true
      }
      const hit = all.find(record => describeAccount(record, now()).accountId === accountId)
      if (hit === undefined) return false
      await fs.rm(hit.file, { force: true })
      invalidate()
      return true
    },

    /** 统计：给 status 用，不暴露文件名与明文。 */
    async summary() {
      const items = await this.all()
      return {
        dir: root,
        count: items.length,
        usableCount: items.filter(item => item.usable).length,
        regions: [...new Set(items.map(item => item.region))].sort(),
        accounts: items,
      }
    },
  }
}

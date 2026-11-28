/**
 * WorkBuddy 独立市场认证凭证源（零外部插件依赖）。
 *
 * 硬约束：
 *   - 仅读写本插件独占的 Provider 目录 `<dataDir>/providers/workbuddy/accounts/`；
 *   - 绝不探测、绝不读取、绝不导入任何外部插件目录（如 `~/.dsh/workbuddy-vault`）；
 *   - 单凭证模型：同一 Provider 同一时间只维护唯一一份市场访问凭证；
 *   - `status()` / `accounts()` 绝不返回明文 token，仅 `resolveToken()` / `resolveFreshToken()` 在注入请求头前读取。
 */
import path from 'node:path'

import { mask, resolveDshHome } from './util.js'
import { refreshCredential } from './wb-login.js'
import { createAccountStore, normalizeExpiry } from './wb-vault.js'

const REGION_ORDER = ['cn', 'global']

/** 剩余寿命小于这个值就自动刷新，避免请求在路上过期。 */
const REFRESH_SKEW_MS = 60 * 1000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export class WorkBuddyConnector {
  constructor(options = {}) {
    this.dshHome = options.dshHome ?? resolveDshHome()
    const providerId = String(options.providerId ?? 'workbuddy').trim() || 'workbuddy'
    this.store = options.accounts ?? createAccountStore({
      ...options.accountsDir === undefined ? {} : { dir: options.accountsDir },
      ...options.accountsDir === undefined
        ? {
            dataDir: options.dataDir ?? path.join(this.dshHome, 'bazaar'),
            providerId,
          }
        : {},
    })
    this.refreshSkewMs = Number(options.refreshSkewMs ?? REFRESH_SKEW_MS)
    this.fetchImpl = options.fetchImpl
    this.now = options.now ?? (() => Date.now())
    this.urlConfig = options.urlConfig ?? (Array.isArray(options.allowHosts)
      ? { allowHosts: options.allowHosts, allowInsecureLoopback: options.allowInsecureLoopback === true }
      : undefined)
  }

  /** 本插件独立存储的凭证视图（脱敏）。 */
  async ownAccounts() {
    return this.store.all()
  }

  /** 对外统一凭证视图（100% 来自本插件自有存储）。 */
  async accounts() {
    return (await this.store.all()).map(item => ({ ...item, source: 'own' }))
  }

  /** 可用凭证列表（含 access 已过期但 refresh 仍可续期的凭证）。 */
  async usableAccounts() {
    const all = await this.accounts()
    return all.filter(item => item.hasToken && (!item.expired || this.canRefresh(item)))
  }

  canRefresh(item) {
    if (item.hasRefreshToken !== true) return false
    const refreshExpiresAt = Number(item.refreshExpiresAt ?? 0)
    return refreshExpiresAt === 0 || refreshExpiresAt > this.now()
  }

  /**
   * 解析当前市场访问 token。
   */
  async resolveToken(options = {}) {
    const preferred = options.region
    const softRegion =
      preferred === undefined && typeof options.preferredRegion === 'string' && options.preferredRegion !== ''
        ? options.preferredRegion
        : undefined
    const excluded = new Set(
      Array.isArray(options.excludeAccountIds) ? options.excludeAccountIds.filter(Boolean) : [],
    )
    const all = await this.accounts()
    const regionRank = item => {
      if (softRegion !== undefined) return item.region === softRegion ? 0 : 1
      const index = REGION_ORDER.indexOf(item.region)
      return index === -1 ? REGION_ORDER.length : index
    }
    const ranked = all
      .filter(item => item.hasToken)
      .filter(item => excluded.has(item.accountId) === false)
      .filter(item => preferred === undefined || item.region === preferred)
      .filter(item => options.includeExpired === true || !item.expired || this.canRefresh(item))
      .sort((a, b) => regionRank(a) - regionRank(b) || b.expiresAt - a.expiresAt)
    const chosen = ranked[0]
    if (chosen === undefined) return undefined
    return this.readToken(chosen)
  }

  /** 把一条凭证记录读成明文 token（唯一的读秘密入口）。 */
  async readToken(item) {
    const raw = await this.store.raw(item.accountId)
    if (raw === undefined) return undefined
    const token = raw.auth?.accessToken
    if (typeof token !== 'string' || token === '') return undefined
    return {
      token,
      refreshToken: String(raw.auth?.refreshToken ?? ''),
      accountId: item.accountId,
      uid: String(raw.account?.uid ?? ''),
      nickname: String(raw.account?.nickname ?? ''),
      region: item.region,
      domain: typeof raw.auth?.domain === 'string' ? raw.auth.domain : undefined,
      expiresAt: item.expiresAt,
      source: 'own',
    }
  }

  /**
   * 取一条确定有效的 token：快过期或已过期时自动用 refreshToken 续期并覆盖落盘。
   */
  async resolveFreshToken(options = {}) {
    const hit = await this.resolveToken(options)
    if (hit === undefined) return undefined
    const remaining = hit.expiresAt === 0 ? Number.POSITIVE_INFINITY : hit.expiresAt - this.now()
    if (remaining > this.refreshSkewMs) return { ...hit, refreshed: false }
    if (hit.refreshToken === '') {
      return remaining > 0 ? { ...hit, refreshed: false } : undefined
    }
    try {
      const next = await refreshCredential({
        credential: hit,
        fetchImpl: this.fetchImpl,
        now: this.now(),
        ...this.urlConfig === undefined ? {} : { urlConfig: this.urlConfig },
      })
      await this.store.update(hit.accountId, {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAtMs: next.expiresAtMs,
        refreshExpiresAtMs: next.refreshExpiresAtMs,
        domain: next.domain,
      })
      return {
        ...hit,
        token: next.accessToken,
        refreshToken: next.refreshToken,
        domain: next.domain === '' ? hit.domain : next.domain,
        expiresAt: normalizeExpiry(next.expiresAtMs),
        refreshed: true,
      }
    } catch (error) {
      if (remaining > 0) return { ...hit, refreshed: false, refreshError: messageOf(error) }
      throw new Error(`WorkBuddy 市场认证凭证已过期且自动续期失败：${messageOf(error)}`)
    }
  }

  /** 认证成功后覆盖保存唯一凭证。 */
  async saveAccount(account) {
    return this.store.save(account)
  }

  /** 手动强制刷新当前凭证。 */
  async refreshAccount(accountId) {
    const raw = await this.store.raw(accountId)
    if (raw === undefined) throw new Error(`account not found: ${accountId}`)
    const targetId = String(raw.accountId ?? accountId ?? '')
    const refreshToken = String(raw.auth?.refreshToken ?? '')
    if (refreshToken === '') throw new Error('当前凭证不含 refresh token，请重新登录认证')
    const next = await refreshCredential({
      credential: {
        refreshToken,
        domain: raw.auth?.domain,
        enterpriseId: raw.auth?.enterpriseId,
        base: undefined,
      },
      fetchImpl: this.fetchImpl,
      now: this.now(),
      ...this.urlConfig === undefined ? {} : { urlConfig: this.urlConfig },
    })
    return this.store.update(targetId, {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAtMs: next.expiresAtMs,
      refreshExpiresAtMs: next.refreshExpiresAtMs,
      domain: next.domain,
    })
  }

  /** 单凭证状态摘要（不含任何外部插件字段与明文）。 */
  async status() {
    const own = await this.store.all()
    const usable = own.filter(item => item.hasToken && (!item.expired || this.canRefresh(item)))
    const best = usable.sort((a, b) => b.expiresAt - a.expiresAt)[0]
    return {
      accountCount: own.length,
      usableAccountCount: usable.length,
      tokenAvailable: usable.length > 0,
      source: best === undefined ? 'none' : 'own',
      regions: [...new Set(own.map(item => item.region))],
      own: {
        dir: mask(this.store.root, 12),
        count: own.length,
        usableCount: usable.length,
        accounts: own.map(item => ({
          accountId: mask(item.accountId, 4),
          nickname: mask(item.nickname, 2),
          region: item.region,
          domain: item.domain,
          expiresAt: item.expiresAt > 0 ? new Date(item.expiresAt).toISOString() : null,
          expired: item.expired,
          hasToken: item.hasToken,
          hasRefreshToken: item.hasRefreshToken,
          usable: item.usable,
        })),
      },
      accounts: own.map(item => ({
        source: 'own',
        accountId: mask(item.accountId, 4),
        nickname: mask(item.nickname, 2),
        region: item.region,
        expiresAt: item.expiresAt > 0 ? new Date(item.expiresAt).toISOString() : null,
        expired: item.expired,
        hasToken: item.hasToken,
        hasRefreshToken: item.hasRefreshToken === true,
      })),
    }
  }
}

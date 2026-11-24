/**
 * 单个 provider 的只读状态（设置页用）：凭据名/是否已配置、缓存目录用量、是否会话活跃。
 *
 * 三个域各自的面板（市场、连接器、账号）已经能回答「有什么」，但设置页要回答的是另一类
 * 问题：「这家库靠什么出网、配好了没有、缓存占了多少」。把它们塞进 domains.js 会让分组
 * 返回层开始承载与 provider 实现无关的宿主侧状态——provider 自己并不知道凭据名或缓存目录，
 * 那是注册层推导出来的（见 paths.js 的 credentialNameFor / providerLayout）。
 *
 * 因此本模块只做「注册层事实的投影」，两条纪律：
 *   1. 凭据值永不回显：configured 之外只给掩码，掩码也不从明文来（只有描述接口给出的
 *      preview/hint/last4 会被用到尾部四位）。
 *   2. 缓存清理只碰 <dataDir>/providers/<id>/cache 一个子树，且不创建它——「问了路径就凭空
 *      多出目录」会破坏 spec 的目录隔离断言（providerLayout 本身也刻意不 mkdir）。
 */

import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { CODES, fail, ok } from './errors.js'
import { assertProviderId, providerLayout, resolveCredentialName } from './paths.js'
import { declarationOf } from './contract.js'

/** 缓存用量的防护线：超过就不继续数，避免一个巨大缓存把设置页拖住。 */
const MAX_CACHE_ENTRIES = 5000
const MAX_CACHE_DEPTH = 4

function unknownProvider(registry, providerId) {
  const ids = registry.ids()
  return fail(
    CODES.PROVIDER_UNKNOWN,
    'provider ' +
      JSON.stringify(providerId) +
      ' 未注册（当前已注册：' +
      (ids.length === 0 ? '无' : ids.join(', ')) +
      '）',
    { providerId: providerId, registered: ids },
  )
}

/**
 * 掩码只由「允许回显的尾部片段」构造；没有片段时用一个固定宽度的掩码占位。
 * 绝不把 resolve() 的明文截断后当掩码——截断后的令牌照样是可用的凭据。
 */
export function maskCredential(info) {
  if (info === undefined || info === null || info.configured !== true) return ''
  const tail =
    typeof info.last4 === 'string'
      ? info.last4
      : typeof info.hint === 'string'
        ? info.hint
        : typeof info.preview === 'string'
          ? info.preview
          : ''
  const visible = tail.replace(/[^0-9A-Za-z]/g, '').slice(-4)
  return visible === '' ? '••••••' : '••••' + visible
}

async function countTree(root, fsImpl) {
  let entries = 0
  let bytes = 0
  let truncated = false
  async function walk(dir, depth) {
    let dirents
    try {
      dirents = await fsImpl.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const dirent of dirents) {
      if (entries >= MAX_CACHE_ENTRIES) {
        truncated = true
        return
      }
      entries += 1
      const target = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (depth < MAX_CACHE_DEPTH) await walk(target, depth + 1)
        continue
      }
      if (dirent.isFile()) {
        try {
          const stat = await fsImpl.stat(target)
          bytes += Number(stat.size) || 0
        } catch {
          // 并发删除：计不进大小，也不影响其它条目。
        }
      }
    }
  }
  await walk(root, 0)
  return { entries: entries, bytes: bytes, truncated: truncated }
}

/**
 * @param {object} deps
 * @param {object} deps.registry createProviderRegistry() 的返回值
 * @param {Function} deps.describeCredential (providerId, declaration) => Promise<{mode,configured,source,writable,last4?}>
 * @param {Function} deps.layoutOf (providerId) => {ok:true, root, accounts, vault, cache, connectorsFile}
 * @param {Function} [deps.activeOf] (sessionId) => Promise<string[]>；缺省时 active 恒为 null
 * @param {object} [deps.fs] 只做单测替换用
 */
export function createProviderStatus(deps) {
  const registry = deps?.registry
  const describeCredential = deps?.describeCredential
  const layoutOf = deps?.layoutOf
  const activeOf = deps?.activeOf
  const fsImpl = deps?.fs ?? fsPromises

  async function cacheOf(providerId) {
    const layout = layoutOf(providerId)
    if (layout.ok === false) return layout
    const counted = await countTree(layout.cache, fsImpl)
    return ok({
      dir: layout.cache,
      entries: counted.entries,
      bytes: counted.bytes,
      truncated: counted.truncated,
    })
  }

  async function credentialOf(record) {
    const resolved = resolveCredentialName({
      providerId: record.id,
      credentialRef: record.credentialRef,
      knownProviderIds: registry.ids(),
    })
    if (resolved.ok === false) return resolved
    let described
    try {
      described = await describeCredential(record.id, record)
    } catch (error) {
      described = { mode: 'unknown', configured: false, source: 'unavailable' }
      described.note = String(error?.message ?? error)
    }
    const info = described !== null && typeof described === 'object' ? described : {}
    return ok({
      name: resolved.name,
      derived: resolved.derived,
      mode: typeof info.mode === 'string' ? info.mode : 'unknown',
      configured: info.configured === true,
      source: typeof info.source === 'string' ? info.source : 'unknown',
      writable: info.writable === true,
      masked: maskCredential(info),
      note: typeof info.note === 'string' ? info.note : undefined,
    })
  }

  /**
   * 状态投影。providerId 非法/未注册都返回失败信封（未注册不是 404，理由同 routes.js）。
   */
  async function describe(providerId, sessionId) {
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    const record = registry.getRecord(providerId)
    if (record === undefined) return unknownProvider(registry, providerId)

    const credential = await credentialOf(record)
    if (credential.ok === false) return credential
    const cache = await cacheOf(providerId)
    if (cache.ok === false) return cache

    let active = null
    if (typeof activeOf === 'function' && typeof sessionId === 'string' && sessionId !== '') {
      try {
        const ids = await activeOf(sessionId)
        active = Array.isArray(ids) ? ids.includes(providerId) : null
      } catch {
        active = null
      }
    }

    return ok({
      provider: { ...declarationOf(record), active: active === true },
      credential: credential,
      cache: cache,
    })
  }

  /**
   * 清空该 provider 的缓存：只删 cache 子树里的条目，保留目录本身（目录存在与否本身是
   * 「这家库有没有缓存过东西」的证据，删掉会让下一次读取看起来像「从未缓存」）。
   */
  async function clearCache(providerId) {
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    const record = registry.getRecord(providerId)
    if (record === undefined) return unknownProvider(registry, providerId)
    const layout = layoutOf(providerId)
    if (layout.ok === false) return layout

    let dirents
    try {
      dirents = await fsImpl.readdir(layout.cache, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT')
        return ok({ dir: layout.cache, removedEntries: 0, existed: false })
      throw error
    }
    let removedEntries = 0
    for (const dirent of dirents) {
      const target = path.join(layout.cache, dirent.name)
      await fsImpl.rm(target, { recursive: true, force: true })
      removedEntries += 1
    }
    return ok({ dir: layout.cache, removedEntries: removedEntries, existed: true })
  }

  return {
    describe: describe,
    clearCache: clearCache,
    _internals: { maskCredential: maskCredential, countTree: countTree },
  }
}

/**
 * 缓存目录的推导入口：设置页与路由都读这一处，避免两边各算一次「缓存在哪」。
 */
export function providerLayoutOf(dataDir) {
  return function layoutOf(providerId) {
    return providerLayout(dataDir, providerId)
  }
}

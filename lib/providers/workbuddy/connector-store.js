/**
 * provider 级连接器授权库（组 4.1–4.3）。
 *
 * 为什么单独一层：会话门控（tools.restrict）必须留在 connectors.js 的工具集合层，
 * 不能下放进单个连接器 handler；但「某家库里这个连接器是否已授权、授权流程走到哪一步」
 * 是 provider 自己的状态，必须落在该 provider 的目录里。两者职责不同，文件也不同。
 *
 * 落点固定为 providerLayout(dataDir, providerId).connectorsFile，
 * 即 <dataDir>/providers/<providerId>/connectors.json；调用方无法指定别的路径。
 *
 * 本库只管授权状态与可复制文本，绝不写宿主 MCP 配置、不触发重载——写宿主配置是
 * 后续版本的能力，1.0.0 只产出 copy-config 文本。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { providerLayout, assertProviderId } from '../../provider/paths.js'
import { CODES, fail, ok } from '../../provider/errors.js'

const SUPPORTED_ACTIONS = ['list', 'state', 'authorize', 'poll', 'cancel', 'copy-config', 'remove']
/** 授权会话有效期：超时后 poll 明确判过期，不无限挂起。 */
const SESSION_TTL_MS = 5 * 60 * 1000

function emptyStore() {
  return { version: 1, configs: {}, sessions: {} }
}

export function createConnectorStore(options = {}) {
  const dataDir = options.dataDir
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new Error('createConnectorStore 需要 dataDir')
  }
  // connectorViews / readCatalog 由 workbuddy provider 注入，保持本库对宿主无依赖。
  const connectorViews =
    typeof options.connectorViews === 'function' ? options.connectorViews : null
  const readCatalog = typeof options.readCatalog === 'function' ? options.readCatalog : null
  const logger = options.logger
  const stores = new Map()

  function entryFor(providerId) {
    let entry = stores.get(providerId)
    if (entry === undefined) {
      entry = { cache: undefined, queue: Promise.resolve() }
      stores.set(providerId, entry)
    }
    return entry
  }

  function fileFor(providerId) {
    return providerLayout(dataDir, providerId).connectorsFile
  }

  async function load(providerId) {
    const entry = entryFor(providerId)
    if (entry.cache !== undefined) return entry.cache
    try {
      const parsed = JSON.parse(await fs.readFile(fileFor(providerId), 'utf8'))
      const configs = parsed?.configs && typeof parsed.configs === 'object' ? parsed.configs : {}
      const sessions =
        parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      entry.cache = { version: 1, configs, sessions }
    } catch {
      entry.cache = emptyStore()
    }
    return entry.cache
  }

  function save(providerId) {
    const entry = entryFor(providerId)
    const snapshot = JSON.stringify(entry.cache ?? emptyStore(), null, 2)
    const file = fileFor(providerId)
    entry.queue = entry.queue
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await fs.writeFile(tmp, snapshot, 'utf8')
        await fs.rename(tmp, file)
      })
      .catch((error) => {
        logger?.warn?.(
          'bazaar: could not persist connector store for %s: %s',
          providerId,
          String(error),
        )
      })
    return entry.queue
  }

  function recordOf(store, id) {
    return store.configs[id] ?? null
  }

  function defaultView(item, record) {
    const storeConnected = record?.bound === true && record?.authorized !== false
    const liveConnected = item.connected === true || item.state?.connected === true
    const connected = storeConnected || liveConnected
    const connecting = record?.authorizing === true || item.state?.connecting === true
    const tools = Array.isArray(item.tools)
      ? item.tools.length
      : Number(item.tools ?? item.toolCount ?? 0) || 0
    const summary = item.summary ?? item.description ?? ''
    return {
      id: item.id,
      name: item.name ?? item.id,
      displayName: item.displayName ?? item.name ?? item.id,
      transport: item.transport ?? item.auth?.mode ?? 'none',
      category: item.category,
      summary,
      description: summary,
      vendor: item.vendor,
      tags: Array.isArray(item.tags) ? item.tags.slice() : [],
      tools,
      source: item.source,
      catalogOnly: item.catalogOnly === true && storeConnected !== true,
      enabled: record?.enabled !== false,
      bound: record?.bound === true || liveConnected,
      authorized: record?.authorized === true || liveConnected,
      authorizing: record?.authorizing === true,
      connecting,
      connected,
      state: {
        connected,
        connecting,
        reason: item.state?.reason ?? null,
      },
      updatedAt: record?.updatedAt ?? 0,
      // 明确不含 headers/env/credentials/token：列表与详情都不回明文密钥。
    }
  }

  async function catalogItems() {
    if (connectorViews === null) return []
    const view = await connectorViews()
    return Array.isArray(view?.items) ? view.items : []
  }

  function findItem(items, id) {
    return items.find((item) => item.id === id || item.name === id)
  }

  /** 列表（4.1）：状态与关键词同时生效（AND），三入口共用这一处。 */
  async function listConnectorsFor(providerId, params = {}) {
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    const store = await load(providerId)
    const items = await catalogItems()
    const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
    const status = typeof params.status === 'string' ? params.status.trim().toLowerCase() : ''
    const views = items
      .map((item) => defaultView(item, recordOf(store, item.id)))
      .filter((item) => {
        if (query !== '') {
          const text = [
            item.id,
            item.name,
            item.displayName,
            item.vendor,
            item.summary,
            item.category,
            ...item.tags,
          ]
            .filter((value) => typeof value === 'string')
            .join(' ')
            .toLowerCase()
          if (text.includes(query) === false) return false
        }
        if (status !== '') {
          if (status === 'enabled') return item.enabled === true
          if (status === 'disabled') return item.enabled === false
          if (status === 'bound') return item.bound === true
          if (status === 'connected') return item.connected === true
          if (status === 'connecting') return item.connecting === true
          if (status === 'action-required')
            return item.connecting === false && item.connected === false
          if (status === 'disconnected') return item.bound !== true
        }
        return true
      })
      .sort((a, b) => {
        const rank = (entry) => {
          if (entry.connected === true) return 0
          if (entry.source === 'plugin') return 1
          return 2
        }
        return rank(a) - rank(b)
      })
    let categories = []
    if (readCatalog !== null) {
      const catalog = await readCatalog()
      categories = Array.isArray(catalog?.categories) ? catalog.categories : []
    }
    return ok({ items: views, total: views.length, categories: categories, query, status })
  }

  /** 详情（4.2）：双键定位，任何情况下都不返回明文密钥。 */
  async function getConnectorFor(providerId, id) {
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    if (typeof id !== 'string' || id.trim() === '') {
      return fail(CODES.PARAM_INVALID, '连接器详情需要 id', { field: 'id' })
    }
    const key = id.trim()
    const store = await load(providerId)
    const item = findItem(await catalogItems(), key)
    if (item === undefined) {
      return fail(
        CODES.CONNECTOR_NOT_FOUND,
        'provider ' + providerId + ' 没有连接器 ' + JSON.stringify(key),
        {
          providerId,
          id: key,
        },
      )
    }
    return ok({ item: defaultView(item, recordOf(store, item.id)) })
  }

  function newSessionId() {
    return 'bz_' + randomBytes(12).toString('hex')
  }

  /**
   * 动作分发（4.2/4.3）：动作集在入口收敛，写宿主配置类动作一律不支持。
   * authorize / poll / cancel / remove 是三段式与删除，全部即时持久化。
   */
  async function connectorActionFor(providerId, action, params = {}) {
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    if (SUPPORTED_ACTIONS.includes(action) === false) {
      return fail(
        CODES.CONNECTOR_ACTION_UNSUPPORTED,
        'provider ' + providerId + ' 不支持连接器动作 ' + JSON.stringify(action),
        { action, supported: SUPPORTED_ACTIONS.slice() },
      )
    }
    if (action === 'list') return listConnectorsFor(providerId, params)
    if (action === 'state') {
      const id = typeof params.id === 'string' ? params.id.trim() : ''
      if (id === '') return fail(CODES.PARAM_INVALID, 'state 需要 id', { field: 'id' })
      return getConnectorFor(providerId, id)
    }

    const store = await load(providerId)
    const id = typeof params.id === 'string' ? params.id.trim() : ''

    if (action === 'authorize') {
      if (id === '') return fail(CODES.PARAM_INVALID, 'authorize 需要 id', { field: 'id' })
      const item = findItem(await catalogItems(), id)
      if (item === undefined) {
        return fail(CODES.CONNECTOR_NOT_FOUND, '没有连接器 ' + JSON.stringify(id), {
          providerId,
          id,
        })
      }
      const existing = recordOf(store, item.id)
      // 单飞：同一连接器已有未过期 pending 会话就复用，不重复发起。
      if (existing?.authorizing === true && typeof existing.pendingSession === 'string') {
        const pending = store.sessions[existing.pendingSession]
        if (
          pending &&
          pending.state === 'pending' &&
          Date.now() - pending.createdAt < SESSION_TTL_MS
        ) {
          return ok({
            action,
            sessionId: existing.pendingSession,
            authorizeUrl: pending.authorizeUrl ?? '',
            state: 'pending',
          })
        }
      }
      const sessionId = newSessionId()
      const authorizeUrl = typeof params.authorizeUrl === 'string' ? params.authorizeUrl : ''
      store.sessions[sessionId] = {
        connectorId: item.id,
        state: 'pending',
        authorizeUrl,
        createdAt: Date.now(),
      }
      store.configs[item.id] = {
        ...(existing ?? {}),
        authorizing: true,
        pendingSession: sessionId,
        enabled: existing?.enabled !== false,
        updatedAt: Date.now(),
      }
      await save(providerId)
      return ok({ action, sessionId, authorizeUrl, state: 'pending' })
    }

    if (action === 'poll') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
      if (sessionId === '')
        return fail(CODES.PARAM_INVALID, 'poll 需要 sessionId', { field: 'sessionId' })
      const session = store.sessions[sessionId]
      if (session === undefined) {
        return fail(CODES.CONNECTOR_NOT_FOUND, '授权会话不存在或已结束', { providerId, sessionId })
      }
      if (Date.now() - session.createdAt >= SESSION_TTL_MS) {
        delete store.sessions[sessionId]
        const record = recordOf(store, session.connectorId)
        if (record) {
          record.authorizing = false
          delete record.pendingSession
          record.updatedAt = Date.now()
        }
        await save(providerId)
        return ok({ action, done: true, expired: true, state: 'expired' })
      }
      if (session.state === 'pending') return ok({ action, done: false, state: 'pending' })
      if (session.state === 'cancelled') {
        delete store.sessions[sessionId]
        await save(providerId)
        return ok({ action, done: true, cancelled: true, state: 'cancelled' })
      }
      if (session.state === 'granted') {
        const record = recordOf(store, session.connectorId) ?? {}
        record.authorized = true
        record.bound = true
        record.authorizing = false
        record.enabled = true
        record.updatedAt = Date.now()
        delete record.pendingSession
        store.configs[session.connectorId] = record
        delete store.sessions[sessionId]
        await save(providerId)
        return ok({ action, done: true, success: true, state: 'granted' })
      }
      return fail(CODES.PARAM_INVALID, '未知的授权会话状态', {
        field: 'state',
        state: session.state,
      })
    }

    if (action === 'cancel') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
      if (sessionId === '')
        return fail(CODES.PARAM_INVALID, 'cancel 需要 sessionId', { field: 'sessionId' })
      const session = store.sessions[sessionId]
      if (session === undefined) return ok({ action, done: true, cancelled: true })
      session.state = 'cancelled'
      const record = recordOf(store, session.connectorId)
      if (record) {
        record.authorizing = false
        delete record.pendingSession
        record.updatedAt = Date.now()
      }
      await save(providerId)
      return ok({ action, done: true, cancelled: true, state: 'cancelled' })
    }

    if (action === 'copy-config') {
      if (id === '') return fail(CODES.PARAM_INVALID, 'copy-config 需要 id', { field: 'id' })
      const item = findItem(await catalogItems(), id)
      if (item === undefined) {
        return fail(CODES.CONNECTOR_NOT_FOUND, '没有连接器 ' + JSON.stringify(id), {
          providerId,
          id,
        })
      }
      const record = recordOf(store, item.id)
      // 只产文本：headers/env 来自调用方显式提供的覆盖值，绝不读宿主 patch，也绝不写回。
      const headers = params.headers && typeof params.headers === 'object' ? params.headers : {}
      const env = params.env && typeof params.env === 'object' ? params.env : {}
      const text = JSON.stringify(
        {
          connector: item.id,
          providerId,
          serverName: item.serverName ?? item.name ?? item.id,
          headers,
          env,
          authorized: record?.authorized === true,
          note: '这是可复制文本；1.0.0 不会写宿主配置，也不会触发重载。',
        },
        null,
        2,
      )
      return ok({ action, text, written: false, reloaded: false })
    }

    // remove：只删本 provider 自己 store 里的授权记录。
    if (id === '') return fail(CODES.PARAM_INVALID, 'remove 需要 id', { field: 'id' })
    const removed = store.configs[id] !== undefined
    delete store.configs[id]
    for (const [sessionId, session] of Object.entries(store.sessions)) {
      if (session.connectorId === id) delete store.sessions[sessionId]
    }
    await save(providerId)
    return ok({ action, removed, id })
  }

  /**
   * 授权回调入口：上游授权完成后由回调把会话推进到 granted/cancelled。
   * poll 观察到终态才落库，因此「即时持久化」发生在 poll 成功那一刻，
   * 而不是回调到达那一刻——用户必须轮询确认后才被呈现为已连接。
   */
  async function completeAuthorizationFor(providerId, sessionId, outcome = 'granted') {
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    const store = await load(providerId)
    const session = store.sessions[sessionId]
    if (session === undefined) {
      return fail(CODES.CONNECTOR_NOT_FOUND, '授权会话不存在', { providerId, sessionId })
    }
    session.state = outcome === 'cancelled' ? 'cancelled' : 'granted'
    await save(providerId)
    return ok({ sessionId, state: session.state })
  }

  return {
    listConnectorsFor,
    getConnectorFor,
    connectorActionFor,
    completeAuthorizationFor,
    supportedActions: () => SUPPORTED_ACTIONS.slice(),
    /** 仅供测试诊断：确认落点确实在 provider 目录。 */
    storePathFor: fileFor,
  }
}

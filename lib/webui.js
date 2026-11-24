import { AuthError } from './auth.js'
import { connectorUiHint, connectorUiUrl } from './connector-flow.js'
import { CODES } from './provider/errors.js'
import { listInstalledSkills } from './skill-install.js'

const PREFIX = '/dsh-bazaar'
/**
 * 一个进程里 webServer 是共享的，而插件热重载会重新执行 registerWebUi：上一轮
 * 注册时拿到的 dispose 函数只存在于上一轮的闭包里。把 release 挂在 webServer 上，
 * 新一轮就能先撤掉旧路由——否则 webServer.register 因路径重复抛错，宿主继续用
 * 那个已经 dispose 掉的 handler 应答。
 */
const routeOwners = new WeakMap()
/**
 * 这条路由是不是本插件自己的？按路径边界判定，不做裸字符串前缀匹配——
 * `/dsh-bazaar-next/x` 与 `/api/dsh-bazaar/x` 都不是我们的路由，热重载时
 * 必须留给注册它们的人。
 */
const ownRoutePath = key => key === PREFIX || key.startsWith(PREFIX + '/')
const ROUTES = {
  state: `${PREFIX}/state`,
  experts: `${PREFIX}/experts`,
  connectors: `${PREFIX}/connectors`,
  connectorsSession: `${PREFIX}/connectors/session`,
  connectorsAction: `${PREFIX}/connectors/action`,
  connectorsState: `${PREFIX}/connectors/state`,
  skillMarket: `${PREFIX}/skill-market`,
  skillInstall: `${PREFIX}/skill-install`,
  accounts: `${PREFIX}/accounts`,
  accountsAction: `${PREFIX}/accounts/action`,
  select: `${PREFIX}/select`,
  skills: `${PREFIX}/skills`,
  off: `${PREFIX}/off`,
}
const MAX_BODY_BYTES = 64 * 1024
const CATEGORY_TTL_MS = 10 * 60 * 1000

/**
 * 域方法的失败信封 → HTTP 状态码。分组返回层把「哪家库坏了」写进 groups，
 * 但整个请求仍可能因为参数非法、provider 未注册这类原因整体失败；那种情况
 * 必须给出对应状态码，而不是一律 500——500 会让面板把参数错误当成服务端故障，
 * 重试按钮点下去还是同一个错。
 */
const FAILURE_STATUS = {
  BAZAAR_PARAM_INVALID: 400,
  BAZAAR_PROVIDER_REQUIRED: 400,
  BAZAAR_PROVIDER_INVALID_ID: 400,
  BAZAAR_PROVIDER_UNKNOWN: 404,
  BAZAAR_PROVIDER_ID_MISMATCH: 400,
  BAZAAR_CAPABILITY_UNDECLARED: 400,
  BAZAAR_EXPERT_NOT_FOUND: 404,
  BAZAAR_SKILL_NAME_CONFLICT: 409,
  BAZAAR_SKILL_SLUG_INVALID: 400,
  BAZAAR_SKILL_PACKAGE_TOO_LARGE: 413,
  BAZAAR_CONNECTOR_NOT_FOUND: 404,
  BAZAAR_CONNECTOR_ACTION_UNSUPPORTED: 400,
  BAZAAR_MEMORY_UNAVAILABLE: 503,
  BAZAAR_MARKET_UNAVAILABLE: 503,
  BAZAAR_MARKET_RATE_LIMITED: 429,
  BAZAAR_MARKET_AUTH_REQUIRED: 401,
  BAZAAR_PORTAL_AUTH_REQUIRED: 401,
  BAZAAR_AUTH_MISSING: 401,
  BAZAAR_AUTH_INLINE: 400,
  BAZAAR_AUTH_MODE: 400,
  BAZAAR_AUTH_HEADER_MISSING: 400,
  BAZAAR_CREDENTIALS_MISSING: 401,
  BAZAAR_LOGIN_EXPIRED: 401,
  BAZAAR_HOST_DENIED: 403,
  BAZAAR_URL_INVALID: 400,
  BAZAAR_URL_INSECURE: 400,
  BAZAAR_URL_USERINFO: 400,
}

function failureStatus(code) {
  return FAILURE_STATUS[code] ?? 500
}

function sendFailure(response, failure) {
  const body = { ...failure, ok: false }
  delete body.impl
  send(response, failureStatus(failure.code), body)
}

function send(response, status, body) {
  try {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  } catch {
    // The socket may already be gone; there is nothing useful to do.
  }
}

function readBody(request) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let failed = false
    request.on('data', chunk => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        request.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (failed) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => {
      if (!failed) {
        failed = true
        resolve(undefined)
      }
    })
  })
}

function sessionIdOf(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '' || text.length > 256) return undefined
  return text
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function list(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : undefined
}

/**
 * Same-origin guard for the two write routes.
 *
 * A browser always sends `Origin` on a cross-site POST. Requiring it to match
 * `Host` keeps a random web page from switching experts in the local DSH
 * window, without needing the browser-session cookie (which headless hosts do
 * not mint).
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function createCategoryCache(market) {
  let cache
  return async () => {
    if (cache !== undefined && Date.now() - cache.at < CATEGORY_TTL_MS) return cache.value
    let value = []
    try {
      value = await market.categories()
    } catch {
      value = []
    }
    cache = { at: Date.now(), value }
    return value
  }
}

/**
 * 分页参数原样透传给分组返回层：非正整数必须由它拦下并指明字段，
 * 面板才能把错误贴在对应输入框上。这里只把空值折成 undefined，
 * 解析不出来的保持原样（字符串），让校验器报出用户真正填的内容。
 */
function intParam(url, name) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) ? value : raw
}

function matchesLocal(item, query, categoryId) {
  if (categoryId !== undefined && item.categoryId !== categoryId) return false
  if (query === '') return true
  return [
    item.id,
    item.plugin,
    item.agentName,
    item.displayName,
    item.profession,
    item.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

/**
 * 本地已装的专家包并进它所属的那一家库。
 *
 * 本地包不是一家「库」：它是某家库的专家被装到磁盘上之后的副本，另立一个
 * providerId 会让「同一专家的两个身份」在面板里并排出现。所以只往内置库
 * 的分区里追加，并且只追加库里还没有的行（remote 行赢在 plugin 名上）。
 * 内置库不在活跃集里时不追加——未点亮的库不渲染任何条目。
 */
function withLocalExperts(groups, localItems, builtinProviderId, query, categoryId) {
  if (builtinProviderId === undefined) return groups
  const target = groups.find(group => group.providerId === builtinProviderId)
  if (target === undefined) return groups
  const remote = groups.flatMap(group => group.items)
  const localOnly = localItems
    .filter(item => !remote.some(row => row.plugin === item.plugin || row.id === item.id))
    .filter(item => matchesLocal(item, query.toLowerCase(), categoryId))
    .map(item => ({
      ...item,
      providerId: builtinProviderId,
      qualifiedName: item.displayName ?? item.id,
      source: 'local',
      installed: true,
      marketExpertId: null,
      avatar: null,
    }))
  if (localOnly.length === 0) return groups
  return groups.map(group =>
    group === target
      ? { ...group, items: [...localOnly, ...group.items], total: group.total + localOnly.length }
      : group,
  )
}

/**
 * Register the composer panel's JSON routes on the shared DSH web server.
 *
 * The client half is served from the same origin, so relative `fetch` calls
 * carry the host's session and no CORS handling is needed.
 */
export function registerWebUi(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return
  const categories = createCategoryCache(deps.market)
  // 分组返回层与会话活跃集都在本函数之后才构建（它们依赖注册表），只能惰性取。
  // 直接读 deps.views 会在 apply() 里拿到 undefined，面板就退回「一家库」的旧形状。
  const viewsOf = () => (typeof deps.getViews === 'function' ? deps.getViews() : deps.views)
  const activeOf = () => (typeof deps.getActive === 'function' ? deps.getActive() : deps.active)
  ctx.logger?.info?.('bazaar: registering web UI routes')
  const routeDisposers = []
  const releaseRoutes = () => {
    while (routeDisposers.length > 0) {
      const dispose = routeDisposers.pop()
      try {
        dispose()
      } catch {
        // A route may already have been removed by the host.
      }
    }
  }
  try {
    ctx.inject(['webServer'], scoped => {
      const webServer = scoped?.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger?.warn?.('bazaar: webServer.register is unavailable')
        return
      }
      // HMR / plugin reload tears down the old fiber but keeps the shared
      // webServer alive. Dispose our previous routes first, then make sure the
      // new scoped context releases these routes when it goes inactive;
      // otherwise stale handlers keep answering with a disposed ctx and the
      // panel sees "cannot get required service ... in inactive context".
      // The previous call's disposers live on the webServer itself, because a
      // reload builds a NEW closure and would otherwise lose track of them —
      // then the second register() hits "duplicate route" and the host keeps
      // serving the dead handler.
      const priorRelease = routeOwners.get(webServer)
      if (typeof priorRelease === 'function') {
        try {
          priorRelease()
        } catch {
          // already released
        }
      }
      routeOwners.set(webServer, releaseRoutes)
      // Older versions of this plugin never released their registrations. The
      // host's exact table is a plain Map in JS; evict stale entries owned by
      // this PREFIX so a reload in an already-running process self-heals
      // without a full DSH restart. Never touch routes from other plugins.
      // Ownership is decided on a path boundary: `/dsh-bazaar` itself or
      // `/dsh-bazaar/...`, never a mere string prefix such as
      // `/dsh-bazaar-next/...` or `/api/dsh-bazaar/...`.
      try {
        const table = webServer.exact
        if (table instanceof Map) {
          for (const key of [...table.keys()]) {
            if (typeof key === 'string' && ownRoutePath(key)) table.delete(key)
          }
        }
      } catch {
        // Host internals are optional; the normal dispose path still works.
      }
      try {
        if (typeof scoped.effect === 'function') {
          scoped.effect(() => () => releaseRoutes(), 'bazaar: web routes')
        }
      } catch {
        // Older hosts may not expose effect on the injected scope; the root
        // context effect below still covers plugin unload.
      }
      const register = route => {
        const dispose = webServer.register(route)
        if (typeof dispose === 'function') routeDisposers.push(dispose)
        return dispose
      }
      try {
      /**
       * 技能安装根目录：优先会话自身的工作区。
       * `<workspace>/.dsh/skills` 正是 dsh-skill-filesystem 的 project-dsh 根
       * （该包 lib/index.js:150-165），写进去下一轮 `<available_skills>` 就能发现；
       * 只有拿不到会话 cwd 时才退回服务端进程目录。
       */
      const workspaceOf = sessionId => {
        const agent = sessionId === undefined ? undefined : deps.sessions.getAgent?.(sessionId)
        const cwd = agent?.session?.header?.cwd
        return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd()
      }

      /**
       * 「记忆系统技能市场」是本插件之外的能力（`dsh-mnemon` 自己的技能管理页）。
       * 没装那个包时这个页签点进去只有一片空白，所以把探测结果一并下发，
       * 由客户端决定是否渲染——判定逻辑只留在服务端一处。
       */
      const mnemonState = async () => {
        if (typeof deps.mnemon !== 'function') return { available: false, version: null, path: null, source: null }
        return deps.mnemon().catch(() => ({ available: false, version: null, path: null, source: null }))
      }

      /**
       * 面板顶的 provider 开关组：已注册的库、各自能力域、本会话点亮了哪些。
       * 拿不到活跃集就返回 null，客户端退回只读会话状态里的 activeProviders。
       */
      const providerSummary = async sessionId => {
        const active = activeOf()
        if (active === undefined || typeof active.describeProviders !== 'function') return null
        try {
          const described = await active.describeProviders(sessionId)
          if (described.ok !== true) return null
          return {
            items: described.items,
            activeProviders: described.activeProviders,
            defaultProvider: described.defaultProvider,
          }
        } catch {
          return null
        }
      }

      const panelState = async sessionId => {
        const state = await deps.sessions.panelState(sessionId)
        const [items, marketTotal, portalAvailable, connectorStatus, connectorsView, mnemon, providers] = await Promise.all([
          categories(),
          deps.market.marketSize().catch(() => null),
          deps.portal?.available?.().catch(() => false) ?? false,
          deps.connector.status().catch(() => undefined),
          connectorSummary(sessionId),
          mnemonState(),
          providerSummary(sessionId),
        ])
        return {
          ...state,
          // 开关组要的是「已注册的库 + 哪些已点亮」，不是活跃集本身。
          providers,
          categories: items,
          market: {
            source: portalAvailable ? 'portal' : 'cos',
            marketTotal,
            portalAvailable,
          },
          mnemon,
          connector: connectorStatus === undefined ? null : {
            installed: connectorStatus.installed,
            accountCount: connectorStatus.accountCount,
            usableAccountCount: connectorStatus.usableAccountCount,
            // token 到底从哪儿来：helper（本插件库）/ vault（兼容层）/ none。
            source: connectorStatus.source ?? null,
            own: connectorStatus.own === undefined ? null : {
              count: connectorStatus.own.count,
              usableCount: connectorStatus.own.usableCount,
            },
          },
          connectors: connectorsView,
        }
      }

      /** 连接器目录：优先 WorkBuddy 连接器市场（需要登录态），失败退回本地快照。 */
      async function catalogSummary() {
        try {
          const market = await deps.portal.listBuddyConnectors({ page: 1, pageSize: 1 })
          return { count: market.total, source: 'workbuddy' }
        } catch {
          try {
            const local = await deps.connectors.catalog()
            return { count: local.total, source: 'local' }
          } catch {
            return { count: 0, source: 'none' }
          }
        }
      }

      async function connectorSummary(sessionId) {
        const controller = deps.connectors
        if (controller === undefined) {
          return { disabled: [], pluginCount: 0, catalogCount: 0, catalogSource: 'none', connectedCount: 0, boundCount: 0 }
        }
        const [plugins, catalogInfo, stateMap] = await Promise.all([
          Promise.resolve().then(() => controller.connectorViews()).catch(() => ({ items: [], total: 0 })),
          catalogSummary(),
          Promise.resolve().then(() => controller.states?.(sessionId)).catch(() => ({})),
        ])
        const states = Object.values(stateMap ?? {})
        return {
          disabled: [...controller.disabledOf(sessionId)],
          pluginCount: plugins.total ?? plugins.items.length,
          catalogCount: catalogInfo.count,
          catalogSource: catalogInfo.source,
          connectedCount: states.filter(state => state?.connected === true).length,
          boundCount: states.filter(state => state?.bound === true).length,
        }
      }

      const handle = fn => async (request, response) => {
        try {
          await fn(request, response)
        } catch (error) {
          if (error instanceof AuthError) {
            send(response, 401, { ok: false, error: `${error.code}: ${error.message}` })
            return
          }
          send(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      register({
        kind: 'exact',
        path: ROUTES.state,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectors,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const controller = deps.connectors
          if (controller === undefined) {
            send(response, 200, { ok: true, view: 'plugins', items: [], total: 0, disabled: [] })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const view = url.searchParams.get('view') === 'catalog' ? 'catalog' : 'plugins'
          const query = text(url.searchParams.get('query')).trim().toLowerCase()
          const category = text(url.searchParams.get('category')).trim() || undefined
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
          const pageSize = Math.max(1, Math.min(Number(url.searchParams.get('pageSize') ?? 24) || 24, 60))

          if (view === 'catalog') {
            let source = 'workbuddy'
            let items = []
            let total = 0
            let categories = []
            let hasMore = false
            try {
              const market = await deps.portal.listBuddyConnectors({ query, page, pageSize })
              items = market.items
              total = market.total
              hasMore = market.hasMore === true
            } catch (error) {
              ctx.logger?.warn?.('bazaar: connector market fallback: %s', error instanceof Error ? error.message : String(error))
              source = 'local'
              const catalog = await Promise.resolve()
                .then(() => controller.catalog())
                .catch(() => ({ items: [], total: 0, categories: [] }))
              const filtered = catalog.items
                .filter(item => category === undefined || item.category === category)
                .filter(item => {
                  if (query === '') return true
                  return [item.id, item.name, item.vendor, item.summary, item.category, ...item.tags]
                    .join(' ')
                    .toLowerCase()
                    .includes(query)
                })
              total = filtered.length
              items = filtered.slice((page - 1) * pageSize, page * pageSize)
              categories = catalog.categories
              hasMore = page * pageSize < filtered.length
            }
            send(response, 200, {
              ok: true,
              view,
              source,
              total,
              categories,
              page,
              pageSize,
              hasMore,
              items,
            })
            return
          }

          const pluginsView = await Promise.resolve()
            .then(() => controller.connectorViews())
            .catch(() => ({ items: [], total: 0 }))
          const filtered = pluginsView.items
            .filter(item => {
              if (query === '') return true
              return [item.id, item.name, item.packageName, item.description]
                .join(' ')
                .toLowerCase()
                .includes(query)
            })
          send(response, 200, {
            ok: true,
            view,
            total: filtered.length,
            items: filtered,
            disabled: [...controller.disabledOf(sessionId)],
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectorsSession,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const controller = deps.connectors
          const sessionId = sessionIdOf(body.sessionId)
          if (controller === undefined || sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const appliedIds = controller.setSession(sessionId, body.disabled)
          send(response, 200, {
            ok: true,
            disabled: appliedIds,
            state: await panelState(sessionId),
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectorsState,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const controller = deps.connectors
          if (controller === undefined || typeof controller.states !== 'function') {
            send(response, 200, { ok: true, configs: [], states: {} })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          const [configs, states] = await Promise.all([
            controller.configs(),
            controller.states(sessionId),
          ])
          send(response, 200, {
            ok: true,
            total: configs.total,
            configs: configs.items,
            states,
            pending: controller.pendingOperations(),
            patchPath: controller.patchPath,
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectorsAction,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const controller = deps.connectors
          if (controller === undefined) {
            send(response, 200, { ok: false, error: 'connector controller unavailable' })
            return
          }
          const connectorId = text(body.connectorId ?? body.id).trim()
          if (connectorId === '') {
            send(response, 400, { ok: false, error: 'connectorId is required' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          const action = text(body.action ?? 'connect').trim()
          // 埋点：用户从本面板跳到连接器管理页去授权/断开。管理页不接受深链，
          // 所以"去过"这件事只能记在我们自己这边，面板回来后才解释得清。
          if (action === 'openConnectorUi') {
            const config = typeof controller.configs === 'function'
              ? (await controller.configs()).items.find(item => item.id === connectorId)
              : undefined
            const serverName = text(body.serverName).trim() !== ''
              ? text(body.serverName).trim()
              : text(config?.serverName).trim()
            const entry = typeof controller.recordUiOpen === 'function'
              ? await controller.recordUiOpen(connectorId, { serverName, sessionId })
              : null
            // 上游 UI 支持深链就用深链，否则退回"跳过去 + 让用户搜索"。
            const capability = typeof controller.uiCapability === 'function'
              ? await controller.uiCapability()
              : { supported: false, param: null }
            const stateMap = typeof controller.states === 'function' ? await controller.states(sessionId) : {}
            send(response, 200, {
              ok: true,
              action,
              connectorId,
              url: connectorUiUrl({
                serverName,
                configId: connectorId,
                deepLinkParam: capability.supported === true ? capability.param : '',
              }),
              hint: connectorUiHint(config, stateMap[connectorId], { deepLink: capability.supported === true }),
              deepLink: capability.supported === true,
              uiOpen: entry,
              state: stateMap[connectorId] ?? null,
            })
            return
          }
          let result
          switch (action) {
            case 'connect':
            case 'repairConnect':
            case 'reauthorize':
              result = await controller.connect(connectorId, {
                action,
                sessionId,
                token: typeof body.token === 'string' ? body.token : undefined,
                header: typeof body.header === 'string' ? body.header : undefined,
                headers: body.headers,
                env: body.env,
                credentials: body.credentials,
              })
              break
            case 'cancel':
              result = await controller.cancelConnect(connectorId)
              break
            case 'disconnect':
              result = await controller.disconnect(connectorId)
              break
            case 'unbind':
              result = await controller.unbind(connectorId)
              break
            case 'updateHeaders':
              result = await controller.updateHeaders(connectorId, body.headers)
              break
            case 'updateEnv':
              result = await controller.updateEnv(connectorId, body.env)
              break
            case 'setEnabled':
              result = await controller.setEnabled(connectorId, body.enabled !== false, sessionId)
              break
            case 'setPatchedDisabled':
              result = await controller.setPatchedDisabled(connectorId, body.disabled === true)
              break
            default:
              send(response, 400, { ok: false, error: `unknown action: ${action}` })
              return
          }
          send(response, 200, {
            ok: result?.success === true || result?.status === 'connecting' || result?.status === 'action-required',
            action,
            connectorId,
            result,
            state: await controller.stateOf(connectorId, sessionId),
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.experts,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          const providerParam = text(url.searchParams.get('provider')).trim()
          const views = viewsOf()
          if (views === undefined) {
            send(response, 503, { ok: false, error: 'expert market views are unavailable' })
            return
          }
          const grouped = await views.listExperts({
            sessionId,
            providers: providerParam === '' ? undefined : [providerParam],
            query: text(url.searchParams.get('query')).trim(),
            categoryId: text(url.searchParams.get('categoryId')).trim() || undefined,
            page: intParam(url, 'page'),
            pageSize: intParam(url, 'pageSize'),
          })
          if (grouped.ok !== true) {
            sendFailure(response, grouped)
            return
          }
          // 本地已装插件不是一家「库」，只是给同名条目加 installed 标记，
          // 以及把库里没有的本地包并进它所属的那家库（见 withLocalExperts）。
          const localItems = await deps.bundles.listLocal().catch(() => [])
          const localPlugins = new Set(localItems.map(item => item.plugin))
          const groups = withLocalExperts(
            grouped.groups.map(group => ({
              ...group,
              items: group.items.map(item => ({
                ...item,
                installed: localPlugins.has(item.plugin),
              })),
            })),
            localItems,
            deps.builtinProviderId,
            text(url.searchParams.get('query')).trim(),
            text(url.searchParams.get('categoryId')).trim() || undefined,
          )
          const items = groups.flatMap(group => group.items)
          const matchedTotal = groups.reduce((sum, group) => sum + (group.matchedTotal ?? 0), 0)
          send(response, 200, {
            ok: true,
            groups,
            items,
            activeProviders: grouped.activeProviders,
            matchedTotal,
            page: grouped.page,
            pageSize: grouped.pageSize,
            hasMore: groups.some(group => group.hasMore === true),
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.skillMarket,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          const providerParam = text(url.searchParams.get('provider')).trim()
          const views = viewsOf()
          if (views === undefined) {
            send(response, 503, { ok: false, error: 'skill market views are unavailable' })
            return
          }
          const grouped = await views.listSkills({
            sessionId,
            providers: providerParam === '' ? undefined : [providerParam],
            query: text(url.searchParams.get('query')).trim(),
            page: intParam(url, 'page'),
            pageSize: intParam(url, 'pageSize'),
          })
          if (grouped.ok !== true) {
            sendFailure(response, grouped)
            return
          }
          const workspace = workspaceOf(sessionId)
          let installed = []
          try {
            installed = await listInstalledSkills(workspace)
          } catch (error) {
            ctx.logger?.warn?.('bazaar: cannot list installed skills: %s', String(error))
          }
          // 归属来自落盘元数据：同名技能在不同库里是两份，面板据此判断「已装的是哪一家的」。
          const installedBy = new Map(installed.map(skill => [skill.slug, skill.providerId ?? null]))
          const groups = grouped.groups.map(group => ({
            ...group,
            items: group.items.map(item => ({
              ...item,
              installed: item.slug === undefined ? false : installedBy.has(item.slug),
              installedBy: item.slug === undefined ? null : (installedBy.get(item.slug) ?? null),
            })),
          }))
          const items = groups.flatMap(group => group.items)
          send(response, 200, {
            ok: true,
            groups,
            items,
            total: items.length,
            activeProviders: grouped.activeProviders,
            page: grouped.page,
            pageSize: grouped.pageSize,
            hasMore: groups.some(group => group.hasMore === true),
            workspace,
            installed: installed.map(skill => skill.slug),
          })
        }),
      })

      /**
       * 真实安装技能：拉市场详情 → 下载签名 zip → 解包到
       * `<workspace>/.dsh/skills/<slug>/`。不再只是"复制 ID"。
       */
      register({
        kind: 'exact',
        path: ROUTES.skillInstall,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const skillId = text(body.skillId).trim()
          if (skillId === '') {
            send(response, 400, { ok: false, error: 'skillId is required' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          const workspace = workspaceOf(sessionId)
          const views = viewsOf()
          if (views === undefined) {
            send(response, 503, { ok: false, error: 'skill market views are unavailable' })
            return
          }
          // 归属必须落在某一家库上：面板传来的 providerId 优先，
          // 否则按会话活跃集推断（唯一活跃库才允许推断）。
          const explicit = text(body.providerId ?? body.provider).trim()
          let providerId = explicit === '' ? undefined : explicit
          if (providerId === undefined) {
            const active = activeOf()
            const resolved = await active?.resolveProvider?.(sessionId, undefined)
            if (resolved?.ok !== true) {
              sendFailure(response, resolved ?? { code: CODES.PROVIDER_REQUIRED, message: '安装技能必须带 providerId' })
              return
            }
            providerId = resolved.providerId
          }
          const result = await views.installSkill({
            providerId,
            skillId,
            workspace,
            // force 由面板上的「强制重试」按钮显式传入，正常重装不带。
            force: body.force === true,
          })
          if (result.ok !== true) {
            if (result.code === CODES.PORTAL_AUTH_REQUIRED || result.code === CODES.MARKET_AUTH_REQUIRED) {
              send(response, 401, { ok: false, authRequired: true, ...result })
              return
            }
            sendFailure(response, result)
            return
          }
          ctx.logger?.info?.(
            'bazaar: installed skill %s -> %s (%d files)',
            result.slug,
            result.installedPath,
            Array.isArray(result.files) ? result.files.length : 0,
          )
          send(response, 200, { ok: true, ...result })
        }),
      })

      /**
       * 账号：本插件自己的库 + 兼容层（dsh-connect-workbuddy 的 vault）。
       *
       * `pending` 是还没扫码完成的登录会话（只有 loginId/region/到期时间，
       * 不含 state——state 是半张凭据，不出服务端）。
       */
      register({
        kind: 'exact',
        path: ROUTES.accounts,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (deps.accounts === undefined) {
            send(response, 200, { ok: true, available: false, own: [], all: [], pending: [], summary: null })
            return
          }
          const view = await deps.accounts.list()
          send(response, 200, {
            ok: true,
            available: true,
            own: view.own,
            all: view.all,
            pending: view.pending,
            summary: view.summary,
          })
        }),
      })

      /**
       * 账号动作。扫码登录是「申请 state → 人在浏览器里授权 → 面板轮询」三段，
       * 所以这里刻意做成动作而不是一条长请求：轮询由客户端定时发，服务端每次只
       * 问上游一次，超时/取消都在客户端表达。
       */
      register({
        kind: 'exact',
        path: ROUTES.accountsAction,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          if (deps.accounts === undefined) {
            send(response, 200, { ok: false, error: 'account service unavailable' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const action = text(body.action ?? 'list').trim()
          try {
            switch (action) {
              case 'start': {
                // 登录区域是必选：缺省或非法值一律 BAZAAR_PARAM_INVALID 并点名 region。
                // 客户端已按「未选就拦在本地」实现，但绕过 UI 直接 POST 必须同样被拒——
                // 否则「必选」只是界面文案，服务端仍会拿 undefined 去猜站点。
                const region = text(body.region).trim()
                if (region !== 'cn' && region !== 'global') {
                  sendFailure(response, {
                    code: CODES.PARAM_INVALID,
                    message:
                      '登录区域必选：region 必须是 cn（国内版）或 global（国际版），收到 ' +
                      JSON.stringify(region),
                    field: 'region',
                    admitted: ['cn', 'global'],
                  })
                  return
                }
                const started = await deps.accounts.start(region)
                if (started.error !== undefined) {
                  send(response, 200, { ok: false, action, error: started.error })
                  return
                }
                send(response, 200, { ok: true, action, ...started })
                return
              }
              case 'poll': {
                const loginId = text(body.loginId).trim()
                if (loginId === '') {
                  send(response, 400, { ok: false, error: 'loginId is required' })
                  return
                }
                const outcome = await deps.accounts.poll(loginId, { region: text(body.region).trim() || undefined })
                // 落库成功要把整份账号状态一起回，客户端不必再多发一次 GET。
                const view = outcome.account === undefined ? null : await deps.accounts.list()
                send(response, 200, { ok: outcome.error === undefined, action, ...outcome, accounts: view })
                return
              }
              case 'cancel': {
                const cancelled = deps.accounts.cancel(text(body.loginId).trim())
                send(response, 200, { ok: true, action, cancelled })
                return
              }
              case 'refresh': {
                const account = await deps.accounts.refresh(text(body.accountId).trim())
                send(response, 200, { ok: true, action, account, accounts: await deps.accounts.list() })
                return
              }
              case 'remove': {
                const outcome = await deps.accounts.remove(text(body.accountId).trim())
                send(response, 200, { ok: true, action, ...outcome, accounts: await deps.accounts.list() })
                return
              }
              case 'importLegacy': {
                const outcome = await deps.accounts.importLegacy()
                send(response, 200, { ok: true, action, ...outcome, accounts: await deps.accounts.list() })
                return
              }
              default:
                send(response, 400, { ok: false, error: `unknown action: ${action}` })
                return
            }
          } catch (error) {
            ctx.logger?.warn?.('bazaar: account action %s failed: %s', action, String(error))
            send(response, 200, { ok: false, action, error: error instanceof Error ? error.message : String(error) })
          }
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.select,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          const expertId = text(body.expertId).trim()
          if (sessionId === undefined || expertId === '') {
            send(response, 400, { ok: false, error: 'sessionId and expertId are required' })
            return
          }
          // providerId 原样透传，缺了由 selectExpert 抛 BAZAAR_PROVIDER_REQUIRED：
          // 四条入口（面板/工具/命令/本路由）必须给出同一个码，不能各自编文案。
          const providerId = text(body.providerId ?? body.provider).trim()
          try {
            await deps.sessions.selectExpert(sessionId, expertId, {
              providerId: providerId === '' ? undefined : providerId,
            })
          } catch (error) {
            if (typeof error?.code === 'string') {
              sendFailure(response, {
                code: error.code,
                message: error instanceof Error ? error.message : String(error),
                ...(error.details ?? {}),
              })
              return
            }
            throw error
          }
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.skills,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          if (sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          // 技能范围按库分区：缺 providerId 由 setSkills 抛 BAZAAR_PROVIDER_REQUIRED。
          const providerId = text(body.providerId ?? body.provider).trim()
          try {
            await deps.sessions.setSkills(
              sessionId,
              {
                globalMode: body.globalMode === 'selected' ? 'selected' : body.globalMode === 'all' ? 'all' : undefined,
                globalNames: list(body.globalNames),
                expertNames: list(body.expertNames),
              },
              { providerId: providerId === '' ? undefined : providerId },
            )
          } catch (error) {
            if (typeof error?.code === 'string') {
              sendFailure(response, {
                code: error.code,
                message: error instanceof Error ? error.message : String(error),
                ...(error.details ?? {}),
              })
              return
            }
            throw error
          }
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.off,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          const sessionId = sessionIdOf(body?.sessionId)
          if (sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          await deps.sessions.clear(sessionId)
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })
      ctx.logger?.info?.('bazaar: web UI routes registered')
      } catch (error) {
        console.error('[bazaar] route registration failed', error)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.('bazaar: web UI routes failed: %s', String(error))
  }
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => releaseRoutes(), 'bazaar: dispose web routes')
    }
  } catch {
    // The scoped effect above is the primary path.
  }
}

export { ROUTES }

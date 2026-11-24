/**
 * provider 集合的 HTTP 路由：列举、单个查询、活跃集写入、按库分组的分域读写（任务 2.6 / 5.1）。
 *
 * 集合入口（list / one / active）与模型工具的 providers 动作、斜杠命令 /bazaar providers 读的
 * 是同一个 createActiveProviderSet 实例，因此「面板、工具、命令、路由四处集合一致」是结构性
 * 成立，不靠各自实现再去算一遍。
 *
 * 与 lib/webui.js 的扁平路由分工：扁平路由（/dsh-bazaar/experts 等）保留给「按会话活跃集
 * 取数」的旧形状；/dsh-bazaar/providers/<id>/... 是 1.0.0 面板真正用的形状——路径段里带
 * providerId，于是「点某一家库的重试」天然只重发那一家（spec: 单库故障隔离），而不是取全量
 * 再前端过滤。两条形状都进同一个 domains.js 入口。
 *
 * 关于本文件里的 send/readBody/sameOrigin：lib/webui.js 有同样的三个小工具，但组 2 的执行
 * 边界不允许改它，所以这里先自带一份最小实现，并把「合并到一处」记成组 4（改 webui.js）的
 * 收口项——已在 tasks.md 的 2.6 证据行点名，不留成隐性重复。
 *
 * 未注册的 provider 走 PROVIDER_UNKNOWN 而不是 404（spec 明确要求）：宿主没有 SPA fallback，
 * 404 在面板里表现为「请求失败」而不是「这个库没注册」，用户看不到可执行的下一步。
 */

import { CODES, fail, ok } from './errors.js'

/**
 * 路径段与请求体 providerId 一致性校验的唯一落点（Rule Boundary 8）。
 * 写路由是插件里唯一「同一请求出现两个 providerId」的形态；比对只在路由入口做一次，
 * 域方法永远收不到 mismatch 码。返回失败信封时**没有调用任何域方法**，因此两个 provider
 * 都不发生写入。
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 与 lib/webui.js 的 PREFIX 同源；用例里有静态断言守这条一致性。 */
export const PROVIDER_PREFIX = '/dsh-bazaar/providers'

export const PROVIDER_ROUTES = {
  list: PROVIDER_PREFIX,
  one: PROVIDER_PREFIX + '/',
  active: PROVIDER_PREFIX + '/active',
}

/**
 * /providers/<id> 下的子段。读路由与写路由共用这一张表：面板、e2e 假服务、静态扫描都读它，
 * 于是「客户端拼的路径」和「服务端认的路径」不会各自漂移。
 */
export const PROVIDER_SUBROUTES = Object.freeze({
  experts: 'experts',
  skillMarket: 'skill-market',
  accounts: 'accounts',
  connectors: 'connectors',
  status: 'status',
  skillInstall: 'skill-install',
  accountsAction: 'accounts/action',
  connectorSession: 'connectors/session',
  connectorAction: 'connectors/action',
  cacheClear: 'cache/clear',
})

/** 拼一个 provider 级路径；sub 为空时就是 /providers/<id>。 */
export function providerRouteOf(providerId, sub) {
  const base = PROVIDER_PREFIX + '/' + encodeURIComponent(String(providerId))
  return sub === undefined || sub === '' ? base : base + '/' + sub
}

const MAX_BODY_BYTES = 64 * 1024

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
    // socket 可能已经断了，这里没有有意义的事可做。
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let failed = false
    request.on('data', (chunk) => {
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
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

/** 写路由的同源校验：浏览器跨站 POST 必带 Origin，比对 Host 即可，不依赖会话 cookie。 */
function sameOrigin(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers?.host
  } catch {
    return false
  }
}

function sessionIdOf(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 256) return undefined
  return trimmed
}

function queryOf(url, name, fallback) {
  const raw = url.searchParams.get(name)
  return raw === null ? fallback : raw
}

/**
 * @param {object} ctx 插件上下文（需要 inject 与可选 logger）
 * @param {object} deps { active, getViews, status }
 *   - active: createActiveProviderSet 的返回值
 *   - getViews: () => createDomainViews 的返回值（getter 以跟随热重载）
 *   - status: createProviderStatus 的返回值（设置页的凭据/缓存投影）
 * @returns {Function|undefined} release（撤掉本组路由）
 */
export function registerProviderRoutes(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return undefined
  const active = deps?.active
  // views 通过 getter 取：热重载会重建域入口，闭包持值会拿到失效实例。
  const viewsOf = () => (typeof deps?.getViews === 'function' ? deps.getViews() : deps?.views)
  const statusOf = () => deps?.status
  if (active === undefined && viewsOf() === undefined) return undefined

  const disposers = []
  const release = function () {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch {
        // 宿主可能已经撤掉了路由。
      }
    }
  }

  const wrap = function (handler) {
    return async function (request, response) {
      try {
        await handler(request, response)
      } catch (error) {
        // 与 lib/webui.js 同一策略：路由层绝不把异常抛给宿主 fiber。
        send(response, 500, {
          ok: false,
          code: CODES.PROVIDER_THROWN,
          error: String(error?.message ?? error),
        })
      }
    }
  }

  ctx.inject(['webServer'], function (scoped) {
    const webServer = scoped?.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('bazaar: webServer.register is unavailable; provider routes skipped')
      return
    }
    const register = function (path, handler, kind) {
      const dispose = webServer.register({ kind: kind ?? 'exact', path: path, handler: handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    }

    /**
     * 写路由的统一前置：同源 → 读体 → 路径/请求体 providerId 一致。
     * 返回 undefined 表示已经发过错误响应，调用方直接 return。
     */
    const writeBody = async function (request, response, pathProviderId) {
      if (!sameOrigin(request)) {
        send(response, 403, { ok: false, error: 'cross-origin request rejected' })
        return undefined
      }
      const body = await readBody(request)
      if (body === undefined) {
        send(response, 400, fail(CODES.PARAM_INVALID, 'invalid JSON body'))
        return undefined
      }
      const bodyProviderId = text(body.providerId)
      if (bodyProviderId === '' || bodyProviderId !== pathProviderId) {
        send(
          response,
          400,
          fail(
            CODES.PROVIDER_ID_MISMATCH,
            '请求体 providerId 与路径段不一致：路径=' +
              JSON.stringify(pathProviderId) +
              '，请求体=' +
              JSON.stringify(bodyProviderId),
            { pathProviderId: pathProviderId, bodyProviderId: bodyProviderId },
          ),
        )
        return undefined
      }
      return body
    }

    register(
      PROVIDER_ROUTES.active,
      wrap(async function (request, response) {
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
          send(response, 400, {
            ok: false,
            code: CODES.PARAM_INVALID,
            error: 'sessionId is required',
          })
          return
        }
        // activeProviders 允许空数组：屏 B 的清空动作就是「提交 [] 并回空态」，服务端必须接受。
        const result = await active.setActive(sessionId, body.activeProviders)
        send(response, result.ok === true ? 200 : 400, result)
      }),
    )

    register(
      PROVIDER_ROUTES.list,
      wrap(async function (request, response) {
        if (request.method !== 'GET') {
          send(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const url = new URL(request.url ?? PROVIDER_ROUTES.list, 'http://localhost')
        // sessionId 可缺省：缺省时只列声明面（设置页不需要会话上下文），active 全 false。
        const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
        const result = await active.describeProviders(sessionId)
        send(response, 200, result)
      }),
    )

    // provider 级路由用 prefix 路由：路径段里的 id 由本函数自己截，宿主没有路径参数解析。
    register(
      PROVIDER_PREFIX,
      wrap(async function (request, response) {
        const url = new URL(request.url ?? PROVIDER_ROUTES.list, 'http://localhost')
        const rest = url.pathname.slice(PROVIDER_PREFIX.length).replace(/^\/+/, '')
        const segments = rest === '' ? [] : rest.split('/')
        const pathProviderId = segments.length > 0 ? segments[0] : ''
        const domainViews = viewsOf()
        const domainReady = domainViews !== undefined && typeof domainViews === 'object'

        // Rule Boundary 8：provider 级连接器写路由。路径段 providerId 用于定位，
        // 请求体 providerId 用于防误投；两者必须完全一致，否则 BAZAAR_PROVIDER_ID_MISMATCH，
        // 且比对发生在调用任何域方法之前——两个 provider 都不发生写入。
        const connectorWrite =
          request.method === 'POST' &&
          segments.length === 3 &&
          segments[1] === 'connectors' &&
          (segments[2] === 'session' || segments[2] === 'action')
        if (connectorWrite) {
          const body = await writeBody(request, response, pathProviderId)
          if (body === undefined) return
          if (domainReady === false || typeof domainViews.connectorAction !== 'function') {
            send(response, 503, fail(CODES.PROVIDER_THROWN, 'connector domain views unavailable'))
            return
          }
          const params = { ...body, providerId: pathProviderId }
          // session 路由承载会话级状态动作，action 路由承载其余七动作；两者都进同一个
          // 域入口，由 provider 侧的动作白名单决定支持与否（此处不下放门控判定）。
          const action = segments[2] === 'session' ? 'state' : params.action
          const result = await domainViews.connectorAction({ ...params, action })
          send(response, result?.ok === false ? 400 : 200, result ?? ok({}))
          return
        }

        // 账号动作：/providers/<id>/accounts/action（登录三段式、刷新、移除都由 provider 落地）。
        if (request.method === 'POST' && segments.length === 3 && segments[1] === 'accounts') {
          if (segments[2] !== 'action') {
            send(response, 400, fail(CODES.PARAM_INVALID, '账号子段只有 accounts/action'))
            return
          }
          const body = await writeBody(request, response, pathProviderId)
          if (body === undefined) return
          if (domainReady === false || typeof domainViews.accountAction !== 'function') {
            send(response, 503, fail(CODES.PROVIDER_THROWN, 'account domain views unavailable'))
            return
          }
          const result = await domainViews.accountAction({ ...body, providerId: pathProviderId })
          send(response, result?.ok === false ? 400 : 200, result ?? ok({}))
          return
        }

        // 技能安装：/providers/<id>/skill-install（归属按库记录，冲突检测依赖 providerId）。
        if (request.method === 'POST' && segments.length === 2 && segments[1] === 'skill-install') {
          const body = await writeBody(request, response, pathProviderId)
          if (body === undefined) return
          if (domainReady === false || typeof domainViews.installSkill !== 'function') {
            send(response, 503, fail(CODES.PROVIDER_THROWN, 'skill domain views unavailable'))
            return
          }
          const result = await domainViews.installSkill({
            providerId: pathProviderId,
            skillId: body.skillId,
            force: body.force === true,
            workspace: body.workspace,
          })
          send(response, result?.ok === false ? 400 : 200, result ?? ok({}))
          return
        }

        // 缓存清理：/providers/<id>/cache/clear（只清这一家的 cache 子树）。
        if (request.method === 'POST' && segments.length === 3 && segments[1] === 'cache') {
          if (segments[2] !== 'clear') {
            send(response, 400, fail(CODES.PARAM_INVALID, '缓存子段只有 cache/clear'))
            return
          }
          const body = await writeBody(request, response, pathProviderId)
          if (body === undefined) return
          const status = statusOf()
          if (status === undefined || typeof status.clearCache !== 'function') {
            send(response, 503, fail(CODES.PROVIDER_THROWN, 'provider status service unavailable'))
            return
          }
          const result = await status.clearCache(pathProviderId)
          send(response, result?.ok === false ? 400 : 200, result ?? ok({}))
          return
        }

        if (request.method === 'GET' && segments.length === 2) {
          const sub = segments[1]
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sub === 'status') {
            const status = statusOf()
            if (status === undefined || typeof status.describe !== 'function') {
              send(
                response,
                503,
                fail(CODES.PROVIDER_THROWN, 'provider status service unavailable'),
              )
              return
            }
            const result = await status.describe(pathProviderId, sessionId)
            send(response, result?.ok === false ? 400 : 200, result)
            return
          }
          const readers = {
            experts: 'listExperts',
            'skill-market': 'listSkills',
            accounts: 'listAccounts',
            connectors: 'listConnectors',
          }
          const method = readers[sub]
          if (method === undefined) {
            send(
              response,
              400,
              fail(
                CODES.PARAM_INVALID,
                'provider 路由未识别：GET 支持 /providers、/providers/<id>、/providers/<id>/{' +
                  Object.keys(readers).join(',') +
                  ',status}，POST 支持 /providers/active、/providers/<id>/{' +
                  [
                    PROVIDER_SUBROUTES.skillInstall,
                    PROVIDER_SUBROUTES.accountsAction,
                    PROVIDER_SUBROUTES.cacheClear,
                    'connectors/session',
                    'connectors/action',
                  ].join(',') +
                  '}',
                { path: url.pathname, segments: segments.slice(0) },
              ),
            )
            return
          }
          if (domainReady === false || typeof domainViews[method] !== 'function') {
            send(response, 503, fail(CODES.PROVIDER_THROWN, 'domain views unavailable'))
            return
          }
          const params = {
            sessionId: sessionId,
            // 显式 providers:[id] 是「只重发这一家」的唯一表达，取数不会波及另一家。
            providers: [pathProviderId],
            query: queryOf(url, 'query', ''),
            page: queryOf(url, 'page', undefined),
            pageSize: queryOf(url, 'pageSize', undefined),
          }
          if (sub === 'experts') params.categoryId = queryOf(url, 'categoryId', undefined)
          if (sub === 'connectors') params.status = queryOf(url, 'status', '')
          const result = await domainViews[method](params)
          send(response, result?.ok === false ? 400 : 200, result)
          return
        }

        const list = request.method === 'GET' && rest === ''
        if (list) {
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          send(response, 200, await active.describeProviders(sessionId))
          return
        }
        if (request.method !== 'GET') {
          send(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        // /providers/<id>；带子段的已在上面各分支处理，未识别的子段不静默当单条查询。
        if (segments.length !== 1 || pathProviderId === '') {
          send(response, 400, {
            ok: false,
            code: CODES.PARAM_INVALID,
            error: 'provider route needs exactly /providers/<id>',
          })
          return
        }
        const result = await active.resolveProvider(
          sessionIdOf(url.searchParams.get('sessionId')),
          pathProviderId,
        )
        if (result.ok === false) {
          // 未注册必须是 PROVIDER_UNKNOWN 而不是 404：面板要能显示「这家库没注册」。
          send(response, 400, result)
          return
        }
        send(response, 200, result)
      }),
      'prefix',
    )

    ctx.logger?.info?.('bazaar: provider routes registered at ' + PROVIDER_PREFIX)
  })

  return release
}

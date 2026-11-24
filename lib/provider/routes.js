/**
 * provider 集合的 HTTP 路由：列举、单个查询、活跃集写入（任务 2.6）。
 *
 * 这三条与模型工具的 providers 动作、斜杠命令 /bazaar providers 读的是同一个
 * createActiveProviderSet 实例，因此「面板、工具、命令、路由四处集合一致」是结构性成立，
 * 不靠各自实现再去算一遍。
 *
 * 关于本文件里的 send/readBody/sameOrigin：lib/webui.js 有同样的三个小工具，但组 2 的
 * 执行边界不允许改它，所以这里先自带一份最小实现，并把「合并到一处」记成组 4（改 webui.js）
 * 的收口项——已在 tasks.md 的 2.6 证据行点名，不留成隐性重复。
 *
 * 未注册的 provider 走 PROVIDER_UNKNOWN 而不是 404（spec 明确要求）：宿主没有 SPA fallback，
 * 404 在面板里表现为「请求失败」而不是「这个库没注册」，用户看不到可执行的下一步。
 */

import { CODES, fail, ok } from './errors.js'

/**
 * 路径段与请求体 providerId 一致性校验的唯一落点（Rule Boundary 8）。
 * 这两条写路由是插件里唯一「同一请求出现两个 providerId」的形态；比对只在
 * 路由入口做一次，域方法永远收不到 mismatch 码。返回失败信封时**没有调用任何
 * 域方法**，因此两个 provider 都不发生写入。
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

/**
 * @param {object} ctx 插件上下文（需要 inject 与可选 logger）
 * @param {object} deps { active } —— active 为 createActiveProviderSet 的返回值
 * @returns {Function|undefined} release（撤掉本组路由）
 */
export function registerProviderRoutes(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return undefined
  const active = deps?.active
  // views 通过 getter 取：热重载会重建域入口，闭包持值会拿到失效实例。
  const viewsOf = () => (typeof deps?.getViews === 'function' ? deps.getViews() : deps?.views)
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

    // 单个 provider 查询用 prefix 路由：路径段里的 id 由本函数自己截，宿主没有路径参数解析。
    register(
      PROVIDER_PREFIX,
      wrap(async function (request, response) {
        const url = new URL(request.url ?? PROVIDER_ROUTES.list, 'http://localhost')
        const rest = url.pathname.slice(PROVIDER_PREFIX.length).replace(/^\/+/, '')
        const segments = rest.split('/')

        // Rule Boundary 8：provider 级连接器写路由。路径段 providerId 用于定位，
        // 请求体 providerId 用于防误投；两者必须完全一致，否则 BAZAAR_PROVIDER_ID_MISMATCH，
        // 且比对发生在调用任何域方法之前——两个 provider 都不发生写入。
        const connectorWrite =
          request.method === 'POST' &&
          segments.length === 3 &&
          segments[1] === 'connectors' &&
          (segments[2] === 'session' || segments[2] === 'action')
        if (connectorWrite) {
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, fail(CODES.PARAM_INVALID, 'invalid JSON body'))
            return
          }
          const pathProviderId = segments[0]
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
                { pathProviderId, bodyProviderId },
              ),
            )
            return
          }
          const domainViews = viewsOf()
          if (domainViews === undefined || typeof domainViews.connectorAction !== 'function') {
            send(response, 503, fail(CODES.PROVIDER_THROWN, 'connector domain views unavailable'))
            return
          }
          const params = { ...body, providerId: bodyProviderId }
          // session 路由承载会话级状态动作，action 路由承载其余七动作；两者都进同一个
          // 域入口，由 provider 侧的动作白名单决定支持与否（此处不下放门控判定）。
          const action = segments[2] === 'session' ? 'state' : params.action
          const result = await domainViews.connectorAction({ ...params, action })
          send(response, result?.ok === false ? 400 : 200, result ?? ok({}))
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
        // /providers/<id>；带子段的（/providers/<id>/xxx）留给组 3/4 的分组路由，这里不误吞。
        if (segments.length !== 1 || segments[0] === '') {
          send(response, 400, {
            ok: false,
            code: CODES.PARAM_INVALID,
            error: 'provider route needs exactly /providers/<id>',
          })
          return
        }
        const result = await active.resolveProvider(
          sessionIdOf(url.searchParams.get('sessionId')),
          segments[0],
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

/**
 * WorkBuddy 自己的登录（插件 OAuth），不依赖 `dsh-connect-workbuddy`。
 *
 * 为什么可以自己做：那套插件的价值在于「vault 文件格式 + 模型 provider」，
 * 登录本身只是三个公开端点。三个端点实测都还活着（见 docs/workbuddy-own-login.md）：
 *
 *   POST {base}/v2/plugin/auth/state?platform=workbuddy
 *        -> { code:0, data:{ state, authUrl } }        申请一个 state，拿到给人扫的 URL
 *   GET  {base}/v2/plugin/auth/token?state=<state>
 *        -> 未完成 { code:11217, msg:'login ing...' }；完成 { code:0, data:{ accessToken, refreshToken, expiresIn, domain } }
 *   GET  {base}/v2/plugin/account            （Bearer）
 *        -> { code:0, data:{ uid, nickname, uin, avatarUrl, ... } }
 *        -> 旧端点 /v2/plugin/login/account 对任何凭据都回 12151 空 data，只能当回退
 *   POST {base}/v2/plugin/auth/token/refresh （X-Refresh-Token，无 Authorization）
 *        -> 坏 token 回 401 { code:12153 }，正常回 { code:0, data:{ accessToken, ... } }
 *
 * 区域决定 base，且**必须**在申请 state 之前定下来：一个域名签发的 token 会被
 * 另一个域名的网关拒绝，所以"先拿 token 再换域名"这条路不存在。
 *
 * 本模块没有任何 DSH import，fetch 与时钟都可注入，单测不联网。
 */

import { randomUUID } from 'node:crypto'

import { assertAllowedUrl, AuthError } from './auth.js'

/** 上游把它当成"官方客户端"的 UA。刷新端点不带它会得到不同的答复。 */
export const WB_CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

const API_PREFIX = '/v2/plugin'
/** 一次登录从申请 state 起算的有效期：上游自己的登录页也是十分钟级别。 */
const LOGIN_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 允许发请求的域名。刻意是白名单而不是"用户随便填"：这条链路会送出
 * `accessToken` / `refreshToken`，域名写错就是把凭据交给别人。
 */
export const REGIONS = Object.freeze({
  cn: Object.freeze({
    id: 'cn',
    label: '国内版',
    base: 'https://www.codebuddy.cn',
    hosts: Object.freeze(['www.codebuddy.cn']),
  }),
  global: Object.freeze({
    id: 'global',
    label: '国际版',
    base: 'https://www.workbuddy.ai',
    // 国际版两个品牌域名各自签发，互不承认；两个都要在白名单里。
    hosts: Object.freeze(['www.workbuddy.ai', 'www.codebuddy.ai']),
  }),
})

/** 账号 `domain` → 区域。认不出来时按国内版处理（国内是单宿主）。 */
export function regionOfDomain(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * 区域 → 起始 base。这里只负责"默认域名映射 + URL 解析"，**不再自带 host /
 * HTTPS 白名单**：那是出网判定，唯一落点是 assertAllowedUrl（传 provider 的
 * urlConfig）。两处各判一次会漂移，且 baseForRegion 抛的是无码普通 Error。
 */
export function baseForRegion(region, explicitBase) {
  const known = REGIONS[region] ?? REGIONS.cn
  const candidate = String(explicitBase ?? '').trim().replace(/\/+$/, '')
  if (candidate === '') return known.base
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`not a URL: ${candidate}`)
  }
  return parsed.origin
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 出网校验配置：由 provider 通过 `urlConfig` 注入（allowHosts/allowInsecureLoopback），
 * 走与在线市场/公开快照/技能下载同一个 assertAllowedUrl 落点。未注入时（离线单测、
 * 独立实例）退回两区域自己的已知域名——那段域名表是上游区域定义，不是 provider
 * 白名单，仅作兼容缺省；生产路径一律由 provider 传入自己那份 urlConfig。
 *
 * @param {{urlConfig?: object, allowHosts?: string[], allowInsecureLoopback?: boolean}} options
 */
function urlConfigOf(options = {}) {
  if (options.urlConfig !== null && typeof options.urlConfig === 'object') return options.urlConfig
  if (Array.isArray(options.allowHosts) || options.allowInsecureLoopback === true) {
    return {
      allowHosts: Array.isArray(options.allowHosts) ? options.allowHosts : [],
      allowInsecureLoopback: options.allowInsecureLoopback === true,
    }
  }
  return {
    allowHosts: [...REGIONS.cn.hosts, ...REGIONS.global.hosts],
    allowInsecureLoopback: false,
  }
}

/** 读一个信封响应；非 JSON 返回 undefined，让调用方决定严重性。 */
async function readEnvelope(response) {
  let body
  try {
    body = await response.text()
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: response.status, code: null, message: '', data: {}, raw: body }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: response.status, code: null, message: '', data: {}, raw: body }
  }
  const data = parsed.data !== null && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data : {}
  const rawCode = parsed.code
  const code = typeof rawCode === 'number' ? rawCode : Number.isFinite(Number(rawCode)) ? Number(rawCode) : null
  const message = typeof parsed.msg === 'string' ? parsed.msg : typeof parsed.message === 'string' ? parsed.message : ''
  return { status: response.status, code, message, data, raw: body }
}

/** 取第一个非空字符串；数字也接受（上游偶尔把 uin 发成 number）。 */
export function firstString(source, keys) {
  if (source === null || typeof source !== 'object') return ''
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function optionalString(source, keys) {
  const value = firstString(source, keys)
  return value === '' ? undefined : value
}

/**
 * 到期时间：上游可能给绝对时间（秒或毫秒）也可能给相对 TTL（秒）。
 * 1e12 是毫秒/秒的分界（2001 年 vs 33658 年），和 dsh-connect-workbuddy 的判据一致。
 */
export function expiryMs(source, absoluteKeys, ttlKeys = [], now = Date.now()) {
  for (const key of absoluteKeys) {
    const value = source?.[key]
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  }
  for (const key of ttlKeys) {
    const value = source?.[key]
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    if (Number.isFinite(numeric) && numeric > 0) return now + numeric * 1000
  }
  return undefined
}

/**
 * 解 accessToken 的 JWT 载荷，**只为身份展示**。
 *
 * 这不是鉴权：token 已经被 `/auth/token` 接受，这里的每个字节都由持有者控制。
 * 只在 profile 接口答空时用来补 uid/nickname，绝不拿来当权限判据。
 */
export function decodeJwtIdentity(token) {
  const empty = { sub: '', nickname: '', uin: '', preferredUsername: '' }
  if (typeof token !== 'string') return empty
  const parts = token.split('.')
  if (parts.length < 2) return empty
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return empty
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return empty
  return {
    sub: firstString(payload, ['sub', 'Sub']),
    nickname: firstString(payload, ['nickname', 'NickName']),
    uin: firstString(payload, ['uin', 'Uin']),
    preferredUsername: firstString(payload, ['preferred_username', 'preferredUsername', 'PreferredUsername']),
  }
}

function hasIdentity(profile) {
  return firstString(profile, ['uid', 'Uid', 'userId', 'UserID']) !== ''
}

/**
 * 用 accessToken 拉账号资料，拼出可落库的凭据。
 *
 * 顺序是有原因的：`/login/account` 对任何凭据都回 `12151` 空 data，先问它会让
 * 每个账号都算成"未命名"，彼此覆盖。所以先 `/account`，旧端点只当回退，
 * 两者都没有 uid 时最后读 token 自己的声明。
 */
export async function collectAccount(options) {
  const { base, accessToken, tokenData = {}, fetchImpl, now = Date.now() } = options
  const doFetch = fetchImpl ?? fetch
  // 出网点之一：和在线市场/快照/技能下载共用 assertAllowedUrl。校验收紧在循环
  // 之外，AuthError 不能被下面 "换端点再试" 的 catch 吞掉当成继续发请求。
  assertAllowedUrl(`${base}${API_PREFIX}/account`, urlConfigOf(options))
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': WB_CLIENT_UA,
  }
  const domain = firstString(tokenData, ['domain', 'Domain'])
  if (domain !== '') headers['X-Domain'] = domain

  let profile = {}
  for (const profilePath of [`${API_PREFIX}/account`, `${API_PREFIX}/login/account`]) {
    let envelope
    try {
      envelope = await readEnvelope(await doFetch(`${base}${profilePath}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }))
    } catch {
      continue
    }
    if (envelope === undefined) continue
    if (!hasIdentity(envelope.data)) continue
    profile = envelope.data
    break
  }

  const jwt = decodeJwtIdentity(accessToken)
  const uid = firstString(profile, ['uid', 'Uid', 'userId', 'UserID']) || jwt.sub
  if (uid === '') {
    throw new Error('无法识别这个账号：上游没有返回账号资料，登录令牌里也没有可用的身份信息。稍后重新登录；如果一直这样，说明这种登录方式不再提供身份信息。')
  }
  const nickname = optionalString(profile, ['nickname', 'NickName', 'ScreenName'])
    ?? optionalString(jwt, ['nickname'])
    ?? optionalString(jwt, ['preferredUsername'])
  const uin = optionalString(profile, ['uin', 'Uin']) ?? optionalString(jwt, ['uin'])
  const avatarUrl = optionalString(profile, ['avatarUrl', 'avatar_url', 'AvatarUrl'])
  const enterpriseId = optionalString(profile, ['enterpriseId', 'EnterpriseId'])
  const expiresAtMs = expiryMs(tokenData, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in'], now)
  const refreshExpiresAtMs = expiryMs(tokenData, ['refreshExpiresAt', 'refresh_expires_at'], ['refreshExpiresIn', 'refresh_expires_in'], now)

  return {
    uid,
    ...nickname === undefined ? {} : { nickname },
    ...uin === undefined ? {} : { uin },
    ...avatarUrl === undefined ? {} : { avatarUrl },
    ...enterpriseId === undefined ? {} : { enterpriseId },
    accessToken,
    refreshToken: firstString(tokenData, ['refreshToken', 'refresh_token', 'RefreshToken']),
    domain: domain !== '' ? domain : firstString(profile, ['domain', 'Domain']),
    ...expiresAtMs === undefined ? {} : { expiresAtMs },
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
  }
}

/**
 * 申请一次登录。返回的 `verificationUri` 是给人打开的页面。
 *
 * 上游拒绝也**不抛**：面板要把原因渲染在原地，而不是走异常路径把整块 UI 打掉。
 */
export async function startLogin(region, options = {}) {
  const doFetch = options.fetchImpl ?? fetch
  let base
  try {
    base = baseForRegion(region, options.base)
  } catch (error) {
    return { error: messageOf(error) }
  }
  // 出网点之一：和在线市场/快照/技能下载共用 assertAllowedUrl（传本 provider
  // 的 urlConfig）。失败以 BAZAAR_* 码返回，且在发出任何请求之前拦下。
  let target
  try {
    target = assertAllowedUrl(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, urlConfigOf(options)).href
  } catch (error) {
    if (error instanceof AuthError) return { code: error.code, error: error.message }
    return { error: messageOf(error) }
  }
  let envelope
  try {
    envelope = await readEnvelope(await doFetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': WB_CLIENT_UA,
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }))
  } catch (error) {
    return { error: `could not reach ${base} to start the sign-in (${messageOf(error)})` }
  }
  if (envelope === undefined) return { error: `the sign-in service answered with a non-JSON body (http ${'?'})` }
  const state = firstString(envelope.data, ['state', 'State'])
  if (state === '') {
    // `code === null` 说明上游回的不是 JSON 信封（网关页、拦截页……），
    // 那种答复里不会有 state；和"信封里没 state"分开说，排查方向不同。
    const detail = envelope.code === null
      ? 'answered with a non-JSON body'
      : `did not issue a state (http ${envelope.status}${envelope.message === '' ? '' : `, ${envelope.message}`})`
    return { error: `the sign-in service ${detail}` }
  }
  const verificationUri = firstString(envelope.data, ['authUrl', 'auth_url', 'url', 'Url'])
    || `${base}/login?platform=workbuddy&state=${encodeURIComponent(state)}`
  return {
    base,
    region: regionOfDomain(new URL(base).hostname) === 'global' ? 'global' : 'cn',
    state,
    verificationUri,
    expiresIn: Math.round(LOGIN_TTL_MS / 1000),
  }
}

/** 这些 code 表示"这次登录已经没救了"，其余非 0 一律当"还没完成"。 */
const TERMINAL_CODES = new Set([12153, 12151, 40001, 41001])

/**
 * 轮询一次。未完成返回 `{ done:false, pending:true, code, message }`，
 * 完成返回 `{ done:true, account }`；失败返回 `{ done:true, error }`。
 *
 * 顺序有讲究：会话的 region/base 绑定在任何 I/O **之前**校验，所以一个点名了
 * 别的页签的轮询不会发出请求，未知 id 也不会。
 */
export async function pollLogin(session, options = {}) {
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now()
  if (now > session.expiresAtMs) {
    return { done: true, code: 'BAZAAR_LOGIN_EXPIRED', error: 'the sign-in timed out; start again' }
  }
  // 出网点之一：与其余入口共用 assertAllowedUrl。校验放在 transport catch
  // 之外，越界 host 直接给 BAZAAR_* 终态，不会被当成"还没扫完"继续轮询。
  let target
  try {
    target = assertAllowedUrl(
      `${session.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`,
      urlConfigOf(options),
    ).href
  } catch (error) {
    if (error instanceof AuthError) return { done: true, code: error.code, error: error.message }
    return { done: true, error: messageOf(error) }
  }
  let envelope
  try {
    envelope = await readEnvelope(await doFetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': WB_CLIENT_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }))
  } catch {
    return { done: false, pending: true }
  }
  if (envelope === undefined) return { done: false, pending: true }

  const okCode = envelope.code === 0 || envelope.code === 200
  if (!okCode) {
    if (envelope.code !== null && TERMINAL_CODES.has(envelope.code)) {
      return { done: true, error: envelope.message || `the sign-in failed (code ${envelope.code})` }
    }
    return { done: false, pending: true, code: envelope.code, message: envelope.message }
  }

  const accessToken = firstString(envelope.data, ['accessToken', 'access_token', 'AccessToken'])
  if (accessToken === '') return { done: false, pending: true, code: envelope.code, message: envelope.message }

  try {
    const account = await collectAccount({
      base: session.base,
      accessToken,
      tokenData: envelope.data,
      fetchImpl: doFetch,
      now,
      ...options.urlConfig === undefined ? {} : { urlConfig: options.urlConfig },
      ...options.allowHosts === undefined ? {} : { allowHosts: options.allowHosts },
      ...options.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: options.allowInsecureLoopback },
    })
    return { done: true, account }
  } catch (error) {
    return { done: true, error: messageOf(error) }
  }
}

/**
 * 刷新凭据。只有 refreshToken 有效时才有意义。
 *
 * 头是照上游刷新端点实测的形状发的：不带 `X-Refresh-Token` 会被当成格式错误，
 * `Origin`/`Referer`/UA 三个也都在（少了它们这条"失败等于掉登录"的链路更脆）。
 * 刻意不发 `Authorization`：刷新用的就是 refresh token，不该同时递旧 access。
 */
export async function refreshCredential(options) {
  const { credential, fetchImpl, now = Date.now() } = options
  const doFetch = fetchImpl ?? fetch
  const refreshToken = String(credential?.refreshToken ?? '')
  if (refreshToken === '') throw new Error('this account has no refresh token; sign in again')
  const base = baseForRegion(regionOfDomain(credential?.domain), credential?.base)
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: base,
    Referer: `${base}/`,
    'User-Agent': WB_CLIENT_UA,
    'X-Refresh-Token': refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (typeof credential?.enterpriseId === 'string' && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  // 出网点之一（连接器刷新与登录刷新共用此函数）：与其余入口共用
  // assertAllowedUrl，越界 host / 非 HTTPS 一律 BAZAAR_* 码，发请求之前拦下。
  const target = assertAllowedUrl(`${base}${API_PREFIX}/auth/token/refresh`, urlConfigOf(options)).href
  const envelope = await readEnvelope(await doFetch(target, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  if (envelope === undefined) throw new Error('the refresh endpoint answered with a non-JSON body')
  if (envelope.code !== 0) {
    throw new Error(`refresh failed (${envelope.code === null ? `http ${envelope.status}` : envelope.code}): ${envelope.message || 'unknown'}`)
  }
  const accessToken = firstString(envelope.data, ['accessToken', 'access_token'])
  if (accessToken === '') throw new Error('the refresh endpoint returned no accessToken; sign in again')
  const expiresAtMs = expiryMs(envelope.data, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in'], now)
  const refreshExpiresAtMs = expiryMs(envelope.data, ['refreshExpiresAt', 'refresh_expires_at'], ['refreshExpiresIn', 'refresh_expires_in'], now)
  return {
    accessToken,
    refreshToken: firstString(envelope.data, ['refreshToken', 'refresh_token']) || refreshToken,
    domain: firstString(envelope.data, ['domain', 'Domain']) || credential?.domain || '',
    ...expiresAtMs === undefined ? {} : { expiresAtMs },
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
  }
}

/**
 * 一次进程内的登录会话表。
 *
 * 刻意不落盘：state 是半张凭据，重启即作废比"写进文件再忘了清"安全。
 * 工厂而不是模块级单例，是为了让每个插件实例（以及每个测试）互不干扰。
 */
export function createLoginStore(options = {}) {
  const ttlMs = Number(options.ttlMs ?? LOGIN_TTL_MS)
  const sessions = new Map()

  const prune = now => {
    for (const [id, session] of sessions) {
      if (now > session.expiresAtMs) sessions.delete(id)
    }
  }

  return {
    async start(region, startOptions = {}) {
      const now = startOptions.now ?? Date.now()
      prune(now)
      const started = await startLogin(region, startOptions)
      if (started.error !== undefined) return started
      const loginId = `bz_${randomUUID().replaceAll('-', '')}`
      sessions.set(loginId, {
        loginId,
        region: started.region,
        base: started.base,
        state: started.state,
        expiresAtMs: now + ttlMs,
      })
      return { loginId, verificationUri: started.verificationUri, expiresIn: Math.round(ttlMs / 1000), region: started.region, base: started.base }
    },

    async poll(loginId, pollOptions = {}) {
      const now = pollOptions.now ?? Date.now()
      const session = sessions.get(loginId)
      if (session === undefined) {
        return { done: true, code: 'BAZAAR_LOGIN_EXPIRED', error: 'sign-in session not found; start a new one' }
      }
      if (pollOptions.region !== undefined && pollOptions.region !== session.region) {
        return { done: true, code: 'BAZAAR_PARAM_INVALID', field: 'region', error: 'this sign-in started in another region tab' }
      }
      const outcome = await pollLogin(session, { ...pollOptions, now })
      if (outcome.done === true) sessions.delete(loginId)
      return outcome
    },

    cancel(loginId) {
      return sessions.delete(loginId)
    },

    /** 只读探针，给 `status` 与测试用；不含 state。 */
    list(now = Date.now()) {
      prune(now)
      return [...sessions.values()].map(session => ({
        loginId: session.loginId,
        region: session.region,
        base: session.base,
        expiresAtMs: session.expiresAtMs,
      }))
    },

    get size() {
      return sessions.size
    },
  }
}

/**
 * BAZAAR_* 错误码登记表与统一信封封装。
 *
 * 为什么单独成模块：契约要求「域方法失败 MUST 以 {ok:false, code, message} 表达、
 * MUST NOT 抛异常穿透」（specs/provider-registry：provider 必须同时提供声明面与行为面）。
 * 这条只能在**边界处**兑现——注册表与路由层拿到 provider 的 impl 后统一经 toEnvelope()
 * 折算，否则第三方实现里一句 throw 就把异常顶到宿主 fiber 上，面板看到的是 500
 * 而不是可诊断的错误码。
 *
 * 码名纪律：本表是 1.0.0 的唯一码名清单，五域、注册表与路由层共用；新增码必须先登记
 * 到这里，再写进 docs/provider-integration.md 的码表（任务 2.7）。两个在 1.0.0 被移除的
 * 连接器码（BAZAAR_CONNECTOR_MISSING / BAZAAR_CONNECTOR_NO_TOKEN）刻意不入表——源仓那两处
 * 字面量由组 4 改写为 provider 级 BAZAAR_AUTH_MISSING / BAZAAR_CONNECTOR_NOT_FOUND。
 */

export const CODES = Object.freeze({
  PROVIDER_API_VERSION: 'BAZAAR_PROVIDER_API_VERSION',
  PROVIDER_INVALID_ID: 'BAZAAR_PROVIDER_INVALID_ID',
  PROVIDER_DUPLICATE: 'BAZAAR_PROVIDER_DUPLICATE',
  PROVIDER_IMPL_MISSING: 'BAZAAR_PROVIDER_IMPL_MISSING',
  PROVIDER_REQUIRED: 'BAZAAR_PROVIDER_REQUIRED',
  PROVIDER_UNKNOWN: 'BAZAAR_PROVIDER_UNKNOWN',
  PROVIDER_ID_MISMATCH: 'BAZAAR_PROVIDER_ID_MISMATCH',
  // 契约要求域方法不抛异常；真抛了就是违约，必须给出可诊断的码，而不是让异常穿透。
  PROVIDER_THROWN: 'BAZAAR_PROVIDER_THROWN',
  CAPABILITY_UNDECLARED: 'BAZAAR_CAPABILITY_UNDECLARED',
  PARAM_INVALID: 'BAZAAR_PARAM_INVALID',
  EXPERT_NOT_FOUND: 'BAZAAR_EXPERT_NOT_FOUND',
  MARKET_AUTH_REQUIRED: 'BAZAAR_MARKET_AUTH_REQUIRED',
  MARKET_RATE_LIMITED: 'BAZAAR_MARKET_RATE_LIMITED',
  MARKET_UNAVAILABLE: 'BAZAAR_MARKET_UNAVAILABLE',
  PORTAL_AUTH_REQUIRED: 'BAZAAR_PORTAL_AUTH_REQUIRED',
  MEMORY_UNAVAILABLE: 'BAZAAR_MEMORY_UNAVAILABLE',
  SKILL_NAME_CONFLICT: 'BAZAAR_SKILL_NAME_CONFLICT',
  SKILL_SLUG_INVALID: 'BAZAAR_SKILL_SLUG_INVALID',
  SKILL_PACKAGE_TOO_LARGE: 'BAZAAR_SKILL_PACKAGE_TOO_LARGE',
  CONNECTOR_NOT_FOUND: 'BAZAAR_CONNECTOR_NOT_FOUND',
  CONNECTOR_ACTION_UNSUPPORTED: 'BAZAAR_CONNECTOR_ACTION_UNSUPPORTED',
  AUTH_MISSING: 'BAZAAR_AUTH_MISSING',
  AUTH_INLINE: 'BAZAAR_AUTH_INLINE',
  AUTH_MODE: 'BAZAAR_AUTH_MODE',
  AUTH_HEADER_MISSING: 'BAZAAR_AUTH_HEADER_MISSING',
  CREDENTIALS_MISSING: 'BAZAAR_CREDENTIALS_MISSING',
  LOGIN_EXPIRED: 'BAZAAR_LOGIN_EXPIRED',
  HOST_DENIED: 'BAZAAR_HOST_DENIED',
  URL_INVALID: 'BAZAAR_URL_INVALID',
  URL_INSECURE: 'BAZAAR_URL_INSECURE',
  URL_USERINFO: 'BAZAAR_URL_USERINFO',
})

export class BazaarError extends Error {
  /**
   * @param {string} code CODES 中的码名
   * @param {string} message 人话说明，允许带 providerId / 域名 / 方法名等定位信息
   * @param {object} [details] 平铺进信封的附加字段（必须 JSON 可序列化）
   */
  constructor(code, message, details) {
    super(message === undefined || message === null ? String(code) : String(message))
    this.name = 'BazaarError'
    this.code = code
    if (details !== undefined && details !== null) this.details = details
  }
}

/** 失败信封：{ ok:false, code, message }，details 平铺在同一层（契约要求返回平铺 JSON）。 */
export function fail(code, message, details) {
  const envelope = {
    ok: false,
    code,
    message: message === undefined || message === null ? String(code) : String(message),
  }
  if (details !== undefined && details !== null) {
    for (const [key, value] of Object.entries(details)) envelope[key] = value
  }
  return envelope
}

/**
 * 成功信封：把领域返回体平铺到 { ok:true } 之下。
 * 刻意不另立 DTO——领域结构（items / total / source / item / slug …）原样上浮，外层只加 ok。
 */
export function ok(payload) {
  if (payload === undefined || payload === null) return { ok: true }
  if (typeof payload !== 'object') return { ok: true, result: payload }
  if (Array.isArray(payload)) return { ok: true, items: payload }
  return { ok: true, ...payload }
}

/**
 * 把「抛出来的东西」折算成契约要求的失败信封。
 *
 * - 带 code 的错误（BazaarError、源仓 AuthError、任何 {code,message} 形状）→ 原码保留；
 * - 不带 code 的异常 → BAZAAR_PROVIDER_THROWN，并保留 provider 归属与方法名，让
 *   「第三方实现抛了异常」在诊断时一眼可指认，而不是伪装成一次普通的上游失败。
 */
export function toEnvelope(error, context) {
  const hasCode = typeof error?.code === 'string' && error.code.length > 0
  const code = hasCode ? error.code : CODES.PROVIDER_THROWN
  const message = String(error?.message ?? error ?? 'provider call failed')
  const details = {}
  if (context !== undefined && context !== null) {
    if (context.providerId !== undefined) details.providerId = context.providerId
    if (context.domain !== undefined) details.domain = context.domain
    if (context.method !== undefined) details.method = context.method
  }
  if (
    typeof error?.details === 'object' &&
    error.details !== null &&
    !Array.isArray(error.details)
  ) {
    Object.assign(details, error.details)
  }
  return Object.keys(details).length === 0 ? fail(code, message) : fail(code, message, details)
}

/** 是不是失败信封（只认 ok===false 且有码有文案的对象；不把其它形状当失败）。 */
export function isFailure(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.ok === false &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  )
}

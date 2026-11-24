/**
 * provider 契约（apiVersion 1）的两段校验：声明面 + 行为面。
 *
 * 校验时机是关键：全部在**登记之前**完成（design D2 / D13）。两个理由——
 * ① 错误要在加载期暴露，而不是模型某次调到某个域才炸；② 注册表里不能存在「登记了
 *    但用不了」的条目，否则页签渲染出来了、点进去报错，而且失败的 id 还会占位。
 * 所以任何一段不通过都直接返回失败信封：既不产出 record，也不占用该 id。
 *
 * 纯函数、不碰磁盘、不碰网络：注册表（registry.js）与用例都能直接依赖它。
 */

import { CODES, fail } from './errors.js'

/** 本版唯一合法的契约版本。用整数而非字符串：字符串比较语义要自己定义，整数没有歧义。 */
export const API_VERSION = 1

/**
 * providerId 白名单：小写字母开头，仅小写字母 / 数字 / 连字符，总长 ≤ 32。
 * 这是路径穿越防线的第一道（第二道在 lib/provider/paths.js 的 safeJoin）。
 * 上限 32 是因为 id 直接参与目录与凭据名拼装，过长的 id 会撑爆凭据服务的路径。
 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** 五个能力域；数组顺序即界面区块与错误码表的固定顺序。 */
export const CAPABILITY_DOMAINS = Object.freeze([
  'expertMarket',
  'skillMarket',
  'memoryMarket',
  'connectorMarket',
  'account',
])

/**
 * 各域必需方法 = apiVersion 1 的公开 ABI。
 * 增删其中任何一个都必须提升 API_VERSION 并在 spec 登记新集合；在 v1 下静默增删
 * 等价于破坏性变更（spec: 五域各自的必需方法集合）。
 */
export const REQUIRED_METHODS = Object.freeze({
  expertMarket: Object.freeze(['listExperts', 'getExpert']),
  skillMarket: Object.freeze(['listSkills', 'installSkill']),
  memoryMarket: Object.freeze(['listMemorySkills', 'searchMemory']),
  connectorMarket: Object.freeze(['listConnectors', 'getConnector', 'connectorAction']),
  account: Object.freeze(['listAccounts', 'accountAction']),
})

/** 声明面必填字段。apiVersion 另走一条码（它的失败是契约版本问题，不是字段缺失）。 */
export const REQUIRED_DECLARATION_FIELDS = Object.freeze(['id', 'displayName', 'capabilities'])

const isPlainObject = function (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 可选字段的形状表。不合法一律按参数非法拒绝，而不是静默忽略：静默忽略会让写错配置的人
 * 以为自己的 allowHosts 生效了，实际跑的却是默认集合。
 */
const OPTIONAL_SHAPES = {
  icon: function (value) {
    return typeof value === 'string' && value.length > 0
  },
  allowHosts: function (value) {
    return (
      Array.isArray(value) &&
      value.every(function (host) {
        return typeof host === 'string' && host.length > 0
      })
    )
  },
  allowInsecureLoopback: function (value) {
    return typeof value === 'boolean'
  },
  credentialRef: function (value) {
    return typeof value === 'string' && value.length > 0
  },
}

/**
 * 归一化能力声明：未声明 / undefined 统一成 false，得到五键齐全的布尔表。
 * 界面与域入口都只读这张表，避免各处再写第三种判断。
 */
export function normalizeCapabilities(capabilities) {
  const out = {}
  for (const domain of CAPABILITY_DOMAINS) out[domain] = capabilities?.[domain] === true
  return out
}

/** 某域是否声明为 true。域入口的准入判定只用这一个函数。 */
export function declaresDomain(record, domain) {
  if (!CAPABILITY_DOMAINS.includes(domain)) return false
  return record?.capabilities?.[domain] === true
}

/**
 * 契约承诺的方法面：已声明域 × 该域的必需方法。
 *
 * 存在的意义是把「额外方法不进入本版契约承诺」变成可机检的形式——入口只从这里取方法名，
 * 所以 provider 多实现的方法既不会被依赖，也不会被自动接进任何入口（spec 的对应场景）。
 */
export function methodSurface(record) {
  const surface = {}
  for (const domain of CAPABILITY_DOMAINS) {
    if (declaresDomain(record, domain)) surface[domain] = REQUIRED_METHODS[domain].slice()
  }
  return surface
}

/** 第一段：声明面校验。返回 { declaration } 或失败信封。 */
function validateDeclaration(candidate) {
  if (!isPlainObject(candidate)) {
    return fail(
      CODES.PARAM_INVALID,
      'provider 契约必须是一个普通对象，收到 ' +
        (Array.isArray(candidate) ? 'array' : typeof candidate),
      { field: 'contract' },
    )
  }

  if (candidate.apiVersion !== API_VERSION) {
    return fail(
      CODES.PROVIDER_API_VERSION,
      'provider 契约的 apiVersion 必须是整数 ' +
        API_VERSION +
        '，收到 ' +
        JSON.stringify(candidate.apiVersion ?? null),
      { apiVersion: candidate.apiVersion ?? null, expected: API_VERSION },
    )
  }

  for (const field of REQUIRED_DECLARATION_FIELDS) {
    const value = candidate[field]
    // id 的「缺失」只算 undefined/null：空串与 'WorkBuddy' 一样是白名单不匹配，
    // 必须报 PROVIDER_INVALID_ID（路径片段只有一条判定口），不能报成「字段没给」。
    const missing =
      field === 'id'
        ? value === undefined || value === null
        : value === undefined || value === null || value === ''
    if (missing) {
      // spec 要求指明缺失的字段名：field 同时进文案与信封。
      return fail(CODES.PARAM_INVALID, 'provider 声明缺少必填字段 ' + field, { field })
    }
  }

  if (typeof candidate.id !== 'string' || !PROVIDER_ID_PATTERN.test(candidate.id)) {
    return fail(
      CODES.PROVIDER_INVALID_ID,
      'providerId 必须匹配 ^[a-z][a-z0-9-]{0,31}$，收到 ' + JSON.stringify(candidate.id),
      {
        id: candidate.id,
        field: 'id',
        pattern: PROVIDER_ID_PATTERN.source,
      },
    )
  }

  if (typeof candidate.displayName !== 'string') {
    return fail(
      CODES.PARAM_INVALID,
      'provider 声明的 displayName 必须是字符串，收到 ' + typeof candidate.displayName,
      {
        field: 'displayName',
      },
    )
  }

  if (!isPlainObject(candidate.capabilities)) {
    return fail(
      CODES.PARAM_INVALID,
      'provider 声明的 capabilities 必须是对象，收到 ' +
        (Array.isArray(candidate.capabilities) ? 'array' : typeof candidate.capabilities),
      { field: 'capabilities' },
    )
  }

  for (const [key, value] of Object.entries(candidate.capabilities)) {
    if (!CAPABILITY_DOMAINS.includes(key)) {
      // 未知能力键一律拒绝：拼错的 expertmarket 若被静默忽略，那条域就等价于「没声明」，
      // 表现是「界面少了一块」而不是「注册失败」——这类问题最难被使用者自己发现。
      return fail(
        CODES.PARAM_INVALID,
        'provider 声明了未知能力键 ' + key + '，可用键：' + CAPABILITY_DOMAINS.join(', '),
        { field: 'capabilities.' + key, allowed: CAPABILITY_DOMAINS.slice() },
      )
    }
    if (typeof value !== 'boolean') {
      return fail(
        CODES.PARAM_INVALID,
        'capabilities.' + key + ' 必须是布尔值，收到 ' + JSON.stringify(value),
        { field: 'capabilities.' + key },
      )
    }
  }

  for (const [field, shape] of Object.entries(OPTIONAL_SHAPES)) {
    if (candidate[field] === undefined) continue
    if (!shape(candidate[field])) {
      return fail(CODES.PARAM_INVALID, 'provider 声明的可选字段 ' + field + ' 形状不合法', {
        field,
      })
    }
  }

  const declaration = {
    apiVersion: API_VERSION,
    id: candidate.id,
    displayName: candidate.displayName,
    capabilities: normalizeCapabilities(candidate.capabilities),
  }
  if (candidate.icon !== undefined) declaration.icon = candidate.icon
  if (candidate.allowHosts !== undefined) declaration.allowHosts = candidate.allowHosts.slice()
  if (candidate.allowInsecureLoopback !== undefined)
    declaration.allowInsecureLoopback = candidate.allowInsecureLoopback
  if (candidate.credentialRef !== undefined) declaration.credentialRef = candidate.credentialRef
  return { declaration }
}

/**
 * 第二段：行为面校验。只对 capabilities 为 true 的域要求方法；
 * 未声明的域即使对象上存在该键也一概不看（spec: 未声明的域不要求行为面）。
 */
function validateBehaviour(declaration, impl) {
  const declared = CAPABILITY_DOMAINS.filter(function (domain) {
    return declaration.capabilities[domain]
  })
  if (declared.length === 0) return { impl: isPlainObject(impl) ? { ...impl } : {} }

  if (!isPlainObject(impl)) {
    // 一次报全所有缺失的域：一份契约常被复制粘贴改两行，说清少了哪几个域比说清少了一个字段有用。
    return fail(
      CODES.PROVIDER_IMPL_MISSING,
      'provider ' + declaration.id + ' 声明了 ' + declared.join(', ') + '，但未提供 impl 对象',
      { providerId: declaration.id, domains: declared.slice() },
    )
  }

  for (const domain of declared) {
    const methods = impl[domain]
    if (!isPlainObject(methods)) {
      return fail(
        CODES.PROVIDER_IMPL_MISSING,
        'provider ' + declaration.id + ' 声明了 ' + domain + '，但 impl 缺少该域的方法对象',
        { providerId: declaration.id, domain, missing: REQUIRED_METHODS[domain].slice() },
      )
    }
    for (const method of REQUIRED_METHODS[domain]) {
      if (typeof methods[method] !== 'function') {
        // 三类写法一次报全：缺键、给了 null、给了非函数（最常见是少写一个方法名）。
        const given =
          method in methods
            ? methods[method] === null
              ? 'null'
              : typeof methods[method]
            : 'undefined'
        return fail(
          CODES.PROVIDER_IMPL_MISSING,
          'provider ' +
            declaration.id +
            ' 的 ' +
            domain +
            '.' +
            method +
            ' 必须是函数，收到 ' +
            given,
          { providerId: declaration.id, domain, method },
        )
      }
    }
  }

  return { impl }
}

/**
 * 完整契约校验：两段都通过才产出可登记的 record。
 *
 * @returns {object} { ok:true, record } 或 { ok:false, code, message, ...定位字段 }
 */
export function validateContract(candidate) {
  const declaration = validateDeclaration(candidate)
  if (declaration.ok === false) return declaration

  const behaviour = validateBehaviour(declaration.declaration, candidate.impl)
  if (behaviour.ok === false) return behaviour

  return { ok: true, record: { ...declaration.declaration, impl: behaviour.impl } }
}

/**
 * record 的声明面投影（不含 impl）：给列举、路由与展示层用，避免把实现对象传进展示层
 * （impl 里的闭包会带走整条上游凭据链，序列化时会变成不可 JSON 化的值）。
 * 字段逐个显式列出：契约新增可选字段时必须在这里出现，投影不会悄悄漏掉。
 */
export function declarationOf(record) {
  const declaration = {
    apiVersion: record.apiVersion,
    id: record.id,
    displayName: record.displayName,
    capabilities: { ...record.capabilities },
  }
  if (record.icon !== undefined) declaration.icon = record.icon
  if (record.allowHosts !== undefined) declaration.allowHosts = [...record.allowHosts]
  if (record.allowInsecureLoopback !== undefined)
    declaration.allowInsecureLoopback = record.allowInsecureLoopback
  if (record.credentialRef !== undefined) declaration.credentialRef = record.credentialRef
  return declaration
}

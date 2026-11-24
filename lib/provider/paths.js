/**
 * providerId 准入判定与数据目录拼装（任务 2.2）。
 *
 * 为什么这里要有第二道防线：spec 把白名单写成「唯一准入判定」，意思是注册期只认这一个
 * 正则；但 id 之后会一路参与 path.join，中间任何一处拼装都可能被别的片段带出目录
 * （2.5 会把 accounts / vault / cache 三条子路径拼上去，组 4 还要拼 region 目录）。
 * 所以目录拼装处再过一次 safeJoin：**注册被绕过、或调用方自己传了拼接片段时，落点仍然
 * 只能在该 provider 自己的子树里**。两道用的是同一个 PROVIDER_ID_PATTERN（从 contract.js
 * 引入，不在这里重抄一份正则）——两条规则漂移是这类分层最常见的翻车方式。
 *
 * 纯函数：只算路径，绝不 mkdir、绝不读写。落盘由调用方决定，这样「非法 id 不会在
 * <DSH_HOME>/bazaar/providers/ 下留下任何目录」是靠这里根本不碰 fs 来保证的。
 */

import path from 'node:path'

import { PROVIDER_ID_PATTERN } from './contract.js'
import { CODES, fail } from './errors.js'

/** bazaar 数据目录下承载各 provider 的子目录名。 */
export const PROVIDERS_DIR_NAME = 'providers'

const isNonEmptyString = function (value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * 白名单判定：与 validateContract 用同一个 pattern，因此「注册放行」与「路径拼装放行」
 * 不可能给出不同答案。
 *
 * @returns {object} { ok:true, id } 或 { ok:false, code:BAZAAR_PROVIDER_INVALID_ID, ... }
 */
export function assertProviderId(id) {
  if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
    // id 非法绝不回落成「用 displayName 猜一个」或「sanitizing 后继续」：猜出来的目录会把
    // 两个 provider 的数据写进同一个文件夹，那种串写在事后几乎无法归因。
    return fail(
      CODES.PROVIDER_INVALID_ID,
      'providerId 必须匹配 ^[a-z][a-z0-9-]{0,31}$，收到 ' + JSON.stringify(id ?? null),
      { id: id ?? null, field: 'id', pattern: PROVIDER_ID_PATTERN.source },
    )
  }
  return { ok: true, id }
}

/**
 * bazaar 数据目录下的 providers 根目录。<DSH_HOME>/bazaar 由插件配置给出，这里只负责
 * 拼一层固定名字，并拒绝空 base：base 为空时后续拼装会退化成相对 CWD 的路径，那种路径
 * 在不同启动方式下指向不同目录，是「数据莫名丢失」的经典成因。
 */
export function providersRoot(bazaarDir) {
  if (!isNonEmptyString(bazaarDir)) {
    return fail(CODES.PARAM_INVALID, 'bazaar 数据目录必须是非空字符串路径', { field: 'bazaarDir' })
  }
  return { ok: true, path: path.resolve(bazaarDir, PROVIDERS_DIR_NAME) }
}

/**
 * 目录拼装处的第二道防线：先过白名单，再验「落点是否仍在该 provider 自己的子树内」。
 *
 * 锚点取 providers/<providerId>（而不是 providers/）——这是跨 provider 隔离的结构性保证：
 * alpha 无论怎么拼片段都拿不到 beta 的路径（spec: 以 A provider 身份读取 B provider 的
 * 凭证或目录 MUST 被拒绝）。绝对路径片段同样拦下：path.resolve 会让后面的绝对段直接赢，
 * 不验落点就等于把 /etc/passwd 交给调用方。
 *
 * @param {string} bazaarDir 插件数据根目录（<DSH_HOME>/bazaar）
 * @param {string} providerId 待拼装的 provider id
 * @param {...string} segments 子路径片段（如 'accounts'、'cn'、'x.json'）
 * @returns {object} { ok:true, path } 或失败信封（绝不返回半截路径）
 */
export function safeJoin(bazaarDir, providerId, ...segments) {
  const root = providersRoot(bazaarDir)
  if (root.ok === false) return root

  const admission = assertProviderId(providerId)
  if (admission.ok === false) return admission

  for (const [index, segment] of segments.entries()) {
    if (typeof segment !== 'string') {
      // 契约要求这里不抛异常：resolve() 遇到非字符串会直接 TypeError，先拦下来。
      return fail(CODES.PARAM_INVALID, 'provider 路径片段必须是字符串', {
        providerId,
        field: 'segments[' + index + ']',
      })
    }
  }

  const anchor = path.resolve(root.path, admission.id)
  const target = path.resolve(anchor, ...segments)
  const inside = target === anchor || target.startsWith(anchor + path.sep)
  if (!inside) {
    // 报「逃逸」而不是报 id：id 是合法的，越界来自后续片段，指错地方会把人带去改正则。
    return fail(CODES.PARAM_INVALID, 'provider 路径拼装越出该 provider 自己的目录，已拒绝', {
      providerId: admission.id,
      field: 'segments',
      escaped: true,
      segments: segments.length,
    })
  }

  return { ok: true, path: target }
}

/** provider 自己的数据目录：<base>/providers/<id>。 */
export function providerDir(bazaarDir, providerId) {
  return safeJoin(bazaarDir, providerId)
}
/**
 * 凭据名恒由 providerId 推导：BAZAAR_<UPPER_SNAKE(id)>_TOKEN（大写并把 - 换成 _）。
 *
 * 为什么不接受调用方直接给一个凭据名：凭据名就是隔离边界本身。允许自由传入时，alpha
 * 一句 resolveCredentialName('beta') 就能读到 beta 的令牌，而 spec 把「以 A 的身份读 B 的
 * 凭据」列为 MUST 拒绝。所以这里只有两种合法来源：providerId 推导，或该 provider 自己的
 * credentialRef 覆盖（2.5 的「允许覆盖」那条）。
 */
export function credentialNameFor(providerId) {
  const admitted = assertProviderId(providerId)
  if (admitted.ok === false) return admitted
  return { ok: true, name: 'BAZAAR_' + admitted.id.toUpperCase().replace(/-/g, '_') + '_TOKEN' }
}

/**
 * 解析该 provider 实际使用的凭据名：credentialRef 覆盖优先，否则按 id 推导。
 * 覆盖值必须是形如 BAZAAR_* 的凭据名，且不得指向另一个 provider 的推导名——否则「覆盖」
 * 就成了跨库读取的旁路（这是本函数存在的唯一理由）。
 *
 * @param {object} input { providerId, credentialRef?, knownProviderIds? }
 * @returns {object} { ok:true, name, derived:boolean } 或失败信封
 */
export function resolveCredentialName(input) {
  const providerId = input?.providerId
  const admitted = assertProviderId(providerId)
  if (admitted.ok === false) return admitted

  const derived = credentialNameFor(providerId)
  const ref = input?.credentialRef
  if (ref === undefined || ref === null || ref === '') {
    return { ok: true, name: derived.name, derived: true }
  }
  if (typeof ref !== 'string' || /^BAZAAR_[A-Z0-9_]+_TOKEN$/.test(ref) === false) {
    // 不静默回落到推导名：静默回落会让「我明明配了 credentialRef」的故障查不出来。
    return fail(
      CODES.PARAM_INVALID,
      'credentialRef 必须是形如 BAZAAR_<NAME>_TOKEN 的凭据名，收到 ' + JSON.stringify(ref),
      {
        providerId: providerId,
        field: 'credentialRef',
      },
    )
  }

  // 关键一步：把覆盖名反解成一个 providerId，若它命中另一个已注册 provider，就是跨库取凭据。
  const known = Array.isArray(input?.knownProviderIds) ? input.knownProviderIds : []
  const owner = ownedProviderIdOf(ref, known)
  if (owner !== undefined && owner !== providerId) {
    return fail(
      CODES.PARAM_INVALID,
      '凭据名 ' +
        ref +
        ' 属于 provider ' +
        owner +
        '，请求方是 ' +
        providerId +
        '，跨 provider 读取凭据被拒绝',
      {
        providerId: providerId,
        field: 'credentialRef',
        credentialRef: ref,
        ownerProviderId: owner,
      },
    )
  }
  return { ok: true, name: ref, derived: false }
}

/**
 * 反查一个凭据名在已知集合里属于哪个 provider（只认推导名的形状，不猜外部命名）。
 * 命中不了返回 undefined：自定义名允许存在，只要它不是别人的推导名。
 */
export function ownedProviderIdOf(credentialName, knownProviderIds) {
  if (typeof credentialName !== 'string' || Array.isArray(knownProviderIds) === false)
    return undefined
  for (const id of knownProviderIds) {
    const derived = credentialNameFor(id)
    if (derived.ok === true && derived.name === credentialName) return id
  }
  return undefined
}

/**
 * provider 的四个落点：账号库、凭据库、缓存、连接器 store。
 * 恒由 providerId 推导（组 4.6 出网与凭据判定读的就是这一处），调用方不能指定目录。
 * 注意本模块只算路径、绝不 mkdir：未声明 account 的 provider 不会因为「有人问了它的路径」
 * 就凭空多出目录，spec 的「该 provider 的 vault 目录不被创建」由此兑现。
 */
export function providerLayout(bazaarDir, providerId) {
  const root = providerDir(bazaarDir, providerId)
  if (root.ok === false) return root
  return {
    ok: true,
    providerId: providerId,
    root: root.path,
    accounts: path.join(root.path, 'accounts'),
    vault: path.join(root.path, 'vault'),
    cache: path.join(root.path, 'cache'),
    connectorsFile: path.join(root.path, 'connectors.json'),
  }
}

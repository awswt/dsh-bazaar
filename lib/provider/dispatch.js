/**
 * 域入口判定：每个域动作进入实现之前，唯一的一道「先查声明、再取契约承诺过的方法」。
 *
 * 为什么判定挂在这一处（design D5 同一逻辑的 provider 侧版本）：面板、模型工具、斜杠命令、
 * HTTP 路由四条入口必须共用同一判定，否则会出现「工具拒了、面板放行」这类语义分裂，而 spec
 * 明确要求三条路径结论一致。把判定下放进各域实现内部同样不行——等价路径（provider 自己写的
 * 分支）会绕过它。
 *
 * 两条容易写错的边界，都在这里显式兑现：
 * - 已声明但该域当前无数据 = 正常空态，不是错误：能不能用看 capabilities，有没有数据看
 *   provider 的返回。两者混为一谈会把空列表显示成故障。
 * - 只允许调用 methodSurface() 承诺过的方法：provider 额外实现的方法既不会被依赖，也不会
 *   被自动接进任何入口（spec: 额外方法与契约版本演进）。
 */

import { CODES, fail, isFailure, ok, toEnvelope } from './errors.js'
import { CAPABILITY_DOMAINS, declaresDomain, methodSurface } from './contract.js'

/**
 * PROVIDER_REQUIRED 是「用户还没选库」的落点，文案必须给出下一步动作；
 * providers 动作是它的自救出口（2.6 实现）。
 */
function providerRequiredMessage(hint) {
  const prefix = hint === undefined || hint === null ? '' : String(hint) + '；'
  return (
    '必须指定 provider：' +
    prefix +
    '先在会话面板勾选专家库，或调用时传 provider 参数（providers 动作可列举当前集合）'
  )
}

const isPlainObject = function (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {object} registry createProviderRegistry() 的返回值
 * @param {object} [options]
 * @param {Function} [options.resolveActive] 返回当前会话的活跃 providerId 列表，用于
 *   「未显式传 provider 时读活跃集」的判定（2.6）。缺省视为空活跃集——空活跃集是合法状态，
 *   spec 要求此时给引导错误而不是静默回落首个已注册库。
 */
export function createDomainDispatcher(registry, options = undefined) {
  const resolveActive =
    typeof options?.resolveActive === 'function'
      ? options.resolveActive
      : function () {
          return []
        }

  /**
   * 入口解析：把「显式 provider 参数」与「会话活跃集」折成唯一目标，判定顺序固定。
   * 只判定不执行，check 与 call 共用它，两条路径因此不可能给出不同结论。
   */
  function resolveTarget(request) {
    if (!isPlainObject(request)) {
      return fail(CODES.PARAM_INVALID, '域入口必须接收一个请求对象', { field: 'request' })
    }
    const domain = request.domain
    if (typeof domain !== 'string' || CAPABILITY_DOMAINS.includes(domain) === false) {
      return fail(
        CODES.PARAM_INVALID,
        '未知能力域 ' +
          JSON.stringify(domain ?? null) +
          '，可用域：' +
          CAPABILITY_DOMAINS.join(', '),
        { field: 'domain', domain: domain ?? null, allowed: CAPABILITY_DOMAINS.slice() },
      )
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return fail(CODES.PARAM_INVALID, '域方法名必须是非空字符串', {
        field: 'method',
        domain: domain,
      })
    }

    // providerId 缺省时的取值顺序是刻意的：活跃集为空或有多个就报 PROVIDER_REQUIRED，
    // 绝不回落到「第一个已注册 provider」——那等于替用户决定用哪家库，是凭据串用的入口。
    const active = resolveActive()
    const activeList = Array.isArray(active) ? active : []
    const providerId = request.providerId ?? (activeList.length === 1 ? activeList[0] : undefined)
    if (typeof providerId !== 'string' || providerId.length === 0) {
      const hint =
        activeList.length === 0
          ? '当前会话未选择任何专家库'
          : '当前会话有 ' + activeList.length + ' 个活跃库，无法代为选择'
      return fail(CODES.PROVIDER_REQUIRED, providerRequiredMessage(hint), {
        field: 'providerId',
        activeProviders: activeList.slice(),
      })
    }

    const record = registry.getRecord(providerId)
    if (record === undefined) {
      // 未注册与「注册了但没声明这个域」是两种故障：前者要重新注册，后者要点亮库或换库。
      return fail(CODES.PROVIDER_UNKNOWN, 'provider ' + JSON.stringify(providerId) + ' 未注册', {
        providerId: providerId,
        registered: registry.ids(),
      })
    }

    if (declaresDomain(record, domain) === false) {
      const declared = CAPABILITY_DOMAINS.filter(function (key) {
        return record.capabilities?.[key] === true
      })
      // spec 要求信息同时含 providerId 与缺失域名；顺带给出该库实际声明了什么，
      // 免得调用方在两个库之间反复试探。
      return fail(
        CODES.CAPABILITY_UNDECLARED,
        'provider ' +
          providerId +
          ' 未声明能力域 ' +
          domain +
          (declared.length === 0
            ? '（该库没有任何已声明域）'
            : '，它声明的域：' + declared.join(', ')),
        { providerId: providerId, domain: domain, declared: declared },
      )
    }

    const promised = methodSurface(record)[domain] ?? []
    if (promised.includes(request.method) === false) {
      // 非承诺方法一律不可达。这条码是 PARAM_INVALID 而不是 IMPL_MISSING：声明与实现都齐，
      // 越界的是「调用方想用一个契约外的方法」。
      return fail(
        CODES.PARAM_INVALID,
        '方法 ' +
          domain +
          '.' +
          request.method +
          ' 不在 apiVersion 1 的契约承诺范围内，可用方法：' +
          promised.join(', '),
        { providerId: providerId, field: 'method', domain: domain, allowed: promised.slice() },
      )
    }

    const params = request.params
    if (params !== undefined && params !== null && !isPlainObject(params)) {
      return fail(CODES.PARAM_INVALID, '域方法入参必须是普通对象（契约规定单对象入参）', {
        providerId: providerId,
        field: 'params',
      })
    }

    return {
      ok: true,
      record: record,
      providerId: providerId,
      domain: domain,
      method: request.method,
      params: params ?? {},
    }
  }

  return {
    /** 只判定不执行：渲染前过滤、或路由需要先拒再读体时用。 */
    check(request) {
      const target = resolveTarget(request)
      if (target.ok === false) return target
      return ok({ providerId: target.providerId, domain: target.domain, method: target.method })
    },

    /**
     * 判定 + 派发。返回永远是信封：provider 抛异常在这里折成 BAZAAR_PROVIDER_THROWN
     * （契约要求域方法不抛异常穿透，这条只能在边界兑现）；带 code 的业务失败原码透传。
     */
    async call(request) {
      const target = resolveTarget(request)
      if (target.ok === false) return target
      const context = {
        providerId: target.providerId,
        domain: target.domain,
        method: target.method,
      }
      const implementation = target.record.impl[target.domain][target.method]
      let outcome
      try {
        outcome = await implementation(target.params)
      } catch (error) {
        return toEnvelope(error, context)
      }
      if (isFailure(outcome)) return outcome
      if (outcome !== undefined && outcome !== null && outcome.ok === true) return outcome
      // 域实现按既有形状返回领域对象（items / total / item …），这里只统一补 ok，不重排字段：
      // 「不另立 DTO」是 spec 的硬要求。providerId 与 qualifiedName 由组 3 的分组返回层补，
      // 派发层不重复补，免得两处各写一遍归一逻辑。
      return ok(outcome)
    },

    /**
     * 界面渲染前的可用性过滤：未注册或未声明都给 false。
     * 这里刻意不返回错误码——渲染层要的是布尔，不是分支处理。
     */
    available(providerId, domain) {
      const record = registry.getRecord(providerId)
      if (record === undefined) return false
      return declaresDomain(record, domain)
    },
  }
}

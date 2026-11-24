/**
 * provider 注册表：register / unregister / list / get 四个方法构成 provider 集合的
 * 全部读写口（design D1）。任何调用方都不直接持有对象表，包括本插件自己的路由层。
 *
 * 三条关键设计：
 * 1. 校验全在登记之前（contract.js），因此表里不存在「登记了但用不了」的条目，失败的
 *    id 也不占位：页签与开关只可能渲染出能用的 provider。
 * 2. 写路径串行化。register 与 unregister 都同时动「provider 表」与「会话分区」两处状态，
 *    交错执行会留下「表里没了、会话里还指着它」的窗口，正是这种窗口让面板继续向一个
 *    已注销的库派发请求。
 * 3. 对外只给声明面投影（declarationOf）：impl 里是上游闭包与凭据链，绝不进 list/get 的
 *    返回值，也绝不进 JSON。编排层要拿 impl 走 getRecord()（内部口，不经 ctx.bazaar 暴露）。
 */

import { CODES, fail, ok } from './errors.js'
import { declarationOf, validateContract } from './contract.js'

/** 未注册时 get/unregister 的返回：spec 要求是 PROVIDER_UNKNOWN 信封，而不是 undefined。 */
function unknownFailure(providerId) {
  return fail(
    CODES.PROVIDER_UNKNOWN,
    'provider ' + JSON.stringify(providerId ?? null) + ' 未注册',
    { providerId: providerId ?? null },
  )
}

/**
 * @param {object} [options]
 * @param {object} [options.session] 会话写入口适配器，需实现 clearProvider(providerId)。
 *   unregister 必须在同一临界区内经它清除该库的会话分区（spec 要求复用唯一写入口
 *   saveState()）。组 2 的执行边界不允许改 lib/session.js，因此这里以注入的方式接线
 *   （2.7 由 lib/index.js 注入适配器）。没接线就拒绝注销：宁可报「无处可清」，也不留下
 *   「表里注销了、会话还指着它」的半状态。
 * @param {Function} [options.onChange] 集合变更通知（registered / unregistered）。
 *   2.3 的「注销后路由与页签不残留」、2.6 的「面板、工具、命令、路由读同一份集合」与组
 *   4.4 的门控重算都要靠它，所以留作构造期选项而非第四个方法。监听器抛错不改变注册结果。
 */
export function createProviderRegistry(options = undefined) {
  const session = options?.session
  const onChange = typeof options?.onChange === 'function' ? options.onChange : undefined

  /** 保序的 id -> record 表；Map 的迭代顺序即注册顺序，界面页签按它渲染。 */
  const records = new Map()
  /** 写路径串行链：所有动表与动会话的操作都挂在这条链上。 */
  let chain = Promise.resolve()

  const enqueue = function (task) {
    const next = chain.then(task, task)
    // 单次失败不能毒化整条链：后续操作照样要能执行。
    chain = next.then(
      function () {
        return undefined
      },
      function () {
        return undefined
      },
    )
    return next
  }

  const notify = function (event) {
    if (onChange === undefined) return
    try {
      onChange(event)
    } catch {
      // 通知失败不回滚：集合已经落定，回滚反而制造两处不一致。
    }
  }

  return {
    /**
     * @param {object} candidate provider 契约对象（声明面 + impl）
     * @returns {Promise<object>} { ok:true, provider } 或失败信封
     */
    async register(candidate) {
      const validated = validateContract(candidate)
      if (validated.ok === false) return validated
      return enqueue(function () {
        const record = validated.record
        if (records.has(record.id)) {
          // 不覆盖既有条目（spec 场景点名）：热更新重复注册若覆盖，正在被会话引用的 impl
          // 会被悄悄换掉，而用户没做任何操作。想换实现必须先 unregister。
          return fail(
            CODES.PROVIDER_DUPLICATE,
            'provider ' + record.id + ' 已注册，重复注册被拒绝（如需替换实现请先注销）',
            { providerId: record.id },
          )
        }
        records.set(record.id, record)
        const provider = declarationOf(record)
        notify({ type: 'registered', providerId: record.id, provider })
        return ok({ provider })
      })
    },

    /**
     * 注销并在同一临界区内清除该库的会话分区。
     * @param {string} providerId
     * @returns {Promise<object>} { ok:true, providerId } 或失败信封
     */
    async unregister(providerId) {
      // 回调必须是 async：临界区里要 await 会话写入口，非 async 回调里的 await 是语法错误。
      return enqueue(async function () {
        if (typeof providerId !== 'string' || records.has(providerId) === false)
          return unknownFailure(providerId)
        if (session === undefined || typeof session.clearProvider !== 'function') {
          return fail(
            CODES.PARAM_INVALID,
            '注册表未接线会话写入口，注销会留下悬空的会话分区，已拒绝（构造时传 options.session）',
            { providerId: providerId, field: 'session' },
          )
        }
        const cleared = await session.clearProvider(providerId)
        if (cleared === undefined || cleared.ok === false) {
          // 清除失败就整笔作废：表里保留该 provider，避免出现「已注销但仍被会话引用」。
          if (cleared !== undefined && cleared.ok === false) return cleared
          return fail(CODES.PARAM_INVALID, 'provider ' + providerId + ' 的会话分区清除未返回结果', {
            providerId: providerId,
          })
        }
        records.delete(providerId)
        notify({ type: 'unregistered', providerId })
        return ok({ providerId })
      })
    },

    /** 已注册 provider 的声明面列表，按注册顺序：界面页签与面板开关的唯一来源。 */
    list() {
      return Array.from(records.keys()).map(function (id) {
        return declarationOf(records.get(id))
      })
    },

    /**
     * @param {string} providerId
     * @returns {object} { ok:true, provider } 或 PROVIDER_UNKNOWN 信封。
     * 返回信封而不是 undefined：漏判 undefined 会渲染出空页签，漏判信封只是把错误码回给
     * 前端，后者可诊断（spec 场景要求 get 对未注册 id 给出 PROVIDER_UNKNOWN）。
     */
    get(providerId) {
      const record = typeof providerId === 'string' ? records.get(providerId) : undefined
      if (record === undefined) return unknownFailure(providerId)
      return ok({ provider: declarationOf(record) })
    },

    /**
     * 内部口：编排层按域派发时取带 impl 的完整 record。
     * 不经 ctx.bazaar.providers 暴露，也不出现在任何列举结果里。
     */
    getRecord(providerId) {
      return typeof providerId === 'string' ? records.get(providerId) : undefined
    },

    /** 已注册 id 的快照副本，避免调用方拿到活引用后当集合用。 */
    ids() {
      return Array.from(records.keys())
    },

    /** 域入口的准入判定：未注册给 PROVIDER_UNKNOWN，已注册未声明给 declared:false。 */
    declares(providerId, domain) {
      const record = typeof providerId === 'string' ? records.get(providerId) : undefined
      if (record === undefined) return unknownFailure(providerId)
      return { ok: true, declared: record.capabilities?.[domain] === true }
    },
  }
}

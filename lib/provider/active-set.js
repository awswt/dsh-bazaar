/**
 * 「当前 provider 集合」的唯一取值口（任务 2.6，方案 A 的注入点）。
 *
 * 面板、模型工具、斜杠命令、HTTP 路由四条入口都读这里的同一个函数；任何一处自己算
 * 「该用哪个库」都会退化成「用户以为在用 A 库、实际调的是 B 库的凭据」。
 *
 * 三条判定（顺序固定）：
 * 1. 会话活跃集为空 = 合法空态：未显式传 provider 的调用返回 PROVIDER_REQUIRED 引导，
 *    绝不静默回落到「首个已注册 provider」。
 * 2. 配置的 defaultProvider 指向未注册 id = 配置错误（不是正常空值）：报 PROVIDER_UNKNOWN
 *    并按时注册顺序回落首个已注册，同时把提示留给面板显示。这是唯一允许的回落。
 * 3. 显式传 provider 时按该 id 走，未注册同样报 PROVIDER_UNKNOWN。
 *
 * 落盘是延迟接线：真会话状态按 providerId 分组（activeProviders/experts/skills/revision）
 * 属任务 3.4 的 session.js，组 2 执行边界禁止改它。本模块把持久化做成注入点（options.session
 * 实现 readActive / writeActive），缺省用进程内 Map：判定语义完全一致，只是重启后不保留。
 * 3.4 落地时把注入点换成真 saveState()，判定不用改。
 */

import { CODES, fail, ok } from './errors.js'
import { assertProviderId } from './paths.js'

function noticeMessage(defaultProvider, fallback) {
  const tail =
    fallback === undefined
      ? '，且注册表为空：请先注册一个 provider'
      : '，已回落为首个已注册的 ' + fallback + '（按注册顺序）；请修正 defaultProvider'
  return '默认专家库 ' + JSON.stringify(defaultProvider) + ' 未注册' + tail
}

/**
 * @param {object} registry createProviderRegistry() 的返回值
 * @param {object} [options]
 * @param {string} [options.defaultProvider] 配置项，默认空串（= 没有默认库，1.0.0 的刻意默认）
 * @param {object} [options.session] 活跃集持久化适配器 { readActive?, writeActive? }；
 *   缺省为进程内 Map（3.4 换成真会话状态）
 * @param {Function} [options.onNotice] 提示回调（面板要显示「默认专家库 ghost 未注册」）
 */
export function createActiveProviderSet(registry, options = {}) {
  const defaultProvider = typeof options.defaultProvider === 'string' ? options.defaultProvider : ''
  const onNotice = typeof options.onNotice === 'function' ? options.onNotice : undefined
  /**
   * 全局启用/禁用偏好（createProviderPreferences 的实例，可选）。
   *
   * 为什么把过滤放在 activeFor 这一处：会话面板、完整面板、模型工具、斜杠命令、连接器门控
   * 五条入口都读同一个 activeFor。「被禁用的库」若只在界面上被藏起来，工具照样能调到它的
   * 连接器、域派发照样会向它出网——那是最难解释的一种「禁用」。
   *
   * 缺省不接线（单测与第三方宿主）：此时行为与接线前完全一致，没有隐式全局开关。
   */
  const preferences = options.preferences
  const memory = new Map()
  /**
   * 本进程见过的会话 id。clearProvider 要靠它遍历会话，因此必须与「用哪套持久化」无关：
   * 接了真适配器时 memory 永远是空的，只读 memory 会让注销变成「什么都没清」的静默失败。
   * 3.4 接线时这里的遍历对象换成 sessions 目录下的状态文件，语义不变。
   */
  const seen = new Set()
  const read =
    typeof options.session?.readActive === 'function'
      ? options.session.readActive
      : async function (sessionId) {
          return memory.get(sessionId)
        }
  const write =
    typeof options.session?.writeActive === 'function'
      ? options.session.writeActive
      : async function (sessionId, ids) {
          memory.set(sessionId, ids.slice())
          return ok({ activeProviders: ids.slice() })
        }

  /** 按注册顺序的首个已注册 id；注册表为空时 undefined。 */
  function firstRegistered() {
    const ids = registry.ids()
    return ids.length === 0 ? undefined : ids[0]
  }

  function emitNotice(notice) {
    if (onNotice === undefined) return
    try {
      onNotice(notice)
    } catch {
      // 提示失败不改变集合判定：回落本身要照常生效。
    }
  }

  /**
   * 会话活跃集的原始值（未过全局启用/禁用过滤）。首次访问时按 defaultProvider 播种
   * （spec：新会话 activeProviders 初始为空，只有配置给了默认库、或默认库需要回落时才非空），
   * 之后以持久化结果为准。
   */
  async function storedActiveFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    seen.add(sessionId)
    const stored = await read(sessionId)
    if (Array.isArray(stored))
      return stored.filter(function (id) {
        return typeof id === 'string'
      })
    if (defaultProvider === '') return []
    const admitted = assertProviderId(defaultProvider)
    if (admitted.ok === false) {
      const fallback = firstRegistered()
      emitNotice({
        code: CODES.PROVIDER_INVALID_ID,
        providerId: defaultProvider,
        fallback: fallback,
        message: noticeMessage(defaultProvider, fallback),
      })
      return fallback === undefined ? [] : [fallback]
    }
    if (registry.getRecord(defaultProvider) === undefined) {
      // 唯一允许回落的分支：配置错误，不是用户没选。提示必须发出去，否则用户不知道自己
      // 被「替他决定」了哪家库。
      const fallback = firstRegistered()
      emitNotice({
        code: CODES.PROVIDER_UNKNOWN,
        providerId: defaultProvider,
        fallback: fallback,
        message: noticeMessage(defaultProvider, fallback),
      })
      return fallback === undefined ? [] : [fallback]
    }
    return [defaultProvider]
  }

  /**
   * 会话活跃集（对外口径）= 落盘值 ∩ 全局启用集合。
   *
   * 被全局禁用的库从这里开始就消失：域派发不会向它出网、连接器门控会把它的工具 deny、
   * 面板列表里也不会出现。用户回到设置页重新启用后，落盘值原样还在——禁用不动会话状态，
   * 重新启用即可恢复原来的选择，这正是「禁用」而不是「清空」的意思。
   */
  async function activeFor(sessionId) {
    const stored = await storedActiveFor(sessionId)
    if (preferences === undefined || typeof preferences.filterEnabled !== 'function') return stored
    try {
      return await preferences.filterEnabled(stored)
    } catch {
      // 偏好读失败按「全部启用」处理：读不到一个开关就把整站清空，比多显示一家库糟得多。
      return stored
    }
  }

  function trackedSessions() {
    return Array.from(seen)
  }

  return {
    activeFor,
    trackedSessions,

    /**
     * 写入会话活跃集（面板勾选与路由写入的唯一入口）。空数组是合法值（清空 = 空态）；
     * 未知或非法 id 一律整笔拒绝，不落半份：半份活跃集会让面板显示两家库、只有一家生效。
     */
    async setActive(sessionId, providerIds) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return fail(CODES.PARAM_INVALID, '写入活跃集必须带 sessionId', { field: 'sessionId' })
      }
      seen.add(sessionId)
      if (Array.isArray(providerIds) === false) {
        return fail(CODES.PARAM_INVALID, 'activeProviders 必须是字符串数组', {
          field: 'activeProviders',
        })
      }
      const next = []
      for (const [index, id] of providerIds.entries()) {
        const admitted = assertProviderId(id)
        if (admitted.ok === false) {
          return fail(admitted.code, 'activeProviders[' + index + '] 非法：' + admitted.message, {
            field: 'activeProviders[' + index + ']',
          })
        }
        if (registry.getRecord(id) === undefined) {
          return fail(
            CODES.PROVIDER_UNKNOWN,
            'activeProviders[' + index + '] = ' + JSON.stringify(id) + ' 未注册',
            {
              providerId: id,
              field: 'activeProviders[' + index + ']',
              registered: registry.ids(),
            },
          )
        }
        // 全局禁用的库不允许被写进活跃集：允许写就会留下「面板上没有它、工具却能调到它」的
        // 状态，而那种状态没法向用户解释。整笔拒绝，让调用方回到设置页重新启用。
        if (
          preferences !== undefined &&
          typeof preferences.isEnabled === 'function' &&
          (await preferences.isEnabled(id)) !== true
        ) {
          return fail(
            CODES.PROVIDER_DISABLED,
            'provider ' + id + ' 已在设置页全局禁用：先在设置页启用，再在本会话选择它',
            {
              providerId: id,
              field: 'activeProviders[' + index + ']',
              disabled: true,
            },
          )
        }
        if (next.includes(id) === false) next.push(id)
      }
      const written = await write(sessionId, next)
      if (written === undefined || written.ok === false) {
        // 持久化失败不能报成功：否则面板会把「没写进去」显示成「已生效」。
        if (written !== undefined && written.ok === false) return written
        return fail(CODES.PARAM_INVALID, '活跃集写入未返回结果', { sessionId: sessionId })
      }
      return ok({ sessionId: sessionId, activeProviders: next })
    },

    /**
     * 注销一个 provider 时把它从各会话活跃集里剔除，其它库原样保留。
     * 3.4 接线后这一步由注册表经唯一写入口 saveState() 完成；这里先按注入口做同一件事。
     */
    async clearProvider(providerId) {
      if (typeof providerId !== 'string' || providerId.length === 0) {
        return fail(CODES.PARAM_INVALID, '清除活跃集必须带 providerId', { field: 'providerId' })
      }
      const cleared = []
      for (const sessionId of trackedSessions()) {
        // 必须读落盘值而不是 activeFor：后者已经滤掉了全局禁用的库，用它做基准就会
        // 「因为它是被禁用的，所以没东西可清」，被禁用的库也就永远留在会话状态里。
        const current = await storedActiveFor(sessionId)
        if (current.includes(providerId) === false) continue
        await write(
          sessionId,
          current.filter(function (id) {
            return id !== providerId
          }),
        )
        cleared.push(sessionId)
      }
      return ok({ providerId: providerId, cleared: cleared })
    },

    /**
     * 解析一次调用的目标 provider：显式参数优先；其次活跃集里唯一的那一个；
     * 活跃集为空或有多个都要求显式指定（不代选）。
     */
    async resolveProvider(sessionId, explicitProvider) {
      if (explicitProvider !== undefined && explicitProvider !== null && explicitProvider !== '') {
        const admitted = assertProviderId(explicitProvider)
        if (admitted.ok === false) return admitted
        if (registry.getRecord(explicitProvider) === undefined) {
          // 可选项写进文案本身：工具入口只透出 code + message，只带信封字段的话调用方
          // 看不到该改成什么，会把同一句「未注册」反复试错成循环。
          const registered = registry.ids()
          return fail(
            CODES.PROVIDER_UNKNOWN,
            'provider ' +
              JSON.stringify(explicitProvider) +
              ' 未注册（当前已注册：' +
              (registered.length === 0 ? '无' : registered.join(', ')) +
              '，可用 providers 动作重新列举）',
            {
              providerId: explicitProvider,
              registered: registered,
            },
          )
        }
        // 显式点名一个全局禁用的库同样拒绝：禁用是「这台机器上不启用它」，不是「界面上藏起来」。
        if (
          preferences !== undefined &&
          typeof preferences.isEnabled === 'function' &&
          (await preferences.isEnabled(explicitProvider)) !== true
        ) {
          return fail(
            CODES.PROVIDER_DISABLED,
            'provider ' +
              JSON.stringify(explicitProvider) +
              ' 已在设置页全局禁用（请先在设置页启用它，再指定该库）',
            { providerId: explicitProvider, disabled: true },
          )
        }
        return ok({ providerId: explicitProvider, source: 'argument' })
      }
      const activeList = await activeFor(sessionId)
      if (activeList.length === 0) {
        return fail(
          CODES.PROVIDER_REQUIRED,
          '尚未选择专家库：请在会话面板勾选一家库，或调用时传 provider 参数（providers 动作可列举当前集合）',
          { activeProviders: [], registered: registry.ids() },
        )
      }
      if (activeList.length > 1) {
        return fail(
          CODES.PROVIDER_REQUIRED,
          '当前会话有 ' + activeList.length + ' 个活跃专家库，无法代为选择：请传 provider 参数',
          { activeProviders: activeList.slice(), registered: registry.ids() },
        )
      }
      return ok({ providerId: activeList[0], source: 'session' })
    },

    /**
     * providers 动作与 GET /dsh-bazaar/providers 的共同返回：声明面 + 该会话的活跃标记
     * + 全局启用标记。
     *
     * 三个字段分工写清楚，界面上才有三个互相可区分的概念：
     * - `enabled`：设置页的全局开关。false = 这家库在整台机器上被关掉，界面处处不出现。
     * - `active`：本会话选了它没有。全局禁用时恒为 false（activeFor 已过滤），但反过来
     *   不成立——启用一家库不会替用户勾上它。
     * - `storedActive`：落盘选择里有没有它。全局禁用期间选择被冻结不动，重新启用即恢复；
     *   面板据此显示「已禁用（原选择保留）」而不是把用户的选择说成「没选过」。
     */
    async describeProviders(sessionId) {
      const rawStored =
        typeof sessionId === 'string' && sessionId.length > 0 ? await read(sessionId) : undefined
      const storedList = await storedActiveFor(sessionId)
      const activeList = await activeFor(sessionId)
      let disabledList = []
      if (preferences !== undefined && typeof preferences.disabledIds === 'function') {
        try {
          disabledList = await preferences.disabledIds()
        } catch {
          disabledList = []
        }
      }
      return ok({
        items: registry.list().map(function (provider) {
          const enabled = disabledList.includes(provider.id) === false
          return {
            ...provider,
            active: activeList.includes(provider.id),
            enabled: enabled,
            storedActive: storedList.includes(provider.id),
          }
        }),
        activeProviders: activeList.slice(),
        storedActiveProviders: storedList.slice(),
        disabledProviders: disabledList.slice(),
        defaultProvider: defaultProvider,
        initialized: Array.isArray(rawStored),
      })
    },
  }
}

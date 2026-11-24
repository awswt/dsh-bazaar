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
   * 会话活跃集。首次访问时按 defaultProvider 播种（spec：新会话 activeProviders 初始为空，
   * 只有配置给了默认库、或默认库需要回落时才非空），之后以持久化结果为准。
   */
  async function activeFor(sessionId) {
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
        const current = await activeFor(sessionId)
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

    /** providers 动作与 GET /dsh-bazaar/providers 的共同返回：声明面 + 该会话的活跃标记。 */
    async describeProviders(sessionId) {
      const activeList = await activeFor(sessionId)
      return ok({
        items: registry.list().map(function (provider) {
          return { ...provider, active: activeList.includes(provider.id) }
        }),
        activeProviders: activeList.slice(),
        defaultProvider: defaultProvider,
      })
    },
  }
}

/**
 * 市场认证服务：把「一键网页登录 → 覆盖存进本插件独占目录 → 刷新/退出」收敛为统一状态机。
 *
 * 设计要点：
 *   - 零外部插件耦合：无兼容层、无导入动作；
 *   - 单凭证模型：每次登录成功后立刻落盘并覆盖旧凭证；
 *   - 零表单默认认证：未传 region 时默认走 WorkBuddy 官方认证入口（cn），显式传非法值仍以 BAZAAR_PARAM_INVALID 拦截。
 */
import { createLoginStore } from './wb-login.js'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createAccountService(options) {
  const connector = options?.connector
  if (connector === undefined) throw new Error('createAccountService requires a connector')
  const now = options.now ?? (() => Date.now())
  const urlConfig = options.urlConfig
  const login = options.loginStore ?? createLoginStore({
    ...urlConfig === undefined ? {} : { urlConfig },
  })
  const fetchImpl = options.fetchImpl

  return {
    /** 发起一次网页授权登录；缺省直接走官方默认入口（cn），显式传非法 region 则拒绝。 */
    async start(region) {
      const normalized =
        region === undefined || region === null || region === '' ? 'cn' : String(region)
      if (normalized !== 'global' && normalized !== 'cn') {
        return {
          code: 'BAZAAR_PARAM_INVALID',
          field: 'region',
          admitted: ['cn', 'global'],
          error: '认证区域参数非法：region 必须是 cn 或 global，收到 ' + normalized,
        }
      }
      return login.start(normalized, {
        fetchImpl,
        now: now(),
        ...urlConfig === undefined ? {} : { urlConfig },
      })
    },

    /** 轮询一次登录状态；完成后立刻覆盖落盘到本插件独占目录。 */
    async poll(loginId, options_ = {}) {
      const outcome = await login.poll(loginId, {
        fetchImpl,
        now: now(),
        ...options_.region === undefined ? {} : { region: options_.region },
        ...urlConfig === undefined ? {} : { urlConfig },
      })
      if (outcome.done !== true || outcome.account === undefined) return outcome
      try {
        const saved = await connector.saveAccount(outcome.account)
        return { done: true, account: saved }
      } catch (error) {
        return { done: true, error: `signed in, but the account could not be stored: ${messageOf(error)}` }
      }
    },

    cancel(loginId) {
      return login.cancel(loginId)
    },

    /** 未完成的登录会话（面板显示等待授权用，不含 state）。 */
    pending() {
      return login.list(now())
    },

    /** 当前单凭证总览：100% 来自本 Provider 自有目录。 */
    async list() {
      const own = await connector.ownAccounts()
      const items = own.slice(0, 1)
      return {
        own: items,
        all: items,
        summary: {
          count: items.length,
          usableCount: items.filter(
            item => item.hasToken && (!item.expired || item.refreshExpiresAt === 0 || item.refreshExpiresAt > now()),
          ).length,
          ownCount: items.length,
          dir: typeof connector.store?.root === 'string' ? connector.store.root : null,
        },
        pending: login.list(now()),
      }
    },

    /** 手动刷新当前自有凭证（传空串拒绝；未传时默认刷新当前唯一凭证）。 */
    async refresh(accountId) {
      if (accountId === '') throw new Error('accountId is required to refresh an account')
      let id = accountId === undefined || accountId === null ? '' : String(accountId).trim()
      if (id === '') {
        const current = await connector.ownAccounts()
        if (current.length === 0) throw new Error('当前尚未登录认证，无法刷新凭证')
        id = current[0].accountId
      }
      const raw = await connector.store.raw(id)
      if (raw === undefined) throw new Error(`account not found in this plugin's own store: ${id}`)
      return connector.refreshAccount(id)
    },

    /** 退出/清除认证凭证（传空串拒绝；未传或传 '*' 时清空当前唯一凭证）。 */
    async remove(accountId) {
      if (accountId === '') throw new Error('accountId is required to remove an account')
      const id = accountId === undefined || accountId === null ? '*' : String(accountId).trim() || '*'
      const removed = await connector.store.remove(id)
      return { removed, accountId: id }
    },

    /** 统一动作入口：list / login / poll / cancel / refresh / remove。 */
    async action(action, params = {}) {
      switch (action) {
        case 'list':
          return this.list()
        case 'login':
          return this.start(params.region)
        case 'poll':
          return this.poll(params.loginId, { region: params.region })
        case 'cancel':
          return { canceled: this.cancel(params.loginId), loginId: params.loginId }
        case 'refresh':
          return this.refresh(params.accountId)
        case 'remove':
          return this.remove(params.accountId)
        default:
          return {
            code: 'BAZAAR_PARAM_INVALID',
            field: 'action',
            error: 'unsupported account action: ' + String(action),
          }
      }
    },
  }
}

/**
 * 账号服务：把「扫码登录 → 存进本插件自己的库 → 刷新/删除/迁移」拼成一组动作。
 *
 * 存在的理由是把状态机放在一处：
 *   - `wb-login.js` 只管三个上游端点与会话表；
 *   - `wb-vault.js` 只管落盘、锁、脱敏视图；
 *   - 这里负责"轮询成功后必须立刻落盘"、"region 必须与申请时一致"、"刷新只对自有
 *     账号生效"这类跨模块规则。写进 index.js 会让它继续膨胀，写在 webui 里则工具
 *     调用拿不到同一份逻辑。
 *
 * 本模块没有 DSH import，可离线单测（fetch 可注入）。
 */
import { createLoginStore } from './wb-login.js'
import { importFromVault } from './wb-vault.js'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{
 *   connector: { saveAccount: Function, ownAccounts: Function, accounts: Function,
 *                status: Function, store: object, refreshAccount?: Function },
 *   loginStore?: object,
 *   fetchImpl?: Function,
 *   now?: Function,
 *   vaultDir?: string,
 *   urlConfig?: {allowHosts?: string[], allowInsecureLoopback?: boolean},
 * }} options
 */
export function createAccountService(options) {
  const connector = options.connector
  if (connector === undefined) throw new Error('createAccountService requires a connector')
  const now = options.now ?? (() => Date.now())
  // urlConfig 由该 provider 注入（从 allowHosts/allowInsecureLoopback 派生），
  // 随服务实例持有，登录三段式每次调用不必再由上层面面传。
  const urlConfig = options.urlConfig
  const login = options.loginStore ?? createLoginStore({
    ...urlConfig === undefined ? {} : { urlConfig },
  })
  // 登录这一步用调用方的 fetch（测试可注入），刷新走 connector 自己的那份。
  const fetchImpl = options.fetchImpl

  return {
    /** 申请一次登录；返回给人打开的 URL 和一个 loginId。 */
    async start(region) {
      // 登录区域必选：缺失或非法一律 BAZAAR_PARAM_INVALID 并指明字段，
      // 绝不静默当成 cn（那会把用户选错库伪装成申请成功）。
      if (region !== 'global' && region !== 'cn') {
        // 回显收到的值：面板把错误贴在 region 输入框旁，用户才知道自己填了什么。
        // 未提供与空串都写成「未提供」，而不是把 `undefined` 字面量丢给用户。
        const received =
          region === undefined || region === null || String(region).trim() === ''
            ? '未提供'
            : String(region)
        return {
          code: 'BAZAAR_PARAM_INVALID',
          field: 'region',
          admitted: ['cn', 'global'],
          error: '登录区域必选：region 必须是 cn 或 global，收到 ' + received,
        }
      }
      return login.start(region, {
        fetchImpl,
        now: now(),
        ...urlConfig === undefined ? {} : { urlConfig },
      })
    },

    /**
     * 轮询一次。成功后**立刻落盘**——把落盘放在这里而不是让调用方自己存，
     * 是为了避免"面板拿到 account 却忘了存"这种只在生产出现的漏。
     */
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

    /** 未完成的登录（面板显示"等待扫码"用），不含 state。 */
    pending() {
      return login.list(now())
    },

    /** 账号总览：1.0.0 只有本 provider 自己的分目录库，无兼容层。 */
    async list() {
      const [own, merged] = await Promise.all([
        connector.ownAccounts(),
        connector.accounts(),
      ])
      return {
        own,
        all: merged,
        summary: {
          count: merged.length,
          usableCount: merged.filter(item => item.hasToken && (!item.expired || item.refreshExpiresAt === 0 || item.refreshExpiresAt > now())).length,
          ownCount: own.length,
          // 面板要告诉用户"账号存在哪里"，所以这里给真实路径。
          // 契约规定 summary  MUST NOT 含 vaultCount/source——它们属于已删除的旧 vault 语义。
          dir: typeof connector.store?.root === 'string' ? connector.store.root : null,
        },
        pending: login.list(now()),
      }
    },

    /**
     * 强制刷新一条自有账号。
     *
     * 只允许自有账号：兼容层的文件归 `dsh-connect-workbuddy` 写，我们改它会让那个
     * 插件的 `refreshedAtMs` 与现实不符。要给那条刷新，就在那边点刷新。
     */
    async refresh(accountId) {
      const id = String(accountId ?? '').trim()
      if (id === '') throw new Error('accountId is required to refresh an account')
      const raw = await connector.store.raw(id)
      if (raw === undefined) throw new Error(`account not found in this plugin's own store: ${id}`)
      return connector.refreshAccount(id)
    },

    async remove(accountId) {
      const id = String(accountId ?? '').trim()
      if (id === '') throw new Error('accountId is required to remove an account')
      const removed = await connector.store.remove(id)
      return { removed, accountId: id }
    },

    /**
     * 账号动作统一委托入口：workbuddy provider 的 account 域经此分发。
     * 三段式（login / poll / cancel）与刷新、删除共用一处，避免面板与模型工具
     * 各自拼一套状态机而漂移。落盘发生在 poll 内部，成功后才呈现"已登录"。
     */
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

    /**
     * 把 `dsh-connect-workbuddy` 的 vault 一次性搬进来。
     *
     * 单向：读那边、写我们这边。不删也不改对方目录，所以随时可以反悔。
     */
    async importLegacy(importOptions = {}) {
      const vaultDir = importOptions.vaultDir ?? options.vaultDir
      if (typeof vaultDir !== 'string' || vaultDir === '') {
        throw new Error('no dsh-connect-workbuddy vault directory is configured')
      }
      const outcome = await importFromVault({
        vaultDir,
        store: connector.store,
        ...importOptions.regions === undefined ? {} : { regions: importOptions.regions },
      })
      return {
        imported: outcome.imported.length,
        skipped: outcome.skipped,
        errors: outcome.errors,
        accounts: outcome.imported,
      }
    },
  }
}

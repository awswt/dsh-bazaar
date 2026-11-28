/**
 * 内置 workbuddy provider（任务 2.7 的骨架，自注册）。
 *
 * 本任务只做「声明面 + 五域方法委托」：impl 里每个方法都转调插件既有实例（portal / market /
 * connectors / accounts），**不复制也不改写**它们的内部行为。端点、marketMode、缓存策略的
 * 搬迁属于组 3（专家/技能）与组 4（连接器/账号）：那时这些实例才真正搬进本目录，
 * 这里的方法签名与返回形状保持不变。
 *
 * 为什么先落地骨架：契约的活样例（examples/minimal-provider）与文档都需要一个能真的注册、
 * 列举得到、按域派发的内置 provider。没有它，2.8 的隔离矩阵只有示例一方，测不出「两个
 * provider 并存」的真实形状。
 *
 * 返回体纪律：一律「领域结构 + ok」，不另立 DTO。providerId 与 qualifiedName 由组 3 的
 * 分组返回层补，这里不补，避免两处各写一遍归一逻辑。
 */

import { CODES, fail, ok } from '../../provider/errors.js'
import { installSkill as installSkillFromMarket } from '../../skill-install.js'
import { createConnectorStore } from './connector-store.js'

/** 内置 provider 的 id。与 lib/index.js 的 BUILTIN_PROVIDER_ID 同值，用例里有断言守。 */
export const PROVIDER_ID = 'workbuddy'

/** 展示名。界面只显示这个；多库同名冲突时才用 id 作限定前缀。 */
export const DISPLAY_NAME = 'WorkBuddy'

const clampPage = function (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback
}

const clampPageSize = function (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 24) : fallback
}

/**
 * 构造内置 provider 的契约对象。
 *
 * @param {object} deps 插件既有实例，全部由 lib/index.js 注入（provider 不自己 new）
 * @param {object} [deps.portal] 在线门户：listExperts / getExpert / listSkills / available
 * @param {object} [deps.market] 公开快照：listExperts / getExpert / categories / marketSize
 * @param {object} [deps.connectors] 连接器控制器：connectorViews / catalog
 * @param {object} [deps.accounts] 账号服务：list / action
 * @param {object} [deps.config] 插件设置（allowHosts 等；下沉前仍从这里取）
 */
export function createWorkbuddyProvider(deps) {
  const portal = deps?.portal
  const market = deps?.market
  const connectors = deps?.connectors
  const accounts = deps?.accounts
  const config = deps?.config ?? {}

  /**
   * 合并连接器数据源：已装 DSH 连接器插件（真实工具数决定是否已连接）+ 本机 MCP 目录
   * （同步 dsh-mcp-connector 的真实连接态，未授权目录项标注 catalogOnly）。
   */
  async function combinedConnectorViews() {
    if (connectors === undefined) return { items: [], total: 0 }
    const pluginView =
      typeof connectors.connectorViews === 'function'
        ? await connectors.connectorViews().catch(() => ({ items: [] }))
        : { items: [] }
    const pluginItems = Array.isArray(pluginView?.items) ? pluginView.items : []
    const configView =
      typeof connectors.configs === 'function'
        ? await connectors.configs().catch(() => ({ items: [] }))
        : { items: [] }
    const stateView =
      typeof connectors.states === 'function'
        ? await connectors.states().catch(() => ({ items: {} }))
        : { items: {} }
    const stateMap =
      stateView !== null && typeof stateView === 'object' && stateView.items !== undefined
        ? stateView.items
        : {}

    const merged = new Map()
    for (const plugin of pluginItems) {
      const toolCount = Number(plugin.toolCount ?? 0) || 0
      const liveState = stateMap[plugin.id]
      const connected = liveState?.connected === true || toolCount > 0
      // 跳过无工具且未显式声明 connector 的模型/面板类 DSH 插件，避免把连接器面板塞满 0 工具条目。
      if (connected !== true && plugin.connector !== true) continue
      merged.set(plugin.id, {
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        displayName: plugin.name ?? plugin.id,
        description: plugin.description ?? '',
        summary: plugin.description ?? '',
        vendor: 'DSH 插件',
        category: 'local',
        transport: 'plugin',
        tools: toolCount,
        connected,
        state: {
          connected,
          connecting: liveState?.connecting === true,
          reason: liveState?.reason ?? null,
        },
        source: 'plugin',
        catalogOnly: false,
      })
    }
    const catalogConfigs = Array.isArray(configView?.items) ? configView.items : []
    for (const item of catalogConfigs) {
      if (item.source !== 'catalog' || merged.has(item.id)) continue
      const liveState = stateMap[item.id]
      const connected = liveState?.connected === true
      const serverTransport =
        Array.isArray(item.servers) && item.servers[0]?.transport
          ? String(item.servers[0].transport)
          : (item.auth?.mode ?? 'http')
      const liveTools = Array.isArray(liveState?.tools) ? liveState.tools.length : 0
      merged.set(item.id, {
        id: item.id,
        name: item.name ?? item.id,
        displayName: item.name ?? item.id,
        description: item.summary ?? item.description ?? '',
        summary: item.summary ?? item.description ?? '',
        vendor: item.vendor ?? '',
        category: item.category ?? 'catalog',
        tags: Array.isArray(item.tags) ? item.tags : [],
        serverName: item.serverName ?? null,
        transport: serverTransport,
        tools: liveTools > 0 ? liveTools : Number(item.tools ?? 0) || 0,
        connected,
        state: {
          connected,
          connecting: liveState?.connecting === true,
          reason: liveState?.reason ?? null,
        },
        source: 'catalog',
        catalogOnly: connected !== true,
      })
    }
    const items = [...merged.values()]
    return { items, total: items.length }
  }

  // provider 级连接器授权库：落到 <dataDir>/providers/workbuddy/connectors.json。
  // 门控判定仍留在 connectors.js；这里只管本库的授权状态与可复制文本。
  // deps.connectorStore 仅供测试夹具注入同一个实例（本地假 OAuth 回调要推进授权会话）；
  // 生产路径仍由 config.dataDir 派生，调用方无法绕过 provider 目录约定。
  const connectorStore =
    deps?.connectorStore ??
    (config.dataDir
      ? createConnectorStore({
          dataDir: config.dataDir,
          connectorViews: connectors === undefined ? null : () => combinedConnectorViews(),
          readCatalog: connectors === undefined ? null : () => connectors.catalog(),
        })
      : undefined)

  function isAuthFailure(error) {
    const code = error?.code
    return (
      code === CODES.PORTAL_AUTH_REQUIRED ||
      code === CODES.MARKET_AUTH_REQUIRED ||
      code === CODES.AUTH_MISSING
    )
  }

  /** 专家市场：未认证或凭证失效时直接返回鉴权要求（与设置页严格一致，不拿公开快照混淆）；仅网络/网关故障回落快照。 */
  async function listExperts(params = {}) {
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    const page = clampPage(params.page, 1)
    const pageSize = clampPageSize(params.pageSize, 12)
    const categoryId = params.categoryId
    let portalFailure
    if (portal !== undefined) {
      try {
        return await portal.listExperts({
          query: query,
          page: page,
          pageSize: pageSize,
          categoryId: categoryId,
        })
      } catch (error) {
        if (isAuthFailure(error) || market === undefined) throw error
        portalFailure = error
      }
    }
    if (market === undefined) {
      return fail(CODES.MARKET_UNAVAILABLE, 'workbuddy provider 没有可用的专家数据源', {
        domain: 'expertMarket',
        method: 'listExperts',
      })
    }
    // 门户已经失败过一次：优先直接读 COS 公开快照，避免 marketMode=portal 时重打门户死循环。
    const fallbackFn =
      portalFailure !== undefined && typeof market.listCos === 'function'
        ? (opts) => market.listCos(opts)
        : (opts) => market.listExperts(opts)
    const snapshot = await fallbackFn({
      query: query,
      page: page,
      pageSize: pageSize,
      categoryId: categoryId,
    })
    // 回落不是「一切正常」：调用方（分组层）要靠这条 warning 把「你看到的是快照」说清楚。
    // 静默回落会让用户以为在线门户的实时结果就长这样，故障被藏进正常返回里。
    if (portalFailure === undefined || snapshot === undefined || snapshot === null) return snapshot
    const reason = portalFailure instanceof Error ? portalFailure.message : String(portalFailure)
    return {
      ...snapshot,
      warning:
        typeof snapshot.warning === 'string' && snapshot.warning !== ''
          ? snapshot.warning
          : 'live market unavailable, showing the published snapshot: ' + reason,
    }
  }

  async function getExpert(params = {}) {
    const id = typeof params.id === 'string' ? params.id.trim() : ''
    if (id === '') return fail(CODES.PARAM_INVALID, 'getExpert 需要 id', { field: 'id' })
    if (portal !== undefined) {
      try {
        const hit = await portal.getExpert(id)
        if (hit !== undefined && hit !== null) return { item: hit }
      } catch (error) {
        if (isAuthFailure(error)) throw error
        // 门户非鉴权故障或未收录时回落快照。
      }
    }
    if (market !== undefined) {
      const hit =
        typeof market.getCosExpert === 'function'
          ? await market.getCosExpert(id)
          : await market.getExpert(id)
      if (hit !== undefined && hit !== null) return { item: hit }
    }
    return fail(CODES.EXPERT_NOT_FOUND, 'workbuddy 里没有专家 ' + JSON.stringify(id), { id: id })
  }

  async function listSkills(params = {}) {
    if (portal === undefined) {
      return fail(CODES.MARKET_UNAVAILABLE, 'workbuddy provider 的技能市场需要在线门户', {
        domain: 'skillMarket',
      })
    }
    return portal.listSkills({
      query: typeof params.query === 'string' ? params.query.trim() : '',
      page: clampPage(params.page, 1),
      pageSize: clampPageSize(params.pageSize, 12),
    })
  }

  /**
   * 技能真实落位（3.7）：下载、校验指纹、解压、`<projectRoot>/.dsh/skills/<slug>/` 落地
   * 全部由 skill-install.js 完成；provider 这一层只负责把归属（providerId）与出网配置
   * 传下去，并把异常的码还原成信封——契约要求失败返 {ok:false,code,message}，不抛。
   *
   * 返回体按 provider-registry spec 只承诺 {slug, installedPath, providerId}；
   * 另外带上 installed/files/bytes 供面板显示，属加法不属契约变更。
   */
  async function installSkill(params = {}) {
    const skillId = typeof params?.skillId === 'string' ? params.skillId.trim() : ''
    if (skillId === '')
      return fail(CODES.PARAM_INVALID, 'installSkill 需要 skillId', { field: 'skillId' })
    if (portal === undefined) {
      return fail(CODES.MARKET_UNAVAILABLE, 'workbuddy provider 的技能安装需要在线门户', {
        domain: 'skillMarket',
        method: 'installSkill',
      })
    }
    const workspace =
      typeof params?.workspace === 'string' && params.workspace.trim() !== ''
        ? params.workspace.trim()
        : undefined
    if (workspace === undefined) {
      return fail(
        CODES.PARAM_INVALID,
        'installSkill 需要 workspace：技能装到 <projectRoot>/.dsh/skills/<slug>/',
        {
          field: 'workspace',
        },
      )
    }
    try {
      const result = await installSkillFromMarket({
        portal,
        providerId: PROVIDER_ID,
        skillId,
        workspace,
        allowHosts: Array.isArray(config.allowHosts) ? config.allowHosts : [],
        allowInsecureLoopback: config.allowInsecureLoopback === true,
        force: params.force === true,
      })
      return {
        slug: result.installed.slug,
        installedPath: result.installed.path,
        providerId: PROVIDER_ID,
        installed: result.installed,
        files: result.files,
        bytes: result.bytes,
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : CODES.PARAM_INVALID
      return fail(code, error instanceof Error ? error.message : String(error), {
        domain: 'skillMarket',
        method: 'installSkill',
        ...(error !== null && typeof error === 'object' && error.details !== undefined
          ? error.details
          : {}),
      })
    }
  }

  /** 记忆市场委托 dsh-mnemon；宿主没装时必须显式不可用，不能伪装成空列表。 */
  async function listMemorySkills() {
    return fail(CODES.MEMORY_UNAVAILABLE, '记忆市场依赖宿主插件 dsh-mnemon，当前未安装', {
      domain: 'memoryMarket',
      plugin: 'dsh-mnemon',
    })
  }

  async function searchMemory(params = {}) {
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (query === '')
      return fail(CODES.PARAM_INVALID, 'searchMemory 需要 query', { field: 'query' })
    return fail(CODES.MEMORY_UNAVAILABLE, '记忆市场依赖宿主插件 dsh-mnemon，当前未安装', {
      domain: 'memoryMarket',
      plugin: 'dsh-mnemon',
    })
  }

  async function listConnectors(params = {}) {
    if (connectorStore !== undefined) {
      return connectorStore.listConnectorsFor(PROVIDER_ID, params)
    }
    if (connectors === undefined) {
      return fail(CODES.MARKET_UNAVAILABLE, 'workbuddy provider 的连接器目录不可用', {
        domain: 'connectorMarket',
      })
    }
    const view = await connectors.connectorViews()
    const catalog = await connectors.catalog()
    return { items: view.items, total: view.total, categories: catalog.categories }
  }

  async function getConnector(params = {}) {
    const id = typeof params.id === 'string' ? params.id.trim() : ''
    if (id === '') return fail(CODES.PARAM_INVALID, 'getConnector 需要 id', { field: 'id' })
    if (connectorStore !== undefined) {
      return connectorStore.getConnectorFor(PROVIDER_ID, id)
    }
    if (connectors === undefined) {
      return fail(CODES.CONNECTOR_NOT_FOUND, 'workbuddy provider 的连接器目录不可用', { id: id })
    }
    const view = await connectors.connectorViews()
    const hit = view.items.find(function (item) {
      return item.id === id || item.name === id
    })
    if (hit === undefined) {
      return fail(CODES.CONNECTOR_NOT_FOUND, 'workbuddy 里没有连接器 ' + JSON.stringify(id), {
        id: id,
      })
    }
    return { item: hit }
  }

  /**
   * 连接器动作：本版只放行只读与授权流；写入宿主配置类动作按契约拒绝
   * （组 4 收敛动作集时再收口，届时这里换成 controllers 的真实分发）。
   */
  const SUPPORTED_CONNECTOR_ACTIONS = [
    'list',
    'state',
    'authorize',
    'poll',
    'cancel',
    'copy-config',
    'remove',
  ]

  async function connectorAction(params = {}) {
    const action = typeof params.action === 'string' ? params.action : 'list'
    if (SUPPORTED_CONNECTOR_ACTIONS.includes(action) === false) {
      return fail(
        CODES.CONNECTOR_ACTION_UNSUPPORTED,
        'workbuddy 不支持连接器动作 ' +
          JSON.stringify(action) +
          '（支持：' +
          SUPPORTED_CONNECTOR_ACTIONS.join(', ') +
          '）',
        { action: action, supported: SUPPORTED_CONNECTOR_ACTIONS.slice() },
      )
    }
    // provider 级授权库接管全部七个动作：三段式授权即时持久化、copy-config 只产文本、
    // remove 只删本库记录。它绝不写宿主配置，写宿主配置类动作已在上面的白名单被拒。
    if (connectorStore !== undefined) {
      return connectorStore.connectorActionFor(PROVIDER_ID, action, params)
    }
    if (connectors === undefined) {
      return fail(CODES.CONNECTOR_NOT_FOUND, 'workbuddy provider 的连接器目录不可用', {
        action: action,
      })
    }
    // 没有授权库（测试注入了 connectors 但没给 dataDir）时，保留只读 list 的回落。
    if (action === 'list') {
      const view = await connectors.connectorViews()
      return ok({ action: action, items: view.items, total: view.total })
    }
    return fail(
      CODES.CONNECTOR_ACTION_UNSUPPORTED,
      '连接器动作 ' + JSON.stringify(action) + ' 需要 provider 级授权库（dataDir 未配置）',
      { action: action, supported: ['list'] },
    )
  }

  async function listAccounts() {
    if (accounts === undefined) {
      return fail(CODES.AUTH_MISSING, 'workbuddy provider 的账号服务不可用', { domain: 'account' })
    }
    return accounts.list()
  }

  const SUPPORTED_ACCOUNT_ACTIONS = ['list', 'login', 'poll', 'cancel', 'refresh', 'remove']

  async function accountAction(params = {}) {
    const action = typeof params.action === 'string' ? params.action.trim() : ''
    // 账号动作必须显式点名：空 payload 不许被当成 `list` 悄悄跑通。写动作上
    // 「没传就等于没做」会把用户填错的字段伪装成一次成功读取。
    if (action === '') {
      return fail(
        CODES.PARAM_INVALID,
        '账号动作必选：action 必须是 ' + SUPPORTED_ACCOUNT_ACTIONS.join(', '),
        { field: 'action', supported: SUPPORTED_ACCOUNT_ACTIONS.slice() },
      )
    }
    if (SUPPORTED_ACCOUNT_ACTIONS.includes(action) === false) {
      return fail(
        CODES.PARAM_INVALID,
        'workbuddy 不支持账号动作 ' +
          JSON.stringify(action) +
          '（支持：' +
          SUPPORTED_ACCOUNT_ACTIONS.join(', ') +
          '）',
        { field: 'action', action: action, supported: SUPPORTED_ACCOUNT_ACTIONS.slice() },
      )
    }
    if (accounts === undefined) {
      return fail(CODES.AUTH_MISSING, 'workbuddy provider 的账号服务不可用', { action: action })
    }
    if (action === 'list') return accounts.list()
    const result = await accounts.action(action, params)
    // 账号服务的失败是「带 code 的值」而不是信封（如 region 非法的 BAZAAR_PARAM_INVALID）。
    // 必须在这里折成信封：派发层只认 ok===false 的信封，非信封失败会被当成 200 成功，
    // 面板拿到的就是一个「成功」响应里嵌着的错误对象，字段级提示永远贴不上去。
    if (result !== null && typeof result === 'object' && typeof result.code === 'string') {
      const details = {}
      if (typeof result.field === 'string') details.field = result.field
      if (Array.isArray(result.admitted)) details.admitted = result.admitted.slice()
      return fail(
        result.code,
        typeof result.error === 'string' && result.error !== '' ? result.error : result.code,
        details,
      )
    }
    return { action: action, result }
  }

  return {
    apiVersion: 1,
    id: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    capabilities: {
      expertMarket: true,
      skillMarket: true,
      memoryMarket: true,
      connectorMarket: true,
      account: true,
    },
    // 出网白名单下沉到 provider 级：市场 4 域名（由 index.js 注入）+ 登录 2 域名，去重共 6 个。
    // 登录域名必须在这里补——它们不属于市场设置，登录出网点只认 provider 自己的 urlConfig。
    // urlConfig 由注册层从这两个字段派生冻结，随 impl 持有，调用方无法临时放宽。
    allowHosts: Array.from(
      new Set([
        ...(Array.isArray(config.allowHosts) && config.allowHosts.length > 0
          ? config.allowHosts
          : [
              'acc-1258344699.cos.accelerate.myqcloud.com',
              'www.workbuddy.cn',
              'www.workbuddy.ai',
              'openplatform-cdn.codebuddy.cn',
            ]),
        'www.codebuddy.cn',
        'www.codebuddy.ai',
      ]),
    ),
    allowInsecureLoopback: config.allowInsecureLoopback === true,
    impl: {
      expertMarket: { listExperts: listExperts, getExpert: getExpert },
      skillMarket: { listSkills: listSkills, installSkill: installSkill },
      memoryMarket: { listMemorySkills: listMemorySkills, searchMemory: searchMemory },
      connectorMarket: {
        listConnectors: listConnectors,
        getConnector: getConnector,
        connectorAction: connectorAction,
      },
      account: { listAccounts: listAccounts, accountAction: accountAction },
    },
  }
}

/** 自注册：apply() 在挂好 ctx.bazaar 之后调用它；失败只记日志，不阻断插件加载。 */
export async function registerWorkbuddyProvider(registry, deps) {
  if (registry === undefined || typeof registry.register !== 'function') {
    return ok({ skipped: true, reason: 'registry unavailable' })
  }
  return registry.register(createWorkbuddyProvider(deps))
}

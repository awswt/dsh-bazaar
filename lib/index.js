import os from 'node:os'
import path from 'node:path'
import { AuthError, describeAuth, redact, resolveAuth } from './auth.js'
import { BundleStore } from './bundle.js'
import { createConnectorController } from './connectors.js'
import { WorkBuddyConnector } from './connector.js'
import { MarketClient } from './providers/workbuddy/market.js'
import { createMnemonDetector } from './mnemon.js'
import { createActiveProviderSet } from './provider/active-set.js'
import { createDomainDispatcher } from './provider/dispatch.js'
import { createDomainViews } from './provider/domains.js'
import { createProviderRegistry } from './provider/registry.js'
import { registerProviderRoutes } from './provider/routes.js'
import { createProviderStatus, providerLayoutOf } from './provider/status.js'
import { PortalMarket } from './providers/workbuddy/portal.js'
import { registerWorkbuddyProvider } from './providers/workbuddy/index.js'
import { SessionManager } from './session.js'
import { listInstalledSkills } from './skill-install.js'
import { defineTool } from './tool-def.js'
import { expandHome, resolveDshHome } from './util.js'
import { createAccountService } from './wb-accounts.js'
import { registerWebUi } from './webui.js'

const DEFAULT_HOST = 'acc-1258344699.cos.accelerate.myqcloud.com'
const DEFAULT_BASE = `https://${DEFAULT_HOST}/workbuddy/expert-marketplace`
const PORTAL_HOSTS = ['www.workbuddy.cn', 'www.workbuddy.ai']
const CDN_HOSTS = ['openplatform-cdn.codebuddy.cn']

/**
 * 1.0.0 唯一内置 provider 的 id。它是 providerId（参与目录与凭据名推导），不是插件名；
 * 上游域名、桌面端目录等仍按既有常量保留原样。
 */
export const BUILTIN_PROVIDER_ID = 'workbuddy'
const USAGE = [
  'bazaar_helper actions:',
  '  status',
  '  providers',
  '  experts [provider=<id>] [query] [categoryId] [page] [pageSize]',
  '  expert <expertId> provider=<id>',
  '  off',
  '  skills',
  '  skills install <skillId> provider=<id> [--force]',
  '  set-skills provider=<id> <mode=all|selected> [names=a,b] [expertNames=c,d]',
  '  skill-market [provider=<id>] [query] [page] [pageSize]',
  '  connector [connectorAction=list|state|authorize|poll|cancel|copy-config|remove] [connectorId]',
  '  account [accountAction=list|login|poll|cancel|refresh|remove] [accountId] [region=cn|global] [loginId=...]',
  '  market [query]',
  '  categories',
].join('\n')

export const name = 'dsh-bazaar'
export const inject = ['tools', 'agents', 'systemPrompt', 'skills']

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const settings = {
    marketMode: config.marketMode ?? 'auto',
    marketBaseUrl: config.marketBaseUrl ?? DEFAULT_BASE,
    manifestPath: config.manifestPath ?? '/expert_center.json',
    portalBaseUrl: config.portalBaseUrl ?? 'https://www.workbuddy.cn',
    portalPrefix: config.portalPrefix ?? '/portal',
    timeoutMs: config.timeoutMs ?? 20000,
    retries: config.retries ?? 1,
    cacheTtlMs: config.cacheTtlMs ?? 6 * 60 * 60 * 1000,
    staleWhileErrorMs: config.staleWhileErrorMs ?? 7 * 24 * 60 * 60 * 1000,
    authMode: config.authMode ?? 'auto',
    // 凭据名不在这里写字面量：取值来源改由 providerId 推导（lib/provider/paths.js），
    // auth.js 在解析时才落到 BAZAAR_<ID>_TOKEN；providers.<id>.credentialRef 可覆盖。
    providerId: config.providerId ?? BUILTIN_PROVIDER_ID,
    // 默认空串是 1.0.0 的刻意默认：空值表示「没有默认库」，绝不静默当成「用注册顺序的第一家」。
    defaultProvider: config.defaultProvider ?? '',
    credentialRef: config.credentialRef,
    headerName: config.headerName ?? 'Authorization',
    headerPrefix: config.headerPrefix ?? 'Bearer ',
    connectorRegion: config.connectorRegion,
    allowHosts: config.allowHosts ?? [DEFAULT_HOST, ...PORTAL_HOSTS, ...CDN_HOSTS],
    allowInsecureLoopback: config.allowInsecureLoopback === true,
    maxPromptChars: config.maxPromptChars ?? 60000,
    maxSelectedSkills: config.maxSelectedSkills ?? 64,
    dataDir: expandHome(config.dataDir ?? path.join(resolveDshHome(), 'bazaar')),
    dshHome: expandHome(config.dshHome ?? resolveDshHome()),
    // 账号库放哪。刻意与 dsh-connect-workbuddy 的 vault 分开，两个插件都装时
    // 各写各的，谁也不改对方的文件。
    accountsDir: expandHome(config.accountsDir ?? path.join(config.dataDir ?? path.join(resolveDshHome(), 'bazaar'), 'accounts')),
    legacyVaultDir: config.legacyVaultDir === undefined
      ? path.join(expandHome(config.dshHome ?? resolveDshHome()), 'workbuddy-vault')
      : expandHome(config.legacyVaultDir),
    localRoots: config.localRoots ?? [
      path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins'),
      path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'my-experts'),
    ],
  }

  if (settings.authMode === 'workbuddy-connector' && config.allowPublicMarketAuth !== true) {
    try {
      if (new URL(settings.marketBaseUrl).hostname.toLowerCase() === DEFAULT_HOST) {
        throw new Error('refusing to send a WorkBuddy token to the public market host; use authMode=none, or set allowPublicMarketAuth=true only if the market operator requires it')
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('refusing')) throw error
    }
  }

  // 出网白名单派生一次，随各服务实例持有；登录/刷新/市场/快照/技能下载五处
  // 出网共用同一份配置与 assertAllowedUrl 落点。1.0.0 只有内置 workbuddy，
  // 其默认集合覆盖市场 4 域名 + 登录 2 域名（见 workbuddy/index.js 的推导）。
  const LOGIN_HOSTS = ['www.codebuddy.cn', 'www.codebuddy.ai']
  const urlConfig = Object.freeze({
    allowHosts: Object.freeze(Array.from(new Set([
      ...settings.allowHosts,
      ...LOGIN_HOSTS.filter(host => settings.allowHosts.includes(host) === false),
    ]))),
    allowInsecureLoopback: settings.allowInsecureLoopback,
  })

  const connector = new WorkBuddyConnector({
    dshHome: settings.dshHome,
    vaultDir: config.vaultDir === undefined ? undefined : expandHome(config.vaultDir),
    // 本插件自己的账号库目录（默认 `<dataDir>/accounts`），与兼容层 vault 完全分开。
    accountsDir: settings.accountsDir,
    urlConfig,
  })
  // 登录、刷新、迁移都收敛在这里；webui 与工具走同一个实例，避免两处状态机。
  const accounts = createAccountService({
    connector,
    vaultDir: settings.legacyVaultDir,
    // 测试与自建部署可以换掉 fetch；正常运行时用全局 fetch。
    fetchImpl: config.fetchImpl,
    urlConfig,
  })

  const credentialsService = ctx.get('credentials')
  const credentials = credentialsService === undefined ? undefined : {
    async resolve(ref) {
      try {
        return await credentialsService.resolve(ref)
      } catch {
        return undefined
      }
    },
    async describe(ref) {
      try {
        return await credentialsService.describe(ref)
      } catch {
        return { configured: false, source: 'unavailable', writable: false }
      }
    },
  }

  const authConfig = {
    mode: settings.authMode,
    providerId: settings.providerId,
    credentialRef: settings.credentialRef,
    headerName: settings.headerName,
    headerPrefix: settings.headerPrefix,
    connectorRegion: settings.connectorRegion,
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
  }
  const sources = { credentials, connector }

  const portalAuthMode = settings.authMode === 'auto' || settings.authMode === 'workbuddy-connector'
    ? 'auto'
    : settings.authMode
  const portal = new PortalMarket({
    baseUrl: settings.portalBaseUrl,
    prefix: settings.portalPrefix,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
    authProvider: () => resolveAuth({ ...authConfig, mode: portalAuthMode }, sources),
  })

  const market = new MarketClient({
    baseUrl: settings.marketBaseUrl,
    manifestPath: settings.manifestPath,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    cacheTtlMs: settings.cacheTtlMs,
    staleWhileErrorMs: settings.staleWhileErrorMs,
    cacheDir: path.join(settings.dataDir, 'cache'),
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
    mode: settings.marketMode,
    portal,
    authProvider: () => resolveAuth({
      ...authConfig,
      mode: settings.authMode === 'auto' || settings.authMode === 'workbuddy-connector' ? 'none' : settings.authMode,
    }, sources),
  })

  const bundles = new BundleStore({
    cacheDir: path.join(settings.dataDir, 'cache'),
    market,
    localRoots: settings.localRoots,
    maxPromptChars: settings.maxPromptChars,
  })

  // The grouped views are built further down (they need the registry), but the
  // session manager resolves experts through them. A getter keeps the
  // construction order free: nothing calls it before apply() returns.
  let views

  const sessions = new SessionManager({
    ctx,
    market,
    bundles,
    config: settings,
    getViews: () => views,
  })

  const connectors = createConnectorController(ctx, {
    dataDir: settings.dataDir,
    // 4.4 门控：本 catalog 的连接器归内置 provider；会话活跃集决定整库工具是否 deny。
    // activeProviders 在上面才构建，用 getter 延后取值，避免启动顺序问题。
    providerGate: {
      defaultProviderId: settings.providerId,
      activeProvidersOf: (sessionId) => activeProviders === undefined
        ? []
        : activeProviders.activeFor(sessionId),
    },
  })
  // 连接器的会话门控全靠这几个生命周期钩子（agent/created、agent/pre-step、
  // agent/disposed、tools/change）。忘记 init() 的后果是：一切"看起来正常"，
  // 但 tools.restrict 永远不会被调用——停用的连接器工具照样能被模型调到。
  connectors.init()

  // 「记忆系统技能市场」只有在 dsh-mnemon 真的装在当前 profile 时才有意义：
  // 它指向那个插件自己的技能管理页。profileDir 传函数是因为连接器控制器是惰性
  // 定位 profile 的，这里跟着它走，避免两边算出不同目录。缓存 60s，装/卸插件
  // 本来就要重启 DSH。
  const mnemonState = createMnemonDetector({
    dshHome: resolveDshHome(),
    profileDir: () => connectors.profileDir,
  })

  registerWebUi(ctx, {
    sessions,
    // 分组返回层与活跃集都在下面才构建（它们依赖注册表）。传 getter 而不是值：
    // 直接传 `views` 会永远是 undefined，面板就退回「一家库」的旧形状。
    getViews: () => views,
    getActive: () => activeProviders,
    // 本地已装专家包属于内置库的分区，面板据此把它们并进同一组。
    builtinProviderId: BUILTIN_PROVIDER_ID,
    market,
    bundles,
    connector,
    portal,
    connectors,
    mnemon: mnemonState,
    // 面板的「账号」区：扫码登录、刷新、删除、迁移旧 vault。
    accounts,
    // 技能真实安装要自己 fetch 签名 CDN 链接，必须带上与 portal 相同的白名单。
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
  })

  // provider 集合的唯一实例：注册表 + 活跃集 + 域入口判定。面板（HTTP 路由）、模型工具、
  // 斜杠命令都读这几件，任何入口都不自己算「该用哪家库」——多算一遍就是凭据串用的入口。
  //
  // 活跃集与会话分区的落盘都走 SessionManager 的唯一写入口（saveState）：注册表注销时
  // 调到的 clearProvider 就是它，活跃集的 readActive/writeActive 也是它。注册表内部
  // 不再持有第二份进程内状态，否则「表里没了、文件里还留着」这类漂移无法自证。
  let activeProviders

  const registry = createProviderRegistry({
    session: {
      async clearProvider(providerId) {
        return sessions.clearProvider(providerId)
      },
    },
    onChange(event) {
      // 组 4.4 的会话级门控重算挂在这里；本组只留痕，不提前接线。
      ctx.logger?.info?.(`bazaar: provider ${event.type}: ${String(event.providerId ?? '')}`)
    },
  })
  activeProviders = createActiveProviderSet(registry, {
    defaultProvider: settings.defaultProvider,
    session: {
      readActive: (sessionId) => sessions.readActive(sessionId),
      writeActive: (sessionId, providerIds) => sessions.writeActive(sessionId, providerIds),
    },
    onNotice: (notice) => {
      // 回落必须留痕：替用户选了库而不说，正是最难查的形态。
      ctx.logger?.warn?.(`bazaar: ${notice.message}`)
    },
  })

  // 域派发层：把「哪个 provider 的哪个域方法」这件事收成一处判定。分组返回层在它之上补
  // providerId 与 qualifiedName，不另立 DTO；面板、工具、命令都读同一份分组结果。
  const dispatcher = createDomainDispatcher(registry, {
    resolveActive: (sessionId) => activeProviders.activeFor(sessionId),
  })
  views = createDomainViews({ registry, active: activeProviders, dispatcher })

  // 设置页的「凭据 / 缓存」两块读这一处投影：凭据名与掩码来自 auth.js 的 describeAuth
  // （永不回显明文），缓存目录来自 paths.js 的 providerLayout（按 providerId 推导，不可指定）。
  // 放在活跃集之后构建，active 才知道本会话勾了哪几家。
  const providerStatus = createProviderStatus({
    registry,
    layoutOf: providerLayoutOf(settings.dataDir),
    activeOf: (sessionId) => activeProviders.activeFor(sessionId),
    describeCredential: (providerId, record) =>
      describeAuth(
        { ...authConfig, providerId: providerId, credentialRef: record?.credentialRef },
        sources,
      ),
  })

  // ctx.bazaar：第三方 provider 的注册点（任务 2.7 接线）。只给四个方法；
  // 带 impl 的内部读取口不外露。注销同时清活跃集，避免「表里没了、会话还指着它」。
  //
  // 必须走 ctx.provide() 而不是直接赋值：宿主 cordis 的 ctx 是 Proxy，set trap 对未
  // 声明的属性直接抛 `cannot set property "bazaar" without provide`，而 apply() 是同步
  // 执行的——抛出去等于整个插件加载失败，挂路由、注册工具、写会话状态全都不会发生
  // （面板两处「读取失败」就是这条链的后果）。裸对象 ctx（测试夹具、第三方宿主）没有
  // provide，退回普通赋值。
  const bazaarService = {
    providers: {
      register: (candidate) => registry.register(candidate),
      async unregister(providerId) {
        const result = await registry.unregister(providerId)
        if (result.ok === true) await activeProviders.clearProvider(providerId)
        return result
      },
      list: () => registry.list(),
      get: (providerId) => registry.get(providerId),
    },
  }

  if (typeof ctx.provide === 'function') ctx.provide('bazaar', bazaarService)
  else ctx.bazaar = bazaarService

  // 内置 workbuddy provider 在 apply() 期间自注册：注册表是唯一的 provider 集合来源，
  // 内置库也必须走同一道 register（同一套校验、同一份 onChange 通知），不许直插内部表。
  // 注册表把写路径串行化，因此这一步落定要晚一个微任务；面板、工具、命令、路由的读取
  // 都远在那之后，不影响「启动即可见」。
  // 失败只留一条 warn：内置库自己坏掉不该拖垮宿主启动，缺了它列表里少一个页签而已。
  void registerWorkbuddyProvider(registry, {
    portal,
    market,
    connectors,
    accounts,
    config: {
      allowHosts: settings.allowHosts,
      allowInsecureLoopback: settings.allowInsecureLoopback,
      // 连接器授权库落到 providers/workbuddy/connectors.json，需要 bazaar 根目录。
      dataDir: settings.dataDir,
    },
  }).then(
    (result) => {
      if (result?.ok === false) {
        ctx.logger?.warn?.(
          `bazaar: 内置 provider 注册失败 ${result.code}: ${result.message}`,
        )
      }
    },
    (error) => {
      ctx.logger?.warn?.(`bazaar: 内置 provider 注册异常 ${error?.message ?? String(error)}`)
    },
  )

  const releaseProviderRoutes = registerProviderRoutes(ctx, {
    active: activeProviders,
    // provider 级连接器写路由（路径段/请求体 providerId 一致性）要过域入口；
    // 传 getter 以跟随热重载时 views 的重建，避免闭包里持有旧实例。
    getViews: () => views,
    // /providers/<id>/status 与 /providers/<id>/cache/clear 读同一份投影。
    status: providerStatus,
  })

  const run = async (agent, action, args = {}) => {
    // 显式 provider 参数在进任何 action 前先校验：非法 id 绝不能被当成「没传」而继续跑，
    // 那会让拼错的库名静默落到默认路径上。域动作按 provider 派发随组 3/4 接进来。
    if (args.provider !== undefined && args.provider !== null && args.provider !== '') {
      const resolved = await activeProviders.resolveProvider(agent.id, args.provider)
      if (resolved.ok === false) return { ok: false, text: resolved.code + ': ' + resolved.message }
    }
    switch (action) {
      case 'providers':
        return { ok: true, data: await activeProviders.describeProviders(agent.id) }
      case 'status': {
        const view = sessions.view(agent.id)
        const [connectorStatus, accountView] = await Promise.all([
          connector.status(),
          accounts.list().catch(() => undefined),
        ])
        const authStatus = await describeAuth(authConfig, sources)
        return {
          ok: true,
          data: {
            ...view,
            connector: connectorStatus,
            // 1.0.0 没有兼容层：账号只在本 provider 的分目录库里。
            // summary 刻意不暴露 vaultCount/source——它们属于已删除的旧 vault 语义。
            accounts: accountView === undefined ? null : {
              count: accountView.summary.count,
              ownCount: accountView.summary.ownCount,
              usableCount: accountView.summary.usableCount,
              dir: accountView.summary.dir,
              pending: accountView.pending.length,
            },
            auth: authStatus,
            market: {
              mode: settings.marketMode,
              portal: await portal.available(),
              snapshotBaseUrl: settings.marketBaseUrl,
            },
            // 面板的「记忆系统技能市场」页签靠这个决定是否出现；模型也能据此知道
            // 本机有没有那套技能管理页可指路。
            mnemon: await mnemonState(),
          },
        }
      }
      case 'expert': {
        if (typeof args.expertId !== 'string' || args.expertId.trim() === '') {
          return { ok: false, text: 'expertId is required for action=expert' }
        }
        // 选择必须带库：同一 id 在不同库里可能是两个专家，猜错库就写错分区。
        // requireProviderId 在活跃集为空或有多个库时抛 BAZAAR_PROVIDER_REQUIRED。
        return {
          ok: true,
          data: await sessions.selectExpert(agent.id, args.expertId.trim(), { providerId: args.provider }),
        }
      }
      case 'off':
        return { ok: true, data: await sessions.clear(agent.id) }
      case 'skills': {
        // skillAction=install 直接把市场技能装进当前工作区；默认只列会话里的技能。
        if (args.skillAction === 'install') {
          const skillId = typeof args.skillId === 'string' ? args.skillId.trim() : ''
          if (skillId === '') return { ok: false, text: 'skillId is required for action=skills, skillAction=install' }
          const workspace = agent?.session?.header?.cwd ?? process.cwd()
          // 走分组返回层而不是直接调 skill-install：归属（providerId）由库决定，
          // 冲突检测与「谁装的」元数据都靠它，绕过它装出来的技能没有归属。
          const target = await activeProviders.resolveProvider(agent.id, args.provider)
          if (target.ok === false) return { ok: false, text: target.code + ': ' + target.message }
          const result = await views.installSkill({
            providerId: target.providerId,
            skillId,
            workspace,
            // force=true 只在操作者明确知道残留锁是自己的死进程留下时使用；
            // 它跳过 stale 等待直接破锁，代价是可能打断另一个真在跑的安装。
            force: args.force === true,
          })
          if (result.ok === false) {
            return { ok: false, text: result.code + ': ' + result.message }
          }
          // 信封的 ok 是传输层字段，不进结果体：data 里再出现一个 ok 会让面板
          // 无法区分「域调用成功」与「安装本身成功」。
          const installed = { ...result }
          delete installed.ok
          return {
            ok: true,
            data: { action: 'skills', subaction: 'install', workspace, providerId: target.providerId, ...installed },
          }
        }
        if (args.skillAction === 'installed') {
          const workspace = agent?.session?.header?.cwd ?? process.cwd()
          return { ok: true, data: { action: 'skills', subaction: 'installed', workspace, items: await listInstalledSkills(workspace) } }
        }
        return { ok: true, data: await sessions.listSkills(agent.id) }
      }
      case 'skill-market': {
        // 技能市场按库分组，两个来源（skillMarket / memoryMarket）并列标注；
        // 分页参数非法时由 pageOptions 拦下并指明字段，不静默兜底。
        return {
          ok: true,
          data: await views.listSkills({
            sessionId: agent.id,
            providers: args.provider === undefined ? undefined : [args.provider],
            query: typeof args.query === 'string' ? args.query.trim() : '',
            page: args.page,
            pageSize: args.pageSize,
          }),
        }
      }
      case 'experts': {
        // 分组并列的专家列表：每组带 providerId / displayName / status，
        // 未激活的库不出现，也不会为它发出网请求。
        return {
          ok: true,
          data: await views.listExperts({
            sessionId: agent.id,
            providers: args.provider === undefined ? undefined : [args.provider],
            query: typeof args.query === 'string' ? args.query.trim() : '',
            categoryId: typeof args.categoryId === 'string' ? args.categoryId.trim() : undefined,
            page: args.page,
            pageSize: args.pageSize,
          }),
        }
      }
      case 'set-skills': {
        const mode = args.mode === 'selected' ? 'selected' : args.mode === 'all' ? 'all' : undefined
        const globalNames = parseList(args.names)
        const expertNames = parseList(args.expertNames)
        return {
          ok: true,
          data: await sessions.setSkills(agent.id, {
            providerId: args.provider,
            globalMode: mode,
            globalNames,
            expertNames,
          }),
        }
      }
      case 'connector': {
        const sub = String(args.connectorAction ?? (typeof args.connectorId === 'string' ? 'status' : 'list')).trim()
        const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : ''
        if (sub === 'list' || sub === 'catalog' || sub === 'status') {
          const [view, catalog, states, accounts, shared] = await Promise.all([
            connectors.connectorViews(),
            connectors.catalog(),
            connectors.states(agent.id),
            connector.status().catch(() => undefined),
            connectors.shared().catch(() => undefined),
          ])
          const connected = Object.values(states).filter(state => state?.connected === true)
          return {
            ok: true,
            data: {
              action: 'connector',
              subaction: sub,
              catalogTotal: catalog.total,
              categories: catalog.categories,
              pluginTotal: view.total,
              plugins: view.items,
              accounts: accounts === undefined ? null : {
                installed: accounts.installed,
                accountCount: accounts.accountCount,
                usableAccountCount: accounts.usableAccountCount,
              },
              // 连接器管理页（dsh-mcp-connector）那边的连接；两边共用同一批 mcp__ 工具。
              connectorUi: shared === undefined
                ? null
                : {
                  available: shared.available,
                  file: shared.file,
                  connectionCount: shared.connections.size,
                  connectors: [...shared.byConnector.keys()],
                },
              connectedCount: connected.length,
              connected: connected.map(state => ({ id: state.configId, source: state.source, toolCount: state.toolCount, tools: state.tools })),
              disabled: [...connectors.disabledOf(agent.id)],
              pending: connectors.pendingOperations(),
              patchPath: connectors.patchPath,
            },
          }
        }
        if (connectorId === '') return { ok: false, text: `connectorId is required for connectorAction=${sub}` }
        const sessionId = agent.id
        // 1.0.0 动作集收敛（4.2/4.4）：授权三段式 + 只读 + remove 走 provider 域。
        // 写宿主配置类旧动作一律 BAZAAR_CONNECTOR_ACTION_UNSUPPORTED——写启动补丁
        // 与重载留到 1.1.0，本版只提供 copy-config 产出可复制的手工配置片段。
        const SUPPORTED = ['state', 'authorize', 'poll', 'cancel', 'copy-config', 'remove']
        const LEGACY_WRITE = ['connect', 'repair', 'repairConnect', 'reauthorize', 'disconnect', 'unbind', 'enable', 'disable', 'updateHeaders', 'updateEnv', 'setPatchedDisabled']
        if (LEGACY_WRITE.includes(sub)) {
          return {
            ok: false,
            code: 'BAZAAR_CONNECTOR_ACTION_UNSUPPORTED',
            text: `connectorAction=${sub} writes the host MCP config; 1.0.0 supports only: ${SUPPORTED.join(', ')} (use copy-config for a manual snippet)`,
          }
        }
        if (SUPPORTED.includes(sub) === false) {
          return { ok: false, text: `unknown connectorAction: ${sub}` }
        }
        // state 保留旧只读视图（面板依赖其字段形状）；其余动作经 provider 域派发，
        // 让授权状态按库隔离、copy-config 不写宿主配置的规则只有一处实现。
        if (sub === 'state') {
          return { ok: true, data: await connectors.stateOf(connectorId, sessionId) }
        }
        const resolved = await activeProviders.resolveProvider(agent.id, args.provider)
        if (resolved.ok === false) return { ok: false, text: resolved.code + ': ' + resolved.message }
        const result = await views.connectorAction({
          providerId: resolved.providerId,
          action: sub,
          id: connectorId,
          sessionId: args.loginId ?? args.sessionId ?? sessionId,
          region: args.region,
        })
        return {
          ok: result.ok !== false,
          ...result.ok === false
            ? { text: result.code + ': ' + result.message }
            : { data: result },
        }
      }
      case 'account': {
        const sub = String(args.accountAction ?? 'list').trim()
        switch (sub) {
          case 'list': {
            const view = await accounts.list()
            return {
              ok: true,
              data: {
                action: 'account',
                subaction: sub,
                ...view.summary,
                own: view.own,
                all: view.all,
                pending: view.pending,
              },
            }
          }
          case 'login': {
            // 返回给人打开的 URL。模型不能替人扫码，所以这里只把链路递出去。
            const started = await accounts.start(args.region === 'global' ? 'global' : 'cn')
            if (started.error !== undefined) return { ok: false, text: `could not start the WorkBuddy sign-in: ${started.error}` }
            return {
              ok: true,
              data: {
                action: 'account',
                subaction: sub,
                loginId: started.loginId,
                verificationUri: started.verificationUri,
                expiresIn: started.expiresIn,
                region: started.region,
                next: 'open verificationUri in a browser, then poll with accountAction=poll and this loginId',
              },
            }
          }
          case 'poll': {
            const loginId = String(args.loginId ?? '').trim()
            if (loginId === '') return { ok: false, text: 'loginId is required for accountAction=poll' }
            const outcome = await accounts.poll(loginId, {
              ...args.region === 'global' || args.region === 'cn' ? { region: args.region } : {},
            })
            return { ok: outcome.error === undefined, data: { action: 'account', subaction: sub, loginId, ...outcome } }
          }
          case 'cancel': {
            const cancelled = accounts.cancel(String(args.loginId ?? '').trim())
            return { ok: cancelled, data: { action: 'account', subaction: sub, cancelled } }
          }
          case 'refresh': {
            const accountId = String(args.accountId ?? '').trim()
            if (accountId === '') return { ok: false, text: 'accountId is required for accountAction=refresh' }
            return { ok: true, data: { action: 'account', subaction: sub, account: await accounts.refresh(accountId) } }
          }
          case 'remove': {
            const accountId = String(args.accountId ?? '').trim()
            if (accountId === '') return { ok: false, text: 'accountId is required for accountAction=remove' }
            return { ok: true, data: { action: 'account', subaction: sub, ...await accounts.remove(accountId) } }
          }
          case 'import': {
            // 一次性把 dsh-connect-workbuddy 的 vault 搬进本插件自己的库（只读那边）。
            return { ok: true, data: { action: 'account', subaction: sub, ...await accounts.importLegacy() } }
          }
          default:
            return { ok: false, text: `unknown accountAction: ${sub}\n${USAGE}` }
        }
      }
      case 'market': {
        const query = String(args.query ?? '').trim().toLowerCase()
        const [remote, local, portalAvailable] = await Promise.all([
          market.listExperts({ query: args.query ?? '', limit: 10 }),
          bundles.listLocal(),
          portal.available(),
        ])
        const localPlugins = new Set(local.map(item => item.plugin))
        const remoteItems = remote.items.map(item => ({
          ...item,
          installed: localPlugins.has(item.plugin),
        }))
        const localOnly = local
          .filter(item => !remoteItems.some(remoteItem => remoteItem.plugin === item.plugin || remoteItem.id === item.id))
          .filter(item => query === '' || [item.id, item.plugin, item.agentName, item.displayName, item.profession, item.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query))
          .slice(0, 10)
        const items = [
          ...localOnly.map(item => ({ ...item, source: 'local' })),
          ...remoteItems,
        ].slice(0, 20)
        const marketTotal = portalAvailable ? await market.marketSize() : remote.total
        return {
          ok: true,
          data: {
            source: remote.source,
            marketTotal,
            matchedTotal: remote.total,
            publicTotal: marketTotal,
            localTotal: local.length,
            matched: items.length,
            portalAvailable,
            stale: remote.stale,
            fetchedAt: remote.fetchedAt,
            warning: remote.warning,
            items,
          },
        }
      }
      case 'categories': {
        return {
          ok: true,
          data: {
            source: (await portal.available()) ? 'portal' : 'cos',
            items: await market.categories(),
          },
        }
      }
      default:
        return { ok: false, text: USAGE }
    }
  }

  const format = result => {
    if (result.ok === false) return result.text ?? 'ERROR: request failed'
    return JSON.stringify(result.data, null, 2)
  }

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    ctx.tools.register(defineTool({
      name: 'bazaar_helper',
      description:
        'Inspect or change the expert, skill and connector selection of the CALLING session. '
        + 'Actions: status, providers, experts, expert, off, skills, set-skills, skill-market, connector, account, market, categories. '
        + 'providers lists every registered marketplace with its capabilities and whether this session has it active; pass provider=<id> to target one library explicitly. '
        + 'expert and set-skills REQUIRE provider: one session can light several libraries at once, so the same expert id in two libraries is two different experts. '
        + 'accountAction=list|login|poll|cancel|refresh|remove signs in to WorkBuddy in-process (no dsh-connect-workbuddy needed) and stores the token in this plugin\'s own account store. '
        + 'market queries the live WorkBuddy marketplace when the connector has an account token, and falls back to the published snapshot otherwise. '
        + 'The selection is session-scoped: it never changes another session and never writes global configuration. '
        + 'connectorAction=list|state|authorize|poll|cancel|copy-config|remove drives the WorkBuddy connector catalog for this session; '
        + 'authorize returns status connected|connecting|action-required|failed, and action-required carries the token form or OAuth handoff to finish.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'status | expert | off | skills | set-skills | skill-market | connector | account | market | categories',
        },
        skillAction: {
          type: 'string',
          description: 'Skill sub-action for action=skills: install (needs skillId) | installed (list what is on disk in the workspace).',
        },
        skillId: {
          type: 'string',
          description: 'Market skill id (skill_...) used with action=skills, skillAction=install.',
        },
        force: {
          type: 'boolean',
          description: 'Skill install: break a leftover .lock-<slug> directory instead of waiting it out. Use only when you know the previous install died; it can interrupt a live one.',
        },
        page: {
          type: 'number',
          description: 'Page number for action=skill-market (default 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Page size for action=skill-market (default 12, max 24).',
        },
        expertId: {
          type: 'string',
          description: 'Expert id, plugin slug or agentName used by action=expert.',
        },
        connectorAction: {
          type: 'string',
          description: 'Connector sub-action for action=connector: list (default) | state | connect | repair | cancel | disconnect | unbind | enable | disable.',
        },
        connectorId: {
          type: 'string',
          description: 'Connector id from the catalog or a connector plugin name, used with connectorAction.',
        },
        accountAction: {
          type: 'string',
          description: 'Account sub-action for action=account: list (default) | login | poll | cancel | refresh | remove | import. login returns a verificationUri a human must open; poll with the returned loginId stores the token in this plugin\'s own account store; import migrates a dsh-connect-workbuddy vault read-only.',
        },
        accountId: {
          type: 'string',
          description: 'Account id from accountAction=list, used with accountAction=refresh or remove.',
        },
        loginId: {
          type: 'string',
          description: 'Login id returned by accountAction=login, used with accountAction=poll or cancel.',
        },
        region: {
          type: 'string',
          description: 'WorkBuddy realm for accountAction=login/poll: cn (default) or global. A token issued by one realm is rejected by the other, so pick the realm the human actually uses.',
        },
        token: {
          type: 'string',
          description: 'Credential for connectorAction=connect when the connector authorises by api-key or bearer token.',
        },
        provider: {
          type: 'string',
          description:
            'Target provider id (^[a-z][a-z0-9-]{0,31}$). action=providers lists the registered set and which are active for this session. '
            + 'An unknown or malformed id is refused with BAZAAR_PROVIDER_UNKNOWN / BAZAAR_PROVIDER_INVALID_ID instead of guessing another library.',
        },
        query: {
          type: 'string',
          description: 'Search text used by action=market, experts and skill-market.',
        },
        mode: {
          type: 'string',
          description: 'Global skill mode for action=set-skills: all or selected.',
        },
        names: {
          type: 'string',
          description: 'Comma-separated global skill names for action=set-skills.',
        },
        expertNames: {
          type: 'string',
          description: 'Comma-separated expert skill names for action=set-skills.',
        },
        categoryId: {
          type: 'string',
          description: 'Category filter for action=experts. Combines with query inside each library partition.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return 'ERROR: bazaar_helper requires a calling session'
        try {
          const result = await run(agent, args.action, args)
          return format(result)
        } catch (error) {
          const message = error instanceof AuthError
            ? `${error.code}: ${redact(error.message, [])}`
            : redact(error instanceof Error ? error.message : String(error), [])
          return `ERROR: ${message}`
        }
      },
    }))
  }

  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      name: 'bazaar',
      description: 'Select or inspect this session\'s expert, skills and connectors.',
      input: { hint: 'status | providers | experts [provider=<id>] [query] | expert <id> provider=<id> | off | skills [install <skillId> provider=<id> [--force] | installed] | connector <list|state|authorize|poll|cancel|copy-config|remove> [id] | account <list|login|poll|refresh|remove> [id] | market <query>' },
      async handler({ agent, rawInput }) {
        if (agent === undefined) return { kind: 'error', text: 'no calling session' }
        const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const action = tokens.shift() ?? 'status'
        const args = {}
        // provider= / categoryId= 是跨动作的通用开关：从 token 流里摘掉，
        // 剩下的才是位置参数（专家 id、查询词），顺序不受开关位置影响。
        for (const token of [...tokens]) {
          const [key, value] = token.split('=')
          if (key === 'provider') {
            args.provider = value
            tokens.splice(tokens.indexOf(token), 1)
          }
          if (key === 'categoryId') {
            args.categoryId = value
            tokens.splice(tokens.indexOf(token), 1)
          }
        }
        if (action === 'expert') args.expertId = tokens.join(' ')
        if (action === 'experts' || action === 'market' || action === 'skill-market') args.query = tokens.join(' ')
        if (action === 'skills') {
          // skills install <skillId> [--force] / skills installed
          const sub = tokens.shift()
          if (sub === 'install' || sub === 'installed') {
            args.skillAction = sub
            const rest = tokens.filter(token => token !== '--force')
            if (sub === 'install') args.skillId = rest.shift() ?? ''
            args.force = tokens.indexOf('--force') >= 0
          }
        }
        if (action === 'connector') {
          args.connectorAction = tokens.shift() ?? 'list'
          const rest = tokens.join(' ').trim()
          if (rest !== '') args.connectorId = rest
        }
        if (action === 'account') {
          // account <sub> [accountId|loginId] [region=cn|global]
          args.accountAction = tokens.shift() ?? 'list'
          for (const token of [...tokens]) {
            const [key, value] = token.split('=')
            if (key === 'region') {
              args.region = value
              tokens.splice(tokens.indexOf(token), 1)
            }
            if (key === 'loginId') {
              args.loginId = value
              tokens.splice(tokens.indexOf(token), 1)
            }
          }
          const target = tokens.join(' ').trim()
          if (target !== '') {
            if (args.accountAction === 'poll' || args.accountAction === 'cancel') args.loginId = target
            else args.accountId = target
          }
        }
        if (action === 'set-skills') {
          for (const token of tokens) {
            const [key, value] = token.split('=')
            if (key === 'mode') args.mode = value
            if (key === 'names') args.names = value
            if (key === 'expertNames') args.expertNames = value
          }
        }
        try {
          return { kind: 'success', text: format(await run(agent, action, args)) }
        } catch (error) {
          return { kind: 'error', text: redact(error instanceof Error ? error.message : String(error), []) }
        }
      },
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    void sessions.onAgentCreated(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    sessions.onAgentDisposed(agent.id)
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      // 路由要先撤：热重载时残留的 provider 路由会用已失效的闭包应答，
      // 面板看到的就是「集合读不到」而不是「插件重载了」。
      if (typeof releaseProviderRoutes === 'function') releaseProviderRoutes()
      connectors.dispose()
      void sessions.disposeAll()
    }, 'bazaar: dispose session fibers')
  }

  queueMicrotask(() => {
    void sessions.reconcile().catch(error => {
      ctx.logger?.warn?.('bazaar: reconcile failed: %s', String(error))
    })
  })
}

function parseList(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

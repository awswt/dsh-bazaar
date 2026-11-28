/**
 * 组 5 API 链路测试的隔离 HTTP harness（api-test skill 的「隔离基础设施」）。
 *
 * 这里不写任何生产路径的 stub：registry / active / dispatcher / domains / connectorStore /
 * accounts / providerStatus / workbuddy provider 全部用 lib/ 的真实实现，挂的也是
 * lib/provider/routes.js 与 lib/webui.js 注册的真实 handler。webServer 只在真实 Node
 * http.Server 与 register({kind,path,handler}) 之间做一层分派适配（exact 优先、其次最长前缀），
 * 让 .http 脚本能走真正的 HTTP 协议（provider-routes.test.mjs 用的是内存假对象）。
 *
 * 出网被钉死：所有 fetchImpl 都是同一个抛错实现。harness 里出现的任何"连不上"错误都说明
 * 代码试图出网，而不是 harness 给了假答案——脚本断言的路径都不需要网络。
 *
 * 仅额外暴露两个**测试夹具**端点，不属于生产路由：
 * - POST /__test/complete-auth：模拟上游 OAuth 回调，推进真实 store 的授权会话；
 * - GET  /__test/store-file：只读返回 provider store 的磁盘快照，供后置校验断言落盘字段。
 */

import { promises as fs, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeAuth } from '../lib/auth.js'
import { BundleStore } from '../lib/bundle.js'
import { WorkBuddyConnector } from '../lib/connector.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'
import { createDomainViews } from '../lib/provider/domains.js'
import { createProviderStatus, providerLayoutOf } from '../lib/provider/status.js'
import { registerProviderRoutes } from '../lib/provider/routes.js'
import { createConnectorStore } from '../lib/providers/workbuddy/connector-store.js'
import { createWorkbuddyProvider } from '../lib/providers/workbuddy/index.js'
import { MarketClient } from '../lib/providers/workbuddy/market.js'
import { PortalMarket } from '../lib/providers/workbuddy/portal.js'
import { createAccountService } from '../lib/wb-accounts.js'
import { registerWebUi } from '../lib/webui.js'
import { tempDirSync } from './temp.mjs'

/** 编排会话建议端口，避免与宿主/并发 change 的默认端口冲突。 */
export const API_PORT = 39320

/** 内置 provider 的 id（脚本里的 PROVIDER_ID 仍从列举响应取，不依赖这个常量）。 */
const BUILTIN_PROVIDER_ID = 'workbuddy'

/** 隔离标识：临时目录前缀与夹具账号的 uid/token 都带它，用后随临时目录一起消失。 */
const ISOLATION_TAG = 'bce4b8'

/** 与 lib/index.js 同一份登录白名单；市场域名由 provider 自己派生。 */
const LOGIN_HOSTS = ['www.codebuddy.cn', 'www.codebuddy.ai']

const CATALOG = [
  {
    id: 'github',
    name: 'GitHub',
    displayName: 'GitHub 连接器',
    vendor: 'GitHub',
    summary: '代码托管',
    category: 'dev',
    tags: ['git', 'code'],
    auth: { mode: 'oauth2-pkce' },
  },
  {
    id: 'slack',
    name: 'Slack',
    displayName: 'Slack 连接器',
    vendor: 'Slack',
    summary: '团队消息',
    category: 'comm',
    tags: ['chat'],
    auth: { mode: 'token' },
  },
  {
    id: 'notion',
    name: 'Notion',
    displayName: 'Notion 连接器',
    vendor: 'Notion',
    summary: '知识库',
    category: 'docs',
    tags: ['wiki'],
    auth: { mode: 'token' },
  },
]

const noop = async function () {
  return { ok: true }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * harness 的唯一 fetch：调用即抛。凭据刷新、登录、市场拉取都在这里立刻失败，
 * 因此"脚本跑绿"不可能是网络给的答案。
 */
function offlineFetch() {
  throw new Error('api harness forbids egress: no fetch is expected on the assertion paths')
}

/**
 * 面板域的宿主依赖里，harness 不实现的几件（会话面板状态、连接器控制器）。
 * 用会抛错的代理而不是返回空壳：请求真打到它们时，报错比"假装成功"可诊断。
 */
function untouchable(name) {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error('api harness does not provide deps.' + name + '.' + String(key))
      },
    },
  )
}

function readJson(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/**
 * 真实 webServer 的分派语义，够 harness 用：exact 先匹配（同名取后注册者），
 * 否则在 prefix 里取路径最长的一条（`/dsh-bazaar/providers` 不能抢走更具体的注册）。
 */
function createRouteTable() {
  const specs = new Map()
  return {
    webServer: {
      register(spec) {
        const key = String(spec.kind ?? 'exact') + ' ' + spec.path
        specs.set(key, spec)
        return () => specs.delete(key)
      },
    },
    resolve(pathname) {
      const exact = specs.get('exact ' + pathname)
      if (exact !== undefined) return exact
      let best
      for (const spec of specs.values()) {
        if (spec.kind !== 'prefix') continue
        if (pathname !== spec.path && pathname.startsWith(spec.path + '/') === false) continue
        if (best === undefined || spec.path.length > best.path.length) best = spec
      }
      return best
    },
  }
}

/**
 * 组装真实 provider 栈并返回一个可 listen/close 的 http.Server。
 * @param {object} options { dataDir?, port? }
 */
export async function createApiServer(options = {}) {
  const ownsDataDir = options.dataDir === undefined
  // 自建的临时 profile 同样进 test/temp.mjs 的登记表：close() 正常删掉是第一道，
  // 进程退出兜底是第二道（harness 被 Ctrl+C / 断言提前抛错打断时，close() 轮不到）。
  const dataDir = options.dataDir ?? tempDirSync('bz-api-' + ISOLATION_TAG + '-')
  const cacheDir = path.join(dataDir, 'cache')
  const accountsDir = path.join(dataDir, 'accounts')
  const urlConfig = Object.freeze({
    allowHosts: Object.freeze(LOGIN_HOSTS.slice()),
    allowInsecureLoopback: false,
  })

  const store = createConnectorStore({
    dataDir,
    connectorViews: async () => ({ items: CATALOG, total: CATALOG.length }),
    readCatalog: async () => ({ categories: ['dev', 'comm', 'docs'] }),
  })
  const registry = createProviderRegistry({
    session: {
      async clearProvider(id) {
        return { ok: true, providerId: id }
      },
    },
  })

  // 账号链路用真实的本地文件型账号库（落盘 + 读回，不经 network）。登录动作在
  // region/action 校验处就被拒，所以下面播的这条夹具账号是"已登录"的真实数据：
  // 账号分组的条目必须真的来自账号库，否则"读到空清单"这种坏结果也能通过断言。
  // token 是假值（offlineFetch 保证不刷新、不出网）。
  const connector = new WorkBuddyConnector({
    dshHome: dataDir,
    accountsDir: accountsDir,
    urlConfig: urlConfig,
    fetchImpl: offlineFetch,
  })
  await connector.saveAccount({
    uid: 'fixture-' + ISOLATION_TAG,
    region: 'cn',
    nickname: '夹具账号',
    accessToken: 'fixture-access-token-' + ISOLATION_TAG,
    refreshToken: 'fixture-refresh-token-' + ISOLATION_TAG,
    expiresAtMs: Date.now() + 3600 * 1000,
  })
  const accounts = createAccountService({
    connector: connector,
    fetchImpl: offlineFetch,
    urlConfig: urlConfig,
  })
  const portal = new PortalMarket({
    allowHosts: LOGIN_HOSTS.slice(),
    allowInsecureLoopback: false,
    fetchImpl: offlineFetch,
  })
  const market = new MarketClient({
    baseUrl: 'https://www.codebuddy.cn',
    cacheDir: cacheDir,
    portal: portal,
    allowHosts: LOGIN_HOSTS.slice(),
    allowInsecureLoopback: false,
    fetchImpl: offlineFetch,
  })
  const bundles = new BundleStore({ cacheDir: cacheDir, market: market, localRoots: [] })

  await registry.register(
    createWorkbuddyProvider({
      config: { dataDir: dataDir },
      connectorStore: store,
      accounts: accounts,
      market: market,
      portal: portal,
    }),
  )
  await registry.register({
    apiVersion: 1,
    id: 'demo',
    displayName: '示例库',
    capabilities: { expertMarket: true },
    impl: { expertMarket: { listExperts: noop, getExpert: noop } },
  })

  const active = createActiveProviderSet(registry, {})
  const dispatcher = createDomainDispatcher(registry, { resolveActive: () => [] })
  const views = createDomainViews({ registry: registry, active: active, dispatcher: dispatcher })

  // 设置页的两块投影：凭据名/掩码来自 auth.js 的 describeAuth（永不回显明文），
  // 缓存目录来自 paths.js 的 providerLayout。与 lib/index.js 同一处装配。
  const providerStatus = createProviderStatus({
    registry: registry,
    layoutOf: providerLayoutOf(dataDir),
    activeOf: (sessionId) => active.activeFor(sessionId),
    describeCredential: (providerId, record) =>
      describeAuth(
        { mode: 'auto', providerId: providerId, credentialRef: record?.credentialRef },
        {
          connector: connector,
        },
      ),
  })

  const table = createRouteTable()
  // 宿主的 dispose 契约：两条注册路径上都可能挂 effect（作用域级 + 根级），close()
  // 时按注册顺序反向跑一遍。没有这一层，关闭后表里还留着会回调已释放闭包的路由。
  const disposers = []
  const rememberEffect = (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const ctx = {
    inject(deps, fn) {
      fn({ webServer: deps?.webServer ?? table.webServer, effect: rememberEffect })
    },
    effect: rememberEffect,
    logger: { info() {}, warn() {} },
  }

  // 两组路由都挂真实注册函数：provider 分组路由 + 面板的扁平路由（脚本的步骤 5 走后者）。
  const releaseProviderRoutes = registerProviderRoutes(ctx, {
    active: active,
    getViews: () => views,
    status: providerStatus,
  })
  registerWebUi(ctx, {
    // 面板的会话区（状态/选专家/技能）不在本次链路断言范围内：harness 不实现它们，
    // 被触达时直接抛错。市场、bundle、账号、连接器、状态投影都是真实实例。
    sessions: untouchable('sessions'),
    market: market,
    bundles: bundles,
    connector: connector,
    accounts: accounts,
    portal: portal,
    connectors: untouchable('connectors'),
    // 临时 profile 里没有装 dsh-mnemon，这是真实答案而不是占位。
    mnemon: async () => ({ available: false, version: null, path: null, source: null }),
    getViews: () => views,
    getActive: () => active,
    builtinProviderId: BUILTIN_PROVIDER_ID,
    allowHosts: LOGIN_HOSTS.slice(),
    allowInsecureLoopback: false,
  })

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      // 测试夹具：模拟上游回调；完成后真实 store 的会话进入 granted/cancelled。
      if (url.pathname === '/__test/complete-auth' && request.method === 'POST') {
        const body = await readJson(request)
        const outcome = body?.outcome === 'cancelled' ? 'cancelled' : 'granted'
        const result = await store.completeAuthorizationFor(
          'workbuddy',
          text(body?.sessionId),
          outcome,
        )
        sendJson(response, result.ok === false ? 400 : 200, result)
        return
      }

      // 后置校验：只读读取 provider store 的磁盘快照，断言关键字段确实落盘。
      if (url.pathname === '/__test/store-file' && request.method === 'GET') {
        const providerId = text(url.searchParams.get('providerId'))
        const file = store.storePathFor(providerId)
        let snapshot = { version: 1, configs: {}, sessions: {} }
        try {
          snapshot = JSON.parse(await fs.readFile(file, 'utf8'))
        } catch {
          // 文件尚未生成时按空快照返回，仍可断言"没有被污染"。
        }
        sendJson(response, 200, { providerId: providerId, file: file, snapshot: snapshot })
        return
      }

      const spec = table.resolve(url.pathname)
      if (spec === undefined) {
        sendJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      await spec.handler(request, response)
    } catch (error) {
      if (response.headersSent === false) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  })

  return {
    dataDir: dataDir,
    store: store,
    registry: registry,
    active: active,
    server: server,
    listen(port = options.port ?? API_PORT) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    /**
     * 关服务、放路由、清临时 profile。自证服务用后即停：只删自己 mkdtemp 出来的目录，
     * 调用方显式传进来的 dataDir 属于调用方，不替他删。
     *
     * `server.close()` 本身会被 undici（`fetch`）的 keep-alive 连接挂住，关不掉就轮不到
     * 删目录——先断空闲连接、再强制断全部，否则每跑一次用例就在 %TEMP% 留一个 profile。
     */
    async close() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch {
          // 已释放的路由不必再抛一次。
        }
      }
      if (typeof releaseProviderRoutes === 'function') releaseProviderRoutes()
      const closed = new Promise((resolve) => server.close(resolve))
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await closed
      if (ownsDataDir === true) {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    },
  }
}

/**
 * 判断「本文件就是这个进程的入口」。
 *
 * 必须走 `fileURLToPath`：`new URL(import.meta.url).pathname` 是**百分号编码**串
 * （`E:/a%20b/代码/api-http-server.mjs`），与 `process.argv[1]` 的原始路径永远不相等。
 * 于是 isMain 恒为 false，`node test/api-http-server.mjs` 静默退出——链路脚本实跑时
 * 看到的是「服务没起来」而不是「入口判定写错了」，排查成本全落在错的地方（q5-007）。
 */
export function resolvesToEntry(moduleUrl, argv1) {
  if (argv1 === undefined) return false
  return path.resolve(argv1) === path.resolve(fileURLToPath(moduleUrl))
}

// 直接 `node test/api-http-server.mjs` 时自启，供 api-tests 链路脚本实跑；
// 被 import 时只导出 createApiServer，不产生监听副作用。
const isMain = typeof process !== 'undefined' && resolvesToEntry(import.meta.url, process.argv[1])
if (isMain) {
  createApiServer().then((api) => {
    // 硬杀（Stop-Process）拦不住，但 Ctrl+C / 正常退出必须把临时 profile 带走。
    let stopping = false
    const stop = () => {
      if (stopping === true) return
      stopping = true
      api.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    process.on('SIGHUP', stop)
    api.listen().then(() => {
      console.log('API_HARNESS_READY port=' + API_PORT + ' dataDir=' + api.dataDir)
    })
  })
}

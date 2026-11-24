/**
 * 组 4 API 链路测试的隔离 HTTP harness（api-test skill 的「隔离基础设施」）。
 *
 * 这里不写任何生产路径的 stub：registry / active / dispatcher / domains / connectorStore /
 * workbuddy provider 全部用 lib/ 的真实实现，挂的也是 lib/provider/routes.js 注册的真实
 * handler。webServer 只是在真实 Node http.Server 与 register({kind,path,handler}) 之间做一层
 * 分派适配，让 .http 脚本能走真正的 HTTP 协议（provider-routes.test.mjs 用的是内存假对象）。
 *
 * 仅额外暴露两个**测试夹具**端点，不属于生产路由：
 * - POST /__test/complete-auth：模拟上游 OAuth 回调，推进真实 store 的授权会话；
 * - GET  /__test/store-file：只读返回 provider store 的磁盘快照，供后置校验断言落盘字段。
 */

import { promises as fs } from 'node:fs'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createProviderRegistry } from '../lib/provider/registry.js'
import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'
import { createDomainViews } from '../lib/provider/domains.js'
import { registerProviderRoutes } from '../lib/provider/routes.js'
import { createConnectorStore } from '../lib/providers/workbuddy/connector-store.js'
import { createWorkbuddyProvider } from '../lib/providers/workbuddy/index.js'

/** 编排会话建议端口，避免与宿主/并发 change 的默认端口冲突。 */
export const API_PORT = 39320

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
 * 组装真实 provider 栈并返回一个可 listen/close 的 http.Server。
 * @param {object} options { dataDir?, port? }
 */
export async function createApiServer(options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), 'bz-api-bce4b8-'))
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
  await registry.register(
    createWorkbuddyProvider({ config: { dataDir: dataDir }, connectorStore: store }),
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

  const routes = new Map()
  const webServer = {
    register(spec) {
      const key = spec.kind + ' ' + spec.path
      routes.set(key, spec.handler)
      return () => routes.delete(key)
    },
  }
  const ctx = {
    inject(deps, fn) {
      fn({ webServer: deps?.webServer ?? webServer })
    },
    logger: { info() {}, warn() {} },
  }
  const release = registerProviderRoutes(ctx, { active: active, views: views })

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

      let handler
      if (url.pathname === '/dsh-bazaar/providers/active') {
        handler = routes.get('exact /dsh-bazaar/providers/active')
      } else if (url.pathname === '/dsh-bazaar/providers') {
        handler = routes.get('exact /dsh-bazaar/providers')
      } else if (url.pathname.startsWith('/dsh-bazaar/providers')) {
        handler = routes.get('prefix /dsh-bazaar/providers')
      }
      if (handler === undefined) {
        sendJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      await handler(request, response)
    } catch (error) {
      if (response.headersSent === false) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  })

  return {
    dataDir: dataDir,
    store: store,
    server: server,
    listen(port = options.port ?? API_PORT) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    close() {
      if (typeof release === 'function') release()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// 直接 `node test/api-http-server.mjs` 时自启，供 api-tests 链路脚本实跑；
// 被 import 时只导出 createApiServer，不产生监听副作用。
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  createApiServer().then((api) =>
    api.listen().then(() => {
      console.log('API_HARNESS_READY port=' + API_PORT + ' dataDir=' + api.dataDir)
    }),
  )
}

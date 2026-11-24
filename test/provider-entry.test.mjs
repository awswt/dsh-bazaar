/**
 * 插件入口侧的 provider 集合接线（任务 2.6 的「四处读同一份集合」在 lib/index.js 上的证明）。
 *
 * 上一批用例证的是 provider 层纯函数；这里证入口真的挂上了同一个实例：ctx.bazaar 四个方法、
 * 工具的 providers 动作与 provider 参数、HTTP 路由、配置里的 defaultProvider。假 ctx 参照
 * test/host-integration.mjs 的形状，另加 webServer 注入。
 *
 * 注意工具的输出形状：bazaar_helper 返回的是 data 的 JSON 文本（引导错误才是纯文案），
 * 所以 callText() 拿原文、call() 尽力解析——两种都要断言，否则等于没测 execute 的出口。
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promises as fs } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'
import { CODES } from '../lib/provider/errors.js'
import { PROVIDER_PREFIX, PROVIDER_ROUTES } from '../lib/provider/routes.js'
import { REQUIRED_METHODS } from '../lib/provider/contract.js'
import { PROVIDER_ID as BUILTIN_PROVIDER_ID } from '../lib/providers/workbuddy/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = '127.0.0.1:3080'

async function harness(config = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bz-provider-entry-'))
  const routes = new Map()
  const notices = []
  const agent = {
    id: 'sess-provider',
    session: { header: { cwd: process.cwd() } },
    ctx: {
      async plugin() {
        return { async dispose() {} }
      },
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        ctx.registeredTool = definition
      },
    },
    agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
    systemPrompt: { section: () => () => {} },
    skills: {
      async list() {
        return []
      },
      async snapshot() {
        return { skills: [], complete: true }
      },
      registerProvider: () => () => {},
    },
    get(name) {
      if (name === 'commands') return { register() {} }
      return undefined
    },
    inject(deps, fn) {
      if (deps.includes('webServer') === false) return
      fn({
        webServer: {
          register(spec) {
            routes.set(spec.kind + ' ' + spec.path, spec.handler)
            return () => routes.delete(spec.kind + ' ' + spec.path)
          },
        },
      })
    },
    on() {},
    effect(cb) {
      cb()
      return () => {}
    },
    logger: { info() {}, warn: (message) => notices.push(String(message)) },
  }
  apply(ctx, {
    dataDir,
    authMode: 'none',
    fetchImpl: async () => {
      throw new Error('offline fixture: these cases never reach upstream')
    },
    ...config,
  })

  const callText = async (args) => String(await ctx.registeredTool.execute(args, { agent }))
  const call = async (args) => {
    const text = await callText(args)
    return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : { text: text }
  }

  const requestFor = (body) => {
    const stream = new Readable({ read() {} })
    stream.method = 'POST'
    stream.url = PROVIDER_ROUTES.active
    stream.headers = { host: HOST }
    setImmediate(() => {
      stream.push(JSON.stringify(body))
      stream.push(null)
    })
    return stream
  }

  const reply = async (key, request) => {
    const handler = routes.get(key)
    assert.ok(handler, 'route must exist: ' + key)
    const chunks = []
    const response = {
      status: undefined,
      writeHead(status) {
        response.status = status
      },
      end(payload) {
        chunks.push(String(payload ?? ''))
      },
      get text() {
        return chunks.join('')
      },
      json() {
        return JSON.parse(chunks.join(''))
      },
    }
    await handler(request, response)
    return response
  }

  const getRequest = (urlPath) => ({ method: 'GET', url: urlPath, headers: { host: HOST } })

  return { ctx, agent, call, callText, reply, requestFor, getRequest, routes, notices, dataDir }
}

/** 契约完整、离线可用的示例 provider：五域全声明，方法只返回固定值。 */
function demoProvider(id) {
  const asyncFn = async function () {
    return { items: [], total: 0 }
  }
  return {
    apiVersion: 1,
    id: id,
    displayName: 'ACME 专家库',
    capabilities: {
      expertMarket: true,
      skillMarket: true,
      memoryMarket: true,
      connectorMarket: true,
      account: true,
    },
    impl: {
      expertMarket: { listExperts: asyncFn, getExpert: asyncFn },
      skillMarket: { listSkills: asyncFn, installSkill: asyncFn },
      memoryMarket: { listMemorySkills: asyncFn, searchMemory: asyncFn },
      connectorMarket: { listConnectors: asyncFn, getConnector: asyncFn, connectorAction: asyncFn },
      account: { listAccounts: asyncFn, accountAction: asyncFn },
    },
  }
}

test('apply() 挂出 ctx.bazaar 的四个方法，注册即可被列举', async () => {
  const setup = await harness()
  assert.equal(typeof setup.ctx.bazaar?.providers?.register, 'function')
  assert.equal(typeof setup.ctx.bazaar.providers.unregister, 'function')
  assert.equal(typeof setup.ctx.bazaar.providers.list, 'function')
  assert.equal(typeof setup.ctx.bazaar.providers.get, 'function')
  // 2.7 起 apply() 会自注册内置 workbuddy provider：初始集合不是空表，而是恰好只有内置库。
  // 内置库走的是同一条 register（同一套校验、同一份 onChange），不是直插内部表。
  const initial = setup.ctx.bazaar.providers.list()
  assert.deepEqual(
    initial.map((p) => p.id),
    [BUILTIN_PROVIDER_ID],
    '内置库必须注册且排在首位：' + JSON.stringify(initial),
  )
  assert.deepEqual(
    Object.keys(initial[0].capabilities).sort(),
    Object.keys(REQUIRED_METHODS).sort(),
  )
  assert.equal(
    setup.notices.some((line) => line.includes('内置 provider')),
    false,
    '内置自注册不该失败：' + setup.notices.join('\n'),
  )
  const registered = await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  assert.equal(registered.ok, true, JSON.stringify(registered))
  assert.deepEqual(
    setup.ctx.bazaar.providers.list().map((p) => p.id),
    [BUILTIN_PROVIDER_ID, 'acme'],
  )
  assert.equal(setup.ctx.bazaar.providers.get('acme').ok, true)
  assert.equal(setup.ctx.bazaar.providers.get('ghost').code, CODES.PROVIDER_UNKNOWN)
  assert.equal(
    Object.prototype.hasOwnProperty.call(setup.ctx.bazaar.providers.get('acme').provider, 'impl'),
    false,
  )
})

test('契约不合法的注册经 ctx.bazaar 被拒，且不进入列举', async () => {
  const setup = await harness()
  assert.equal(
    (await setup.ctx.bazaar.providers.register({ ...demoProvider('bad1'), apiVersion: 2 })).code,
    CODES.PROVIDER_API_VERSION,
  )
  assert.equal(
    (await setup.ctx.bazaar.providers.register(demoProvider('../evil'))).code,
    CODES.PROVIDER_INVALID_ID,
  )
  assert.deepEqual(
    setup.ctx.bazaar.providers.list().map((p) => p.id),
    [BUILTIN_PROVIDER_ID],
    '被拒的注册不占位，集合里只剩内置库',
  )
})

test('工具的 providers 动作与 GET /dsh-bazaar/providers 读同一集合', async () => {
  const setup = await harness()
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  const viaTool = await setup.call({ action: 'providers' })
  const acme = viaTool.items.find((p) => p.id === 'acme')
  assert.equal(acme.displayName, 'ACME 专家库')
  assert.deepEqual(Object.keys(acme.capabilities).sort(), Object.keys(REQUIRED_METHODS).sort())
  assert.equal(acme.active, false, '未选择时是空态，不是默认激活')
  assert.equal(viaTool.defaultProvider, '')
  const url = new URL(PROVIDER_ROUTES.list, 'http://' + HOST)
  url.searchParams.set('sessionId', setup.agent.id)
  const viaRoute = await setup.reply(
    'exact ' + PROVIDER_ROUTES.list,
    setup.getRequest(url.pathname + url.search),
  )
  assert.equal(viaRoute.status, 200, viaRoute.text)
  assert.deepEqual(viaRoute.json().items, viaTool.items, '两处集合必须逐字段相同')
  assert.deepEqual(viaRoute.json().activeProviders, viaTool.activeProviders)
})

test('provider 参数非法或未注册时各回各码，且不带 JSON 数据', async () => {
  const setup = await harness()
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  const unknown = await setup.callText({ action: 'status', provider: 'ghost' })
  assert.ok(unknown.includes(CODES.PROVIDER_UNKNOWN), unknown)
  // 可选项必须出现在文案里：工具入口只透出 code + message，光靠信封字段调用方看不到该改成什么。
  assert.ok(unknown.includes('acme'), '未注册要把已注册的可选项说出去：' + unknown)
  const illegal = await setup.callText({ action: 'status', provider: '../acme' })
  assert.ok(illegal.includes(CODES.PROVIDER_INVALID_ID), illegal)
  // 合法 provider 不拦：走的是既有 action 的正常路径。
  const fine = await setup.callText({ action: 'status', provider: 'acme' })
  assert.equal(fine.includes(CODES.PROVIDER_UNKNOWN), false, fine.slice(0, 200))
})

test('POST /dsh-bazaar/providers/active 写入后，工具侧立刻看到 active', async () => {
  const setup = await harness()
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  const written = await setup.reply(
    'exact ' + PROVIDER_ROUTES.active,
    setup.requestFor({ sessionId: setup.agent.id, activeProviders: ['acme'] }),
  )
  assert.equal(written.status, 200, written.text)
  assert.deepEqual(written.json().activeProviders, ['acme'])
  const seen = await setup.call({ action: 'providers' })
  assert.deepEqual(seen.activeProviders, ['acme'], '写入后工具侧必须立刻可见（同一个实例）')
  assert.equal(seen.items.find((p) => p.id === 'acme').active, true)
})

test('活跃集写入被拒时不落半份，工具侧仍是空态', async () => {
  const setup = await harness()
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  const bad = await setup.reply(
    'exact ' + PROVIDER_ROUTES.active,
    setup.requestFor({ sessionId: setup.agent.id, activeProviders: ['acme', 'ghost'] }),
  )
  assert.equal(bad.status, 400, bad.text)
  assert.equal(bad.json().code, CODES.PROVIDER_UNKNOWN)
  const seen = await setup.call({ action: 'providers' })
  assert.deepEqual(seen.activeProviders, [])
})

test('defaultProvider 指向未注册 id：回落首个已注册并留下 warn 提示', async () => {
  const setup = await harness({ defaultProvider: 'ghost' })
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  const seen = await setup.call({ action: 'providers' })
  // 首个已注册是内置 workbuddy（自注册早于本用例的 acme），回落目标随之变成它。
  assert.deepEqual(seen.activeProviders, [BUILTIN_PROVIDER_ID])
  assert.equal(seen.items.find((p) => p.id === BUILTIN_PROVIDER_ID).active, true)
  assert.equal(
    setup.notices.some((line) => line.includes('ghost')),
    true,
    setup.notices.join('\n'),
  )
})

test('经 ctx.bazaar 注销 provider 后，列举与活跃集同步收缩', async () => {
  const setup = await harness()
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  await setup.ctx.bazaar.providers.register(demoProvider('other'))
  await setup.reply(
    'exact ' + PROVIDER_ROUTES.active,
    setup.requestFor({ sessionId: setup.agent.id, activeProviders: ['acme', 'other'] }),
  )
  const result = await setup.ctx.bazaar.providers.unregister('acme')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(
    setup.ctx.bazaar.providers.list().map((p) => p.id),
    [BUILTIN_PROVIDER_ID, 'other'],
    '注销只摘掉 acme，内置库与 other 原样保留',
  )
  const seen = await setup.call({ action: 'providers' })
  assert.deepEqual(seen.activeProviders, ['other'], '注销后该会话不再向 acme 派发')
})

test('provider 路由前缀与 lib/webui.js 的 PREFIX 同源', async () => {
  const webui = await fs.readFile(path.join(root, 'lib', 'webui.js'), 'utf8')
  const match = /const PREFIX = '([^']+)'/.exec(webui)
  assert.ok(match, 'lib/webui.js must keep one PREFIX constant')
  assert.equal(PROVIDER_PREFIX, match[1] + '/providers')
})

test('三条入口共用同一实例：路由写入、工具读取、命令走同一条 run()', async () => {
  const setup = await harness()
  await setup.ctx.bazaar.providers.register(demoProvider('acme'))
  const listed = setup.ctx.bazaar.providers.list()
  const viaRoute = await setup.reply(
    'exact ' + PROVIDER_ROUTES.list,
    setup.getRequest(PROVIDER_ROUTES.list),
  )
  const viaTool = await setup.call({ action: 'providers' })
  assert.deepEqual(
    viaRoute.json().items.map((p) => p.id),
    listed.map((p) => p.id),
  )
  assert.deepEqual(
    viaTool.items.map((p) => p.id),
    listed.map((p) => p.id),
  )
})

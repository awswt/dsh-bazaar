/**
 * provider 路由的用例（任务 2.6 的 HTTP 侧）。
 *
 * 不引真 HTTP server：webServer 用假对象记录注册与调用，断言直接对着信封下。
 * 这样能守住真正会回归的东西（状态码、码名、同源校验、集合一致），而不是 http 细节。
 */

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { PROVIDER_PREFIX, PROVIDER_ROUTES, registerProviderRoutes } from '../lib/provider/routes.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fn = async function () {
  return {}
}

class FakeResponse {
  constructor() {
    this.statusCode = undefined
    this.headers = undefined
    this.body = ''
  }
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers
  }
  end(payload) {
    this.body = String(payload ?? '')
  }
  json() {
    return JSON.parse(this.body)
  }
}

function fakeRequest(method, url, body, headers = {}) {
  const request = new Readable({ read() {} })
  request.method = method
  request.url = url
  request.headers = { host: '127.0.0.1:3080', ...headers }
  if (body !== undefined) {
    setImmediate(() => {
      request.push(JSON.stringify(body))
      request.push(null)
    })
  } else {
    setImmediate(() => request.push(null))
  }
  return request
}

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    webServer: {
      register(spec) {
        routes.set(spec.kind + ' ' + spec.path, spec.handler)
        return () => routes.delete(spec.kind + ' ' + spec.path)
      },
    },
  }
}

async function harness(options = {}) {
  const registry = createProviderRegistry({
    session: {
      async clearProvider(id) {
        return { ok: true, providerId: id }
      },
    },
  })
  for (const pair of [
    ['workbuddy', 'WorkBuddy 专家库'],
    ['demo', '示例库'],
  ]) {
    await registry.register({
      apiVersion: 1,
      id: pair[0],
      displayName: pair[1],
      capabilities: { expertMarket: true },
      impl: { expertMarket: { listExperts: fn, getExpert: fn } },
    })
  }
  const active = createActiveProviderSet(registry, { defaultProvider: options.defaultProvider })
  const server = fakeWebServer()
  const released = []
  const ctx = {
    inject(deps, fn2) {
      released.push(fn2({ webServer: options.noWebServer ? {} : server.webServer }))
    },
    logger: { info() {}, warn() {} },
  }
  const release = registerProviderRoutes(ctx, { active, views: options.views })
  return { registry, active, server, release, ctx }
}

async function call(server, key, request) {
  const handler = server.routes.get(key)
  assert.ok(handler, 'route must be registered: ' + key)
  const response = new FakeResponse()
  await handler(request, response)
  return response
}

test('路由前缀与 lib/webui.js 同源，改名不会只改一处', () => {
  const webui = readFileSync(path.join(root, 'lib', 'webui.js'), 'utf8')
  const match = /const PREFIX = '([^']+)'/.exec(webui)
  assert.ok(match, 'lib/webui.js must keep a single PREFIX constant')
  assert.equal(PROVIDER_PREFIX, match[1] + '/providers')
  assert.equal(PROVIDER_ROUTES.list, PROVIDER_PREFIX)
  assert.equal(PROVIDER_ROUTES.active, PROVIDER_PREFIX + '/active')
})

test('GET /providers 与工具 providers 动作返回同一集合', async () => {
  const setup = await harness()
  await setup.active.setActive('s1', ['demo'])
  const response = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.list + '',
    fakeRequest('GET', PROVIDER_ROUTES.list + '?sessionId=s1'),
  )
  assert.equal(response.statusCode, 200, response.body)
  const listed = response.json()
  assert.deepEqual(
    listed.items.map((p) => [p.id, p.active]),
    [
      ['workbuddy', false],
      ['demo', true],
    ],
  )
  // 与 describeProviders 完全同一份数据：路由层不自己算集合。
  assert.deepEqual(listed, await setup.active.describeProviders('s1'))
  assert.equal(JSON.stringify(listed).includes('impl'), false)
})

test('缺 sessionId 时只列声明面，active 全 false 而不是报错', async () => {
  const setup = await harness()
  const response = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.list,
    fakeRequest('GET', PROVIDER_ROUTES.list),
  )
  assert.equal(response.statusCode, 200)
  const listed = response.json()
  assert.deepEqual(listed.activeProviders, [])
  assert.deepEqual(
    listed.items.map((p) => p.active),
    [false, false],
  )
})

test('POST /providers/active 写入活跃集，非法 id 整笔被拒', async () => {
  const setup = await harness()
  const okWrite = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.active,
    fakeRequest('POST', PROVIDER_ROUTES.active, {
      sessionId: 's1',
      activeProviders: ['workbuddy', 'demo'],
    }),
  )
  assert.equal(okWrite.statusCode, 200, okWrite.body)
  assert.deepEqual(okWrite.json().activeProviders, ['workbuddy', 'demo'])
  const bad = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.active,
    fakeRequest('POST', PROVIDER_ROUTES.active, { sessionId: 's1', activeProviders: ['ghost'] }),
  )
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, CODES.PROVIDER_UNKNOWN)
})

test('写路由拒绝跨源 POST，GET 不受同源限制', async () => {
  const setup = await harness()
  const cross = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.active,
    fakeRequest(
      'POST',
      PROVIDER_ROUTES.active,
      { sessionId: 's1', activeProviders: [] },
      { origin: 'http://evil.example' },
    ),
  )
  assert.equal(cross.statusCode, 403, cross.body)
  // 被拒的写入不留痕：活跃集仍是空态，而不是半份 ['workbuddy']。
  assert.deepEqual(await setup.active.activeFor('s1'), [])
  const sameOriginGet = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.list,
    fakeRequest('GET', PROVIDER_ROUTES.list, undefined, { origin: 'http://127.0.0.1:3080' }),
  )
  assert.equal(sameOriginGet.statusCode, 200)
})

test('GET /providers/<id> 命中已注册库，未注册给 PROVIDER_UNKNOWN 而不是 404', async () => {
  const setup = await harness()
  const hit = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('GET', PROVIDER_PREFIX + '/demo'),
  )
  assert.equal(hit.statusCode, 200, hit.body)
  assert.equal(hit.json().providerId, 'demo')
  const miss = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('GET', PROVIDER_PREFIX + '/ghost'),
  )
  assert.equal(miss.statusCode, 400, 'spec 禁止用 404 表达未注册：面板要能显示可执行的下一步')
  assert.equal(miss.json().code, CODES.PROVIDER_UNKNOWN)
  const tooDeep = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('GET', PROVIDER_PREFIX + '/demo/ghost'),
  )
  assert.equal(
    tooDeep.json().code,
    CODES.PARAM_INVALID,
    '未识别的子段不静默当单条查询：给 PARAM_INVALID 并列出支持的分组路由',
  )
  // /providers/<id>/experts 是组 5 引入的分组读路由；reads 缺席时是 503，而不是被误当作单条查询。
  const grouped = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('GET', PROVIDER_PREFIX + '/demo/experts'),
  )
  assert.equal(grouped.statusCode, 503, grouped.body)
  assert.equal(grouped.json().code, CODES.PROVIDER_THROWN)
})

test('provider 写路由：路径段与请求体 providerId 不一致被拦下，两个 provider 都不写', async () => {
  const calls = []
  const views = {
    connectorAction: async (params) => {
      calls.push(params)
      return { ok: true, action: params.action }
    },
  }
  const setup = await harness({ views })

  for (const suffix of ['session', 'action']) {
    const path = PROVIDER_PREFIX + '/workbuddy/connectors/' + suffix
    const bad = await call(
      setup.server,
      'prefix ' + PROVIDER_PREFIX,
      fakeRequest('POST', path, { providerId: 'demo', action: 'authorize', id: 'x' }),
    )
    assert.equal(bad.statusCode, 400, bad.body)
    assert.equal(bad.json().code, CODES.PROVIDER_ID_MISMATCH)
    assert.ok(bad.json().message.includes('workbuddy'))
    assert.ok(bad.json().message.includes('demo'))
    assert.equal(bad.json().pathProviderId, 'workbuddy')
    assert.equal(bad.json().bodyProviderId, 'demo')
  }
  // 比对失败发生在域入口之前：两个 provider 都没有收到任何写入调用。
  assert.equal(calls.length, 0)
})

test('provider 写路由：请求体缺 providerId 也被 mismatch 拦下', async () => {
  const calls = []
  const views = {
    connectorAction: async (params) => {
      calls.push(params)
      return { ok: true }
    },
  }
  const setup = await harness({ views })
  const path = PROVIDER_PREFIX + '/demo/connectors/action'
  const bad = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('POST', path, { action: 'authorize', id: 'x' }),
  )
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, CODES.PROVIDER_ID_MISMATCH)
  assert.equal(bad.json().bodyProviderId, '')
  assert.equal(calls.length, 0)
})

test('provider 写路由：路径段与请求体 providerId 一致被放行并落到该 provider', async () => {
  const calls = []
  const views = {
    connectorAction: async (params) => {
      calls.push(params)
      return { ok: true, action: params.action, providerId: params.providerId }
    },
  }
  const setup = await harness({ views })
  const path = PROVIDER_PREFIX + '/workbuddy/connectors/action'
  const good = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('POST', path, { providerId: 'workbuddy', action: 'authorize', id: 'x' }),
  )
  assert.equal(good.statusCode, 200, good.body)
  assert.equal(good.json().providerId, 'workbuddy')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].providerId, 'workbuddy')

  // session 路由把动作固定为 state（会话级状态写入）。
  const sessionPath = PROVIDER_PREFIX + '/workbuddy/connectors/session'
  const session = await call(
    setup.server,
    'prefix ' + PROVIDER_PREFIX,
    fakeRequest('POST', sessionPath, { providerId: 'workbuddy', sessionId: 's1' }),
  )
  assert.equal(session.statusCode, 200, session.body)
  assert.equal(calls[1].action, 'state')
})

test('非 GET/POST 方法一律 405', async () => {
  const setup = await harness()
  const del = await call(
    setup.server,
    'exact ' + PROVIDER_ROUTES.list,
    fakeRequest('DELETE', PROVIDER_ROUTES.list),
  )
  assert.equal(del.statusCode, 405)
})

test('release 撤掉本组路由，重复注册不冲突', async () => {
  const setup = await harness()
  assert.equal(setup.server.routes.size, 3)
  setup.release()
  assert.equal(setup.server.routes.size, 0)
  // 热重载：再注册一次必须成功（路径不重复）。
  const second = fakeWebServer()
  const ctx = {
    inject: (deps, fn2) => {
      fn2({ webServer: second.webServer })
    },
    logger: undefined,
  }
  const release2 = registerProviderRoutes(ctx, { active: setup.active })
  assert.equal(second.routes.size, 3)
  release2()
})

test('宿主没有 webServer 时跳过注册而不是抛错', async () => {
  const setup = await harness({ noWebServer: true })
  assert.equal(setup.server.routes.size, 0)
  assert.equal(typeof setup.release, 'function')
  // 拿不到 webServer 时仍返回一个可调用的 release（调用它不抛错）：调用方不必分辨两种跳过。
  const plain = {
    inject: (d, f) => {
      f({})
    },
  }
  const noop = registerProviderRoutes(plain, { active: setup.active })
  assert.equal(typeof noop, 'function')
  assert.doesNotThrow(() => noop())
  // 没有 inject 的老宿主、以及没接 active 的内部误用：都是安静跳过而不是抛异常。
  assert.equal(registerProviderRoutes({}, { active: setup.active }), undefined)
  assert.equal(registerProviderRoutes({ inject() {} }, {}), undefined)
})

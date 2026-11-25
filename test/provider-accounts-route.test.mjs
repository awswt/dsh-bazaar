/**
 * 分组账号路由的端到端用例（注册层 → 分发器 → 域视图 → 内置 provider → 账号服务）。
 *
 * 守三件会真实回归的事：
 * 1. 账号域的域方法回的是视图集合 {own, all, pending, summary}，分组必须把它投影成
 *    `items`——否则面板账号区永远空白，而 HTTP 200 照样"成功"。这里用反向控制
 *    证明「空清单会被这条用例抓到」。
 * 2. provider 内层失败（带 code 的对象）必须折成失败信封直达路由：折叠丢了就退化成
 *    200 + 嵌套 result，前端的 `body.ok === false` 判定永远不会命中。
 * 3. 动作字段缺失不得默认成 list——空 payload 被拒绝并点名字段。
 *
 * 只有上游账号服务是假的（它本来就是 provider 的注入依赖）；注册表、活跃集、
 * 分发器、域视图、路由、内置 provider 全部是真身。
 */

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { tempDirSync } from './temp.mjs'

import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'
import { createDomainViews } from '../lib/provider/domains.js'
import { PROVIDER_PREFIX, registerProviderRoutes } from '../lib/provider/routes.js'
import { createWorkbuddyProvider } from '../lib/providers/workbuddy/index.js'

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

function fakeRequest(method, url, body) {
  const request = new Readable({ read() {} })
  request.method = method
  request.url = url
  request.headers = { host: '127.0.0.1:3080' }
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

const ACCOUNT = {
  accountId: 'bce4b8fixtureaccountid',
  uid: 'fixture-bce4b8',
  nickname: '夹具账号',
  region: 'cn',
  usable: true,
  hasToken: true,
}

/** 只实现契约里的两个账号方法；`action` 按真实账号服务的形状回内层带 code 的对象。 */
function fakeAccounts(options = {}) {
  const calls = []
  return {
    calls,
    async list() {
      const all = options.empty === true ? [] : [ACCOUNT]
      return {
        own: [ACCOUNT],
        all,
        pending: [],
        summary: { count: all.length, usableCount: all.length, ownCount: 1 },
      }
    },
    async action(action, params) {
      calls.push({ action, params })
      if (action === 'login' && params.region === undefined) {
        return {
          code: CODES.PARAM_INVALID,
          field: 'region',
          error: '登录区域必选：region 必须是 cn 或 global，收到 未提供',
        }
      }
      return { ok: true, region: params.region }
    },
  }
}

async function harness(options = {}) {
  const dataDir = tempDirSync('bz-accounts-bce4b8-')
  const registry = createProviderRegistry({
    session: {
      async clearProvider(id) {
        return { ok: true, providerId: id }
      },
    },
  })
  const accounts = options.accounts ?? fakeAccounts(options)
  await registry.register(
    createWorkbuddyProvider({
      config: { dataDir },
      ...(options.omitsAccounts === true ? {} : { accounts }),
    }),
  )
  const active = createActiveProviderSet(registry, {})
  const dispatcher = createDomainDispatcher(registry, { resolveActive: () => [] })
  const views = createDomainViews({ registry, active, dispatcher })
  const server = fakeWebServer()
  const ctx = {
    inject(deps, fn2) {
      fn2({ webServer: server.webServer })
    },
    logger: { info() {}, warn() {} },
  }
  const release = registerProviderRoutes(ctx, { active, views })
  return {
    dataDir,
    accounts,
    server,
    release,
    cleanup() {
      release()
      // 删目录交给 test/temp.mjs 的登记表统一收口（q5-005）：这里再手写一遍 rmSync
      // 只会让「谁负责删」出现第二个答案，而漏删是静默的。
    },
  }
}

async function call(server, request) {
  const key = 'prefix ' + PROVIDER_PREFIX
  const handler = server.routes.get(key)
  assert.ok(handler, 'route must be registered: ' + key)
  const response = new FakeResponse()
  await handler(request, response)
  return response
}

const accountsPath = PROVIDER_PREFIX + '/workbuddy/accounts'
const actionPath = PROVIDER_PREFIX + '/workbuddy/accounts/action'

test('账号分组把 own/all 视图投影成 items，total 与条目数一致', async () => {
  const setup = await harness()
  try {
    const response = await call(setup.server, fakeRequest('GET', accountsPath + '?sessionId=s1'))
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.groups.length, 1, '只请求一个库时就只回一组')
    const group = body.groups[0]
    assert.equal(group.providerId, 'workbuddy')
    assert.equal(group.status, 'ok')
    assert.equal(
      group.items.length,
      1,
      '账号域回的是视图集合，分组必须投影出条目：' + JSON.stringify(group),
    )
    assert.equal(group.total, 1)
    assert.equal(group.matchedTotal, 1)
    assert.equal(group.items[0].accountId, ACCOUNT.accountId)
    assert.equal(
      group.items[0].providerId,
      'workbuddy',
      '条目要带归属库，前端才能按 provider 分组渲染',
    )
    assert.equal(body.items.length, 1, '顶层 items 与分组条目必须来自同一份投影')
    // 其余视图留在组上：前端要区分自有账号与授权账号时不必再打一次域方法。
    assert.deepEqual(
      group.own.map((item) => item.accountId),
      [ACCOUNT.accountId],
    )
    assert.deepEqual(group.summary, { count: 1, usableCount: 1, ownCount: 1 })
    assert.deepEqual(group.pending, [])
  } finally {
    setup.cleanup()
  }
})

test('反向控制：账号服务回空清单时分组条目就是空的（投影不是硬编码非空）', async () => {
  const setup = await harness({ empty: true })
  try {
    const response = await call(setup.server, fakeRequest('GET', accountsPath + '?sessionId=s1'))
    assert.equal(response.statusCode, 200, response.body)
    const group = response.json().groups[0]
    assert.equal(group.status, 'ok')
    assert.equal(group.items.length, 0)
    assert.equal(group.total, 0)
  } finally {
    setup.cleanup()
  }
})

test('账号动作的内层失败折成顶层失败信封，路由给 400 而不是 200 嵌套 result', async () => {
  const setup = await harness()
  try {
    const response = await call(
      setup.server,
      fakeRequest('POST', actionPath, { providerId: 'workbuddy', action: 'login' }),
    )
    assert.equal(response.statusCode, 400, response.body)
    const body = response.json()
    assert.equal(body.ok, false, '内层带 code 的结果必须折成信封：' + response.body)
    assert.equal(body.code, CODES.PARAM_INVALID)
    assert.equal(body.field, 'region')
    assert.ok(body.message.includes('登录区域必选'), body.message)
    assert.equal(body.result, undefined, '折叠后不得再包一层 result')
    assert.equal(body.action, undefined)
  } finally {
    setup.cleanup()
  }
})

test('账号动作缺 action 被拒并点名字段，不默认成 list', async () => {
  const setup = await harness()
  try {
    const response = await call(
      setup.server,
      fakeRequest('POST', actionPath, { providerId: 'workbuddy' }),
    )
    assert.equal(response.statusCode, 400, response.body)
    const body = response.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, CODES.PARAM_INVALID)
    assert.equal(body.field, 'action')
    assert.ok(body.message.includes('账号动作必选'), body.message)
    assert.deepEqual(body.supported, ['list', 'login', 'poll', 'cancel', 'refresh', 'remove'])
    assert.equal(setup.accounts.calls.length, 0, '被拒的空 payload 不得下发到账号服务')
  } finally {
    setup.cleanup()
  }
})

test('list 动作原样回账号服务结果（不过折叠、不包信封）', async () => {
  const setup = await harness()
  try {
    const response = await call(
      setup.server,
      fakeRequest('POST', actionPath, { providerId: 'workbuddy', action: 'list' }),
    )
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.all.length, 1)
    assert.equal(body.summary.count, 1)
    assert.equal(setup.accounts.calls.length, 0, 'list 直接读账号库，不经过 action 分发')
  } finally {
    setup.cleanup()
  }
})

test('账号服务缺席时分组标 error 而不是回空清单冒充成功', async () => {
  const setup = await harness({ omitsAccounts: true })
  try {
    const response = await call(setup.server, fakeRequest('GET', accountsPath + '?sessionId=s1'))
    assert.equal(response.statusCode, 200, response.body)
    const group = response.json().groups[0]
    assert.equal(group.status, 'error', JSON.stringify(group))
    assert.equal(group.code, CODES.AUTH_MISSING)
    assert.equal(group.items.length, 0)
    assert.ok(group.message.length > 0, '错误态必须带可读文案')
  } finally {
    setup.cleanup()
  }
})

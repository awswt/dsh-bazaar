import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { registerWebUi } from '../lib/webui.js'

function makeHarness(options = {}) {
  const routes = new Map()
  const calls = []
  const sessions = {
    async panelState(sessionId) {
      return {
        sessionId,
        applied: true,
        expert: {
          id: 'ex_demo',
          displayName: '演示专家',
          profession: '演示工程师',
          plugin: 'demo-plugin',
        },
        skills: { globalMode: 'selected', globalNames: ['xlsx'], expertNames: ['demo-skill'] },
        globalSkills: [
          { name: 'xlsx', description: 'Spreadsheet', enabled: true },
          { name: 'docx', description: 'Document', enabled: false },
        ],
        expertSkills: [{ name: 'demo-skill', description: 'Demo', enabled: true }],
      }
    },
    async selectExpert(sessionId, expertId, options) {
      calls.push(['select', sessionId, expertId, options])
    },
    async setSkills(sessionId, patch, options) {
      calls.push(['skills', sessionId, patch, options])
    },
    async clear(sessionId) {
      calls.push(['clear', sessionId])
    },
  }
  const market = {
    async listExperts(options) {
      calls.push(['list', options])
      return {
        source: 'portal',
        total: 10000,
        stale: false,
        items: [{
          id: 'ex_demo',
          plugin: 'demo-plugin',
          displayName: '演示专家',
          profession: '演示工程师',
          source: 'portal',
        }],
      }
    },
    async categories() {
      return [{ id: 'eng', name: '技术工程', count: 0 }]
    },
    async marketSize() {
      return 10000
    },
  }
  const bundles = {
    async listLocal() {
      return [{
        id: 'local-demo',
        plugin: 'local-demo',
        displayName: '本地专家',
        profession: '本地工程师',
        categoryId: 'eng',
      }]
    },
  }
  const connector = {
    async status() {
      return { installed: true, accountCount: 3, usableAccountCount: 3 }
    },
  }
  // 账号服务是注入依赖：这里只记「被以什么 region 调过」，好让登录区域的必选
  // 既能验证「被拒绝」，也能验证「合法值真的落到服务上」。
  const accounts = {
    async start(region) {
      calls.push(['accounts.start', region])
      return { loginId: 'login-' + region, verificationUri: 'https://example.invalid/' + region, region }
    },
    async list() {
      return { available: true, own: [], all: [], pending: [], summary: { count: 0, ownCount: 0, usableCount: 0, dir: '/tmp/bazaar' } }
    },
    poll: async () => ({ done: false }),
    cancel: () => ({ cancelled: true }),
    refresh: async () => ({}),
    remove: async () => ({ removed: true }),
    importLegacy: async () => ({ imported: 0 }),
  }
  const portal = { async available() { return true } }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback({
        webServer: {
          register(definition) {
            routes.set(definition.path, definition.handler)
          },
        },
      })
    },
    logger: { warn() {} },
  }
  // 路由读的是分组返回层：一家库一组，条目带 providerId。这里用桩替掉真实视图，
  // 路由只负责「把查询参数递进去、把分组原样吐出来」，分组语义由 provider 层测。
  const group = {
    providerId: 'workbuddy',
    displayName: 'WorkBuddy 专家库',
    capabilities: { expertMarket: true, skillMarket: true },
    status: 'ok',
    source: 'portal',
    items: [{
      id: 'ex_demo',
      plugin: 'demo-plugin',
      displayName: '演示专家',
      profession: '演示工程师',
      providerId: 'workbuddy',
      qualifiedName: '演示专家',
      source: 'portal',
    }],
    total: 10000,
    matchedTotal: 10000,
    hasMore: true,
  }
  const views = {
    async listExperts(params) {
      calls.push(['listExperts', params])
      return { ok: true, groups: [group], items: group.items, activeProviders: ['workbuddy'], page: 1, pageSize: 24 }
    },
    async listSkills(params) {
      calls.push(['listSkills', params])
      return { ok: true, groups: [], items: [], activeProviders: ['workbuddy'], page: 1, pageSize: 12 }
    },
    async installSkill(params) {
      calls.push(['installSkill', params])
      return { ok: true, providerId: params.providerId, slug: 'demo-skill', installedPath: '/tmp/demo-skill' }
    },
  }
  registerWebUi(ctx, {
    sessions,
    market,
    bundles,
    connector,
    accounts,
    portal,
    mnemon: options.mnemon,
    getViews: () => views,
    getActive: () => ({
      async describeProviders() {
        return { ok: true, items: [{ id: 'workbuddy', displayName: 'WorkBuddy 专家库', active: true }], activeProviders: ['workbuddy'], defaultProvider: '' }
      },
      async resolveProvider() {
        return { ok: true, providerId: 'workbuddy', source: 'session' }
      },
    }),
    builtinProviderId: 'workbuddy',
  })
  return { routes, calls }
}

function mockRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }
  return stream
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload
    },
  }
}

async function call(handler, method, url, body) {
  const response = mockResponse()
  await handler(mockRequest(method, url, body), response)
  return { status: response.statusCode, body: JSON.parse(response.body), headers: response.headers }
}

test('web UI state route returns session, skills, categories and market totals', async () => {
  const { routes } = makeHarness()
  const handler = routes.get('/dsh-bazaar/state')
  assert.equal(typeof handler, 'function')
  const result = await call(handler, 'GET', '/dsh-bazaar/state?sessionId=sess-1')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.state.expert.displayName, '演示专家')
  assert.equal(result.body.state.globalSkills.length, 2)
  assert.equal(result.body.state.market.marketTotal, 10000)
  assert.equal(result.body.state.categories[0].name, '技术工程')
  assert.equal(result.body.state.connector.usableAccountCount, 3)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('web UI experts route merges local installs without duplicating market rows', async () => {
  const { routes } = makeHarness()
  const handler = routes.get('/dsh-bazaar/experts')
  const result = await call(handler, 'GET', '/dsh-bazaar/experts?query=&page=1&pageSize=24')
  assert.equal(result.status, 200)
  // 列表按库分组并列：本地包并进它所属的那一家，不另立一个 providerId。
  assert.equal(result.body.groups.length, 1)
  assert.equal(result.body.groups[0].providerId, 'workbuddy')
  assert.equal(result.body.groups[0].source, 'portal')
  assert.equal(result.body.items.some(item => item.id === 'local-demo' && item.source === 'local'), true)
  assert.equal(result.body.items.some(item => item.id === 'ex_demo' && item.installed === false), true)
})

test('web UI select route rejects cross-origin POST and accepts same-origin', async () => {
  const { routes, calls } = makeHarness()
  const handler = routes.get('/dsh-bazaar/select')

  const bad = mockResponse()
  const badRequest = mockRequest('POST', '/dsh-bazaar/select', { sessionId: 's1', expertId: 'ex_demo' })
  badRequest.headers.origin = 'https://evil.example'
  await handler(badRequest, bad)
  assert.equal(bad.statusCode, 403)

  const good = await call(handler, 'POST', '/dsh-bazaar/select', {
    sessionId: 's1',
    expertId: 'ex_demo',
    providerId: 'workbuddy',
  })
  assert.equal(good.status, 200)
  assert.deepEqual(calls.at(-1), ['select', 's1', 'ex_demo', { providerId: 'workbuddy' }])
})

test('web UI skills and off routes forward the panel patch', async () => {
  const { routes, calls } = makeHarness()
  const skills = await call(routes.get('/dsh-bazaar/skills'), 'POST', '/dsh-bazaar/skills', {
    sessionId: 's1',
    providerId: 'workbuddy',
    globalMode: 'selected',
    globalNames: ['xlsx'],
    expertNames: ['demo-skill'],
  })
  assert.equal(skills.status, 200)
  assert.deepEqual(calls.at(-1), [
    'skills',
    's1',
    { globalMode: 'selected', globalNames: ['xlsx'], expertNames: ['demo-skill'] },
    { providerId: 'workbuddy' },
  ])

  const off = await call(routes.get('/dsh-bazaar/off'), 'POST', '/dsh-bazaar/off', { sessionId: 's1' })
  assert.equal(off.status, 200)
  assert.deepEqual(calls.at(-1), ['clear', 's1'])
})

test('web UI routes require a session id and reject unknown methods', async () => {
  const { routes } = makeHarness()
  const missing = await call(routes.get('/dsh-bazaar/state'), 'GET', '/dsh-bazaar/state')
  assert.equal(missing.status, 400)
  const method = await call(routes.get('/dsh-bazaar/select'), 'GET', '/dsh-bazaar/select')
  assert.equal(method.status, 405)
})

test('the state route always reports whether dsh-mnemon is installed', async () => {
  // 未注入探测器：客户端必须能靠 available:false 决定不渲染那个页签，
  // 而不是拿到 undefined 后自己去猜。
  const bare = makeHarness()
  const withoutDetector = await call(bare.routes.get('/dsh-bazaar/state'), 'GET', '/dsh-bazaar/state?sessionId=s1')
  assert.deepEqual(withoutDetector.body.state.mnemon, {
    available: false, version: null, path: null, source: null,
  })

  const installed = makeHarness({
    mnemon: async () => ({ available: true, version: '0.5.52', path: 'C:\\x\\dsh-mnemon', source: 'profile' }),
  })
  const withDetector = await call(installed.routes.get('/dsh-bazaar/state'), 'GET', '/dsh-bazaar/state?sessionId=s1')
  assert.equal(withDetector.body.state.mnemon.available, true)
  assert.equal(withDetector.body.state.mnemon.version, '0.5.52')
})

test('a failing mnemon detector degrades to unavailable instead of failing the route', async () => {
  const { routes } = makeHarness({
    mnemon: async () => { throw new Error('EACCES: permission denied') },
  })
  const result = await call(routes.get('/dsh-bazaar/state'), 'GET', '/dsh-bazaar/state?sessionId=s1')
  assert.equal(result.status, 200)
  assert.equal(result.body.state.mnemon.available, false)
  // 其余字段不能被这次失败带塌。
  assert.equal(result.body.state.expert.displayName, '演示专家')
})

test('账号登录缺 region 时由服务端以 BAZAAR_PARAM_INVALID 拒绝，且不落到账号服务', async () => {
  // 屏 A 的「未选区域不发请求」只是界面自保；绕过界面直接 POST 必须同样被拒，
  // 否则「必选」就只是文案，服务端仍会拿着 undefined 去猜令牌该发往哪套上游。
  const { routes, calls } = makeHarness()
  const handler = routes.get('/dsh-bazaar/accounts/action')
  assert.equal(typeof handler, 'function')

  const missing = await call(handler, 'POST', '/dsh-bazaar/accounts/action', { action: 'start' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'BAZAAR_PARAM_INVALID')
  assert.equal(missing.body.field, 'region')
  assert.deepEqual(missing.body.admitted, ['cn', 'global'])
  // 失败信封的口径与 provider 层一致：{ ok:false, code, message, ...details }。
  assert.match(missing.body.message, /登录区域必选/)

  const bogus = await call(handler, 'POST', '/dsh-bazaar/accounts/action', {
    action: 'start',
    region: 'mars',
  })
  assert.equal(bogus.status, 400)
  assert.equal(bogus.body.field, 'region')
  assert.match(bogus.body.message, /"mars"/)

  // 反向控制：两次被拒期间账号服务一次都没被调用；只有合法区域才真的开始登录。
  assert.deepEqual(calls.filter((entry) => entry[0] === 'accounts.start'), [])

  const ok = await call(handler, 'POST', '/dsh-bazaar/accounts/action', {
    action: 'start',
    region: 'global',
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.deepEqual(calls.filter((entry) => entry[0] === 'accounts.start'), [['accounts.start', 'global']])
})

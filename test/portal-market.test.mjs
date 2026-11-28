import assert from 'node:assert/strict'
import test from 'node:test'
import { PortalMarket } from '../lib/providers/workbuddy/portal.js'

function fakePortal(handlers) {
  const calls = []
  const portal = new PortalMarket({
    baseUrl: 'https://www.workbuddy.cn',
    timeoutMs: 5000,
    retries: 0,
    allowHosts: ['www.workbuddy.cn'],
    authProvider: async () => ({ header: 'Authorization', value: 'Bearer test-token' }),
    fetchImpl: async (url, options) => {
      const parsed = JSON.parse(options.body ?? '{}')
      const urlText = String(url)
      calls.push({ url: urlText, body: parsed })
      for (const handler of handlers) {
        const result = handler(urlText, parsed)
        if (result !== undefined) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => result,
          }
        }
      }
      throw new Error('no handler for ' + url)
    },
  })
  return { portal, calls }
}

test('listSkills searches the WorkBuddy skill market under the portal prefix', async () => {
  const { portal, calls } = fakePortal([
    (urlText, body) => {
      if (!urlText.endsWith('/portal/operation-platform/market/skill/list')) return undefined
      return {
        code: 0,
        data: {
          total_count: 873,
          skills: [
            {
              skill_id: 'skill_1',
              name: 'browser-skill',
              display_name_zh: 'Web Access（浏览器自动化）',
              description_zh: '浏览器自动化技能',
              icon: 'https://cdn.example.com/icon.png',
              version: '1.2.0',
              lifecycle_status: 'published',
            },
          ],
        },
      }
    },
  ])
  const result = await portal.listSkills({ query: '浏览器', page: 1, pageSize: 12 })
  assert.equal(result.total, 873)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].name, 'Web Access（浏览器自动化）')
  assert.equal(result.items[0].id, 'skill_1')
  assert.equal(result.items[0].icon, 'https://cdn.example.com/icon.png')
  const call = calls[0]
  assert.equal(call.url.includes('/portal/operation-platform/market/skill/list'), true)
  assert.equal(call.body.keyword, '浏览器')
  assert.equal(call.body.page_size, 12)
})

test('listBuddyConnectors uses the open-platform buddy API without the portal prefix', async () => {
  const { portal, calls } = fakePortal([
    (urlText, body) => {
      if (!urlText.endsWith('/api/v2/open-platform/buddy/connector/list')) return undefined
      return {
        code: 0,
        data: {
          list: [
            {
              connector_id: 'github',
              display_name_zh: 'GitHub',
              description_zh: '克隆、推送代码',
              auth_type: 'oauth',
              version: '0.0.0+wb.15f749b7cfc4cc00',
              icon: 'https://cdn.example.com/github.png',
            },
          ],
          has_more: true,
        },
      }
    },
  ])
  const result = await portal.listBuddyConnectors({ page: 1, pageSize: 24 })
  assert.equal(result.total, 1)
  assert.equal(result.hasMore, true)
  assert.equal(result.items[0].id, 'github')
  assert.equal(result.items[0].name, 'GitHub')
  assert.equal(result.items[0].source, 'workbuddy')
  const call = calls[0]
  assert.equal(call.url.includes('/api/v2/open-platform/buddy/connector/list'), true)
  assert.equal(call.url.includes('/portal'), false)
  assert.equal(call.body.platform, 'desktop')
})

test('listBuddyConnectors switches to the search route when a keyword is given', async () => {
  const { portal, calls } = fakePortal([
    (urlText, body) => {
      if (!urlText.endsWith('/api/v2/open-platform/buddy/connector/search')) return undefined
      return { code: 0, data: { list: [{ connector_id: 'amap', display_name_zh: '高德地图' }], has_more: false } }
    },
  ])
  const result = await portal.listBuddyConnectors({ query: '地图', page: 1, pageSize: 12 })
  assert.equal(result.items[0].name, '高德地图')
  assert.equal(result.hasMore, false)
  const call = calls[0]
  assert.equal(call.url.endsWith('/api/v2/open-platform/buddy/connector/search'), true)
  assert.equal(call.body.keyword, '地图')
  assert.equal(call.body.platform, 'desktop')
})

test('skill market route serves normalized results and auth-required fallback', async () => {
  const sessions = { async panelState() { return { sessionId: 's1' } }, disabledOf: () => new Set(), setSession: () => [] }
  const market = {
    async listExperts() { return { source: 'portal', total: 0, items: [] } },
    async marketSize() { return 0 },
    async categories() { return [] },
  }
  const bundles = { async listLocal() { return [] } }
  const connector = { async status() { return { installed: true, accountCount: 1, usableAccountCount: 1 } } }
  const portal = {
    async listSkills() {
      return {
        total: 2,
        page: 1,
        pageSize: 12,
        items: [
          { id: 'skill_a', name: '技能A', description: '说明', version: '1.0.0', icon: null },
          { id: 'skill_b', name: '技能B', description: '', version: null, icon: null },
        ],
      }
    },
    async listBuddyConnectors() { return { total: 0, items: [], hasMore: false } },
  }
  const connectors = {
    connectorViews: async () => ({ items: [], total: 0 }),
    catalog: async () => ({ items: [], total: 0, categories: [] }),
    disabledOf: () => new Set(),
  }
  const routes = new Map()
  const ctx = {
    inject(names, callback) {
      callback({ webServer: { register(def) { routes.set(def.path, def.handler) } } })
    },
    logger: { warn() {} },
  }
  // 技能市场走分组返回层：这里用桩替掉视图，路由只负责把查询参数递进去、
  // 把分组原样吐出来；分组语义（双来源、记忆市场不可用）由 provider 层测。
  const views = {
    async listSkills(params) {
      const market = await portal.listSkills({ query: params.query, page: params.page, pageSize: params.pageSize })
      return {
        ok: true,
        groups: [{
          providerId: 'workbuddy',
          displayName: 'WorkBuddy 专家库',
          capabilities: { skillMarket: true, memoryMarket: true },
          status: 'ok',
          sources: { skillMarket: { status: 'ok', total: market.total } },
          items: market.items.map(item => ({ ...item, providerId: 'workbuddy', source: 'skillMarket' })),
          total: market.total,
        }],
        items: market.items.map(item => ({ ...item, providerId: 'workbuddy', source: 'skillMarket' })),
        activeProviders: ['workbuddy'],
        page: params.page,
        pageSize: params.pageSize,
      }
    },
  }
  const { registerWebUi } = await import('../lib/webui.js')
  registerWebUi(ctx, {
    sessions,
    market,
    bundles,
    connector,
    portal,
    connectors,
    getViews: () => views,
  })

  const handler = routes.get('/dsh-bazaar/skill-market')
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(payload) { this.body = payload },
  }
  const request = {
    method: 'GET',
    url: '/dsh-bazaar/skill-market?query=浏览器&page=1&pageSize=12',
    headers: { host: '127.0.0.1:3000' },
    async iterator() {},
    [Symbol.asyncIterator]() {
      return (async function* () { })()
    },
    on() {},
  }
  await handler(request, response)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.total, 2)
  assert.equal(body.items[0].name, '技能A')
})

test('resolveAuth 使用自有单凭证并根据凭证区域自动对齐门户域名，避免跨站点 401', async () => {
  const { resolveAuth } = await import('../lib/auth.js')
  const { WorkBuddyConnector } = await import('../lib/connector.js')
  const { tempDirSync } = await import('./temp.mjs')
  const path = await import('node:path')

  const root = tempDirSync('bz-region-auth-')
  const now = Date.now()
  const connector = new WorkBuddyConnector({
    accountsDir: path.join(root, 'accounts'),
  })

  await connector.saveAccount({
    uid: 'cn-uid',
    nickname: '国内测试',
    region: 'cn',
    accessToken: 'tok-cn',
    expiresAtMs: now + 30 * 86400_000,
    domain: 'www.codebuddy.cn',
  })

  const cnAuth = await resolveAuth(
    { mode: 'auto', portalBaseUrl: 'https://www.workbuddy.cn' },
    { connector },
  )
  assert.equal(cnAuth.value, 'Bearer tok-cn')
  assert.equal(cnAuth.baseUrl, 'https://www.workbuddy.cn')
  assert.equal(cnAuth.region, 'cn')

  // 覆盖保存为国际凭证后，即使默认 portalBaseUrl 配了 workbuddy.cn，也自动切换到 workbuddy.ai
  await connector.saveAccount({
    uid: 'gl-uid',
    nickname: '国际测试',
    region: 'global',
    accessToken: 'tok-global',
    expiresAtMs: now + 365 * 86400_000,
    domain: 'www.workbuddy.ai',
  })
  const fallbackAuth = await resolveAuth(
    { mode: 'auto', portalBaseUrl: 'https://www.workbuddy.cn' },
    { connector },
  )
  assert.equal(fallbackAuth.value, 'Bearer tok-global')
  assert.equal(fallbackAuth.baseUrl, 'https://www.workbuddy.ai')
  assert.equal(fallbackAuth.region, 'global')
})

test('PortalMarket.listExperts 支持单分类 categoryId 并报告 hasMore，遇到 401 自动换号重试一次', async () => {
  const seen = []
  let authCalls = 0
  const portal = new PortalMarket({
    baseUrl: 'https://www.workbuddy.cn',
    timeoutMs: 5000,
    retries: 0,
    allowHosts: ['www.workbuddy.cn'],
    authProvider: async (extra = {}) => {
      authCalls += 1
      if (Array.isArray(extra.excludeAccountIds) && extra.excludeAccountIds.includes('acc-1')) {
        return { header: 'Authorization', value: 'Bearer good-token', accountId: 'acc-2' }
      }
      return { header: 'Authorization', value: 'Bearer bad-token', accountId: 'acc-1' }
    },
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), auth: options.headers.Authorization, body: JSON.parse(options.body) })
      if (options.headers.Authorization === 'Bearer bad-token') {
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          code: 0,
          data: {
            total_count: 100,
            experts: [{ expert_id: 'ex_1', display_name_zh: 'Python 专家', categories: [12] }],
          },
        }),
      }
    },
  })

  const result = await portal.listExperts({ categoryId: '12', page: 1, pageSize: 24 })
  assert.equal(authCalls, 3, '首次取号 + 401 探测备选号 + 换号重发')
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1].body.categories, [12])
  assert.equal(result.hasMore, true)
  assert.equal(result.items[0].displayName, 'Python 专家')
})

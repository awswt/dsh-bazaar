/**
 * 两屏端到端：本地假集市服务 + 真实 `lib/client.js` 组件，不访问公网。
 *
 * 假服务只做三件事：按真实路由表应答、把每个请求记进 `requests`（「发没发请求」
 * 是断言对象）、按 `config` 注入失败/冲突/未声明等场景。服务端语义（缺 region、
 * 空 activeProviders、跨库同名冲突）在这里镜像实现，真实实现由 `test/webui.test.mjs`
 * 与 `test/skill-install.test.mjs` 各自断言；本文件断言的是界面侧的四态与拒绝路径。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createDocument, createHarness, loadClientModule } from './ui-harness.mjs'

const WORKBUDDY = {
  id: 'workbuddy',
  displayName: 'WorkBuddy 专家库',
  capabilities: {
    expertMarket: true,
    skillMarket: true,
    memoryMarket: true,
    connectorMarket: true,
    account: true,
  },
}

const DEMO = {
  id: 'demo',
  displayName: '示例库',
  capabilities: {
    expertMarket: true,
    skillMarket: true,
    memoryMarket: false,
    connectorMarket: true,
    account: true,
  },
}

const REGION_MISSING_MESSAGE = '登录区域必选：region 必须是 cn（国内版）或 global（国际版）'

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return { __invalid: raw }
  }
}

function expert(name, extra) {
  return Object.assign(
    { id: 'ex_' + name, name: name, description: name + '的描述', skills: 2 },
    extra,
  )
}

/** 假集市：状态放在 `config` 上，测试可以先改再 flush。 */
function createBazaar(config) {
  const state = {
    providers: [WORKBUDDY, DEMO],
    activeProviders: [],
    requests: [],
    failStatus: new Set(),
    failExperts: new Set(),
    credentialConfigured: { workbuddy: true, demo: false },
    cache: {
      workbuddy: { entries: 3, bytes: 2048 },
      demo: { entries: 0, bytes: 0 },
    },
    accounts: { workbuddy: [], demo: [] },
    expert: null,
    installed: { pdf: 'workbuddy' },
    // 全局启用开关：缺省全启用，只有显式写进来的 id 才关闭（与
    // `lib/provider/preferences.js` 的「只记 false」口径一致）。
    disabledProviders: new Set(),
    ...config,
  }
  const statusOf = (providerId) => {
    const provider = state.providers.find((item) => item.id === providerId)
    const configured = state.credentialConfigured[providerId] === true
    const cache = state.cache[providerId] ?? { entries: 0, bytes: 0 }
    return {
      ok: true,
      provider: Object.assign({}, provider, {
        active: state.activeProviders.includes(providerId),
      }),
      credential: {
        name: 'BAZAAR_' + providerId.toUpperCase().replace(/-/g, '_') + '_TOKEN',
        derived: true,
        mode: 'auto',
        configured: configured,
        source: configured ? 'credentials' : 'none',
        writable: false,
        masked: configured ? '••••9f3c' : '',
      },
      cache: {
        dir: '/tmp/bazaar/providers/' + providerId + '/cache',
        entries: cache.entries,
        bytes: cache.bytes,
        truncated: false,
      },
    }
  }
  const expertsGroup = (providerId, query, categoryId) => {
    // 平铺入口跨库搜索时不带 provider，夹具回落到第一家，等价于真实服务端的全库遍历。
    const provider = state.providers.find((item) => item.id === providerId) ?? state.providers[0]
    if (state.authRequiredProviders?.has(providerId) === true) {
      return {
        providerId: providerId,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
        status: 'error',
        code: 'BAZAAR_PORTAL_AUTH_REQUIRED',
        message: '尚未完成 WorkBuddy 市场认证，请点击「立即登录认证」完成网页授权',
        items: [],
        total: 0,
        matchedTotal: 0,
        hasMore: false,
      }
    }
    if (state.failExperts.has(providerId) === true) {
      return {
        providerId: providerId,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
        status: 'error',
        code: 'BAZAAR_PROVIDER_THROWN',
        message: '示例库上游 500：只有这一家失败',
        items: [],
        total: 0,
        matchedTotal: 0,
        hasMore: false,
      }
    }
    // 两家都返回同名专家：逼出 qualify() 的 provider 前缀。
    const baseRows = Array.isArray(state.customExperts)
      ? state.customExperts.map((item) => Object.assign({ providerId: providerId }, item))
      : [expert('数据工程师', { providerId: providerId, categoryId: 'eng' })]
    const filtered = baseRows.filter((item) => {
      if (query !== '' && item.name.includes(query) !== true) return false
      if (categoryId !== '' && item.categoryId !== categoryId) return false
      return true
    })
    return {
      providerId: providerId,
      displayName: provider.displayName,
      capabilities: provider.capabilities,
      status: 'ok',
      items: filtered.map((item) =>
        Object.assign({}, item, { qualifiedName: provider.displayName + ' · ' + item.name }),
      ),
      total: Number(state.totalExperts ?? baseRows.length),
      matchedTotal: filtered.length,
      hasMore: state.expertsHasMore === true && query === '',
    }
  }
  const skillsGroup = (providerId) => {
    const provider = state.providers.find((item) => item.id === providerId)
    const memoryDeclared = provider.capabilities.memoryMarket === true
    return {
      providerId: providerId,
      displayName: provider.displayName,
      capabilities: provider.capabilities,
      status: 'ok',
      total: 1,
      sources: {
        skillMarket: { status: 'ok', total: 1 },
        memoryMarket: memoryDeclared
          ? { status: 'ok', available: true, total: 1 }
          : {
              status: 'undeclared',
              code: 'BAZAAR_CAPABILITY_UNDECLARED',
              message: '未声明 memoryMarket',
            },
      },
      items: [
        {
          providerId: providerId,
          id: state.skillIdMap?.pdf ?? 'skill_pdf_001',
          slug: 'pdf',
          description: '把 PDF 转成可检索文本',
          source: 'skillMarket',
          installed: state.installed.pdf !== undefined,
          installedBy: state.installed.pdf ?? null,
        },
        ...(Array.isArray(state.extraSkills)
          ? state.extraSkills.map((item) => Object.assign({ providerId: providerId }, item))
          : []),
        memoryDeclared
          ? {
              providerId: providerId,
              slug: 'memory-search',
              description: '记忆检索',
              source: 'memoryMarket',
            }
          : null,
      ].filter((item) => item !== null),
    }
  }
  const accountsGroup = (providerId) => {
    const rows = state.accounts[providerId] ?? []
    return {
      providerId: providerId,
      displayName: (state.providers.find((item) => item.id === providerId) ?? {}).displayName,
      status: 'ok',
      items: rows.map((row) => Object.assign({ providerId: providerId }, row)),
      total: rows.length,
    }
  }
  const connectorsGroup = (providerId) => {
    const provider = state.providers.find((item) => item.id === providerId)
    return {
      providerId: providerId,
      displayName: provider.displayName,
      status: 'ok',
      items: [
        {
          providerId: providerId,
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          tools: [{ name: 'search' }, { name: 'read' }],
          state: { connected: providerId === 'workbuddy' },
        },
      ],
      total: 1,
    }
  }

  /**
   * 一次请求要问哪几家库。
   *
   * 真实服务端（`lib/provider/domains.js` 的 `targetGroups`）不带 `provider` 时按本会话
   * 活跃集逐家问；带一个 `provider` 时只问那一家（单库重试用这条）。夹具必须镜像这个
   * 语义，否则「多库并列」在测试里永远是单库，冲突与分区失败都测不出来。
   */
  function targetProviderIds(url) {
    const only = url.searchParams.get('provider')
    if (only !== null && only !== '') return [only]
    if (state.activeProviders.length > 0) return state.activeProviders.slice()
    return state.providers.map((provider) => provider.id)
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const body = request.method === 'POST' ? await readBody(request) : null
    state.requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.searchParams,
      body: body,
    })
    const path = url.pathname

    if (path === '/dsh-bazaar/providers' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        items: state.providers.map((provider) =>
          Object.assign({}, provider, {
            active: state.activeProviders.includes(provider.id),
            // 全局开关（设置页），与「本会话选了没」是两件事：禁用时 active 恒 false。
            enabled: state.disabledProviders.has(provider.id) !== true,
            storedActive: state.activeProviders.includes(provider.id),
          }),
        ),
        activeProviders: state.activeProviders.slice(),
        storedActiveProviders: state.activeProviders.slice(),
        disabledProviders: state.providers
          .map((provider) => provider.id)
          .filter((id) => state.disabledProviders.has(id) === true),
        defaultProvider: state.defaultProvider ?? '',
        ...(state.initialized === undefined ? {} : { initialized: state.initialized }),
      })
      return true
    }
    if (path === '/dsh-bazaar/providers/active' && request.method === 'POST') {
      const next = body === null || body === undefined ? undefined : body.activeProviders
      if (Array.isArray(next) !== true) {
        sendJson(response, 400, {
          ok: false,
          code: 'BAZAAR_PARAM_INVALID',
          error: 'activeProviders 必须是字符串数组',
          field: 'activeProviders',
        })
        return true
      }
      const unknown = next.find((id) => state.providers.some((item) => item.id === id) !== true)
      if (unknown !== undefined) {
        sendJson(response, 400, {
          ok: false,
          code: 'BAZAAR_PROVIDER_UNKNOWN',
          error: '未知专家库 ' + String(unknown),
        })
        return true
      }
      // 空数组是合法空态：服务端不拒绝。
      state.activeProviders = next.slice()
      if (state.initialized !== undefined) state.initialized = true
      sendJson(response, 200, {
        ok: true,
        sessionId: body.sessionId,
        activeProviders: next.slice(),
      })
      return true
    }
    if (path === '/dsh-bazaar/state' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        state: {
          sessionId: url.searchParams.get('sessionId') ?? '',
          revision: 1,
          applied: true,
          activeProviders: state.activeProviders.slice(),
          experts: state.expert === null ? [] : [state.expert],
          expert: state.expert,
          skills: { globalMode: 'selected', globalNames: [], expertNames: [] },
          skillCount: 0,
          categories: [
            { id: 'eng', name: '工程' },
            { id: 'data', name: '数据' },
          ],
          warning: null,
          warnings: [],
        },
      })
      return true
    }
    if (path === '/dsh-bazaar/experts' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        groups: targetProviderIds(url).map((providerId) =>
          expertsGroup(
            providerId,
            url.searchParams.get('query') ?? '',
            url.searchParams.get('categoryId') ?? '',
          ),
        ),
        items: [],
        activeProviders: state.activeProviders.slice(),
        matchedTotal: 1,
        page: 1,
        pageSize: 24,
        hasMore: false,
      })
      return true
    }
    if (path === '/dsh-bazaar/skill-market' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        groups: targetProviderIds(url).map((providerId) => skillsGroup(providerId)),
        items: [],
        total: 1,
        activeProviders: state.activeProviders.slice(),
        page: 1,
        pageSize: 24,
        hasMore: false,
        workspace: '/tmp/ws',
        installed: ['pdf'],
      })
      return true
    }
    if (path === '/dsh-bazaar/skill-install' && request.method === 'POST') {
      const owner = state.installed[body.skillId]
      if (owner !== undefined && owner !== body.providerId && body.force !== true) {
        sendJson(response, 409, {
          ok: false,
          code: 'BAZAAR_SKILL_NAME_CONFLICT',
          error: '技能 pdf 已由 ' + owner + ' 安装',
          field: 'skillId',
        })
        return true
      }
      state.installed[body.skillId] = body.providerId
      sendJson(response, 200, { ok: true, providerId: body.providerId, slug: body.skillId })
      return true
    }
    if (path === '/dsh-bazaar/select' && request.method === 'POST') {
      state.expert = {
        id: body.expertId,
        providerId: body.providerId,
        displayName: '数据工程师',
        name: '数据工程师',
      }
      sendJson(response, 200, { ok: true, sessionId: body.sessionId, expert: state.expert })
      return true
    }
    if (path === '/dsh-bazaar/off' && request.method === 'POST') {
      state.expert = null
      sendJson(response, 200, { ok: true, sessionId: body.sessionId, expert: null })
      return true
    }

    const providerMatch = /^\/dsh-bazaar\/providers\/([^/]+)\/(.+)$/.exec(path)
    if (providerMatch !== null) {
      const providerId = decodeURIComponent(providerMatch[1])
      const sub = providerMatch[2]
      if (sub === 'status' && request.method === 'GET') {
        if (state.failStatus.has(providerId) === true) {
          sendJson(response, 500, {
            ok: false,
            code: 'BAZAAR_PROVIDER_THROWN',
            error: '示例库状态读取失败：注入的 500',
          })
          return true
        }
        sendJson(response, 200, statusOf(providerId))
        return true
      }
      if (sub === 'enabled') {
        if (state.providers.some((item) => item.id === providerId) !== true) {
          sendJson(response, 400, {
            ok: false,
            code: 'BAZAAR_PROVIDER_UNKNOWN',
            error: '未知专家库 ' + providerId,
            registered: state.providers.map((item) => item.id),
          })
          return true
        }
        if (request.method === 'GET') {
          sendJson(response, 200, {
            ok: true,
            providerId: providerId,
            enabled: state.disabledProviders.has(providerId) !== true,
          })
          return true
        }
        if (request.method === 'POST') {
          if (typeof body.enabled !== 'boolean') {
            sendJson(response, 400, {
              ok: false,
              code: 'BAZAAR_PARAM_INVALID',
              error: 'enabled 必须是布尔值',
              field: 'enabled',
            })
            return true
          }
          if (body.enabled === true) state.disabledProviders.delete(providerId)
          else state.disabledProviders.add(providerId)
          sendJson(response, 200, {
            ok: true,
            providerId: providerId,
            enabled: state.disabledProviders.has(providerId) !== true,
          })
          return true
        }
      }
      if (sub === 'accounts' && request.method === 'GET') {
        sendJson(response, 200, {
          ok: true,
          groups: [accountsGroup(providerId)],
          items: [],
          activeProviders: state.activeProviders.slice(),
        })
        return true
      }
      if (sub === 'accounts/action' && request.method === 'POST') {
        if (body.action === 'login') {
          const region =
            body.region === undefined || body.region === null || body.region === ''
              ? 'cn'
              : String(body.region)
          if (region !== 'cn' && region !== 'global') {
            sendJson(response, 400, {
              ok: false,
              code: 'BAZAAR_PARAM_INVALID',
              error: REGION_MISSING_MESSAGE,
              field: 'region',
              admitted: ['cn', 'global'],
            })
            return true
          }
          sendJson(response, 200, {
            ok: true,
            action: 'login',
            result: {
              loginId: 'bz_login_1',
              verificationUri: 'https://www.codebuddy.cn/login?state=s1',
              region: region,
            },
          })
          return true
        }
        if (body.action === 'poll') {
          state.accounts[providerId] = [
            {
              accountId: 'acc-own-1',
              nickname: '自有认证账号',
              region: 'cn',
              expiresAt: Date.now() + 3600_000,
              expired: false,
              hasToken: true,
              hasRefreshToken: true,
              usable: true,
            },
          ]
          state.authRequiredProviders?.delete(providerId)
          sendJson(response, 200, {
            ok: true,
            action: 'poll',
            result: { done: true, account: state.accounts[providerId][0] },
          })
          return true
        }
        if (body.action === 'remove') {
          state.accounts[providerId] = []
          sendJson(response, 200, { ok: true, action: 'remove', result: { removed: true } })
          return true
        }
        sendJson(response, 200, { ok: true, action: body.action, result: {} })
        return true
      }
      if (sub === 'connectors' && request.method === 'GET') {
        sendJson(response, 200, {
          ok: true,
          groups: [connectorsGroup(providerId)],
          items: [],
          activeProviders: state.activeProviders.slice(),
          query: '',
          status: '',
        })
        return true
      }
      if (sub === 'connectors/action' && request.method === 'POST') {
        sendJson(response, 200, {
          ok: true,
          action: body.action,
          result: { removed: body.action === 'remove' },
        })
        return true
      }
      if (sub === 'cache/clear' && request.method === 'POST') {
        const cache = state.cache[providerId] ?? { entries: 0, bytes: 0 }
        const removed = cache.entries
        state.cache[providerId] = { entries: 0, bytes: 0 }
        sendJson(response, 200, {
          ok: true,
          dir: '/tmp/bazaar/providers/' + providerId + '/cache',
          removedEntries: removed,
          existed: true,
        })
        return true
      }
    }
    sendJson(response, 404, { ok: false, code: 'BAZAAR_NOT_FOUND', error: 'no route ' + path })
    return true
  }

  return { state, handle }
}

async function startBazaar(config) {
  const bazaar = createBazaar(config)
  const server = http.createServer((request, response) => {
    void bazaar.handle(request, response).catch((error) => {
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    state: bazaar.state,
    baseUrl: 'http://127.0.0.1:' + String(address.port) + '/',
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 起一个 UI：真实 client.js + 假服务，返回树与工具函数。 */
async function bootScreen(service, screen, props) {
  const harness = createHarness()
  const document = createDocument(service.baseUrl)
  globalThis.document = document
  globalThis.window = {}
  // settle() 必须等真实 HTTP 往返结束，而不是靠「多刷几轮」猜：
  // 这里给 fetch 记在途计数，只有归零后 index 还会再走几轮把 json()/setState 收干净。
  let inflight = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = function patchedFetch(...args) {
    inflight += 1
    return realFetch.apply(globalThis, args).finally(function () {
      inflight -= 1
    })
  }
  const loaded = await loadClientModule(harness, { document: document, window: globalThis.window })
  const internals = loaded.exports.__internals
  const h = harness.React.createElement
  const component =
    screen === 'settings'
      ? internals.SettingsScreen
      : screen === 'composer'
        ? internals.ComposerEntry
        : internals.SessionPanel
  harness.mount(h(component, props ?? { sessionId: 's1' }))
  const ui = {
    harness: harness,
    document: document,
    internals: internals,
    get tree() {
      return harness.tree
    },
    async settle() {
      for (let round = 0; round < 400; round += 1) {
        await harness.flush()
        if (inflight === 0) {
          for (let extra = 0; extra < 3; extra += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5))
            await harness.flush()
          }
          if (inflight === 0) return harness.tree
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      }
      return harness.tree
    },
    /** 点一个带 data-* 钩子的控件，并等它引发的请求全部落定。 */
    async click(attr, value) {
      const node = harness.tree.byAttr(attr, value)
      assert.notEqual(node, null, '找不到控件 ' + attr + '=' + value)
      assert.notEqual(
        node.props.disabled,
        true,
        '控件 ' + attr + '=' + value + ' 是禁用态，不该被点',
      )
      await harness.fire(node, 'onClick', { target: {}, currentTarget: {} })
      await ui.settle()
      return node
    },
    find(attr, value) {
      return harness.tree.byAttr(attr, value)
    },
    texts() {
      return harness.tree.text
    },
  }
  await ui.settle()
  return ui
}

function requestsTo(service, suffix) {
  return service.state.requests.filter((item) => item.pathname.endsWith(suffix))
}

test('屏 A：页签由注册表驱动，每页签固定四块，凭据只读', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'settings')
    const tabs = ui.tree.findAll((node) => node.props.role === 'tab')
    assert.equal(tabs.length, 2, '一个 provider 一个页签')
    assert.deepEqual(
      tabs.map((node) => node.props['aria-selected']),
      ['true', 'false'],
      '首屏选中第一家，且 aria-selected 标明状态',
    )
    assert.equal(tabs[0].props['aria-controls'], 'pane-workbuddy')
    const tablist = ui.tree.find((node) => node.props.role === 'tablist')
    assert.notEqual(tablist, null, '页签条必须是 role=tablist')

    // 四块固定顺序：账号与登录 / 宿主凭据 / 本地缓存 / 连接器授权
    const headings = ui.tree
      .findAll((node) => node.kind === 'host' && node.type === 'h4')
      .map((node) => node.text.trim())
    assert.deepEqual(headings, ['账号与登录', '宿主凭据', '本地缓存', '连接器授权'])

    // 凭据值只读：role=textbox + aria-readonly，且块内没有可编辑控件
    const credentialValue = ui.tree.find(
      (node) => node.props.role === 'textbox' && node.props['aria-readonly'] === 'true',
    )
    assert.notEqual(credentialValue, null, '凭据值必须以只读 textbox 呈现')
    assert.equal(credentialValue.text.includes('••••'), true, '凭据值必须脱敏')
    assert.equal(
      ui.tree.findAll((node) => node.kind === 'host' && node.type === 'input').length,
      0,
      '凭据块不得出现可编辑 input',
    )

    // 切页签：示例库凭据未配置 → 登录按钮禁用并写出原因
    await ui.click('id', 'tab-demo')
    const login = ui.find('data-login', 'demo')
    assert.notEqual(login, null)
    assert.equal(login.props.disabled, true, '凭据未配置时登录必须禁用')
    assert.equal(login.props['aria-disabled'], 'true')
    assert.equal(ui.texts().includes('禁用：凭据未配置'), true)
  } finally {
    await service.close()
  }
})

test('屏 A：Provider 栏内建全局启用开关，禁用后写明它不在会话面板显示', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'settings')
    const toggle = ui.find('data-settings-switch', 'workbuddy')
    assert.notEqual(toggle, null, '每个 Provider 页签都要有全局启用开关')
    assert.equal(toggle.props.role, 'switch')
    assert.equal(toggle.props['aria-checked'], 'true', '缺省即启用')
    assert.equal(toggle.props['aria-label'], '启用 WorkBuddy 专家库')

    const before = requestsTo(service, '/enabled').length
    await ui.click('data-settings-switch', 'workbuddy')
    const writes = requestsTo(service, '/enabled').slice(before)
    assert.equal(writes.length, 1, '点一下写一次')
    assert.equal(writes[0].pathname.endsWith('/providers/workbuddy/enabled'), true)
    assert.deepEqual(writes[0].body, { providerId: 'workbuddy', enabled: false })

    // 禁用后：开关翻转 + 页签带「已禁用」+ banner 说清后果（不是只靠颜色）
    const off = ui.find('data-settings-switch', 'workbuddy')
    assert.equal(off.props['aria-checked'], 'false')
    assert.equal(off.props['data-on'], 'false')
    assert.equal(ui.texts().includes('已禁用 · 不在会话面板显示'), true, '要写清禁用后的效果')
    assert.equal(ui.find('id', 'tab-workbuddy').props['data-disabled'], 'true')

    // 全局开关是机器级：禁用不动本会话已有的选择（由 storedActive 承载）。
    assert.equal(
      ui.texts().includes('会话里已做的选择会被冻结保留，重新启用即恢复'),
      true,
      '要说明禁用不是清空会话选择',
    )

    // 再点一次恢复启用
    const beforeOn = requestsTo(service, '/enabled').length
    await ui.click('data-settings-switch', 'workbuddy')
    const onWrites = requestsTo(service, '/enabled').slice(beforeOn)
    assert.equal(onWrites.length, 1)
    assert.deepEqual(onWrites[0].body, { providerId: 'workbuddy', enabled: true })
    assert.equal(ui.find('data-settings-switch', 'workbuddy').props['aria-checked'], 'true')
  } finally {
    await service.close()
  }
})

test('屏 B：全部 Provider 被全局禁用时给空态引导，且一条条目请求都不发', async () => {
  const service = await startBazaar({ disabledProviders: new Set(['workbuddy', 'demo']) })
  try {
    const ui = await bootScreen(service, 'session')
    assert.equal(ui.texts().includes('所有 Provider 都已在设置页禁用'), true, '全禁用要说明原因')
    assert.equal(
      ui.texts().includes('请前往「设置 → 集市」启用至少一个 Provider'),
      true,
      '要指路，而不是只报「空」',
    )
    assert.notEqual(ui.find('data-goto-settings', 'true'), null, '要给前往设置页的入口')
    assert.equal(requestsTo(service, '/experts').length, 0, '一家都不显示就不该取条目')
    assert.equal(
      ui.tree.findAll((node) => node.props['data-provider-switch'] !== undefined).length,
      0,
      '被全局禁用的库连开关都不出现',
    )
  } finally {
    await service.close()
  }
})

test('屏 A：注册表为空时整块空态，且不渲染页签条', async () => {
  const service = await startBazaar({ providers: [] })
  try {
    const ui = await bootScreen(service, 'settings')
    assert.equal(ui.tree.findAll((node) => node.props.role === 'tab').length, 0)
    assert.equal(ui.texts().includes('暂无已注册的专家库'), true)
    assert.equal(ui.texts().includes('空数据'), true)
  } finally {
    await service.close()
  }
})

test('屏 A：单库失败只红自己，切页签不污染别人，重试与重放各自只打一家', async () => {
  const service = await startBazaar({ failStatus: new Set(['demo']) })
  try {
    const ui = await bootScreen(service, 'settings')
    const statusCalls = () =>
      service.state.requests.filter((item) => item.pathname.endsWith('/status'))
    // 首屏只加载当前页签（workbuddy），demo 尚未请求。
    assert.equal(statusCalls().length, 1, '只加载当前页签')
    assert.equal(statusCalls()[0].pathname.includes('/workbuddy/'), true)

    // 切到 demo：只有它自己报错，另一家页签与内容不受影响
    await ui.click('id', 'tab-demo')
    assert.equal(statusCalls().length, 2)
    assert.equal(ui.find('id', 'tab-demo').props['data-error'], 'true', 'demo 页签自己标出错')
    assert.equal(ui.find('id', 'tab-workbuddy').props['data-error'], 'false', '另一家页签不受影响')
    assert.equal(ui.texts().includes('示例库 加载失败'), true, '本页签显示错误态')
    assert.equal(ui.texts().includes('只有本页签内容报错'), true, '错误态要写清影响面')

    // 切回 workbuddy：内容还在，且不重新请求，也没有把 demo 的错误态重置
    await ui.click('id', 'tab-workbuddy')
    assert.equal(ui.texts().includes('加载失败'), false)
    assert.equal(ui.texts().includes('WorkBuddy 专家库'), true)
    assert.equal(statusCalls().length, 2, '切换页签不应重新请求')

    // 重试只重发当前这家
    service.state.failStatus.delete('demo')
    await ui.click('id', 'tab-demo')
    assert.equal(statusCalls().length, 2, '回到仍在错误态的页签也不自动重试')
    const retry = ui.find('data-retry-settings', 'demo')
    assert.notEqual(retry, null)
    await ui.harness.fire(retry, 'onClick', {})
    await ui.settle()
    const afterRetry = statusCalls()
    assert.equal(
      afterRetry.filter((item) => item.pathname.includes('/demo/')).length,
      2,
      'demo 被请求两次（首次 + 重试）',
    )
    assert.equal(
      afterRetry.filter((item) => item.pathname.includes('/workbuddy/')).length,
      1,
      '另一家只有首次那一次',
    )
    assert.equal(ui.texts().includes('示例库 加载失败'), false, '重试成功后错误消失')

    // 重放加载态：可重复观察 loading，且只影响本页签
    const replay = ui.find('data-replay-settings', 'demo')
    assert.notEqual(replay, null, '就绪态要能重放加载态')
    await ui.harness.fire(replay, 'onClick', {})
    await ui.settle()
    assert.equal(
      statusCalls().filter((item) => item.pathname.includes('/demo/')).length,
      3,
      '重放会重新取一次本页签数据',
    )
    assert.equal(ui.texts().includes('加载中'), false, '重放结束后回到就绪态')
  } finally {
    await service.close()
  }
})

test('屏 A：清理缓存与退出登录都要二次确认，取消不执行', async () => {
  const service = await startBazaar({
    accounts: {
      workbuddy: [
        {
          accountId: 'acc-1',
          nickname: '演示账号',
          region: 'cn',
          expiresAt: Date.now() + 3600_000,
          expired: false,
          hasRefreshToken: true,
          usable: true,
        },
      ],
      demo: [],
    },
  })
  try {
    const ui = await bootScreen(service, 'settings')
    const clear = ui.find('data-clear-cache', 'workbuddy')
    assert.notEqual(clear, null)
    await ui.harness.fire(clear, 'onClick', {})
    await ui.settle()
    const dialog = ui.tree.find(
      (node) => node.props.role === 'dialog' && node.props['aria-modal'] === 'true',
    )
    assert.notEqual(dialog, null, '清理缓存必须先弹确认')
    assert.equal(dialog.text.includes('清理 WorkBuddy 专家库 的缓存'), true)
    assert.equal(dialog.text.includes('其他专家库不受影响'), true, '确认文案要写清范围')
    // 取消：不发请求
    const cancel = dialog.find(
      (node) => node.kind === 'host' && node.type === 'button' && node.text.trim() === '取消',
    )
    await ui.harness.fire(cancel, 'onClick', {})
    await ui.settle()
    assert.equal(requestsTo(service, '/cache/clear').length, 0, '取消后不得发出清理请求')

    // 确认：发一次
    await ui.harness.fire(ui.find('data-clear-cache', 'workbuddy'), 'onClick', {})
    await ui.settle()
    await ui.click('data-confirm', 'clear-cache')
    await ui.settle()
    assert.equal(requestsTo(service, '/cache/clear').length, 1)

    // 退出登录：先取消，再确认
    const logout = ui.find('data-logout', 'workbuddy')
    assert.notEqual(logout, null, '已登录状态要提供退出登录')
    await ui.harness.fire(logout, 'onClick', {})
    await ui.settle()
    const logoutDialog = ui.tree.find(
      (node) => node.props.role === 'dialog' && node.text.includes('退出 WorkBuddy 专家库 的账号'),
    )
    assert.notEqual(logoutDialog, null)
    assert.equal(logoutDialog.text.includes('当前会话的选择不受影响'), true)
    const logoutCancel = logoutDialog.find(
      (node) => node.kind === 'host' && node.type === 'button' && node.text.trim() === '取消',
    )
    await ui.harness.fire(logoutCancel, 'onClick', {})
    await ui.settle()
    assert.equal(
      requestsTo(service, '/accounts/action').filter((item) => item.body?.action === 'remove')
        .length,
      0,
    )
    await ui.harness.fire(ui.find('data-logout', 'workbuddy'), 'onClick', {})
    await ui.settle()
    await ui.click('data-confirm', 'logout')
    await ui.settle()
    assert.equal(
      requestsTo(service, '/accounts/action').filter((item) => item.body?.action === 'remove')
        .length,
      1,
    )
  } finally {
    await service.close()
  }
})

test('屏 A 与屏 B：零表单单凭证认证，且未认证时上浮面板与完整工作台均可就地一键完成认证并自动刷出列表', async () => {
  const service = await startBazaar({
    initialized: false,
    authRequiredProviders: new Set(['workbuddy']),
  })
  try {
    // 1. 屏 A 设置页：无区域下拉框，直接显示「未认证」+「立即登录认证」
    const settingsUi = await bootScreen(service, 'settings')
    assert.equal(settingsUi.find('data-region', 'workbuddy'), null, '不再渲染区域必选下拉框')
    assert.equal(settingsUi.texts().includes('未认证'), true)
    const settingsLoginBtn = settingsUi.find('data-login', 'workbuddy')
    assert.notEqual(settingsLoginBtn, null)
    assert.equal(settingsLoginBtn.props.disabled, false)

    // 显式传非法 region 仍被服务端以 BAZAAR_PARAM_INVALID 拦截
    const bypass = await fetch(service.baseUrl + 'dsh-bazaar/providers/workbuddy/accounts/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'workbuddy', action: 'login', region: 'mars' }),
    })
    const bypassBody = await bypass.json()
    assert.equal(bypass.status, 400)
    assert.equal(bypassBody.code, 'BAZAAR_PARAM_INVALID')
    assert.equal(bypassBody.field, 'region')

    // 2. 屏 B 会话上浮面板：未认证时显示中文引导并提供就地「立即登录认证」，完成后自动拉出专家列表
    const composerUi = await bootScreen(service, 'composer', { sessionId: 's-inline-auth' })
    const expertPill = composerUi.tree.find(
      (node) => node.props['data-kind'] === 'expert' && node.type === 'button',
    )
    await composerUi.harness.fire(expertPill, 'onClick', {})
    await composerUi.settle()
    assert.equal(composerUi.texts().includes('WorkBuddy 专家库 尚未完成市场认证'), true)

    await composerUi.click('data-inline-login', 'workbuddy')
    assert.equal(composerUi.texts().includes('等待浏览器完成认证'), true)
    assert.equal(composerUi.texts().includes('https://www.codebuddy.cn/login?state=s1'), true)

    await composerUi.click('data-inline-poll', 'workbuddy')
    assert.equal(
      composerUi.texts().includes('数据工程师'),
      true,
      '就地认证完成后自动刷新出市场条目',
    )
  } finally {
    await service.close()
  }
})

test('屏 B：来源开关组可选（不是必填），全不选时给空态入口，且服务端接受空集', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'session')
    const group = ui.find('aria-label', '本会话来源开关')
    assert.notEqual(group, null, '来源开关组要有可读名称')
    assert.equal(group.props.role, 'group')
    assert.equal(group.props['aria-required'], undefined, '开关组不得标 aria-required')
    assert.equal(
      ui.tree.findAll((node) => node.props['aria-required'] === 'true').length,
      0,
      '屏 B 没有任何必填字段',
    )

    // 开关是 `button role="switch"`：文字状态写在旁边，不只靠颜色。
    const switches = ui.tree.findAll((node) => node.props['data-provider-switch'] !== undefined)
    assert.equal(switches.length, 2, '每个已注册 provider 一个来源开关')
    assert.equal(switches[0].props.role, 'switch')
    assert.equal(switches[0].props['aria-checked'], 'false')
    assert.equal(ui.texts().includes('未选'), true, '开关要带文字状态')

    assert.equal(ui.texts().includes('尚未选择本会话的来源'), true, '全不选是合法空态')

    // 打开第一家：写入活跃集
    await ui.click('data-provider-switch', 'workbuddy')
    const writes = requestsTo(service, '/providers/active')
    assert.equal(writes.length >= 1, true)
    assert.deepEqual(writes.at(-1).body.activeProviders, ['workbuddy'])

    // 再点一次关掉：回到空态，服务端接受空数组
    await ui.click('data-provider-switch', 'workbuddy')
    const afterClear = requestsTo(service, '/providers/active').at(-1)
    assert.deepEqual(afterClear.body.activeProviders, [], '清空是合法空态')
    assert.equal(ui.texts().includes('尚未选择本会话的来源'), true, '清空后回到空态')
    assert.equal(ui.texts().includes('当前使用'), false)
  } finally {
    await service.close()
  }
})

test('屏 B：多库分组并列、跨库同名冲突禁用安装、未声明 memoryMarket 不冒充空态', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'session')
    // 来源开关是 `button role="switch"`：点一下即切换，不是勾选框的 onChange。
    await ui.click('data-provider-switch', 'workbuddy')
    await ui.click('data-provider-switch', 'demo')
    // 技能在「技能与记忆」页签下：工作台按域分页签，默认停在「专家」。
    await ui.click('data-domain-tab', 'skill')

    assert.equal(ui.texts().includes('WorkBuddy 专家库'), true)
    assert.equal(ui.texts().includes('示例库'), true)

    // 冲突：示例库里的 pdf 已由 WorkBuddy 安装 → 安装禁用 + 原因 + 查看已有安装
    assert.equal(ui.texts().includes('冲突'), true)
    const blocked = ui.tree.findAll(
      (node) =>
        node.kind === 'host' &&
        node.type === 'button' &&
        node.text.trim() === '安装' &&
        node.props.disabled === true,
    )
    assert.equal(blocked.length >= 1, true, '冲突条目的安装按钮必须禁用')
    assert.equal(
      ui.texts().includes('查看已有安装（已被 WorkBuddy 专家库 安装）'),
      true,
      '冲突要给「查看已有安装」入口并写明是谁装的',
    )
    assert.equal(ui.texts().includes('跨来源同名不覆盖'), true, '冲突说明要写清为什么不覆盖')
    const installCallsBefore = requestsTo(service, '/skill-install').length
    assert.equal(installCallsBefore, 0, '冲突条目点不动，也就不会发安装请求')

    // 未声明 memoryMarket：不拿「暂无条目」冒充空态，而是明说这一域没有。
    assert.equal(ui.texts().includes('禁用：未声明 memoryMarket'), true)
    assert.equal(
      ui.texts().includes('该 Provider 未声明 memoryMarket 能力'),
      true,
      '要解释清楚这不是空列表，而是没有这个能力',
    )

    // 服务端仍会拒绝越权安装：直接 POST 拿到 409，与界面禁用形成双重保障。
    const conflictResponse = await fetch(service.baseUrl + 'dsh-bazaar/skill-install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', providerId: 'demo', skillId: 'pdf', force: false }),
    })
    assert.equal(conflictResponse.status, 409)
    assert.equal((await conflictResponse.json()).code, 'BAZAAR_SKILL_NAME_CONFLICT')
  } finally {
    await service.close()
  }
})

test('屏 B：单分区失败只红自己，重试只重发该库，搜索与分类只在本分区内筛', async () => {
  const service = await startBazaar({ failExperts: new Set(['demo']) })
  try {
    const ui = await bootScreen(service, 'session')
    await ui.click('data-provider-switch', 'workbuddy')
    await ui.click('data-provider-switch', 'demo')

    assert.equal(ui.texts().includes('只有这一家失败'), true, '失败分区要显示原因')
    assert.equal(ui.texts().includes('只有本分区报错'), true, '要说清影响面')
    assert.equal(ui.texts().includes('WorkBuddy 专家库 · 数据工程师'), true, '另一家照常显示条目')

    // 单库重试：只重发失败的那一家，带 provider=demo。
    service.state.failExperts.delete('demo')
    const retry = ui.find('data-retry-group', 'demo')
    assert.notEqual(retry, null)
    const before = requestsTo(service, '/experts').length
    await ui.harness.fire(retry, 'onClick', {})
    await ui.settle()
    const after = requestsTo(service, '/experts').slice(before)
    assert.equal(after.length, 1, '重试只发一次')
    assert.equal(after[0].search.get('provider'), 'demo', '且只重发失败那一家')
    assert.equal(ui.texts().includes('只有这一家失败'), false, '重试成功后错误消失')

    // 搜索与分类都是本地区间筛：不发新请求，也不把别的库卷进来。
    const search = ui.find('data-modal-search', 'true')
    assert.notEqual(search, null, '工作台要有统一的筛选框')
    const searchBefore = requestsTo(service, '/experts').length
    await ui.harness.type(search, '数据')
    await ui.settle()
    assert.equal(
      requestsTo(service, '/experts').length,
      searchBefore,
      '筛选是本地筛，敲字不该再请求一遍服务端',
    )
    assert.equal(ui.texts().includes('数据工程师'), true)

    const chipBefore = requestsTo(service, '/experts').length
    await ui.click('data-category-tab', 'eng')
    assert.equal(requestsTo(service, '/experts').length, chipBefore, '分类同样是本地筛')
    assert.equal(ui.texts().includes('数据工程师'), true, 'eng 分类下条目仍在')
  } finally {
    await service.close()
  }
})

test('屏 B：当前使用 / 已选 / 未启用来源三种态互相可区分，providerId 只读', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'session')
    // 一家都没选时：不列任何条目，先给「尚未选择来源」这个可操作的空态。
    assert.equal(
      ui.texts().includes('尚未选择本会话的来源'),
      true,
      '未选来源要说明原因，而不是假装它在加载',
    )
    assert.equal(
      ui.texts().includes('勾选上方任意来源即可展示对应能力'),
      true,
      '未选不等于没有内容，要给可操作的下一步',
    )

    await ui.click('data-provider-switch', 'workbuddy')
    // 选中一家后：条目可选
    const choose = ui.tree.findAll(
      (node) => node.kind === 'host' && node.type === 'button' && node.text.trim() === '选择',
    )
    assert.equal(choose.length >= 1, true, '不禁用时给「选择」按钮')
    const selectRequests = requestsTo(service, '/select').length
    await ui.harness.fire(choose[0], 'onClick', {})
    await ui.settle()
    assert.equal(requestsTo(service, '/select').length, selectRequests + 1)
    assert.equal(ui.texts().includes('当前使用'), true, '选中后要标「当前使用」')
    const chosen = ui.tree.findAll(
      (node) => node.kind === 'host' && node.type === 'button' && node.text.trim() === '已选',
    )
    assert.ok(chosen.length >= 1, '当前专家要显示为「已选」且禁用')
    assert.equal(chosen[0].props.disabled, true)

    // providerId 以只读徽标出现（不是可编辑输入）
    const ids = ui.tree.findAll(
      (node) => node.props['data-kind'] === 'muted' && node.text.trim() === 'workbuddy',
    )
    assert.equal(ids.length >= 1, true, '分组头要有只读 providerId 徽标')
  } finally {
    await service.close()
  }
})

test('上浮面板：三个胶囊各自切换，搜索走本地筛，完整面板入口常驻', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'composer')

    // 输入栏只留三个胶囊，顺序固定 expert / skill / connector（provider 入口已移除）。
    const pills = ui.tree.findAll(
      (node) => node.props['data-kind'] !== undefined && node.props['data-active'] !== undefined,
    )
    assert.deepEqual(
      pills.map((node) => node.props['data-kind']),
      ['expert', 'skill', 'connector'],
    )
    assert.equal(ui.find('data-popover-search', 'expert'), null, '未点胶囊时不展开面板')
    // 「完整面板」是常驻图标按钮，不占胶囊位。
    assert.notEqual(ui.find('aria-label', '打开能力集市完整面板'), null)

    // 一家都没选时：面板给引导空态，不请求条目列表。
    const before = requestsTo(service, '/experts').length
    await ui.click('data-kind', 'expert')
    assert.equal(ui.texts().includes('尚未选择会话来源'), true)
    assert.equal(requestsTo(service, '/experts').length, before, '没有活跃来源就不该发列表请求')

    // 选一家来源后展开专家：面板按来源过滤，条目出现。
    await ui.click('data-provider', 'workbuddy')
    await ui.settle()
    assert.notEqual(ui.find('data-popover-search', 'expert'), null)
    assert.equal(ui.texts().includes('数据工程师'), true, '选了来源后该库条目出现')

    // 搜索是本地筛：不发新请求。
    const searchBefore = requestsTo(service, '/experts').length
    await ui.harness.type(ui.find('data-popover-search', 'expert'), '不存在')
    await ui.settle()
    assert.equal(requestsTo(service, '/experts').length, searchBefore, '输入不触发请求')
    assert.equal(ui.texts().includes('未找到匹配的专家'), true, '本地筛出空集要给空态')

    // 点同一个胶囊收起。
    await ui.click('data-kind', 'expert')
    assert.equal(ui.find('data-popover-search', 'expert'), null, '再次点击应收起面板')
  } finally {
    await service.close()
  }
})

test('上浮面板：新会话 initialized=false 自动激活已启用来源，选专家后可退出，报错不谎报空集', async () => {
  const service = await startBazaar({
    initialized: false,
    disabledProviders: new Set(['demo']),
    expertsHasMore: true,
    totalExperts: 100,
    customExperts: [
      expert('数据工程师', { categoryId: 'eng' }),
      expert('财报分析师', { categoryId: 'data' }),
    ],
  })
  try {
    const ui = await bootScreen(service, 'composer')
    // 自动激活了唯一启用的 workbuddy，不激活被全局禁用的 demo。
    assert.deepEqual(service.state.activeProviders, ['workbuddy'])

    // 点开专家胶囊立刻看到专家列表，不需要手动勾选来源。
    await ui.click('data-kind', 'expert')
    assert.equal(ui.texts().includes('数据工程师'), true)

    // 选择专家，再点退出按钮调用 /dsh-bazaar/off 成功退出。
    await ui.click('data-pick-expert', 'workbuddy:ex_数据工程师')
    assert.notEqual(ui.find('data-clear-current-expert', 'true'), null)
    const offBefore = requestsTo(service, '/off').length
    await ui.click('data-clear-current-expert', 'true')
    assert.equal(requestsTo(service, '/off').length, offBefore + 1)
    assert.equal(ui.find('data-clear-current-expert', 'true'), null)

    // 当市场有更多条（hasMore）时，按 Enter 触发服务端全库搜索。
    const search = ui.find('data-popover-search', 'expert')
    await ui.harness.type(search, '财报')
    const beforeEnter = requestsTo(service, '/experts').length
    await ui.harness.fire(search, 'onKeyDown', { key: 'Enter' })
    await ui.settle()
    const afterEnter = requestsTo(service, '/experts').slice(beforeEnter)
    assert.equal(afterEnter.length >= 1, true, '有更多条目时按 Enter 必须发服务端查询')
    assert.equal(afterEnter.at(-1).search.get('query'), '财报')
    assert.equal(ui.texts().includes('财报分析师'), true)

    // 全部活跃库报错时必须呈现真实错误态，绝不谎报「未找到匹配的专家」。
    service.state.failExperts.add('workbuddy')
    await ui.click('data-reset-filters', 'expert').catch(() => {})
    await ui.harness.fire(ui.find('data-popover-search', 'expert'), 'onKeyDown', { key: 'Enter' })
    await ui.settle()
    assert.equal(ui.texts().includes('专家读取失败'), true)
    assert.equal(ui.texts().includes('未找到匹配的专家'), false)
  } finally {
    await service.close()
  }
})

test('上浮面板：安装技能提交真实 skill_id 而非 slug，本地已装专家行按 plugin 也能高亮选中态', async () => {
  const service = await startBazaar({
    initialized: false,
    disabledProviders: new Set(['demo']),
    installed: {},
    extraSkills: [
      {
        id: 'skill_987654321',
        slug: 'docx-tools',
        name: 'Docx 工具',
        description: '处理 Word 文档',
        source: 'skillMarket',
        installed: false,
      },
    ],
    customExperts: [
      {
        id: 'ai-agent-engineer',
        plugin: 'ai-agent-engineer',
        name: '程枢',
        description: 'AI Agent 工程师',
      },
    ],
    expert: {
      id: 'ex_zYK6DThTcjqH',
      plugin: 'ai-agent-engineer',
      providerId: 'workbuddy',
      displayName: '程枢',
    },
  })
  try {
    const ui = await bootScreen(service, 'composer')

    // 专家浮层里合并的本地行 id='ai-agent-engineer'，虽然与 currentExpert.id='ex_zYK6DThTcjqH' 不同，
    // 但同 provider 下 plugin 相同，必须高亮显示「当前使用」与「退出」。
    await ui.click('data-kind', 'expert')
    assert.equal(ui.texts().includes('当前使用'), true, 'plugin 匹配应高亮当前使用')
    assert.notEqual(ui.find('data-clear-expert', 'workbuddy'), null, '行内应出现退出按钮')

    // 切到技能浮层并点击安装 docx-tools：发往 /skill-install 的必须是真实 skill_id。
    await ui.click('data-kind', 'skill')
    await ui.click('data-install-skill', 'workbuddy:docx-tools')
    const installCalls = requestsTo(service, '/skill-install')
    assert.equal(installCalls.length, 1)
    assert.equal(installCalls[0].body.skillId, 'skill_987654321')
  } finally {
    await service.close()
  }
})

test('屏 A：defaultProvider 为空串时不误报未注册警告，配置未知 id 时如实提示', async () => {
  const emptyDefault = await startBazaar({ defaultProvider: '' })
  try {
    const ui = await bootScreen(emptyDefault, 'settings')
    assert.equal(
      ui.texts().includes('未注册：已回落为首个已注册的专家库'),
      false,
      '未配置默认专家库（空串）不得显示未注册错误提示',
    )
  } finally {
    await emptyDefault.close()
  }

  const missingDefault = await startBazaar({ defaultProvider: 'ghost-lib' })
  try {
    const ui = await bootScreen(missingDefault, 'settings')
    assert.equal(
      ui.texts().includes('默认专家库 ghost-lib 未注册'),
      true,
      '显式配置了未注册的 defaultProvider 时必须给出纠正提示',
    )
  } finally {
    await missingDefault.close()
  }
})

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
    const rows = [expert('数据工程师', { providerId: providerId, categoryId: 'eng' })]
    const filtered = rows.filter((item) => {
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
      total: rows.length,
      matchedTotal: filtered.length,
      hasMore: false,
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
          slug: 'pdf',
          description: '把 PDF 转成可检索文本',
          source: 'skillMarket',
          installed: true,
          installedBy: state.installed.pdf,
        },
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
          Object.assign({}, provider, { active: state.activeProviders.includes(provider.id) }),
        ),
        activeProviders: state.activeProviders.slice(),
        defaultProvider: '',
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
      const providerId = url.searchParams.get('provider') ?? ''
      sendJson(response, 200, {
        ok: true,
        groups: [
          expertsGroup(
            providerId,
            url.searchParams.get('query') ?? '',
            url.searchParams.get('categoryId') ?? '',
          ),
        ],
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
      const providerId = url.searchParams.get('provider') ?? ''
      sendJson(response, 200, {
        ok: true,
        groups: [skillsGroup(providerId)],
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
          const region = body.region
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
              loginId: 'login-1',
              verificationUri: 'http://127.0.0.1/scan',
              region: region,
            },
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

    // 四块固定顺序：账号 / 凭据 / 缓存 / 连接器授权
    const headings = ui.tree
      .findAll((node) => node.kind === 'host' && node.type === 'h4')
      .map((node) => node.text.trim())
    assert.deepEqual(headings, ['账号', '凭据', '缓存', '连接器授权'])

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

test('屏 A：未选登录区域时界面拦住且一个请求都不发；服务端同样拒绝缺 region', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'settings')
    const select = ui.find('data-region', 'workbuddy')
    assert.notEqual(select, null)
    assert.equal(select.props.required, true, '区域必须标 required')
    assert.equal(select.props['aria-required'], 'true')
    assert.equal(select.props.value, '', '默认不预选')
    assert.equal(ui.texts().includes('必选'), true, '要有可见的「必选」标记')

    await ui.click('data-login', 'workbuddy')
    await ui.settle()
    assert.equal(requestsTo(service, '/accounts/action').length, 0, '未选区域时不得发出登录请求')
    const afterSelect = ui.find('data-region', 'workbuddy')
    assert.equal(afterSelect.props['aria-invalid'], 'true', '字段级错误要落在控件上')
    assert.equal(
      typeof afterSelect.props['aria-describedby'],
      'string',
      '错误说明要用 aria-describedby 锚定',
    )
    const described = ui.tree.find(
      (node) => node.props.id === afterSelect.props['aria-describedby'],
    )
    assert.notEqual(described, null, 'aria-describedby 指向的说明必须真的存在')
    assert.equal(described.text.includes('尚未选择登录区域'), true, '说明要写清错在哪')
    assert.equal(described.text.includes('BAZAAR_PARAM_INVALID'), true, '说明要写清服务端同样拒绝')
    assert.equal(ui.texts().includes('登录区域'), true)

    // 绕过界面直接提交：服务端以 BAZAAR_PARAM_INVALID 拒绝，并点名 region。
    const bypass = await fetch(service.baseUrl + 'dsh-bazaar/providers/workbuddy/accounts/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', sessionId: 's1' }),
    })
    const bypassBody = await bypass.json()
    assert.equal(bypass.status, 400)
    assert.equal(bypassBody.code, 'BAZAAR_PARAM_INVALID')
    assert.equal(bypassBody.field, 'region')
  } finally {
    await service.close()
  }
})

test('屏 B：开关组可选（不是必填），全不勾选时给空态入口，且服务端接受空集', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'session')
    assert.equal(ui.texts().includes('选择专家库（可多选）'), true)
    assert.equal(ui.texts().includes('可选'), true, '开关组要标「可选」而不是必填')
    const group = ui.tree.find((node) => node.props.role === 'group')
    assert.notEqual(group, null, '开关组要有 role=group')
    assert.equal(group.props['aria-required'], undefined, '开关组不得标 aria-required')
    assert.equal(
      ui.tree.findAll((node) => node.props['aria-required'] === 'true').length,
      0,
      '屏 B 没有任何必填字段',
    )
    const switches = ui.tree.findAll(
      (node) => node.kind === 'host' && node.type === 'input' && node.props.type === 'checkbox',
    )
    assert.equal(switches.length, 2, '每个已注册 provider 一个多选开关')
    assert.equal(switches[0].props['aria-checked'], 'false')
    assert.equal(ui.texts().includes('未启用'), true, '开关要带文字状态而不是只靠颜色')

    assert.equal(ui.texts().includes('尚未选择专家库'), true, '全不勾选是合法空态')

    // 勾上第一家：写入活跃集
    const toggle = ui.find('data-switch', 'workbuddy')
    await ui.harness.fire(toggle, 'onChange', { target: { checked: true } })
    await ui.settle()
    const writes = requestsTo(service, '/providers/active')
    assert.equal(writes.length >= 1, true)
    assert.deepEqual(writes.at(-1).body.activeProviders, ['workbuddy'])

    // 取消勾选：回到空态，服务端接受空数组
    await ui.harness.fire(ui.find('data-switch', 'workbuddy'), 'onChange', {
      target: { checked: false },
    })
    await ui.settle()
    const afterClear = requestsTo(service, '/providers/active').at(-1)
    assert.deepEqual(afterClear.body.activeProviders, [], '清空是合法空态')
    assert.equal(ui.texts().includes('尚未选择专家库'), true, '清空后回到空态')
    assert.equal(ui.texts().includes('已启用'), false)
  } finally {
    await service.close()
  }
})

test('屏 B：多库分组并列、跨库同名冲突禁用安装、未声明 memoryMarket 禁用搜索', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'session')
    await ui.harness.fire(ui.find('data-switch', 'workbuddy'), 'onChange', {
      target: { checked: true },
    })
    await ui.settle()
    await ui.harness.fire(ui.find('data-switch', 'demo'), 'onChange', { target: { checked: true } })
    await ui.settle()

    assert.equal(ui.texts().includes('WorkBuddy 专家库'), true)
    assert.equal(ui.texts().includes('示例库'), true)
    assert.equal(ui.texts().includes('WorkBuddy 专家库 · 数据工程师'), true, '跨库同名要带库前缀')

    // 冲突：示例库里的 pdf 已由 WorkBuddy 安装 → 安装禁用 + 原因 + 查看已有安装
    assert.equal(ui.texts().includes('冲突'), true)
    assert.equal(ui.texts().includes('禁用：已被 WorkBuddy 专家库 安装'), true)
    const blocked = ui.tree.findAll(
      (node) =>
        node.kind === 'host' &&
        node.type === 'button' &&
        node.text.trim() === '安装' &&
        node.props.disabled === true,
    )
    assert.equal(blocked.length >= 1, true, '冲突条目的安装按钮必须禁用')
    assert.equal(ui.texts().includes('查看已有安装'), true, '冲突要给「查看已有安装」入口')
    assert.equal(ui.texts().includes('跨库同名不覆盖'), true, '冲突说明要写清为什么不覆盖')
    const installCallsBefore = requestsTo(service, '/skill-install').length
    assert.equal(installCallsBefore, 0, '冲突条目点不动，也就不会发安装请求')

    // 未声明 memoryMarket：搜索框禁用 + 原因（示例库没有 memoryMarket）
    const disabledSearch = ui.tree.findAll(
      (node) =>
        node.kind === 'host' &&
        node.type === 'input' &&
        node.props.disabled === true &&
        node.props['aria-disabled'] === 'true',
    )
    assert.equal(disabledSearch.length >= 1, true, '未声明记忆市场的库要禁用记忆搜索')
    assert.equal(ui.texts().includes('禁用：未声明 memoryMarket'), true)

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

test('屏 B：单分区失败只红自己，重试只重发该库，搜索与分类只作用于本分区', async () => {
  const service = await startBazaar({ failExperts: new Set(['demo']) })
  try {
    const ui = await bootScreen(service, 'session')
    await ui.harness.fire(ui.find('data-switch', 'workbuddy'), 'onChange', {
      target: { checked: true },
    })
    await ui.settle()
    await ui.harness.fire(ui.find('data-switch', 'demo'), 'onChange', { target: { checked: true } })
    await ui.settle()

    assert.equal(ui.texts().includes('只有这一家失败'), true, '失败分区要显示原因')
    assert.equal(ui.texts().includes('只有本分区报错'), true, '要说清影响面')
    assert.equal(ui.texts().includes('WorkBuddy 专家库 · 数据工程师'), true, '另一家照常显示条目')

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

    // 搜索只带本库 provider 参数
    const search = ui.find('aria-label', '搜索 WorkBuddy 专家库 的专家')
    assert.notEqual(search, null)
    const searchBefore = requestsTo(service, '/experts').length
    await ui.harness.type(search, '数据')
    await new Promise((resolve) => setTimeout(resolve, 260))
    await ui.settle()
    const searched = requestsTo(service, '/experts').slice(searchBefore)
    assert.equal(searched.length >= 1, true, '输入要触发本库搜索')
    assert.equal(
      searched.every((item) => item.search.get('provider') === 'workbuddy'),
      true,
    )
    assert.equal(searched.at(-1).search.get('query'), '数据')

    // 分类 chip 也只作用于本库
    const chip = ui.tree.find(
      (node) =>
        node.kind === 'host' &&
        node.type === 'button' &&
        node.props['aria-pressed'] !== undefined &&
        node.text.trim() === '数据',
    )
    assert.notEqual(chip, null, '分类 chip 要存在')
    const chipBefore = requestsTo(service, '/experts').length
    await ui.harness.fire(chip, 'onClick', {})
    await ui.settle()
    const chipped = requestsTo(service, '/experts').slice(chipBefore)
    assert.equal(chipped.length >= 1, true)
    assert.equal(chipped.at(-1).search.get('categoryId'), 'data')
  } finally {
    await service.close()
  }
})

test('屏 B：当前使用 / 已选 / 未启用库条目三种态互相可区分，providerId 只读', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'session')
    // 未勾选时：库条目仍然列出，但禁用并写明原因
    assert.equal(
      ui.texts().includes('禁用：未选择该专家库'),
      true,
      '未启用库的条目要禁用并说明原因',
    )

    await ui.harness.fire(ui.find('data-switch', 'workbuddy'), 'onChange', {
      target: { checked: true },
    })
    await ui.settle()
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
      (node) => node.props['data-kind'] === 'readonly' && node.text.trim() === 'workbuddy',
    )
    assert.equal(ids.length >= 1, true, '分组头要有只读 providerId 徽标')
  } finally {
    await service.close()
  }
})

test('平铺入口：四个分类按钮独立切换，默认只显最近使用，搜索后才拉列表', async () => {
  const service = await startBazaar()
  try {
    const ui = await bootScreen(service, 'composer')

    // 从左到右四个按钮，顺序固定 expert / skill / connector / provider。
    const tabs = ui.tree.findAll((node) => node.props['data-flat-tab'] !== undefined)
    assert.deepEqual(
      tabs.map((node) => node.props['data-flat-tab']),
      ['expert', 'skill', 'connector', 'provider'],
    )
    assert.equal(ui.texts().includes('默认只显示最近使用的'), false, '未点分类时不展开面板')

    const before = requestsTo(service, '/experts').length
    await ui.harness.fire(ui.find('data-flat-tab', 'expert'), 'onClick', {})
    await ui.settle()
    assert.equal(
      ui.texts().includes('暂无最近使用的专家；在上方搜索框输入关键词即可查找。'),
      true,
      '未搜索前只显最近使用空态，不主动展示列表',
    )
    assert.equal(
      requestsTo(service, '/experts').length,
      before,
      '打开分类面板不应触发列表请求（默认不主动展示列表）',
    )
    assert.equal(ui.find('data-flat-search', 'expert') !== null, true)

    // 输入关键词 → 等 220ms 防抖 → 发请求 → 展示结果列表。
    await ui.harness.fire(ui.find('data-flat-search', 'expert'), 'onChange', {
      target: { value: '数据' },
    })
    // 等 220ms 防抖真正触发后再 settle；用轮询而非固定 sleep，避免 React/网络调度抖动。
    let listed
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await ui.harness.flush()
      listed = requestsTo(service, '/experts')
      if (listed.length >= 1 && ui.tree.text.includes('数据工程师')) break
    }
    assert.ok(listed.length >= 1, '搜索后应请求专家列表')
    assert.equal(listed.at(-1).search.get('query'), '数据')
    assert.equal(listed.at(-1).search.get('pageSize'), '8')
    assert.equal(ui.tree.text.includes('数据工程师'), true, '搜索后应展示列表条目')

    // 切到另一个分类：面板换成该分类，expert 的搜索框消失。
    await ui.harness.fire(ui.find('data-flat-tab', 'connector'), 'onClick', {})
    await ui.settle()
    assert.equal(ui.find('data-flat-search', 'connector') !== null, true)
    assert.equal(ui.find('data-flat-search', 'expert') === null, true)

    // 再点同一个按钮收起面板。
    await ui.harness.fire(ui.find('data-flat-tab', 'connector'), 'onClick', {})
    await ui.settle()
    assert.equal(ui.find('data-flat-search', 'connector') === null, true, '再次点击应收起')
  } finally {
    await service.close()
  }
})

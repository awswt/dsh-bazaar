import assert from 'node:assert/strict'
import test from 'node:test'
import { registerWebUi } from '../lib/webui.js'

/**
 * 这里的四件事都属于「路由生命周期」，不是业务逻辑：
 *
 * 1. 热重载不能留下上一轮的 handler（否则宿主继续用已 dispose 的 ctx 应答）。
 * 2. 老版本插件留下的自身前缀路由要能自愈，但**只能**动自己的前缀。
 * 3. 卸载后一条不留。
 * 4. 注册出来的路径必须全部挂在 `/dsh-bazaar` 下，没有旧前缀残留。
 *
 * 第 2 条带反向控制：路径里只是「含有」这个前缀的别家路由必须原样留着。
 */

const PREFIX = '/dsh-bazaar'

function deps() {
  return {
    sessions: {
      async panelState() {
        return { sessionId: 's1' }
      },
      disabledOf: () => new Set(),
      setSession: () => [],
      async select() {
        return {}
      },
      async setSkills() {
        return {}
      },
      async clear() {
        return {}
      },
    },
    market: {
      async listExperts() {
        return { source: 'portal', total: 0, items: [] }
      },
      async marketSize() {
        return 0
      },
      async categories() {
        return []
      },
    },
    bundles: {
      async listLocal() {
        return []
      },
    },
    connector: {
      async status() {
        return { installed: true, accountCount: 1, usableAccountCount: 1 }
      },
    },
    portal: {
      async listSkills() {
        return { total: 0, items: [] }
      },
      async listBuddyConnectors() {
        return { total: 0, hasMore: false, items: [] }
      },
      async available() {
        return true
      },
    },
    connectors: {
      connectorViews: async () => ({ items: [], total: 0 }),
      catalog: async () => ({ items: [], total: 0, categories: [] }),
      disabledOf: () => new Set(),
    },
  }
}

function createCtx(routes) {
  const scopedEffects = []
  const rootEffects = []
  const warnings = []
  // 同一个 ctx 的 webServer 必须自始至终是同一个对象：插件的「上一轮 release」
  // 就挂在 webServer 这个引用上（WeakMap 键），每次 inject 都换新对象等于
  // 让重载永远找不到上一轮的 disposer。
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    inject(names, callback) {
      callback({
        webServer,
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') scopedEffects.push(dispose)
        },
      })
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') rootEffects.push(dispose)
    },
    logger: {
      info() {},
      warn(...args) {
        warnings.push(args.join(' '))
      },
    },
  }
  return { ctx, scopedEffects, rootEffects, warnings }
}

test('热重载替换自己的路由而不是叠加，也不产生 duplicate 警告', () => {
  const routes = new Map()
  const { ctx, rootEffects, scopedEffects, warnings } = createCtx(routes)
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.map(String).join(' '))
  try {
    registerWebUi(ctx, deps())
    const first = [...routes.keys()]
    assert.ok(first.includes('/dsh-bazaar/state'))
    assert.ok(first.includes('/dsh-bazaar/skill-market'))

    // 重载会在共享 webServer 上重新执行 inject 回调；这个假宿主没有 exact 表，
    // 驱逐只能靠上一轮闭包挂在 webServer 上的 release。
    registerWebUi(ctx, deps())
    assert.deepEqual([...routes.keys()], first, '第二次注册不能留下上一轮的 handler')
    assert.deepEqual(
      warnings.filter((line) => line.includes('duplicate')),
      [],
      '重载应先释放自己的路由，而不是与它们撞成 duplicate',
    )
    // 反向控制：注册阶段一次错都不能报，否则「键没变」可能只是全部注册失败。
    assert.deepEqual(errors, [], '重载不应触发任何注册失败')
  } finally {
    console.error = originalError
  }

  for (const dispose of rootEffects) dispose()
  assert.equal(routes.size, 0, '插件卸载必须释放每一条已注册路由')
  assert.ok(scopedEffects.length > 0, '作用域 effect 也应该注册')
})

test('自愈只清自己前缀的旧路由：反向前缀与外挂路径必须留着', () => {
  const routes = new Map()
  const stale = { path: '/dsh-bazaar/state', handler() {} }
  routes.set('/dsh-bazaar/state', stale)
  // 反向控制素材：都「含有」/dsh-bazaar，但路径边界上不属于本插件。
  const foreignRoutes = [
    '/other-plugin/route',
    '/dsh-bazaar-next/route',
    '/api/dsh-bazaar/state',
    '/dsh-bazaarx',
  ]
  for (const path of foreignRoutes) routes.set(path, { path, handler() {} })
  const foreign = new Map(foreignRoutes.map((path) => [path, routes.get(path)]))

  const ctx = {
    inject(names, callback) {
      callback({
        webServer: {
          exact: routes,
          register(route) {
            if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
        effect() {},
      })
    },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  const deps = {
    sessions: {
      async panelState() {
        return {}
      },
      disabledOf: () => new Set(),
    },
    market: {
      async marketSize() {
        return 0
      },
      async categories() {
        return []
      },
    },
    bundles: {},
    connector: {
      async status() {
        return {}
      },
    },
    portal: {
      async listBuddyConnectors() {
        return { total: 0, items: [] }
      },
    },
    connectors: {
      connectorViews: async () => ({ items: [], total: 0 }),
      catalog: async () => ({ items: [], total: 0 }),
      disabledOf: () => new Set(),
    },
  }
  registerWebUi(ctx, deps)

  assert.notEqual(routes.get('/dsh-bazaar/state'), stale, '旧的自有路由必须被替换')
  for (const [path, handler] of foreign) {
    assert.equal(routes.get(path), handler, `${path} 不属于本插件，必须原样保留`)
  }
  // 注册出来的每条路由都在自己的路径边界内：没有旧前缀、没有根路径裸注册。
  for (const path of routes.keys()) {
    if (foreign.has(path)) continue
    assert.equal(path === PREFIX || path.startsWith(PREFIX + '/'), true, `${path} 越界注册`)
  }
})

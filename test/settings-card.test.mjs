import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 设置页（屏 A）的注册契约与「单一 id 来源」。
 *
 * 为什么不去渲染：`lib/client.js` 是浏览器半侧，真渲染交给
 * `test/two-screen-e2e.test.mjs`。这里守的是渲染测不出来的三件事：
 *  1. `apply()` 真的向 `settings.section` 与 `settings.section.icon` 各注册了一条；
 *  2. 两条注册读的是**同一个常量**——宿主按 id 把图标配给页，id 一处写死一处写偏
 *     就是永久静默无图标，渲染测试也照样绿；
 *  3. 老宿主没有 settings.* 槽位时，composer 的 pill 注册不受牵连。
 *
 * 每条断言都配一条反向控制：先证明「这条检查真的会失败」，再证明真实代码通过。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(),
  })
  const refuse = () => {
    throw new Error('hooks must not run at module load')
  }
  return {
    createElement,
    Fragment: 'Fragment',
    Component: function Component() {},
    useState: refuse,
    useEffect: refuse,
    useCallback: refuse,
    useMemo: refuse,
    useRef: refuse,
  }
}

/** 把 `lib/client.js` 的 factory body 取出来，以 `require` 注入的 React 求值。 */
async function loadClient(files = {}) {
  const source = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const marker = 'factory: function (require) {'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'client factory marker must exist')
  const bodyStart = start + marker.length
  const bodyEnd = source.lastIndexOf('\n  },\n})')
  assert.ok(bodyEnd > bodyStart, 'client factory must be closed with `  },` before `})`')
  const body = source.slice(bodyStart, bodyEnd)
  const run = new Function('require', 'window', 'document', body)
  const moduleExports = run(
    (name) => {
      if (name === 'react') return fakeReact()
      if (name === 'react-dom') return files.reactDom ?? { createPortal: (node) => node }
      throw new Error(`unexpected require: ${name}`)
    },
    {},
    files.document,
  )
  return { moduleExports, source }
}

/** 记录每次 inject/register 的假 ctx；`reject` 里的槽位名会在 inject 时抛错。 */
function recordingCtx(options = {}) {
  const reject = new Set(options.reject ?? [])
  const injected = []
  const registered = []
  return {
    injected,
    registered,
    ctx: {
      get() {
        return null
      },
      slots: {
        inject(name, fn) {
          injected.push(name)
          if (reject.has(name)) throw new Error(`slot ${name} is not declared by this host`)
          fn()
        },
        register(entry, component) {
          registered.push({
            name: entry.name,
            id: entry.id,
            order: entry.order,
            label: typeof entry.label === 'function' ? entry.label() : entry.label,
            component,
          })
          return () => {}
        },
      },
    },
  }
}

test('apply 注册设置页与导航图标，两条共用同一个 id', async () => {
  const { moduleExports } = await loadClient()
  const harness = recordingCtx()
  moduleExports.apply(harness.ctx)

  const section = harness.registered.find((entry) => entry.name === 'settings.section')
  const icon = harness.registered.find((entry) => entry.name === 'settings.section.icon')
  assert.ok(section, 'settings.section must be registered')
  assert.ok(icon, 'settings.section.icon must be registered')
  assert.equal(icon.id, section.id, '图标必须与页签同 id，否则永远静默不渲染')
  assert.equal(section.id, moduleExports.__internals.SETTINGS_ENTRY_ID)
  assert.equal(section.id, 'bazaar-account')
  assert.equal(typeof section.component, 'function')
  assert.equal(typeof icon.component, 'function')
  assert.equal(section.label, 'bazaar')
  assert.equal(section.order, 25)
  // 图标那条只带 id（宿主按 id 配对），order 不是它的契约。
  assert.equal(icon.order === undefined || icon.order === 25, true)

  // 借用官方 id 会顶掉那一页。
  const shipped = ['models', 'plugins', 'account', 'agent-presets', 'general']
  assert.equal(shipped.includes(section.id), false)
})

test('两条设置注册都读同一个常量，不是各写一份字面量', async () => {
  const { source } = await loadClient()

  /** 按括号配对切出每一次 `slots.register(...)` 调用。 */
  function registerCalls(text) {
    const out = []
    const marker = 'slots.register('
    let index = text.indexOf(marker)
    while (index !== -1) {
      let depth = 0
      let cursor = index + marker.length - 1
      for (; cursor < text.length; cursor += 1) {
        if (text[cursor] === '(') depth += 1
        else if (text[cursor] === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      out.push(text.slice(index, cursor + 1))
      index = text.indexOf(marker, cursor + 1)
    }
    return out
  }

  /** 设置槽位注册里，「用常量」与「用字面量 id」各出现几次。 */
  function auditSettingsIds(text) {
    const uses = []
    const literals = []
    for (const call of registerCalls(text)) {
      // 槽位名可以写字面量，也可以写常量——两者都算设置注册。
      const isSettings =
        call.includes('settings.section') ||
        call.includes('SETTINGS_SLOT') ||
        call.includes('SETTINGS_ICON_SLOT')
      if (isSettings !== true) continue
      if (/id: SETTINGS_ENTRY_ID/.test(call)) uses.push('constant')
      const literal = /id: '(?!SETTINGS_ENTRY_ID)[^']*'/.exec(call)
      if (literal !== null) literals.push(literal[0])
    }
    return { uses, literals }
  }

  // 反向控制：字面量写法必须被判成违规，否则这条检查是空转。
  const planted = [
    "ctx.slots.register({ name: 'settings.section', id: 'bazaar-account' }, A)",
    "ctx.slots.register({ name: 'settings.section.icon', id: 'bazaar-settings' }, B)",
  ].join('\n')
  const plantedAudit = auditSettingsIds(planted)
  assert.equal(plantedAudit.uses.length, 0)
  assert.deepEqual(plantedAudit.literals, ["id: 'bazaar-account'", "id: 'bazaar-settings'"])

  const audit = auditSettingsIds(source)
  assert.equal(audit.uses.length, 2, '两条设置注册都要用 SETTINGS_ENTRY_ID')
  assert.deepEqual(audit.literals, [], '设置注册里不得出现字面量 id')
})

test('老宿主没有 settings 槽位时 pill 仍然注册，且失败只报自己那两条', async () => {
  const { moduleExports } = await loadClient()
  const harness = recordingCtx({ reject: ['settings.section', 'settings.section.icon'] })
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args.map(String).join(' '))
  try {
    assert.doesNotThrow(() => moduleExports.apply(harness.ctx))
  } finally {
    console.error = originalError
  }

  const pill = harness.registered.find((entry) => entry.name === 'conversation.input.left')
  assert.ok(pill, 'the composer pill must survive a host without settings slots')
  assert.equal(pill.id, 'bazaar-expert-picker')
  assert.equal(pill.label, '集市')
  assert.equal(pill.order, 26)
  // 两个 settings 槽位都要试过（而不是第一个失败就整段跳过）。
  assert.deepEqual(harness.injected, [
    'conversation.input.left',
    'settings.section',
    'settings.section.icon',
  ])
  assert.equal(logged.length, 2, '失败要留痕，但不能多报')
  assert.match(logged[0], /settings section registration failed/)
  assert.match(logged[1], /settings icon registration failed/)
})

test('屏 A 组件与 provider 分组路由都从 __internals 暴露，且路由带 /providers/<id> 段', async () => {
  const { moduleExports } = await loadClient()
  const internals = moduleExports.__internals
  assert.equal(typeof internals.SettingsScreen, 'function')
  assert.equal(typeof internals.AccountBlock, 'function')
  assert.equal(typeof internals.CredentialBlock, 'function')
  assert.equal(typeof internals.CacheBlock, 'function')
  assert.equal(typeof internals.ConnectorBlock, 'function')

  const ROUTES = internals.ROUTES
  assert.equal(ROUTES.providers, '/dsh-bazaar/providers')
  assert.equal(ROUTES.providersActive, '/dsh-bazaar/providers/active')
  assert.equal(ROUTES.provider('workbuddy'), '/dsh-bazaar/providers/workbuddy')
  assert.equal(ROUTES.providerStatus('workbuddy'), '/dsh-bazaar/providers/workbuddy/status')
  assert.equal(ROUTES.providerAccounts('workbuddy'), '/dsh-bazaar/providers/workbuddy/accounts')
  assert.equal(
    ROUTES.providerAccountsAction('workbuddy'),
    '/dsh-bazaar/providers/workbuddy/accounts/action',
  )
  assert.equal(ROUTES.providerConnectors('workbuddy'), '/dsh-bazaar/providers/workbuddy/connectors')
  assert.equal(
    ROUTES.providerConnectorAction('workbuddy'),
    '/dsh-bazaar/providers/workbuddy/connectors/action',
  )
  assert.equal(
    ROUTES.providerCacheClear('workbuddy'),
    '/dsh-bazaar/providers/workbuddy/cache/clear',
  )
  // id 要编码：路径段是用户可控字符串。
  assert.equal(ROUTES.provider('a/b'), '/dsh-bazaar/providers/a%2Fb')
  // 旧的扁平市场路由仍在（list 读要借它带 installed/installedBy 装饰）。
  assert.equal(ROUTES.experts, '/dsh-bazaar/experts')
  assert.equal(ROUTES.skillMarket, '/dsh-bazaar/skill-market')

  // 反向：任何一条路由都不得离开自己的前缀。
  for (const value of Object.values(ROUTES)) {
    if (typeof value !== 'string') continue
    assert.ok(value.startsWith('/dsh-bazaar'), `${value} must stay under the plugin prefix`)
  }
})

test('样式表只用自己的 bz- 前缀，反向控制能抓出别家前缀', async () => {
  const { moduleExports } = await loadClient()
  const css = moduleExports.__internals.CSS

  function foreignSelectors(text) {
    const out = new Set()
    for (const match of text.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      if (match[1].startsWith('bz-') !== true) out.add(match[1])
    }
    return [...out]
  }

  // 反向控制：换成别家前缀必须被抓出来。
  assert.deepEqual(foreignSelectors('.armory-panel{color:red}'), ['armory-panel'])
  assert.deepEqual(foreignSelectors(css), [], '自造前缀会与宿主样式串味')

  for (const rule of ['.bz-settings{', '.bz-tabs{', '.bz-tag{', '.bz-select{', '.bz-confirm{']) {
    assert.ok(css.includes(rule), `${rule} must be in the shared stylesheet`)
  }
})

test('样式表不写死颜色，只消费宿主 alias 令牌（深色模式靠 body[data-ds-dark-theme] 翻转）', async () => {
  const { moduleExports } = await loadClient()
  const css = moduleExports.__internals.CSS

  // 裸 hex 只能是 var() 的 fallback（宿主令牌缺失时才用），不能直接当颜色值。
  // 反向控制：裸 hex 写在声明值里必须被抓出来。
  function hardCodedColors(text) {
    const bad = []
    for (const match of text.matchAll(/[-\w]+\s*:\s*([^;{}]+)/g)) {
      const value = match[1]
      if (/#[0-9a-fA-F]{3,8}/.test(value) && /var\(/.test(value) !== true) bad.push(match[0])
      if (/rgba?\(/.test(value) && /var\(/.test(value) !== true) bad.push(match[0])
    }
    return bad
  }

  assert.deepEqual(hardCodedColors('.x{background:#fef2f2}'), ['background:#fef2f2'])
  assert.deepEqual(hardCodedColors(css), [], '写死颜色会在深色模式下变成一片白斑')

  // static 令牌是恒定色，宿主只翻转 alias；拿它当表面色就是 1.0.0 那次白斑事故。
  assert.ok(
    /--dsw-static-/.test(css) !== true,
    '--dsw-static-* 不随主题翻转，只能出现在宿主自己的样式表里',
  )
  // 不写自己的深色覆盖，也不写媒体查询：消费 alias 就够了。
  assert.ok(/prefers-color-scheme/.test(css) !== true, '主题跟随靠 alias，不写媒体查询')
  assert.ok(/data-ds-dark-theme/.test(css) !== true, '主题跟随靠 alias，不写深色覆盖')

  for (const token of ['--bz-bg-alt:var(--dsw-alias-', '--bz-ok-bg:', '--bz-danger-bg:']) {
    assert.ok(css.includes(token), `${token} must derive from host aliases`)
  }
})

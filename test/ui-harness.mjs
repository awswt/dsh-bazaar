/**
 * 极小的 React 运行时：让 `lib/client.js` 的两个屏在 node 里真的跑起来。
 *
 * 为什么不用 jsdom + 真 React：
 * - 依赖清单要保持零新增（package.json 只允许既有依赖），而两屏的断言点是
 *   「文案 / aria 属性 / 发没发请求 / 状态可区分」，不涉及布局与像素；
 * - 真 React 的并发调度会让「点一下 → 断言」变成竞态，这里每次 `flush()`
 *   同步跑完渲染与副作用，测试可重复。
 *
 * 支持的子集：函数组件、class 组件（错误边界要用）、useState / useRef /
 * useCallback / useMemo / useEffect、Fragment、数组子节点、createPortal。
 * 不支持：context、reducer、并发渲染、diff 复用——每次 flush 全树重渲染，
 * 靠 path 保持 hook 槽位与组件实例不变。
 */

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

function flatten(children, out) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue
    if (Array.isArray(child)) flatten(child, out)
    else out.push(child)
  }
  return out
}

function sameDeps(previous, next) {
  if (previous === null || previous === undefined) return false
  if (next === null || next === undefined) return false
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (Object.is(previous[index], next[index]) !== true) return false
  }
  return true
}

/** 元素树里的一个已渲染节点：测试靠它读属性、点按钮。 */
class UiNode {
  constructor(kind, type, props, children) {
    this.kind = kind
    this.type = type
    this.props = props === null || props === undefined ? {} : props
    this.children = children
    this.parent = null
  }

  /** 自身文本（不含子树）。 */
  get ownText() {
    if (this.kind === 'text') return this.type
    return ''
  }

  /** 含子树的可见文本，按渲染顺序拼接。 */
  get text() {
    if (this.kind === 'text') return this.type
    const parts = []
    for (const child of this.children) {
      const value = child.text
      if (value !== '') parts.push(value)
    }
    return parts.join(' ')
  }

  /** 该节点的所有后代（含自身）。 */
  all() {
    const out = []
    const walk = (node) => {
      out.push(node)
      for (const child of node.children) walk(child)
    }
    walk(this)
    return out
  }

  find(predicate) {
    for (const node of this.all()) if (predicate(node) === true) return node
    return null
  }

  findAll(predicate) {
    return this.all().filter((node) => predicate(node) === true)
  }

  /** 按 data-* 钩子找节点（测试里的稳定定位器）。 */
  byAttr(name, value) {
    return this.find(
      (node) =>
        node.props[name] !== undefined && (value === undefined || node.props[name] === value),
    )
  }

  hasText(needle) {
    return this.all().some((node) => node.kind === 'text' && String(node.type).includes(needle))
  }

  /** 该 subtree 里所有失效（disabled）控件的文本集合，用于「整组禁用」类断言。 */
  disabledTexts() {
    return this.findAll((node) => node.props.disabled === true).map((node) => node.text)
  }
}

export function createHarness() {
  const roots = new Map()
  const instances = new Map()
  const log = []
  let pass = 0
  let dirty = false
  let flushing = false
  let current = null
  let currentPath = ''

  class Component {
    constructor(props) {
      this.props = props
      this.state = this.constructor.state === undefined ? {} : this.constructor.state
    }

    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state) : patch
      this.state = Object.assign({}, this.state, next)
      markDirty()
    }

    forceUpdate() {
      markDirty()
    }
  }

  function markDirty() {
    dirty = true
  }

  function hookSlot(initial, factory) {
    const instance = current
    if (instance === null) {
      throw new Error('hooks must run while a component renders')
    }
    const index = instance.index
    instance.index += 1
    if (instance.hooks[index] === undefined) instance.hooks[index] = factory(initial, instance)
    return instance.hooks[index]
  }

  function useState(initial) {
    const slot = hookSlot(initial, (value) => {
      const state = { value: typeof value === 'function' ? value() : value }
      state.set = (next) => {
        const resolved = typeof next === 'function' ? next(state.value) : next
        if (Object.is(resolved, state.value)) return
        state.value = resolved
        markDirty()
      }
      return state
    })
    return [slot.value, slot.set]
  }

  function useRef(initial) {
    return hookSlot(initial, (value) => ({ current: value }))
  }

  function useMemo(factory, deps) {
    const slot = hookSlot(deps, () => ({ deps: null, value: undefined }))
    if (slot.deps === null || sameDeps(slot.deps, deps) !== true) {
      slot.deps = deps === null || deps === undefined ? null : deps.slice()
      slot.value = factory()
    }
    return slot.value
  }

  function useCallback(callback, deps) {
    const slot = hookSlot(deps, () => ({ deps: null, value: callback }))
    if (slot.deps === null || sameDeps(slot.deps, deps) !== true) {
      slot.deps = deps === null || deps === undefined ? null : deps.slice()
      slot.value = callback
    }
    return slot.value
  }

  function useEffect(effect, deps) {
    const slot = hookSlot(deps, () => ({
      deps: null,
      cleanup: undefined,
      queued: false,
      effect: undefined,
    }))
    const changed = slot.deps === null || sameDeps(slot.deps, deps) !== true
    // 首帧也必须记住 effect：否则第一次渲染排进去的副作用永远是空跑。
    slot.effect = effect
    if (changed) {
      slot.deps = deps === null || deps === undefined ? null : deps.slice()
      slot.queued = true
    }
  }

  function createElement(type, props) {
    const children = flatten(Array.prototype.slice.call(arguments, 2), [])
    const nextProps = Object.assign({}, props === null || props === undefined ? {} : props)
    // React 会把子节点同时放进 props.children：组件里读 props.children 的必须能拿到。
    if (children.length === 1) nextProps.children = children[0]
    else if (children.length > 1) nextProps.children = children
    return { __vnode: true, type: type, props: nextProps, children: children }
  }

  const React = {
    createElement: createElement,
    Fragment: '__fragment__',
    Component: Component,
    useState: useState,
    useRef: useRef,
    useMemo: useMemo,
    useCallback: useCallback,
    useEffect: useEffect,
    createPortal: (element) => element,
  }

  function toNodes(vnode, path) {
    if (vnode === null || vnode === undefined || vnode === false || vnode === true) return []
    if (Array.isArray(vnode)) {
      const out = []
      vnode.forEach((child, index) => {
        out.push(...toNodes(child, path + '$' + index))
      })
      return out
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      return [new UiNode('text', String(vnode), {}, [])]
    }
    if (vnode.__vnode !== true) {
      // 组件直接返回了数组或已渲染节点（不常见，但允许）。
      return toNodes(vnode, path)
    }
    const type = vnode.type
    if (typeof type === 'function') {
      const isClass =
        type.prototype !== undefined &&
        (typeof type.prototype.render === 'function' || type.prototype.isReactComponent === true)
      let instance = instances.get(path)
      if (instance === undefined || instance.type !== type) {
        instance = {
          type: type,
          component: null,
          hooks: [],
          index: 0,
          effects: [],
          path: path,
        }
        instances.set(path, instance)
      }
      instance.index = 0
      instance.effects = []
      let rendered
      if (isClass) {
        if (instance.component === null) {
          instance.component = new type(vnode.props)
          instance.component.props = vnode.props
        } else {
          instance.component.props = vnode.props
        }
        rendered = instance.component.render()
        instance.type = type
      } else {
        const previous = current
        const previousPath = currentPath
        current = instance
        currentPath = path
        try {
          rendered = type(vnode.props)
        } finally {
          current = previous
          currentPath = previousPath
        }
      }
      const children = toNodes(rendered, path + '/r')
      const node = new UiNode('component', type, vnode.props, children)
      for (const child of children) child.parent = node
      node.instance = instance
      return [node]
    }
    // 宿主节点
    const children = []
    vnode.children.forEach((child, index) => {
      children.push(...toNodes(child, path + '/' + index))
    })
    const node = new UiNode('host', type, vnode.props, children)
    for (const child of children) child.parent = node
    return [node]
  }

  function runEffects() {
    for (const instance of instances.values()) {
      for (const slot of instance.hooks) {
        if (slot === null || typeof slot !== 'object') continue
        if (slot.queued !== true) continue
        slot.queued = false
        if (typeof slot.cleanup === 'function') {
          try {
            slot.cleanup()
          } catch (error) {
            log.push({ kind: 'cleanup-error', error: error })
          }
        }
        slot.cleanup = undefined
        const effect = slot.effect
        if (typeof effect !== 'function') continue
        try {
          const cleanup = effect()
          slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        } catch (error) {
          log.push({ kind: 'effect-error', error: error })
          throw error
        }
      }
    }
  }

  function renderPass(element) {
    pass += 1
    const previous = current
    current = null
    try {
      const nodes = toNodes(element, 'root')
      const harnessRoot = new UiNode('root', null, {}, nodes)
      for (const node of nodes) node.parent = harnessRoot
      return harnessRoot
    } finally {
      current = previous
    }
  }

  let tree = null

  function render(element) {
    dirty = false
    tree = renderPass(element)
    runEffects()
    return tree
  }

  /** 跑完所有微任务 + 重渲染 + 新产生的副作用，直到稳定。 */
  async function flush(rounds) {
    const limit = rounds === undefined ? 24 : rounds
    if (flushing === true) return tree
    flushing = true
    try {
      for (let round = 0; round < limit; round += 1) {
        const root = roots.get('main')
        await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
        if (root !== undefined) tree = renderPass(root.element)
        runEffects()
        if (dirty !== true) break
        dirty = false
      }
    } finally {
      flushing = false
    }
    return tree
  }

  function mount(element) {
    roots.set('main', { element: element })
    dirty = false
    tree = renderPass(element)
    runEffects()
    return tree
  }

  return {
    React: React,
    Component: Component,
    UiNode: UiNode,
    get tree() {
      return tree
    },
    get passes() {
      return pass
    },
    get log() {
      return log
    },
    instances: instances,
    mount: mount,
    render: render,
    flush: flush,
    /** 触发一个事件处理器并等它落定。 */
    async fire(node, name, argument) {
      const handler = node === null || node === undefined ? undefined : node.props[name]
      if (typeof handler !== 'function') {
        throw new Error(
          'node has no ' +
            name +
            ' handler: ' +
            (node === null ? 'null' : node.kind + ' ' + String(node.type)),
        )
      }
      const result = handler(argument)
      if (isThenable(result) === true) await result
      await flush()
      return result
    },
    /** 改输入框的值（等价于用户输入）。 */
    async type(node, value) {
      const handler = node.props.onChange
      if (typeof handler !== 'function') throw new Error('node has no onChange handler')
      const result = handler({ target: { value: value }, currentTarget: { value: value } })
      if (isThenable(result) === true) await result
      await flush()
    },
  }
}

/**
 * 把 `lib/client.js` 的工厂体切出来，在受控环境里跑一遍，拿到它的 exports。
 *
 * 切的是 `factory: function (require) {` 之后到文件末尾 `},\n})` 之前的整段：
 * 那段就是真实的工厂体（含 `var module = {exports:{}}` 与 `return module.exports`），
 * 所以跑出来的对象与宿主拿到的完全一致。
 */
export async function loadClientModule(harness, env) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const source = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const marker = 'factory: function (require) {'
  const start = source.indexOf(marker)
  if (start === -1) throw new Error('client factory marker not found')
  const end = source.lastIndexOf('\n  },\n})')
  if (end === -1) throw new Error('client factory terminator not found')
  const body = source.slice(start + marker.length, end)
  const factory = new Function('require', 'window', 'document', body)
  const requireImpl = (name) => {
    if (name === 'react') return harness.React
    if (name === 'react-dom') return { createPortal: harness.React.createPortal }
    throw new Error('unexpected require: ' + name)
  }
  const window = env.window === undefined ? {} : env.window
  const exports = factory(requireImpl, window, env.document)
  return { exports: exports, harness: harness }
}

/** 造一个最小的 `window`：client 的工厂只写 `window.__ModuleLoader__.load`，测试里不需要更多。 */
export function createWindow() {
  const window = { document: null }
  window.__ModuleLoader__ = {
    loaded: null,
    load(definition) {
      window.loaded = definition
      return definition
    },
  }
  return window
}

/** 造一个能骗过 `installStyles()`、`apiUrl()` 与焦点管理的 document。 */
export function createDocument(baseURI) {
  const head = []
  const focusable = new Map()
  return {
    baseURI: baseURI,
    getElementById(id) {
      return head.some((style) => style.id === id) ? head.find((style) => style.id === id) : null
    },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), id: '', textContent: '' }
    },
    querySelector(selector) {
      return focusable.get(selector) === undefined ? null : focusable.get(selector)
    },
    querySelectorAll() {
      return []
    },
    /** 测试专用：让 `document.querySelector('[data-region=…]')` 拿到一个可聚焦的替身。 */
    __registerFocusable(selector, node) {
      focusable.set(selector, node)
    },
    get head() {
      return { appendChild: (node) => head.push(node) }
    },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
}

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 这个文件守的是一条 React 规则，不是某个功能：
 *
 * **任何条件 return 都不能站在 hook 前面。**
 *
 * 违反它的代价在这里特别大。`conversation.input.left` 是宿主的 `kind: 'list'` 槽位，
 * `@deepseek-ai/dsh-client-ui-renderer` 的 SlotErrorBoundary 捕到非链式槽位的异常后
 * 会把**整个 entry 退栈**（abdicate），而 pill 与面板是同一个 entry。所以一次
 * "Rendered more hooks than during the previous render" 的后果不是面板消失，
 * 而是「点一次集市按钮，按钮从此消失，重启 DSH 才回来」。
 *
 * 静态扫描比渲染测试稳：它不需要 mock React 调度，也不会因为组件内部重构而假绿。
 * 每条检查都先过一遍反向控制——先证明这条检查真的会失败，再证明真实代码通过。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

const HOOK_PATTERN =
  /React\.use(State|Effect|Callback|Memo|Ref|Reducer|LayoutEffect|Context|Transition|DeferredValue|Id|ImperativeHandle|SyncExternalStore)\(/

/** 把 `function Name(` 到下一条同级 `function` 之间的源码切出来。 */
function functionBodies(source) {
  const lines = source.split('\n')
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{0,4}function ([A-Za-z0-9_]+)\s*\(/)
    if (match !== null) starts.push({ name: match[1], line: index })
  }
  const bodies = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index].line
    const to = index + 1 < starts.length ? starts[index + 1].line : lines.length
    bodies.push({ name: starts[index].name, from, lines: lines.slice(from, to) })
  }
  return bodies
}

/**
 * 扫「函数体第一层」的 return，以及它们之后出现的 hook 调用。
 * 深度 1 = 直接写在函数体里；嵌在 if/callback 里的 return 不算（那是合法写法）。
 */
function auditBody(lines) {
  let depth = 0
  let earlyReturnLine = null
  const hooksAfterReturn = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    const atBodyLevel = depth === 1
    if (atBodyLevel && index > 0) {
      const isReturn =
        /^return\b/.test(trimmed) ||
        /^if\s*\(.*\)\s*return\b/.test(trimmed) ||
        /^if\s*\(.*\)\s*\{\s*return\b/.test(trimmed)
      if (isReturn && earlyReturnLine === null) earlyReturnLine = index + 1
      if (earlyReturnLine !== null && HOOK_PATTERN.test(line)) hooksAfterReturn.push(index + 1)
    }
    for (const character of line) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
    }
  }
  return { earlyReturnLine, hooksAfterReturn }
}

test('没有组件把 hook 写在条件 return 之后（含反向控制）', () => {
  // 反向控制：故意写一个坏函数，auditBody 必须抓出来，否则后面的「没有违规」是空话。
  const planted = [
    'function Bad(props) {',
    '  if (props.open !== true) return null',
    '  var pair = React.useState(0)',
    '  return null',
    '}',
  ]
  const plantedAudit = auditBody(planted)
  assert.equal(plantedAudit.earlyReturnLine, 2)
  assert.deepEqual(plantedAudit.hooksAfterReturn, [3], '反向控制：return 后的 hook 必须被点名')

  // 合法写法（hook 全在前）必须判干净，避免这条检查把正确代码也打成违规。
  const healthy = [
    'function Good(props) {',
    '  var pair = React.useState(0)',
    '  if (props.open !== true) return null',
    '  return null',
    '}',
  ]
  assert.deepEqual(auditBody(healthy).hooksAfterReturn, [])

  const offenders = []
  const bodies = functionBodies(clientSource)
  assert.equal(bodies.length > 30, true, '函数切分自身要能切出足够多的函数')
  for (const body of bodies) {
    const { earlyReturnLine, hooksAfterReturn } = auditBody(body.lines)
    if (hooksAfterReturn.length > 0) {
      offenders.push(
        `${body.name}: return at line ${earlyReturnLine + body.from}, hooks after it at ${hooksAfterReturn
          .map((line) => line + body.from)
          .join(', ')}`,
      )
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '有条件 return 挡在 hook 前面；后果是整个 entry 被退栈而不是只坏一个面板：\n' +
      offenders.join('\n'),
  )
})

test('面板与弹窗的关闭态早退都排在最后一个 hook 之后', () => {
  const bodies = functionBodies(clientSource)
  for (const name of ['SessionPanel', 'PickerDialog']) {
    const body = bodies.find((item) => item.name === name)
    assert.ok(body !== undefined && body !== null, `${name} must exist in lib/client.js`)
    const { earlyReturnLine, hooksAfterReturn } = auditBody(body.lines)
    assert.notEqual(
      earlyReturnLine,
      null,
      `${name} is expected to keep a closed-state early return`,
    )
    assert.deepEqual(
      hooksAfterReturn,
      [],
      `${name}: the early return must come after the last hook`,
    )
    const lastHook = Math.max(
      ...body.lines.map((line, index) => (HOOK_PATTERN.test(line) ? index : -1)),
    )
    const returnIndex = body.lines.findIndex((line, index) => index + 1 === earlyReturnLine)
    assert.ok(returnIndex > lastHook, `${name}: 早退必须晚于最后一个 hook`)
  }
  // 弹窗自己必须守住关闭态早退：open 不为 true 时不挂载任何子树。
  const dialog = bodies.find((item) => item.name === 'PickerDialog')
  assert.match(dialog.lines.join('\n'), /if \(props\.open !== true\) return null/)
})

test('弹窗包在自家边界里，pill 画在边界之外（含反向控制）', () => {
  /**
   * pill 是否画在边界外：pill 位置必须早于边界出现的位置。
   * 只认 `DialogBoundary` 这个名字，不认具体换行——prettier 会把一次调用拆成多行。
   */
  function pillOutsideBoundary(text) {
    const boundaryAt = text.indexOf('DialogBoundary')
    const pillAt = text.indexOf("className: 'bz-pill'")
    if (boundaryAt < 0 || pillAt < 0) return false
    return pillAt < boundaryAt
  }

  // 反向控制：把 pill 写进边界里必须被判违规。
  const planted = "h(DialogBoundary, null, h('button', { className: 'bz-pill' }, '集市'))"
  assert.equal(pillOutsideBoundary(planted), false)

  const composer = functionBodies(clientSource).find((body) => body.name === 'ComposerEntry')
  assert.ok(
    composer !== undefined && composer !== null,
    'ComposerEntry must exist in lib/client.js',
  )
  const source = composer.lines.join('\n')
  // 弹窗必须包在自家边界里，且关闭时不挂载——两条合起来保证 pill 与面板互不牵连。
  assert.match(source, /h\(\s*DialogBoundary,\s*null,\s*h\(PickerDialog,\s*\{/)
  assert.match(source, /open === true\s*\?\s*h\(\s*DialogBoundary/)
  assert.match(source, /:\s*null,/)
  assert.equal(pillOutsideBoundary(source), true, 'pill 必须在边界之外渲染')
})

test('崩溃边界接住自己：拿掉 getDerivedStateFromError 就必须判违规（含反向控制）', () => {
  /** 边界必须同时具备：静态降级、错误留痕、失败时渲染 null。 */
  function auditBoundary(text) {
    return {
      derived: /getDerivedStateFromError/.test(text),
      didCatch: /componentDidCatch/.test(text),
      failedNull: /state\.failed === true\) return null/.test(text),
      childrenFallback: /this\.props\.children === undefined \? null : this\.props\.children/.test(
        text,
      ),
    }
  }

  // 反向控制：缺 getDerivedStateFromError 的边界要被判出来。
  const planted = 'Boundary.prototype.componentDidCatch = function (e) {}'
  assert.equal(auditBoundary(planted).derived, false)

  const audit = auditBoundary(clientSource)
  assert.deepEqual(audit, {
    derived: true,
    didCatch: true,
    failedNull: true,
    childrenFallback: true,
  })
  // 边界必须只包弹窗，不能连 pill 一起包（否则崩一次按钮也没了）。
  const composer = functionBodies(clientSource).find((body) => body.name === 'ComposerEntry')
  const source = composer.lines.join('\n')
  assert.equal(source.indexOf("className: 'bz-pill'") < source.indexOf('DialogBoundary'), true)
})

/**
 * 工具定义工厂与「宿主内部包不进运行依赖」的守卫。
 *
 * 为什么要有这两组断言：1.0.0 把 `@deepseek-ai/dsh-tools` 写成 `dependencies`，包管理器在
 * profile 里装了一份副本；宿主升级后，启动预检按运行时版本判定这份副本不兼容，把它置成
 * `disabled`，于是 `tools` 服务没有提供者、34 个插件一起挂起，宿主直接起不来。
 *
 * 修复有两半，缺一半就会复发：
 * 1. 工具定义改成本地工厂（`lib/tool-def.js`），不再 import 宿主内部包；
 * 2. `package.json` 不再把任何 `@deepseek-ai/*` 声明成运行依赖。
 *
 * 第二半必须由用例守住：把 import 删掉但忘了改 `package.json`，崩溃照旧。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { defineTool } from '../lib/tool-def.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 最小可用参数集：一个必填字符串 + 一个可选布尔 + 一个可选数字 + 一个可选整数。 */
const PARAMS = {
  action: { type: 'string', required: true, description: 'what to do' },
  force: { type: 'boolean', description: 'break a stale lock' },
  page: { type: 'number', description: 'page number' },
  limit: { type: 'integer', description: 'page size' },
}

function makeTool(overrides = {}) {
  return defineTool({
    name: 'probe',
    description: 'probe tool',
    parameters: PARAMS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return `ran:${args.action}`
    },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 参数展开
// ---------------------------------------------------------------------------

test('parameters 展开成标准 JSON Schema 的 object 根', () => {
  const tool = makeTool()
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    'action',
    'force',
    'limit',
    'page',
  ])
  assert.deepEqual(tool.parameters.required, ['action'])
})

test('声明级 required 不泄漏进属性 schema（反向控制：泄漏则宿主按 JSON Schema 校验会误判）', () => {
  const tool = makeTool()
  // 正向：description 保留，type 保留。
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.equal(tool.parameters.properties.action.description, 'what to do')
  // 反向：required 是声明级标志，不属于属性描述；留着它属性就会被当成嵌套 schema。
  for (const [key, schema] of Object.entries(tool.parameters.properties)) {
    assert.equal(
      Object.hasOwn(schema, 'required'),
      false,
      `property ${key} must not carry the declaration-level "required" flag`,
    )
  }
})

test('没有必填项时不产出空的 required 数组', () => {
  const tool = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { query: { type: 'string' } },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() {
      return ''
    },
  })
  assert.equal(Object.hasOwn(tool.parameters, 'required'), false)
})

test('未声明 parameters 时给出空 object 根而不是 undefined', () => {
  const tool = defineTool({
    name: 'probe',
    description: 'probe',
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() {
      return ''
    },
  })
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} })
})

test('不支持的参数类型直接报错，而不是悄悄透传', () => {
  assert.throws(
    () => makeTool({ parameters: { nested: { type: 'object', properties: {} } } }),
    /unsupported type "object"/,
  )
})

test('参数声明本身形状不对就报错', () => {
  assert.throws(() => makeTool({ parameters: null }), /parameters must be a plain object/)
  assert.throws(() => makeTool({ parameters: ['action'] }), /parameters must be a plain object/)
  assert.throws(() => makeTool({ parameters: { action: 'string' } }), /must be a plain object/)
})

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

test('必填缺失时拒绝，并点名缺哪个字段', async () => {
  const tool = makeTool()
  await assert.rejects(() => tool.execute({}), /invalid arguments: action is required/)
})

test('标量类型不符时拒绝', async () => {
  const tool = makeTool()
  await assert.rejects(() => tool.execute({ action: 7 }), /action must be string/)
  await assert.rejects(() => tool.execute({ action: 'x', force: 'yes' }), /force must be boolean/)
  await assert.rejects(() => tool.execute({ action: 'x', page: '2' }), /page must be number/)
  await assert.rejects(() => tool.execute({ action: 'x', limit: 1.5 }), /limit must be integer/)
})

test('数值型拒绝 NaN / Infinity（宿主对 JSON 数值的边界）', async () => {
  const tool = makeTool()
  await assert.rejects(() => tool.execute({ action: 'x', page: NaN }), /page must be number/)
  await assert.rejects(
    () => tool.execute({ action: 'x', page: Number.POSITIVE_INFINITY }),
    /page must be number/,
  )
})

test('整个参数不是对象时拒绝', async () => {
  const tool = makeTool()
  await assert.rejects(() => tool.execute(null), /arguments must be an object/)
  await assert.rejects(() => tool.execute('action=status'), /arguments must be an object/)
  await assert.rejects(() => tool.execute([]), /arguments must be an object/)
})

test('多带未声明字段放行（不影响取值，报错只会制造噪声）', async () => {
  const tool = makeTool()
  assert.equal(await tool.execute({ action: 'status', extra: 'ignored' }), 'ran:status')
})

test('合法参数原样交给 execute，并带上 exec', async () => {
  const seen = {}
  const tool = makeTool({
    async execute(args, exec) {
      seen.args = args
      seen.exec = exec
      return 'ok'
    },
  })
  const exec = { agent: { id: 'a1' } }
  assert.equal(await tool.execute({ action: 'status', page: 2 }, exec), 'ok')
  assert.deepEqual(seen.args, { action: 'status', page: 2 })
  assert.equal(seen.exec, exec)
})

// ---------------------------------------------------------------------------
// 定义形状：必须是与宿主 ToolsService.register() 同形的数据
// ---------------------------------------------------------------------------

test('返回的定义带齐宿主 register() 要求的字段', () => {
  const tool = makeTool()
  assert.equal(tool.name, 'probe')
  assert.equal(tool.description, 'probe tool')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output, 'object')
  assert.equal(typeof tool.output.render, 'function')
  assert.deepEqual(tool.output.schema, { type: 'string' })
})

test('output.render 透传用户渲染器', () => {
  const tool = makeTool()
  assert.deepEqual(tool.output.render({ action: 'status' }, 'hello'), [
    { type: 'text', text: 'hello' },
  ])
})

test('缺 output.render 或 execute 直接报错', () => {
  assert.throws(
    () => makeTool({ output: { schema: { type: 'string' } } }),
    /output must be \{ schema, render \}/,
  )
  assert.throws(() => makeTool({ execute: 'not a function' }), /execute must be a function/)
})

test('run_code 是保留名，注册前就拒', () => {
  assert.throws(() => makeTool({ name: 'run_code' }), /reserved/)
})

test('timeoutMs 只接受正有限数', () => {
  assert.throws(() => makeTool({ timeoutMs: 0 }), /timeoutMs must be a positive finite number/)
  assert.throws(() => makeTool({ timeoutMs: -1 }), /timeoutMs must be a positive finite number/)
  assert.throws(() => makeTool({ timeoutMs: NaN }), /timeoutMs must be a positive finite number/)
  assert.equal(makeTool({ timeoutMs: 5000 }).timeoutMs, 5000)
})

// ---------------------------------------------------------------------------
// 崩溃回归守卫：宿主内部包不得出现在运行依赖里
// ---------------------------------------------------------------------------

/** 一份 manifest 里被声明成运行依赖的宿主内部包名。 */
function hostPackagesInDependencies(manifest) {
  return Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
}

test('package.json 的运行依赖里没有任何 @deepseek-ai/* 包', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  // 反向控制：判定函数必须真能抓到（否则全绿只说明它恒返回空）。
  assert.deepEqual(
    hostPackagesInDependencies({ dependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' } }),
    ['@deepseek-ai/dsh-tools'],
  )
  assert.deepEqual(
    hostPackagesInDependencies(manifest),
    [],
    '把宿主内部包写成运行依赖会让包管理器在 profile 里装副本，' +
      '宿主升级后启动预检判它不兼容，tools 服务就没有提供者了（1.0.0 的真实事故）',
  )
})

/** 在源码里找对宿主内部包的静态 import（注释与字符串不算）。 */
export function hostImportsIn(source) {
  const hits = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    if (/^import\b[^\n]*from\s+['"]@deepseek-ai\//.test(line)) hits.push(line)
    if (/\bimport\(\s*['"]@deepseek-ai\//.test(line)) hits.push(line)
  }
  return hits
}

test('lib/ 下没有对 @deepseek-ai/* 的运行期 import', () => {
  const walk = (rel, out) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(next, out)
      else if (entry.name.endsWith('.js')) out.push(next)
    }
    return out
  }
  const files = walk('lib', [])
  assert.ok(files.length >= 30, `扫描面太小，疑似扫漏了：${files.length} 个文件`)

  // 反向控制：真 import 与动态 import 都要被抓到。
  assert.equal(hostImportsIn("import { defineTool } from '@deepseek-ai/dsh-tools'\n").length, 1)
  assert.equal(hostImportsIn("const tools = await import('@deepseek-ai/dsh-tools')\n").length, 1)
  // 反向控制：JSDoc 里的类型引用不是运行依赖，不能误报。
  assert.deepEqual(hostImportsIn("/** @param {import('@deepseek-ai/cordis').Context} ctx */\n"), [])

  const offenders = []
  for (const rel of files) {
    const source = readFileSync(path.join(root, rel), 'utf8')
    for (const hit of hostImportsIn(source)) offenders.push(`${rel}: ${hit}`)
  }
  assert.deepEqual(offenders, [], `这些文件把宿主内部包当成了运行依赖：\n${offenders.join('\n')}`)
})

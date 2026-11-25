#!/usr/bin/env node
/**
 * .http 链路脚本的可复现执行器（ijhttp 缺席时的兜底）。
 *
 * 本仓链路脚本用的是 IntelliJ HTTP Client 的 DSL 子集：`###` 分块、`# @name`、
 * `{{VAR}}` 变量、可选 JSON body，以及 `> {% ... %}` 里的响应脚本（只用
 * `client.test` / `client.assert` / `client.global.set|get`）。判定逻辑全在脚本里，
 * 执行器只负责喂 `response`——换执行器不改变断言语义，所以 ijhttp 与本执行器
 * 得到的是同一个结论。
 *
 * 用法：
 *   node test/api-script-runner.mjs api-tests/script/*.http
 *   node test/api-script-runner.mjs --base-url http://127.0.0.1:39320 FILE.http
 *
 * 变量：`api-tests/http-client.env.json` 的 `<env>` 段（`--env` 选，缺省取第一段），
 * `--base-url` 覆盖 `BASE_URL`。`client.global` 按文件重置——一个文件是一条独立链路。
 *
 * 退出码：任一断言失败或请求出错即非 0（可直接进质量门/CI）。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DEFAULT_ENV_FILE = 'api-tests/http-client.env.json'

/**
 * 单个请求的上限（毫秒）。
 *
 * 为什么要钉死：`fetch` 默认没有超时。链路脚本连不上服务、或服务端挂住不响应时，
 * 执行器会一直等下去——质量门看起来"卡住了"，而真因是某个块永远不返回。
 * 超时被折成一条带 code 的失败（`BAZAAR_TEST_TIMEOUT`），并指明脚本与块名，
 * 这样「哪个链路的哪一块断在超时上」在结论里直接可读，不用回头翻日志（q5-006）。
 */
export const REQUEST_TIMEOUT_MS = 30_000

/** 超时错误用固定 code 标识，调用方（用例/CI）可以只判 code 而不解析文案。 */
export const TIMEOUT_CODE = 'BAZAAR_TEST_TIMEOUT'

/** 构造带 code 的超时失败：脚本名 + 块名 + 上限都必须出现在文案里，否则定位不到块。 */
function timeoutError(file, label, timeoutMs) {
  const error = new Error(
    `${file} @${label}: request exceeded ${timeoutMs}ms without a response ` +
      `(cancel via AbortSignal.timeout)`,
  )
  error.code = TIMEOUT_CODE
  error.file = file
  error.block = label
  error.timeoutMs = timeoutMs
  return error
}

/** AbortSignal.timeout 在 Node 里以 TimeoutError 拒绝；个别实现包成 AbortError。 */
function isTimeout(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    /^Time(d)?outError$|^AbortError$/.test(error.name ?? '')
  )
}

function parseArgs(argv) {
  const files = []
  const options = { baseUrl: '', env: '', envFile: DEFAULT_ENV_FILE, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base-url') {
      options.baseUrl = String(argv[index + 1] ?? '')
      index += 1
      continue
    }
    if (arg === '--env') {
      options.env = String(argv[index + 1] ?? '')
      index += 1
      continue
    }
    if (arg === '--env-file') {
      options.envFile = String(argv[index + 1] ?? '')
      index += 1
      continue
    }
    if (arg === '--quiet') {
      options.quiet = true
      continue
    }
    if (arg.startsWith('--') === true) throw new Error(`unknown option: ${arg}`)
    files.push(arg)
  }
  if (files.length === 0) throw new Error('at least one .http file is required')
  return { files, options }
}

/** 按 `###` 切块；注释与脚本块混在同一块里，先切块再逐段解释比正则扫全文件好读。 */
function splitBlocks(source) {
  const blocks = []
  let current = null
  for (const line of source.split(/\r?\n/)) {
    if (/^###/.test(line) === true) {
      if (current !== null) blocks.push(current)
      current = { title: line.replace(/^#+\s*/, '').trim(), lines: [] }
      continue
    }
    if (current === null) current = { title: '', lines: [] }
    current.lines.push(line)
  }
  if (current !== null) blocks.push(current)
  return blocks.filter((block) => block.lines.some((line) => line.trim() !== ''))
}

/** 把一块拆成 name / 请求行 / 头 / body / 脚本。 */
function parseBlock(block) {
  const lines = block.lines
  let index = 0
  let name = ''
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }
    const named = /^#\s*@name\s+(.+)$/.exec(line)
    if (named !== null) {
      name = named[1].trim()
      index += 1
      continue
    }
    if (line.trim().startsWith('#') === true) {
      index += 1
      continue
    }
    break
  }
  if (index >= lines.length) return null
  const requestMatch = /^([A-Z]+)\s+(\S+)$/.exec(lines[index].trim())
  if (requestMatch === null) return null
  const method = requestMatch[1]
  const url = requestMatch[2]
  index += 1

  const headers = {}
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('>') === true) break
    if (line.trim() === '') {
      index += 1
      break
    }
    const headerMatch = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line)
    if (headerMatch === null) break
    headers[headerMatch[1]] = headerMatch[2].trim()
    index += 1
  }

  const bodyLines = []
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('>') === true) break
    bodyLines.push(line)
    index += 1
  }

  let script = ''
  if (index < lines.length) {
    const scriptMatch = />\s*\{%([\s\S]*?)%\}/.exec(lines.slice(index).join('\n'))
    if (scriptMatch !== null) script = scriptMatch[1]
  }
  return {
    name,
    method,
    url,
    headers,
    body: bodyLines.join('\n').trim(),
    script,
    title: block.title,
  }
}

/** `{{VAR}}` 替换；未解析的变量留给调用方判失败，避免静默拼出坏 URL。 */
function substitute(text, scope) {
  const missing = []
  const out = String(text).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, function (whole, key) {
    if (Object.hasOwn(scope, key) === true && scope[key] !== undefined) return String(scope[key])
    missing.push(key)
    return whole
  })
  return { text: out, missing }
}

/** 脚本侧可见的 `client`：语义与 IntelliJ 的相同子集。 */
function createClient(report) {
  const globals = new Map()
  return {
    globals,
    global: {
      set(key, value) {
        globals.set(key, value)
      },
      get(key) {
        return globals.get(key)
      },
      isEmpty() {
        return globals.size === 0
      },
      clearAll() {
        globals.clear()
      },
    },
    assert(condition, message) {
      if (condition !== true)
        throw new Error(message === undefined ? 'assertion failed' : String(message))
    },
    test(name, fn) {
      try {
        fn()
        report.tests.push({ name, passed: true })
      } catch (error) {
        // 与 ijhttp 同语义：一条 test 失败只记失败，不打断后续请求——否则一次跑只能看到
        // 第一处红，而链路脚本的价值恰恰是"一次看完所有断点"。
        report.tests.push({ name, passed: false, message: error.message })
      }
    },
    log(text) {
      if (report.quiet !== true) report.logs.push(String(text))
    },
  }
}

async function loadEnvScope(envFile, envName) {
  const file = path.resolve(envFile)
  if (existsSync(file) === false) return { name: '', scope: {} }
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const names = Object.keys(parsed)
  const chosen = envName !== '' ? envName : names[0]
  if (chosen === undefined || parsed[chosen] === undefined) {
    throw new Error(
      `env "${envName}" not found in ${envFile} (have: ${names.join(', ') || 'none'})`,
    )
  }
  return { name: chosen, scope: { ...parsed[chosen] } }
}

async function runFile(file, options, env) {
  const source = await readFile(file, 'utf8')
  const report = { file, tests: [], blocks: [], logs: [], requests: 0, quiet: options.quiet }
  const client = createClient(report)

  for (const block of splitBlocks(source)) {
    const parsed = parseBlock(block)
    if (parsed === null) continue
    const label = parsed.name === '' ? parsed.title : parsed.name
    // 每个请求都取最新快照：前一步 set 的 PROVIDER_ID 要能影响后一步的 URL 与 body。
    const scope = { ...env.scope, ...options.overrides, ...Object.fromEntries(client.globals) }
    const url = substitute(parsed.url, scope)
    const body = substitute(parsed.body, scope)
    if (url.missing.length > 0) {
      throw new Error(
        `${file} @${label}: unresolved variable(s) ${url.missing.join(', ')} in ${parsed.url}`,
      )
    }
    if (body.missing.length > 0) {
      throw new Error(
        `${file} @${label}: unresolved variable(s) ${body.missing.join(', ')} in body`,
      )
    }

    const headers = {}
    for (const [key, value] of Object.entries(parsed.headers))
      headers[key] = substitute(value, scope).text
    const init = { method: parsed.method, headers }
    if (body.text !== '') {
      init.body = body.text
      if (Object.keys(headers).some((key) => key.toLowerCase() === 'content-type') === false) {
        headers['Content-Type'] = 'application/json'
      }
    }

    report.requests += 1
    // 逐块的下标必须是**块起点**：`report.tests.length` 就是这块开始前已有的条数。
    // 旧实现取「已通过的条数」当下标（filter(passed).length），前一块只要失败过一条，
    // 后续块的切片就会落在旧区间上——「前块红、本块绿」会被判成本块也红（q5-003）。
    const blockStart = report.tests.length
    const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    let response
    try {
      response = await fetch(url.text, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if (isTimeout(error) === true) throw timeoutError(file, label, timeoutMs)
      throw error
    }
    const text = await response.text()
    let parsedBody
    try {
      parsedBody = text === '' ? null : JSON.parse(text)
    } catch {
      parsedBody = text
    }
    if (parsed.script.trim() !== '') {
      const runner = new Function('client', 'response', parsed.script)
      runner(client, {
        status: response.status,
        body: parsedBody,
        headers: Object.fromEntries(response.headers),
      })
    }
    const blockTests = report.tests.slice(blockStart)
    const blockFailed = blockTests.some((test) => test.passed !== true)
    // 逐块结论同时进报告：只把 PASS/FAIL 打在 stdout 上，用例就没法断言「哪一块被判成了什么」，
    // 而这里恰恰是 q5-003 出过错的地方——结论必须可被断言，不能只可被肉眼看见。
    report.blocks.push({
      label,
      method: parsed.method,
      url: url.text,
      status: response.status,
      tests: blockTests.length,
      verdict: blockFailed ? 'FAIL' : 'PASS',
    })
    if (report.quiet !== true) {
      const verdict = blockFailed ? 'FAIL' : 'PASS'
      process.stdout.write(
        `  ${verdict} ${parsed.method} ${url.text} @${label} -> ${response.status}\n`,
      )
    }
  }
  return report
}

/**
 * 跑一批 .http 文件，返回汇总（供 CLI 与本仓的链路用例共用）。
 * 判定逻辑在脚本里，这里只统计「几个请求、几条 test、几条失败」。
 */
export async function runFiles({ files, options, env }) {
  const summary = { requests: 0, tests: 0, failures: 0, reports: [] }
  for (const file of files) {
    const report = await runFile(file, options, env)
    summary.reports.push(report)
    summary.requests += report.requests
    summary.tests += report.tests.length
    const failed = report.tests.filter((test) => test.passed !== true)
    summary.failures += failed.length
    for (const test of failed) {
      process.stdout.write(`  FAIL ${path.basename(file)} :: ${test.name} -> ${test.message}\n`)
    }
  }
  return summary
}

/** 装载环境文件并按名字取一段；用例可直接复用同一份 env 文件。 */
export function loadEnv(envFile, envName = '') {
  return loadEnvScope(envFile, envName)
}

/** 解析参数、装载环境、跑文件、按失败数落退出码。 */
export async function main(argv = process.argv.slice(2)) {
  const { files, options } = parseArgs(argv)
  const env = await loadEnvScope(options.envFile, options.env)
  const overrides = options.baseUrl === '' ? {} : { BASE_URL: options.baseUrl }
  if (options.quiet !== true) process.stdout.write(`env=${env.name} files=${files.length}\n`)

  const summary = await runFiles({ files, options: { ...options, overrides }, env })
  process.stdout.write(
    `requests=${summary.requests} tests=${summary.tests} failed=${summary.failures}\n`,
  )
  if (summary.failures > 0) process.exitCode = 1
  return summary
}

// 直接 `node test/api-script-runner.mjs FILE.http` 时自跑；被用例 import 时不产生副作用。
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`api-script-runner: ${error.message}\n`)
    process.exitCode = 1
  })
}

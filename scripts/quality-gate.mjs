/**
 * 一条命令跑完全部质量门：行尾 → 逐文件语法 → 用例与条数 → ESLint（存量走抑制清单）→
 * ESLint 抑制清单增量门禁 → Prettier。
 *
 * 为什么要「跑两遍 ESLint」：`--suppress-all` 的清单是按 file+rule 记**计数**的，
 * 只看退出码的话，同一个文件同一条规则再犯一次会被既有计数默默吃掉，CI 照样绿。
 * 所以第二遍用一份空的抑制清单拿**原始违规**，与提交的 eslint-suppressions.json 对账：
 * 任何新增条目或计数增长都判失败。这就是任务 1.5 要求的「新增抑制条目数必须为 0」
 * 与「新增违规确实会报错」两条门禁；自测见 test/quality-gate.test.mjs。
 *
 * Prettier 的强制面 = 未被 .prettierignore 排除的文件；该文件逐个点名排除源仓搬来的存量，
 * 因此「本次新建/改动的物料必须格式化」是默认效果（组 5 再加静态扫描断言新增文件都在面内）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { forward, tapPassCount } from './spawn-util.mjs'

export const MIN_TESTS = 226
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SUPPRESSIONS = path.join(root, 'eslint-suppressions.json')
const ESLINT_BIN = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js')
const PRETTIER_BIN = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs')
const TARGETS = ['lib', 'scripts', 'test']

/** 读抑制清单为 Map（key = '相对路径::规则'）；文件不存在按空基线处理。 */
export function readBaselineSuppressions(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return new Map()
  }
  const out = new Map()
  for (const [fileKey, rules] of Object.entries(JSON.parse(raw))) {
    for (const [rule, spec] of Object.entries(rules || {})) {
      out.set(fileKey + '::' + rule, Number(spec && spec.count) || 0)
    }
  }
  return out
}

/** 把 { 'file': { 'rule': n } } 折算成与基线同一套 key。 */
export function flattenViolations(byFile) {
  const out = new Map()
  for (const [fileKey, rules] of Object.entries(byFile)) {
    for (const [rule, count] of Object.entries(rules || {})) {
      out.set(fileKey + '::' + rule, Number(count) || 0)
    }
  }
  return out
}

/**
 * 基线之外出现的新条目、或既有条目的计数增长，都算「新增违规」。
 * 返回条目而不是布尔值，报错才能指名道姓（哪个文件哪条规则从几涨到几）。
 */
export function diffSuppressionBaseline(current, baseline) {
  const growth = []
  for (const [key, count] of current) {
    const allowed = baseline.get(key)
    if (allowed === undefined) growth.push({ key, before: 0, after: count, kind: 'new-entry' })
    else if (count > allowed)
      growth.push({ key, before: allowed, after: count, kind: 'count-growth' })
  }
  return growth
}

/** ESLint --format json → { '相对/路径': { '规则': 条数 } }（只计 severity 2）。 */
export function countErrors(report, rootDir) {
  const byFile = {}
  for (const entry of report) {
    const key = path.relative(rootDir, entry.filePath).split(path.sep).join('/')
    for (const message of entry.messages || []) {
      if (message.severity !== 2) continue
      byFile[key] = byFile[key] || {}
      const rule = message.ruleId || '(parse-error)'
      byFile[key][rule] = (byFile[key][rule] || 0) + 1
    }
  }
  return byFile
}

function shell(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...options })
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

const checks = []
function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  // 走 forward()（process.stdout.write）而不是 console.log：本文件在 scripts/ 下，
  // no-console 对 scripts/ 生效，而门禁的输出是被用例断言的契约。用现成的转发口，
  // 不给自己的新文件开抑制条目（新文件必须零新增条目，见上面的纪律）。
  forward((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '') + '\n')
}

export async function main() {
  // [1/6] 行尾：dry-run 诊断；真有 CRLF 漂移就说明有人绕过了 .gitattributes。
  const eol = shell(process.execPath, ['scripts/normalize-eol.mjs'])
  const eolOut = (eol.stdout + eol.stderr).trim()
  const eolMatch = /rewrite (\d+)\/\d+/.exec(eolOut)
  record(
    'eol=lf（normalize-eol.mjs dry-run）',
    eol.status === 0 && eolMatch !== null && Number(eolMatch[1]) === 0,
    eolOut,
  )

  // [2/6] 逐文件 node --check：lib/*.js、scripts/*.mjs、test/*.mjs 一个都不能漏。
  // 逻辑在 scripts/check-syntax.mjs：独立文件而非内联 -e（内联时字符串里的换行转义会被
  // 外层模板字面量吃掉一层，语法检查自己先 SyntaxError——1.5 落位时真踩过）。
  const syntax = shell(process.execPath, ['scripts/check-syntax.mjs'])
  const syntaxOut = (syntax.stdout + syntax.stderr).trim().replace(/\r?\n/g, '; ')
  record(
    'node --check（' + syntaxOut + '）',
    syntax.status === 0 && !syntaxOut.includes('CHECK_FAIL'),
    '',
  )

  // [3/6] 用例：全绿且条数 ≥ MIN_TESTS（口径与 test/baseline.test.mjs 的静态计数一致）。
  const tests = shell(process.execPath, ['--test', 'test/*.test.mjs'])
  const pass = tapPassCount(tests.stdout)
  const failMatch = /^# fail (\d+)$/m.exec(tests.stdout)
  const failed = failMatch === null ? null : Number(failMatch[1])
  record(
    'node --test（pass ' +
      (pass === null ? '?' : pass) +
      ' / fail ' +
      (failed === null ? '?' : failed) +
      '，口径 ≥ ' +
      MIN_TESTS +
      '）',
    tests.status === 0 && pass !== null && pass >= MIN_TESTS && failed === 0,
    tests.status === 0 ? '' : tests.stdout.slice(-400) + tests.stderr.slice(-200),
  )

  // ── ESLint 三段：顺序与写法都是被一次真实事故逼出来的 ─────────────────────
  //
  // 纪律：`--suppress-all` 会**改写** `--suppressions-location` 指向的文件。把它指向提交进
  // 仓库的 eslint-suppressions.json 时，门禁每跑一次就把当轮新违规自动登记进基线；下一遍
  // 再拿同一份文件当基线比对，增量恒为 0 —— 「新增违规必须报错」在结构上不可能失败，而且
  // 不报任何错。1.5 落位时真翻过车：植入 2 条真违规，门禁仍 6/6 绿。
  //
  // 因此检查路径全程只读，三段都用临时清单；要重建基线只能显式跑 npm run lint:baseline。
  const scratch = mkdtempSync(path.join(tmpdir(), 'bazaar-gate-'))
  const emptyLedger = path.join(scratch, 'empty-suppressions.json')
  writeFileSync(emptyLedger, '{}', 'utf8')
  const ledgerBefore = readFileSync(SUPPRESSIONS, 'utf8')

  // [4/6] 原始违规扫描：空清单跑一遍，拿到不被任何历史抑制掩盖的真实违规，再与基线对账。
  const raw = shell(
    process.execPath,
    [ESLINT_BIN, ...TARGETS, '--suppressions-location', emptyLedger, '--format', 'json'],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  let growth
  let detail = ''
  try {
    growth = diffSuppressionBaseline(
      flattenViolations(countErrors(JSON.parse(raw.stdout || '[]'), root)),
      readBaselineSuppressions(SUPPRESSIONS),
    )
  } catch (error) {
    growth = undefined
    detail = 'ESLint JSON 解析失败：' + (error && error.message)
  }
  if (growth !== undefined) {
    detail =
      growth.length === 0
        ? '原始违规与 eslint-suppressions.json 逐条相符'
        : growth.map((g) => g.key + ' ' + g.before + '→' + g.after + '(' + g.kind + ')').join('; ')
  }
  record(
    'eslint 抑制清单增量门禁（新增条目必须为 0）',
    growth !== undefined && growth.length === 0,
    detail,
  )

  // [5/6] 按提交的清单放行存量：不带 --suppress-all，因此这一遍只读。
  const honoring = shell(process.execPath, [
    ESLINT_BIN,
    ...TARGETS,
    '--suppressions-location',
    './eslint-suppressions.json',
  ])
  record(
    'eslint（存量走抑制清单，只读）',
    honoring.status === 0,
    (honoring.stdout + honoring.stderr).trim().slice(0, 400),
  )
  // 门禁跑完必须一个字节都不改基线：改了等于下一轮看不见新增违规。
  record(
    'eslint-suppressions.json 未被门禁改写',
    ledgerBefore === readFileSync(SUPPRESSIONS, 'utf8'),
    '',
  )

  // [6/6] Prettier：只约束强制面（新建/改动文件），存量按 .prettierignore 逐个点名放行。
  const pretty = shell(process.execPath, [PRETTIER_BIN, '--check', '.'])
  record(
    'prettier --check（强制面 = 新建/改动文件）',
    pretty.status === 0,
    (pretty.stdout + pretty.stderr).trim().slice(-500),
  )

  const notOk = checks.filter((c) => !c.ok)
  // 临时清单是脚本自己的产物，跑完必须带走：留一个 `bazaar-gate-*` 目录就等于每次
  // `npm run check` 都在 %TEMP% 里加一份（q5-005 的对账口径就包含它）。
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  forward(
    '\nquality gate: ' + (checks.length - notOk.length) + '/' + checks.length + ' checks passed\n',
  )
  if (notOk.length > 0) {
    forward('failed: ' + notOk.map((c) => c.name).join(' | ') + '\n')
    return 1
  }
  forward('OK: 一条命令质量门全绿（npm run check）\n')
  return 0
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main()
}

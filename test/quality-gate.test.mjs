/**
 * 质量门自身的回归：证明「抑制清单不会吃掉真违规」。
 *
 * 真踩过的坑（源仓 0.x 的教训写在 AGENTS 的坑清单里）：`--suppress-all` 生成的清单
 * 一旦提交，后续新增同类违规会被同一 file+rule 的计数默默吃掉，CI 依旧绿。
 * 这里的断言全部对着 quality-gate.mjs 的纯函数下，不碰仓库文件、不改抑制清单。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import {
  MIN_TESTS,
  diffSuppressionBaseline,
  flattenViolations,
  readBaselineSuppressions,
} from '../scripts/quality-gate.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('the suppression ledger is count-based: growth beyond the baseline is reported', () => {
  const baseline = new Map([['lib/client.js::no-unused-vars', 20]])
  const current = flattenViolations({ 'lib/client.js': { 'no-unused-vars': 21 } })
  const growth = diffSuppressionBaseline(current, baseline)
  assert.equal(growth.length, 1)
  assert.equal(growth[0].key, 'lib/client.js::no-unused-vars')
  assert.equal(growth[0].kind, 'count-growth')
  assert.equal(growth[0].before, 20)
  assert.equal(growth[0].after, 21)
})

test('a violation in a file the ledger never mentions is reported as a new entry', () => {
  const growth = diffSuppressionBaseline(
    flattenViolations({ 'lib/new-module.js': { eqeqeq: 1 } }),
    new Map(),
  )
  assert.equal(growth.length, 1)
  assert.equal(growth[0].kind, 'new-entry')
  assert.equal(growth[0].key, 'lib/new-module.js::eqeqeq')
})

test('a suppressed file staying at its recorded count adds nothing (no false alarm)', () => {
  const baseline = flattenViolations({ 'scripts/e2e.mjs': { 'no-console': 22 } })
  assert.deepEqual(diffSuppressionBaseline(baseline, baseline), [])
})

test('a violation the ruleset really catches reaches the gate (end-to-end probe)', async () => {
  // 不是拿手搭的计数表自证：让 ESLint 自己判一条真新写的违规。
  const { ESLint } = await import('eslint')
  // overrideConfigFile 指向仓内真实配置：探针跑的就是门禁那一套规则面，不是临时拼的。
  const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.js') })
  const [result] = await eslint.lintText(
    'const deliberatelyUnused = 1\nif (globalThis.x == null) {}\n',
    {
      filePath: path.join(root, 'lib/quality-gate-probe.js'),
    },
  )
  const rules = result.messages.map((m) => m.ruleId)
  assert.ok(
    rules.includes('no-unused-vars'),
    'no-unused-vars must fire on the probe: ' + rules.join(','),
  )
  assert.ok(rules.includes('eqeqeq'), 'eqeqeq must fire on the probe: ' + rules.join(','))
  // 这条探针文件从未登记进抑制清单，所以门禁用它做增量比对必然报 new-entry —— 即"吃掉真违规"不可能发生。
  const counts = {}
  for (const m of result.messages) {
    if (m.severity !== 2) continue
    counts['lib/quality-gate-probe.js'] = counts['lib/quality-gate-probe.js'] || {}
    counts['lib/quality-gate-probe.js'][m.ruleId] =
      (counts['lib/quality-gate-probe.js'][m.ruleId] || 0) + 1
  }
  assert.ok(
    diffSuppressionBaseline(
      flattenViolations(counts),
      readBaselineSuppressions(path.join(root, 'eslint-suppressions.json')),
    ).length >= 2,
  )
})

test('the committed suppression ledger stays parseable and non-negative', () => {
  const baseline = readBaselineSuppressions(path.join(root, 'eslint-suppressions.json'))
  assert.ok(baseline.size > 0, 'expected a committed baseline with at least one entry')
  for (const [key, count] of baseline) {
    assert.ok(
      Number.isInteger(count) && count >= 0,
      key + ' must carry a non-negative integer count',
    )
  }
})

test('门禁源码里没有「把 --suppress-all 指向仓库清单」的写法', () => {
  // 这条守的是 1.5 那次真实事故：--suppress-all 会改写 --suppressions-location 指向的文件，
  // 一旦指向提交进仓库的 eslint-suppressions.json，门禁每跑一次就把新违规登记进基线，
  // 增量恒为 0，门禁永远绿。静态断言比行为断言更早生效——它在读代码时就能拦住这种写法。
  const source = readFileSync(path.join(root, 'scripts', 'quality-gate.mjs'), 'utf8')
  const codeLines = source.split('\n').filter((line) => {
    const trimmed = line.trim()
    return (
      trimmed.startsWith('//') === false &&
      trimmed.startsWith('*') === false &&
      trimmed.startsWith('/*') === false
    )
  })
  assert.equal(
    codeLines.some((line) => line.includes('--suppress-all')),
    false,
    '检查路径必须只读：要重建基线只能显式跑 npm run lint:baseline',
  )
  // 基线写入只允许出现在 npm script 里，且那条 script 名字必须明说是重建基线。
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(
    pkg.scripts['lint:baseline'].includes('--suppress-all'),
    'lint:baseline 是唯一允许写基线的入口',
  )
  assert.equal(pkg.scripts.lint.includes('--suppress-all'), false, 'npm run lint 不能改写基线')
  assert.equal(pkg.scripts.check.includes('--suppress-all'), false, 'npm run check 不能改写基线')
})

test('真实 ESLint 输出对未登记违规报 new-entry，且比对不修改基线文件', async () => {
  // 集成断言：不用手搭的计数表，让 ESLint 真的跑一遍，再用门禁自己的比对函数判增量。
  const { ESLint } = await import('eslint')
  const ledgerPath = path.join(root, 'eslint-suppressions.json')
  const before = readFileSync(ledgerPath, 'utf8')
  const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.js') })
  // 探针必须是真违规：导出的 const 不算未使用，所以这里刻意写一个未使用的局部量 + 松散相等。
  const [result] = await eslint.lintText('const unused = 1\nif (globalThis.x == null) {}\n', {
    filePath: path.join(root, 'lib', '__probe__.js'),
  })
  const byFile = {}
  for (const message of result.messages) {
    if (message.severity !== 2) continue
    byFile['lib/__probe__.js'] = byFile['lib/__probe__.js'] || {}
    byFile['lib/__probe__.js'][message.ruleId] =
      (byFile['lib/__probe__.js'][message.ruleId] || 0) + 1
  }
  const growth = diffSuppressionBaseline(
    flattenViolations(byFile),
    readBaselineSuppressions(ledgerPath),
  )
  assert.ok(growth.length >= 1, '未登记的新违规必须被算成增量：' + JSON.stringify(growth))
  assert.equal(growth[0].kind, 'new-entry')
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '比对过程不得改写基线')
})
test('the baseline test-count floor matches what the suite is held to', () => {
  // 门禁的下限与静态计数用例同源，避免"改了一处、另一处还写着旧数"。
  assert.equal(MIN_TESTS, 226)
  assert.equal(typeof flattenViolations, 'function')
  assert.equal(process.exitCode !== 1, true, 'importing the gate must not flip the exit code')
})

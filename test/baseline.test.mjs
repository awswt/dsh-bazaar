/**
 * 基线守护：用例条数、逐文件语法、以及「源仓搬来的实现文件不许凭空多出或消失」。
 *
 * 1.1 记录过入仓基线（226 条用例 / 49 个实现文件 / 16,513 行）。后续每组的改动都要能
 * 对着这份数字说话：条数只增不减，文件清单变化必须是显式的新增（provider 化会加目录）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 递归收集某个目录下的实现文件（POSIX 相对路径）。
 *
 * 必须是递归的：组 2 起实现分层了（`lib/provider/`、`lib/providers/<id>/`，
 * 组 3/4 还会加更多），单层 readdir 会「扫过目录、没扫到文件」，让这道地基变成假绿灯——
 * 文件真被删掉时它也照样绿。
 */
function collectSources(dir) {
  const out = []
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(next)
    }
  }
  walk(dir)
  return out.sort()
}

/** 计数口径与 1.1 基线一致：每个 .test.mjs 里行首的 test( / it( 各算一条。 */
function countCasesPerFile() {
  const dir = path.join(root, 'test')
  const out = {}
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mjs')) continue
    const text = readFileSync(path.join(dir, name), 'utf8')
    out[name] = text.split('\n').filter((line) => /^\s*(test|it)\(/.test(line)).length
  }
  return out
}

test('the suite carries at least the 226 cases it arrived with', () => {
  const perFile = countCasesPerFile()
  const total = Object.values(perFile).reduce((a, b) => a + b, 0)
  assert.ok(total >= 226, `expected ≥226 declared cases, got ${total}`)
})

test('every implementation directory keeps its 1.1 file inventory as a floor', () => {
  // 下限是「源仓搬来的文件一个都不许凭空消失」这道地基；分层后的新文件只会把实际值抬高。
  const floors = { lib: 20, scripts: 4, test: 22 }
  for (const [dir, floor] of Object.entries(floors)) {
    const files = collectSources(dir)
    const testFiles = dir === 'test' ? files.filter((f) => f.endsWith('.test.mjs')) : files
    assert.ok(
      testFiles.length >= floor,
      `${dir}: expected ≥${floor} files, got ${testFiles.length}`,
    )
  }
  // 分层目录必须真的被扫到，否则上面的下限只是在数顶层。
  const lib = collectSources('lib')
  for (const nested of ['lib/provider/registry.js', 'lib/providers/workbuddy/market.js']) {
    assert.ok(lib.includes(nested), `file inventory missed the nested module ${nested}`)
  }
})

test('no stray CRLF made it into the tracked sources', () => {
  // .gitattributes 声明 eol=lf；工作区只要混进 CRLF，release.mjs 就会被 git 的 stderr 警告坑到。
  // 递归：分层目录里的新文件同样是发布产物，漏扫等于给它们开免检。
  for (const dir of ['lib', 'scripts', 'test']) {
    for (const rel of collectSources(dir)) {
      const text = readFileSync(path.join(root, rel), 'utf8')
      assert.ok(
        !text.includes('\r\n'),
        `${rel} contains CRLF — run node scripts/normalize-eol.mjs --write`,
      )
    }
  }
})

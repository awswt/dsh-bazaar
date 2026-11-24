/**
 * 基线守护：用例条数、逐文件语法、文件清点，以及「谁在 prettier 的强制面内」。
 *
 * 1.1 记录过入仓基线（226 条用例 / 49 个实现文件 / 16,513 行）。后续每组的改动都要能
 * 对着这份数字说话：条数只增不减，文件清单变化必须是显式的新增（provider 化会加目录）。
 *
 * 组 5 追加的一条是双向的：`.prettierignore` 既是「存量免检名单」，也是「新文件登记表」。
 * 只做单向检查（新文件在强制面内）会漏掉另一半——重写过的存量文件忘记从名单里划掉时，
 * 它既没被 prettier 守，也没人发现。
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 递归收集某个目录下的实现文件（POSIX 相对路径）。
 *
 * 必须是递归的：组 2 起实现分层了（`lib/provider/`、`lib/providers/<id>/`，
 * 组 3/4 还会加更多），单层 readdir 会「扫过目录、没扫到文件」，让这道地基变成假绿灯——
 * 文件真被删掉时它也照样照绿。
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

/* ------------------------------------------------------------------ *
 * prettier 强制面：清单 = 登记表
 * ------------------------------------------------------------------ */

/**
 * 把 `.prettierignore` 读成「目录前缀」与「精确文件」两张表。
 *
 * 这里刻意不实现通配：清单里出现 `*` 时直接判违规，因为通配会让两种错误同时隐形——
 * 新文件自动被排除（没人发现它没进强制面），存量文件被顺手豁免（没人发现它没被守）。
 */
function readIgnoreList() {
  const text = readFileSync(path.join(root, '.prettierignore'), 'utf8')
  const dirs = []
  const files = []
  const wildcards = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.includes('*') || line.includes('{') || line.includes('?')) {
      wildcards.push(line)
      continue
    }
    const normalized = line.replace(/^\//, '')
    if (line.endsWith('/')) dirs.push(normalized)
    else files.push(normalized)
  }
  return { dirs, files, wildcards }
}

/** 相对路径是否被清单排除（= 免检）。 */
function ignoredBy(rel, list) {
  if (list.files.includes(rel)) return true
  return list.dirs.some((dir) => rel === dir.slice(0, -1) || rel.startsWith(dir))
}

/** 本仓（组 2 起）新建/重写的文件：必须在强制面内。 */
const ENFORCED_BY_CONSTRUCTION = [
  'lib/client.js',
  'lib/provider/status.js',
  'lib/provider/routes.js',
  'lib/provider/registry.js',
  'lib/provider/contract.js',
  'lib/provider/active-set.js',
  'test/hook-order.test.mjs',
  'test/settings-card.test.mjs',
  'test/route-lifecycle.test.mjs',
  'test/baseline.test.mjs',
  'test/ui-harness.mjs',
  'test/two-screen-e2e.test.mjs',
  'docs/e2e-baseline.md',
]

test('新建与重写的文件都在 prettier 强制面内（含反向控制）', () => {
  const list = readIgnoreList()
  assert.deepEqual(list.wildcards, [], '免检名单不接受通配：它必须逐条点名')

  // 反向控制：一个真实存量文件必须落在免检面，否则「新文件不在免检面」可能只是因为整张表读空了。
  assert.equal(ignoredBy('lib/auth.js', list), true, '存量文件 lib/auth.js 应仍在免检名单里')
  // 反向控制：清单里没登记的路径必须判成「在强制面内」，避免判定函数恒真。
  assert.equal(ignoredBy('lib/brand-new-module.js', list), false)

  const missing = ENFORCED_BY_CONSTRUCTION.filter((rel) => {
    assert.equal(existsSync(path.join(root, rel)), true, `${rel} 不存在，登记表已过期`)
    return ignoredBy(rel, list)
  })
  assert.deepEqual(
    missing,
    [],
    `这些文件被 .prettierignore 排除了，等于既没被 prettier 守也没人发现：\n${missing.join('\n')}`,
  )
})

test('免检名单与磁盘双向对账：没有漏登记，也没有已重写的死条目', () => {
  const list = readIgnoreList()
  const walked = [
    ...collectSources('lib'),
    ...collectSources('scripts'),
    ...collectSources('test'),
    ...collectDocs(),
    'README.md',
    'AGENTS.md',
  ]

  // 死条目：清单里点名了，磁盘上却找不到——通常是文件改名/删除后忘了划掉。
  const dead = list.files.filter((rel) => !existsSync(path.join(root, rel)))
  assert.deepEqual(dead, [], `免检名单里有已不存在的文件，请划掉：\n${dead.join('\n')}`)

  // 漏登记的反面：被免检的文件必须就是清单点名的文件（目录前缀下的存量按目录整体免检）。
  const ignored = walked.filter((rel) => ignoredBy(rel, list))
  const named = new Set(list.files)
  const unorthodox = ignored.filter((rel) => {
    if (named.has(rel)) return false
    return !list.dirs.some((dir) => rel.startsWith(dir) && !isThisGroupsRewrite(rel))
  })
  assert.deepEqual(
    unorthodox,
    [],
    `这些文件被某个目录前缀顺手豁免，但它们不是该目录的存量：\n${unorthodox.join('\n')}`,
  )
})

/** 组 5 重写过的文件：不允许被「目录整体免检」这种模糊理由塞回免检面。 */
function isThisGroupsRewrite(rel) {
  return (
    rel === 'docs/e2e-baseline.md' || rel === 'docs/releases/v1.0.0.md' || rel === 'lib/client.js'
  )
}

function collectDocs() {
  const out = []
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith('.md')) out.push(next)
    }
  }
  walk('docs')
  return out.sort()
}

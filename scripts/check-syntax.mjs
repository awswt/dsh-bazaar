/**
 * 逐文件 node --check：lib/、scripts/、test/、examples/ 下每个 .js/.mjs 全过才算过。
 *
 * 为什么单独成文件：把它写成 node -e 的内联脚本时，字符串里的换行转义会被外层模板
 * 字面量吃掉一层，语法检查自己先 SyntaxError（1.5 落位时真踩过）。独立文件既落在
 * prettier 强制面内，也让 CI 与本地跑的是同一份逻辑。
 *
 * 为什么必须递归：2.x 起源码不再是扁平一层（lib/provider/、lib/providers/workbuddy/、
 * examples/minimal-provider/）。只读顶层的话，新增子目录里的文件一次都没被检查过，
 * 而门禁照样打印「checked N files, 0 failed」——那是最坏的一种绿。
 */
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { forward } from './spawn-util.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dirs = ['lib', 'scripts', 'test', 'examples']

/**
 * 递归收集可检查文件，返回相对仓库根的 POSIX 路径（报错时能直接拿去定位）。
 * 子目录里的用例夹具若含故意写坏的语法，文件名以 .fixture 结尾即可避开——比在
 * 收集逻辑里硬编码例外清单更难被后人无意破坏。
 */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = dir + '/' + entry.name
    if (entry.isDirectory()) {
      out.push(...collect(relative))
      continue
    }
    if (entry.name.endsWith('.fixture')) continue
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(relative)
  }
  return out
}

const files = dirs.flatMap((dir) => collect(dir))

const failures = []
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' })
  } catch (error) {
    const detail = String((error && error.stderr) || error || '')
      .split('\n')
      .slice(0, 4)
      .join(' | ')
    failures.push({ file, detail })
  }
}

for (const f of failures) forward('CHECK_FAIL ' + f.file + ' :: ' + f.detail + '\n')
forward('checked ' + files.length + ' files, ' + failures.length + ' failed\n')
process.exitCode = failures.length === 0 ? 0 : 1

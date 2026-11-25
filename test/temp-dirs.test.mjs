/**
 * 临时目录登记表的收口证明（q5-005）。
 *
 * 为什么要有这条用例：临时目录泄漏是**静默**的——漏掉的目录不报错、不影响断言，
 * 只在磁盘配额耗尽那天才被发现（本仓实测一次全量 `npm test` 留 145 个目录）。
 * 所以「登记表真的会删」和「进程退出也会删」两半都必须有断言，光把 mkdtemp 换成 helper
 * 只是把写法统一了，证明不了真会删。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { cleanupTempDirs, pendingTempDirs, tempDir, tempDirSync } from './temp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const helperUrl = pathToFileURL(path.join(here, 'temp.mjs')).href

/** %TEMP% 里还剩几个该前缀的目录——这就是「跑完一批用例后有没有增长」的判定面。 */
function leftovers(prefix) {
  return readdirSync(tmpdir()).filter(function (name) {
    return name.startsWith(prefix)
  })
}

test('建出来的目录都在登记表里，cleanup 之后磁盘上不再有它们', async () => {
  const asyncDir = await tempDir('bz-guard-mem-async-')
  const syncDir = tempDirSync('bz-guard-mem-sync-')
  assert.equal(existsSync(asyncDir), true)
  assert.equal(existsSync(syncDir), true)

  const registered = pendingTempDirs()
  assert.equal(registered.includes(asyncDir), true, 'tempDir 必须登记')
  assert.equal(registered.includes(syncDir), true, 'tempDirSync 必须登记')

  assert.deepEqual(cleanupTempDirs(), [], 'cleanup 不该留下删不掉的条目')
  assert.equal(existsSync(asyncDir), false)
  assert.equal(existsSync(syncDir), false)
  assert.deepEqual(pendingTempDirs(), [], '删掉之后登记表必须清空')
  assert.deepEqual(leftovers('bz-guard-mem-'), [], '这批目录跑完不该在 %TEMP% 留东西')
})

test('进程退出时兜底清理：子进程没调 cleanup 也不留目录', () => {
  // 子进程只建目录、写一行结果、退出，全程不调 cleanup——能删掉就只可能是 exit 钩子干的。
  // 结果走**标记文件**而不是 stdout：子进程读不读得到结果，不该取决于自己往终端里打了什么
  // （早先的版本里 `temp.mjs` 会 import node:test，一载入就往 stdout 打 TAP 横幅，解析
  // stdout 等于依赖一段与本用例无关的输出格式）。
  const marker = path.join(tempDirSync('bz-guard-marker-'), 'child.json')
  const script = [
    'import { writeFileSync } from "node:fs"',
    'import { tempDir, pendingTempDirs } from ' + JSON.stringify(helperUrl),
    "const dir = await tempDir('bz-guard-exit-')",
    'writeFileSync(',
    '  process.env.BAZAAR_TEMP_PROBE,',
    '  JSON.stringify({ dir, pending: pendingTempDirs().length }),',
    ')',
    // 显式 exit：不依赖运行器怎么收尾，退出的那一刻就是唯一可观测点；把 exit 钩子拆掉，
    // 这条用例必然红（探针实测 `.probe-child/reverse.mjs` 的 q5-005 一项）。
    'process.exit(0)',
  ].join('\n')

  const before = leftovers('bz-guard-exit-')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, BAZAAR_TEMP_PROBE: marker },
  })
  assert.equal(child.status, 0, '子进程必须正常退出：' + (child.stderr || ''))

  const parsed = JSON.parse(readFileSync(marker, 'utf8'))
  assert.equal(parsed.pending, 1, '子进程里应当登记着一个待删目录')
  assert.equal(existsSync(parsed.dir), false, '没有 exit 兜底时这个目录会留在 %TEMP% 里')
  // 差值而非「一个都没有」：%TEMP% 是共享目录，历史遗留（本仓早先版本的泄漏）不属于这次
  // 运行的账，用绝对值断言会让这条用例从第一天起就红，久而久之就被当成噪音关掉。
  const added = leftovers('bz-guard-exit-').filter(function (name) {
    return before.includes(name) === false
  })
  assert.deepEqual(added, [], '这一轮跑完不该新增残留：' + JSON.stringify(added))
})

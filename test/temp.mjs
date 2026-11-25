/**
 * 临时 profile 的统一收口（q5-005）。
 *
 * 为什么要有这个文件：`mkdtemp` 在 test/ 下有三十几处，清理调用只有个位数——每跑一次
 * `npm test` 就在 %TEMP% 留一批 `bz-*` / `bazaar-*` 目录（实测一次全量 145 个）。仓里
 * 的纪律是「自证服务用后即停」，临时目录同理；散落在各文件里手写 rm 的写法一定会漏，
 * 因为漏掉不报错，只在磁盘配额耗尽那天才被发现。
 *
 * 所以：建目录与删目录绑在同一个入口上——凡经 `tempDir()` / `tempDirSync()` 建出来的
 * 目录都会进登记表，**进程退出时**统一删除。
 *
 * 为什么只在 exit 删、不用 `node:test` 的 `after()`：`after()` 的作用域取决于它被注册时
 * 所在的上下文，不是「文件末尾」——在 `before()` 或某个 test body 里首次建目录时，钩子会
 * 挂到那个上下文上，于是「第一个用例一结束」就把整份共享 scratch 删了，后面的用例再往
 * 里写文件就是 ENOENT（实测：`test/api-http-chain.test.mjs` 的 `bz-chain-scratch-*` 被提前
 * 删，反向控制两条直接红）。exit 钩子没有这个问题：目录活到进程结束，一个文件一个进程，
 * 覆盖面与「文件跑完就删」等价，而时序确定。
 *
 * 反例（别写）：`await fs.mkdtemp(...)` 直接建目录——它不会进登记表，也就没人删。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 已登记、待删除的临时目录。Set 而不是数组：重复登记同一个路径不该被删两次。 */
const created = new Set()
let cleanupRegistered = false

/**
 * 删一个目录。`force` 让「已经不在了」也算成功（幂等）；Windows 上杀毒/索引器会短暂
 * 占住句柄，`maxRetries` + `retryDelay` 是给这种瞬时 EBUSY/EPERM 留的余地（全量跑 40 个
 * profile 并发时 5 次 × 50ms 曾不够，见 q5-005 的实测）。
 * 删不掉的条目保留在登记表里，留给下一次（含 exit 兜底）重试。
 */
function dropDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  created.delete(dir)
}

/**
 * 立刻删掉全部已登记的临时目录，返回删不掉的条目（正常情况应为空）。
 * 用例直接调它来做「跑完不增长」的断言；文件收尾与进程退出也走同一个入口。
 */
export function cleanupTempDirs() {
  const failures = []
  for (const dir of Array.from(created)) {
    try {
      dropDir(dir)
    } catch (error) {
      failures.push(dir + ': ' + (error && error.message))
    }
  }
  return failures
}

/**
 * 登记清理。只挂 exit 钩子：它必须同步、且绝不能抛（抛了会把退出码带坏）。
 * 这里不注册 `after()`——理由见文件头：作用域随时序漂移，会把别的用例还要用的目录删掉。
 */
function registerCleanup() {
  if (cleanupRegistered === true) return
  cleanupRegistered = true
  process.once('exit', () => {
    cleanupTempDirs()
  })
}

/** 建一个带登记清理的临时目录（异步版，与 `fs.mkdtemp` 同形）。 */
export async function tempDir(prefix = 'bz-') {
  registerCleanup()
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  created.add(dir)
  return dir
}

/** 建一个带登记清理的临时目录（同步版，给同步构造 fixtures 的文件用）。 */
export function tempDirSync(prefix = 'bz-') {
  registerCleanup()
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  created.add(dir)
  return dir
}

/** 当前仍待删除的目录快照——供用例做「登记表真的空了」的断言。 */
export function pendingTempDirs() {
  return Array.from(created)
}

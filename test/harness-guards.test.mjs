/**
 * API 链路基建的三条守卫（q5-003 / q5-006 / q5-007）。
 *
 * 为什么单独成文件：这三条都不是业务行为，而是「执行器把结论判错了」或「入口静默没跑」。
 * 它们的共同点是**出错时仍然是绿的**——逐块结论判错只影响一行输出，请求挂住只表现为「卡住」，
 * isMain 判错则是直接退出、什么都不打印。所以每条用例都必须先在坏实现上变红，再在修好的
 * 实现上变绿，否则这些用例只是把同一份错误又抄了一遍。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvesToEntry } from './api-http-server.mjs'
import { REQUEST_TIMEOUT_MS, TIMEOUT_CODE, runFiles } from './api-script-runner.mjs'
import { tempDir } from './temp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 用一次性本地服务跑一段 .http 源码。
 *
 * 服务必须无条件关掉：`runFiles` 在超时那条路径上会 reject，若把 close 写在成功分支里，
 * 用例进程会因为挂住的连接退不出去——那正好会掩盖「超时已经生效」这个结论。
 */
async function runAgainst(handler, source, options = {}) {
  const server = http.createServer(handler)
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve)
  })
  // 连临时目录与写文件都放进 try：它们任何一步抛错时，服务同样必须被关掉，
  // 否则挂着的监听会把用例进程一起拖住（这里踩过一次）。
  try {
    const base = 'http://127.0.0.1:' + server.address().port
    const dir = await tempDir('bz-guard-http-')
    const file = path.join(dir, 'guard.http')
    await writeFile(file, source, 'utf8')
    return await runFiles({
      files: [file],
      options: { quiet: true, ...options, overrides: { BASE_URL: base } },
      env: { name: '', scope: {} },
    })
  } finally {
    server.closeAllConnections()
    await new Promise(function (resolve) {
      server.close(resolve)
    })
  }
}

function answerJson(request, response) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ path: request.url }))
}

test('逐块结论按块起点切分：前一块红不会把后一块也判红（q5-003）', async () => {
  const source = [
    '### 第一块：故意留一条红',
    '# @name first',
    'GET {{BASE_URL}}/first',
    '',
    '> {%',
    "  client.test('第一块通过项', () => { client.assert(response.status === 200) })",
    "  client.test('第一块故意失败项', () => { client.assert(response.status === 599, 'boom') })",
    '%}',
    '',
    '### 第二块：全绿',
    '# @name second',
    'GET {{BASE_URL}}/second',
    '',
    '> {%',
    "  client.test('第二块通过项', () => { client.assert(response.status === 200) })",
    '%}',
  ].join('\n')

  const summary = await runAgainst(answerJson, source)
  const report = summary.reports[0]

  // 旧实现用「已通过条数」当块起点：第一块 [通过, 失败] 之后 through=1，第二块 slice(1) 就把
  // 第一块的失败项算进了第二块，明明全绿的第二块被判 FAIL。所以这里断言的不是「有 blocks」，
  // 而是每个块的结论与条数都对得上。
  assert.deepEqual(
    report.blocks.map(function (block) {
      return block.label + ':' + block.verdict + ':' + block.tests
    }),
    ['first:FAIL:2', 'second:PASS:1'],
    '块起点必须取 report.tests.length，不能取已通过条数',
  )
  assert.equal(summary.failures, 1, '失败条数只该统计真正失败的那一条')
  assert.equal(summary.tests, 3)
})

test('请求挂住时按上限折成带 code 的失败，并指明脚本与块（q5-006）', async () => {
  const source = [
    '### 永不返回的块',
    '# @name hung',
    'GET {{BASE_URL}}/never',
    '',
    '> {%',
    "  client.test('不会跑到这里', () => { client.assert(response.status === 200) })",
    '%}',
  ].join('\n')

  await assert.rejects(
    function () {
      // 故意不写响应：连接建立但不返回，正是 fetch 没有超时时会永久等下去的形态。
      return runAgainst(function () {}, source, { requestTimeoutMs: 150 })
    },
    function (error) {
      assert.equal(error.code, TIMEOUT_CODE, '超时必须带固定 code，调用方才不用解析文案')
      assert.equal(error.timeoutMs, 150, '实际生效的上限要回传，否则分不清是配置还是默认')
      assert.equal(error.block, 'hung')
      assert.match(error.message, /guard\.http @hung/, '文案必须同时指明脚本与块名')
      assert.match(error.message, /150ms/)
      return true
    },
  )
  // 默认上限钉死 30s：更小会在慢 CI 上误伤正常请求，更大等于没设。
  assert.equal(REQUEST_TIMEOUT_MS, 30_000)
})

test('isMain 用 fileURLToPath 判定：含空格/中文的路径也算自己（q5-007）', () => {
  const entry = path.join(here, 'api-http-server.mjs')
  const entryUrl = pathToFileURL(entry).href
  assert.equal(resolvesToEntry(entryUrl, entry), true, '绝对路径的 argv[1] 必须判成自己')

  // pathToFileURL 会把空格与中文 percent-encode；旧的 `new URL(...).pathname` 拿到的仍是
  // 转义串，与真实路径永远不相等——于是 harness 静默退出，脚本看起来「跑过了」。
  const tricky = path.join(here, '带 空格 的 目录', '入口 文件.mjs')
  const trickyUrl = pathToFileURL(tricky).href
  assert.match(trickyUrl, /%20/, 'file URL 里空格必须被编码，否则这条用例测不到旧 bug')
  assert.match(trickyUrl, /%E[4-9]/i, 'file URL 里中文必须被编码')
  assert.equal(resolvesToEntry(trickyUrl, tricky), true)

  const legacyPath = new URL(trickyUrl).pathname
  assert.notEqual(legacyPath, tricky, 'URL.pathname 没解码，直接拿来比路径是错的')
  assert.match(legacyPath, /%[0-9A-F]{2}/i, '旧实现手上一直是百分号转义串')

  // 反向控制：别的文件、后缀相近的路径、缺 argv[1] 都不能判成自己。
  assert.equal(resolvesToEntry(entryUrl, path.join(here, 'api-script-runner.mjs')), false)
  assert.equal(resolvesToEntry(entryUrl, entry + '.bak'), false)
  assert.equal(resolvesToEntry(entryUrl, undefined), false)
  // CLI 里 argv[1] 常常是相对路径，判定必须先把两边都 resolve 再比。
  assert.equal(resolvesToEntry(entryUrl, path.relative(process.cwd(), entry)), true)
})

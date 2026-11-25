/**
 * 链路脚本的可复现回归：`api-tests/script/*.http` 必须在**本仓自己的** harness 上全绿。
 *
 * 为什么要有这条用例：组 5 曾经把「脚本全绿」当成交付证据，但那份证据是拿一个手写的
 * 假服务跑出来的——只要换回仓里的 harness，同一条脚本立刻红三处：
 *   - `GET /providers/<id>/status` → 503 BAZAAR_PROVIDER_THROWN（装配时漏传 status 依赖）
 *   - `GET /dsh-bazaar/experts` → 404（只挂了 provider 分组路由，没挂面板扁平路由）
 *   - `POST .../accounts/action` → 400 BAZAAR_AUTH_MISSING（provider 没接账号服务）
 * 也就是说：脚本断言再严，也管不住「harness 装配漏件」。这里把整条链路钉进 `npm test`，
 * 让「同样一条命令、两个人都能跑出同一个结论」成为默认，而不是靠谁记得手动起服务。
 *
 * harness 监听 0 端口（不占 39320），每次自建自毁；断言的判定逻辑仍在 .http 脚本里，
 * 本用例只负责「喂真实 HTTP、统计结论、并证明失败会被计数」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createApiServer } from './api-http-server.mjs'
import { loadEnv, runFiles } from './api-script-runner.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENV_FILE = path.join(ROOT, 'api-tests', 'http-client.env.json')

/** 脚本 → 该脚本里的请求块数（块被静默跳过就会对不上，见反向控制 2）。 */
const CHAINS = [
  { file: path.join(ROOT, 'api-tests', 'script', 'provider-registry-chain.http'), requests: 11 },
  { file: path.join(ROOT, 'api-tests', 'script', 'connector-oauth-chain.http'), requests: 17 },
]

describe('api-tests 链路脚本在仓内 harness 上可复现', () => {
  let api
  let base
  let env
  let scratch

  before(async () => {
    api = await createApiServer({ port: 0 })
    await api.listen(0)
    const address = api.server.address()
    base = 'http://127.0.0.1:' + address.port
    env = await loadEnv(ENV_FILE, '')
    scratch = await mkdtemp(path.join(tmpdir(), 'bz-chain-scratch-'))
  })

  after(async () => {
    if (api !== undefined) await api.close()
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  })

  /** 用给到的 HTTP 地址跑一个 .http 文件，返回 runner 的汇总。 */
  function runScript(file) {
    return runFiles({
      files: [file],
      options: { quiet: true, overrides: { BASE_URL: base } },
      env: env,
    })
  }

  for (const chain of CHAINS) {
    it(path.basename(chain.file) + '：全部请求与断言通过', async () => {
      const summary = await runScript(chain.file)
      assert.equal(summary.failures, 0, '断言失败数必须为 0：' + JSON.stringify(summary.failures))
      // 请求块数是"脚本没被改坏/没被静默跳过"的锚点：少一块就是少一份覆盖。
      assert.equal(summary.requests, chain.requests, '请求块数应与脚本一致')
      assert.equal(summary.tests, chain.requests, '每个请求块都应带一条 client.test')
      // 反向自证：这里必须真的拿到过判定结果，而不是 0 条 test 也算通过。
      const names = summary.reports.flatMap((report) => report.tests.map((test) => test.name))
      assert.equal(names.length, chain.requests)
      assert.ok(
        names.every((name) => typeof name === 'string' && name.trim() !== ''),
        '每条 test 都要有名字，否则失败的到底是哪一段无从定位',
      )
    })
  }

  it('三处装配缺一不可：状态投影、面板扁平路由、账号服务', async () => {
    // 这三条正是组 5 曾经红过的三个入口；漏掉任一装配就会退回 503 / 404 / 400。
    const status = await fetch(base + '/dsh-bazaar/providers/workbuddy/status?sessionId=bce4b8-api')
    const statusBody = await status.json()
    assert.equal(status.status, 200, '状态投影应由真实 createProviderStatus 应答')
    assert.equal(typeof statusBody.cache.dir, 'string', '缓存目录必须回显')

    const experts = await fetch(
      base + '/dsh-bazaar/experts?provider=workbuddy&sessionId=bce4b8-api',
    )
    assert.equal(experts.status, 200, '面板扁平路由必须挂上（否则 404）')
    const expertsBody = await experts.json()
    assert.equal(Array.isArray(expertsBody.groups), true)

    const action = await fetch(base + '/dsh-bazaar/providers/workbuddy/accounts/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'workbuddy', action: 'list' }),
    })
    assert.equal(action.status, 200, '账号动作必须落到真实账号服务（否则 400 AUTH_MISSING）')
    const actionBody = await action.json()
    assert.equal(Array.isArray(actionBody.all), true, '账号列表应回真实账号库的条目')

    // 反向控制：路由真的在判定，而不是对任何路径都回 200。
    const ghost = await fetch(
      base + '/dsh-bazaar/providers/bce4b8-ghost/status?sessionId=bce4b8-api',
    )
    assert.ok(ghost.status >= 400, '未知 provider 必须被拒，实际 ' + ghost.status)
  })

  it('反向控制 1：脚本里塞一条必然失败的断言，结论必须变红', async () => {
    const source = await readFile(CHAINS[0].file, 'utf8')
    const tampered = path.join(scratch, 'tampered.http')
    await writeFile(
      tampered,
      source +
        [
          '',
          '### 反向控制：这条断言必然失败（不放进仓里，只在用例里生成）',
          '# @name reverseControlFails',
          'GET {{BASE_URL}}/dsh-bazaar/providers?sessionId=bce4b8-api',
          '',
          '> {%',
          '    client.test("反向控制必须失败", function() {',
          '        client.assert(false, "反向控制：这条断言必须被计成失败");',
          '    });',
          '%}',
          '',
        ].join('\n'),
    )
    const summary = await runScript(tampered)
    assert.equal(summary.failures, 1, '失败必须被计数（否则"全绿"没有意义）')
    assert.equal(summary.requests, CHAINS[0].requests + 1, '真实脚本的 11 块仍应照跑')
  })

  it('反向控制 2：请求块被跳过时请求数对不上，"零失败"不能说成通过', async () => {
    const source = await readFile(CHAINS[0].file, 'utf8')
    const truncated = path.join(scratch, 'truncated.http')
    // 整块消失（改脚本时误删一块）不会产生任何失败断言，只会让覆盖悄悄变少——
    // 所以"failed=0"必须和"请求块数"一起对账，单看失败数是查不出来的。
    const parts = source.split('\n###')
    await writeFile(truncated, parts.slice(0, -1).join('\n###'))
    const summary = await runScript(truncated)
    assert.equal(summary.failures, 0, '缺一块也不会产生失败断言——正因如此才需要对账')
    assert.equal(summary.requests, CHAINS[0].requests - 1, '少一块就少一个请求')
    assert.notEqual(summary.requests, CHAINS[0].requests, '请求数必须与脚本块数对账')
  })
})

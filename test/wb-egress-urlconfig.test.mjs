/**
 * 4.6/4.7：出网地址校验下沉到 provider 级 + 登录到出网鉴权五跳链路。
 *
 * 这里钉住两件事：
 *   1. 登录三段式（start / poll / refresh）与在线市场、公开快照、技能下载一样，
 *      在发请求之前经同一个 assertAllowedUrl，传的是本 provider 的 urlConfig；
 *      越界 host、非 HTTPS、userinfo 一律 BAZAAR_* 码且不发出请求。
 *   2. 从发起登录 → 轮询成功 → 落库 → 凭据可用 → 出网带鉴权头是一条可逐字段
 *      验证的链路；任一环失败不让后续呈现成功。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { AuthError, assertAllowedUrl, resolveAuth } from '../lib/auth.js'
import { createAccountStore } from '../lib/wb-vault.js'
import { createAccountService } from '../lib/wb-accounts.js'
import { collectAccount, pollLogin, refreshCredential, startLogin } from '../lib/wb-login.js'
import { WorkBuddyConnector } from '../lib/connector.js'
import { tempDir } from './temp.mjs'

const ALLOW = ['www.codebuddy.cn', 'www.codebuddy.ai']

function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const record = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} }
    calls.push(record)
    const answer = await handler(record)
    if (answer instanceof Error) throw answer
    const payload =
      typeof answer?.body === 'string' ? answer.body : JSON.stringify(answer?.body ?? {})
    return new Response(payload, {
      status: answer?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

const SIGNED_IN = () => ({
  body: {
    code: 0,
    data: {
      state: 'state-ok',
      authUrl: 'https://www.codebuddy.cn/login?state=state-ok',
      uid: 'uid-ok',
      accessToken: 'tok-ok',
      refreshToken: 'ref-ok',
      expiresIn: 3600,
      domain: 'www.codebuddy.cn',
    },
  },
})

// ---------------------------------------------------------------------------
// A. 四个出网入口都经同一份 assertAllowedUrl（越界 host / 非 HTTPS / userinfo）
// ---------------------------------------------------------------------------

test('startLogin rejects an out-of-list host before any request (BAZAAR_HOST_DENIED)', async () => {
  const fetchImpl = makeFetch(SIGNED_IN)
  const started = await startLogin('cn', {
    base: 'https://evil.example',
    urlConfig: { allowHosts: ALLOW },
    fetchImpl,
  })
  assert.equal(started.code, 'BAZAAR_HOST_DENIED')
  assert.equal(fetchImpl.calls.length, 0)

  // 比对：白名单内同形状请求正常出网。
  const good = makeFetch(SIGNED_IN)
  const ok = await startLogin('cn', { urlConfig: { allowHosts: ALLOW }, fetchImpl: good })
  assert.equal(ok.state, 'state-ok')
  assert.equal(good.calls.length, 1)
})

test('startLogin rejects a non-HTTPS base with BAZAAR_URL_INSECURE (loopback off)', async () => {
  const fetchImpl = makeFetch(SIGNED_IN)
  const started = await startLogin('cn', {
    base: 'http://www.codebuddy.cn',
    urlConfig: { allowHosts: ALLOW, allowInsecureLoopback: false },
    fetchImpl,
  })
  assert.equal(started.code, 'BAZAAR_URL_INSECURE')
  assert.equal(fetchImpl.calls.length, 0)
})

test('pollLogin rejects an out-of-list session base with BAZAAR_HOST_DENIED', async () => {
  const fetchImpl = makeFetch(SIGNED_IN)
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://evil.example', state: 's', expiresAtMs: Date.now() + 60_000 },
    { urlConfig: { allowHosts: ALLOW }, fetchImpl },
  )
  assert.equal(outcome.done, true)
  assert.equal(outcome.code, 'BAZAAR_HOST_DENIED')
  assert.equal(fetchImpl.calls.length, 0)
})

test('refreshCredential rejects an out-of-list base with BAZAAR_HOST_DENIED', async () => {
  const fetchImpl = makeFetch(SIGNED_IN)
  await assert.rejects(
    () =>
      refreshCredential({
        credential: {
          refreshToken: 'ref',
          base: 'https://evil.example',
          domain: 'www.codebuddy.cn',
        },
        urlConfig: { allowHosts: ALLOW },
        fetchImpl,
      }),
    (error) => error instanceof AuthError && error.code === 'BAZAAR_HOST_DENIED',
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('collectAccount rejects a userinfo-bearing base before any profile request', async () => {
  const fetchImpl = makeFetch(SIGNED_IN)
  await assert.rejects(
    () =>
      collectAccount({
        base: 'https://user:pass@www.codebuddy.cn',
        accessToken: 'tok-ok',
        urlConfig: { allowHosts: ALLOW },
        fetchImpl,
      }),
    (error) => error instanceof AuthError && error.code === 'BAZAAR_URL_USERINFO',
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('loopback exception is per-provider: only allowInsecureLoopback=true lets it through', async () => {
  const fetchImpl = makeFetch(SIGNED_IN)
  const denied = await startLogin('cn', {
    base: 'http://127.0.0.1:39320',
    urlConfig: { allowHosts: [...ALLOW, '127.0.0.1'], allowInsecureLoopback: false },
    fetchImpl,
  })
  assert.equal(denied.code, 'BAZAAR_URL_INSECURE')
  assert.equal(fetchImpl.calls.length, 0)

  const allowed = makeFetch(SIGNED_IN)
  const ok = await startLogin('cn', {
    base: 'http://127.0.0.1:39320',
    urlConfig: { allowHosts: [...ALLOW, '127.0.0.1'], allowInsecureLoopback: true },
    fetchImpl: allowed,
  })
  assert.equal(ok.state, 'state-ok')
  assert.equal(allowed.calls.length, 1)
})

test('assertAllowedUrl stays the single decision point for the other two entry points', () => {
  // 市场与快照的调用点在各自文件里；这里钉住判定函数本身对四类输入的码，
  // 保证 provider 注入同一份 config 时判定一致。
  const config = { allowHosts: ALLOW, allowInsecureLoopback: false }
  const codeOf = (raw) => {
    try {
      assertAllowedUrl(raw, config)
      return 'ok'
    } catch (error) {
      return error.code
    }
  }
  assert.equal(codeOf('https://www.codebuddy.cn/a'), 'ok')
  assert.equal(codeOf('https://evil.example/a'), 'BAZAAR_HOST_DENIED')
  assert.equal(codeOf('http://www.codebuddy.cn/a'), 'BAZAAR_URL_INSECURE')
  assert.equal(codeOf('https://u:p@www.codebuddy.cn/a'), 'BAZAAR_URL_USERINFO')
  assert.equal(codeOf('not a url'), 'BAZAAR_URL_INVALID')
})

// ---------------------------------------------------------------------------
// B. 五跳链路：发起 → 轮询 → 落库 → 凭据可用 → 出网带鉴权头
// ---------------------------------------------------------------------------

test('full chain: login -> poll -> persist -> credentials -> authenticated egress', async () => {
  const dir = await makeTempDir()
  const store = createAccountStore({ dir })
  const authFetch = makeFetch(SIGNED_IN)
  const connector = new WorkBuddyConnector({
    accounts: store,
    urlConfig: { allowHosts: ALLOW },
    fetchImpl: authFetch,
  })
  const accounts = createAccountService({
    connector,
    urlConfig: { allowHosts: ALLOW },
    fetchImpl: authFetch,
  })

  // 跳 1：发起登录（真实出网到白名单内 host）。
  const started = await accounts.start('cn')
  assert.equal(started.code, undefined)
  assert.match(started.loginId, /^bz_/)
  assert.equal(started.region, 'cn')
  assert.equal(authFetch.calls.length, 1)
  assert.equal(authFetch.calls[0].url.startsWith('https://www.codebuddy.cn'), true)

  // 跳 2：轮询拿到 token。
  const polled = await accounts.poll(started.loginId)
  assert.equal(polled.done, true)
  assert.equal(polled.account.uid !== undefined, true)

  // 跳 3：poll 内部已立刻落盘——换一个全新 store 读同一目录也应看到账号。
  const reloaded = createAccountStore({ dir })
  const listed = await reloaded.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].hasToken, true)
  // 脱敏视图绝不回明文 token。
  assert.equal(JSON.stringify(listed).includes('tok-ok'), false)

  // 跳 4：凭据经宿主凭据服务之外的本 provider 账号库解析（auto 模式）。
  const hit = await connector.resolveToken({ region: 'cn' })
  assert.equal(hit?.token, 'tok-ok')

  // 跳 5：出网请求带上鉴权头，host 在白名单内。
  const header = await resolveAuth(
    { mode: 'auto', connectorRegion: 'cn', allowHosts: ALLOW },
    { connector },
  )
  assert.equal(header.header, 'Authorization')
  assert.equal(header.value, 'Bearer tok-ok')
})

test('full chain stops at persist failure: poll does not present a stored account', async () => {
  const dir = await makeTempDir()
  const store = createAccountStore({ dir })
  // 让 saveAccount 抛错：模拟落盘失败。
  const connector = new WorkBuddyConnector({ accounts: store, urlConfig: { allowHosts: ALLOW } })
  connector.saveAccount = async () => {
    throw new Error('disk full')
  }
  const accounts = createAccountService({
    connector,
    urlConfig: { allowHosts: ALLOW },
    fetchImpl: makeFetch(SIGNED_IN),
  })
  const started = await accounts.start('cn')
  const polled = await accounts.poll(started.loginId)
  assert.equal(polled.done, true)
  assert.match(polled.error, /could not be stored/)
  assert.equal(polled.account, undefined)
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function makeTempDir() {
  return tempDir('bazaar-egress-')
}

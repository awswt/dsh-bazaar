/**
 * 旧名残留扫描（任务 1.7）。
 *
 * 为什么要有这条用例：改名是一次性动作，但「从源仓再搬一个模块进来」是长期动作。
 * 没有扫描，旧标识会在下一次搬运时悄悄回流；等到有人按旧名注册路由才发现，代价是线上。
 * 所以判定面 = 代码与仓根配置/文档；允许面 = 上游真实事实（改了就接不上真服务）。
 *
 * 纪律：旧名字面量一律由片段拼装，本文件因此不含任何旧名——它自己也在扫描面内。
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const join = function (...parts) {
  return parts.join('')
}

/** 禁止残留的旧标识：包名、工具名、命令/路由/目录 id、错误码前缀、凭据名、e2e 环境变量、CSS 前缀、登录 id 前缀。 */
export const FORBIDDEN = [
  { label: '旧包名', token: join('dsh-', 'workbuddy', '-helper') },
  { label: '旧模型工具名', token: join('workbuddy', '_', 'helper') },
  {
    label: '旧命令名/路由前缀/设置项与入口 id/旧数据目录/bundle 元文件名',
    token: join('workbuddy', '-helper'),
  },
  { label: '旧错误码前缀', token: join('WORKBUDDY', '_', 'HELPER', '_') },
  { label: '旧凭据名', token: join('WB_', 'EXPERT_TOKEN') },
  { label: '旧 e2e 环境变量', token: join('WBH', '_LIB_ROOT') },
  { label: '旧 CSS 前缀', token: join('wb', 'h-') },
  { label: '旧登录 id 前缀', token: join('wb', 'h_') },
  // 旧军械库桥接取值：开发规范（本地 AGENTS.md 坑位 4）说「任何该取值都是回归」，那就必须由扫描面兜住，
  // 否则这句话只是一句口号——真正删除它的人可能是下一次从源仓搬代码进来的人（q5-004）。
  { label: '旧军械库桥接取值', token: join('remote', '.', 'mcpManager') },
]

/**
 * 允许出现的事实：providerId 与其推导名、上游域名、桌面端插件目录。
 * 这些是上游真实存在的名字，重命名它们等于把插件与上游断开。
 */
export const ALLOWED_FACTS = [
  join('workbuddy'),
  join('www.workbuddy.cn'),
  join('www.workbuddy.ai'),
  join('www.codebuddy.cn'),
  join('www.codebuddy.ai'),
  join('openplatform-cdn.codebuddy.cn'),
  join('.workbuddy-plugin'),
  join('.codebuddy-plugin'),
  join('BAZAAR_', 'WORKBUDDY_TOKEN'),
  join('providers/workbuddy'),
]

/**
 * 扫描面：搬来的实现 + 本组新建的脚本与用例 + 契约样例 + 仓根配置与文档。
 *
 * examples/ 进扫描面是刻意的：它不随包发布（package.json 的 files 不含 examples），
 * 但它是「照抄这个文件就能接进来」的活样例，样例里带旧名等于把旧名教给下一个 provider 作者。
 * CHANGELOG 是迁移记录，按设计点名旧名，不在扫描面。
 */
const SCAN_DIRS = ['lib', 'scripts', 'test', 'examples']
const SCAN_ROOT_FILES = [
  'README.md',
  'AGENTS.md',
  'DESIGN.md',
  'package.json',
  'cordis.patch.yml',
  '.gitignore',
  '.prettierignore',
  'eslint.config.js',
]
/**
 * 非仓根、但同样不许带旧名的文档：契约手册要按新名描述契约（组 2 交付物）。
 * docs/e2e-baseline.md 是组 5 才重写的旧基线，此刻仍满是旧名，故不入面。
 */
const SCAN_EXTRA_FILES = ['docs/provider-integration.md']

/** 在 text 里找禁止 token，返回命中列表（token 字面量只出现在返回值里，不出现在源码里）。 */
export function findForbidden(text) {
  const hits = []
  for (const entry of FORBIDDEN) {
    let at = text.indexOf(entry.token)
    while (at !== -1) {
      hits.push({ label: entry.label, token: entry.token, at })
      at = text.indexOf(entry.token, at + entry.token.length)
    }
  }
  return hits
}

/**
 * 递归收集扫描面。组 2 起实现是分层的（lib/provider/、lib/providers/<id>/），
 * 只扫一层的版本会「扫过目录、没扫到文件」——零命中变成假绿灯，比不扫更危险。
 */
function collect(dir, out) {
  const abs = path.join(root, dir)
  if (!existsSync(abs)) return out
  const entries = readdirSync(abs, { withFileTypes: true }).sort(function (a, b) {
    return a.name.localeCompare(b.name)
  })
  for (const entry of entries) {
    const rel = path.posix.join(dir.split(path.sep).join('/'), entry.name)
    if (entry.isDirectory()) {
      collect(rel, out)
      continue
    }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue
    out.push(rel)
  }
  return out
}

function collectFiles() {
  const out = SCAN_DIRS.reduce(function (acc, dir) {
    return collect(dir, acc)
  }, [])
  for (const rel of [...SCAN_ROOT_FILES, ...SCAN_EXTRA_FILES]) {
    const abs = path.join(root, rel)
    if (existsSync(abs) && statSync(abs).isFile()) out.push(rel)
  }
  return out
}

test('no legacy identity survives in lib/, scripts/, test/ or the root config docs', () => {
  const files = collectFiles()
  const offenders = []
  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), 'utf8')
    for (const hit of findForbidden(text)) {
      const line = text.slice(0, hit.at).split('\n').length
      offenders.push(rel + ':' + line + ' ' + hit.label)
    }
  }
  assert.deepEqual(offenders, [], 'legacy identifiers still present:\n' + offenders.join('\n'))
  // 扫描面必须真的覆盖到实现目录，否则"零命中"只是因为什么都没扫。
  assert.ok(
    files.length >= 80,
    'expected the scan surface to cover the shipped sources, got ' + files.length,
  )
  // 总数够不等于扫对了地方：两个深路径是「递归真的生效」的正面证据。
  for (const deep of ['lib/provider/contract.js', 'examples/minimal-provider/index.mjs']) {
    assert.ok(files.includes(deep), 'the scan surface must reach ' + deep)
  }
})

test('the scan is not vacuous: every forbidden identity is actually caught', () => {
  for (const entry of FORBIDDEN) {
    const sample = 'const route = /' + entry.token + '/state'
    const hits = findForbidden(sample)
    assert.ok(hits.length > 0, 'the scanner must flag ' + entry.label)
    assert.equal(hits[0].label, entry.label)
  }
})

test('the armory bridge read is caught on the real client (reverse control)', () => {
  // 这条反向控制必须落在真文件上：只喂 fixture 证明不了「这棵树现在是干净的」，
  // 只断言干净又证明不了「扫描器真的会红」。两半都要，缺一半就是假绿灯。
  const rel = path.posix.join('lib', 'client.js')
  const clean = readFileSync(path.join(root, rel), 'utf8')
  const armory = FORBIDDEN.find(function (entry) {
    return entry.label === '旧军械库桥接取值'
  })
  assert.ok(armory !== undefined, 'the armory bridge entry must stay registered in FORBIDDEN')
  assert.deepEqual(findForbidden(clean), [], rel + ' must not read the armory bridge')

  // 把探测行追加到真文本上（token 运行时取值，本文件源码因此不含旧名）。
  const probe = '\nconst armory = ctx.get(' + JSON.stringify(armory.token) + ')\n'
  const combined = clean + probe
  const hits = findForbidden(combined)
  assert.equal(hits.length, 1, 'appending an armory read must turn the scan red')
  assert.equal(hits[0].label, '旧军械库桥接取值')
  const line = combined.slice(0, hits[0].at).split('\n').length
  assert.ok(
    line > clean.split('\n').length,
    'the only hit must land on the appended probe line, got line ' + line,
  )
  // 还原面：同一份原文再扫一次仍然零命中。
  assert.deepEqual(findForbidden(clean), [], rel + ' must be clean again once the probe is gone')
})

test('the allowed upstream facts are never reported (reverse assertion)', () => {
  const fixture = [
    "const PROVIDER_ID = '" + ALLOWED_FACTS[0] + "'",
    "const portal = 'https://" + ALLOWED_FACTS[1] + "/portal'",
    "const cdn = '" + ALLOWED_FACTS[4] + "'",
    "const dirs = ['" + ALLOWED_FACTS[6] + "', '" + ALLOWED_FACTS[7] + "']",
    "const ref = '" + ALLOWED_FACTS[8] + "'",
    "const data = 'providers/" + ALLOWED_FACTS[0] + "/vault'",
  ].join('\n')
  assert.deepEqual(
    findForbidden(fixture),
    [],
    'upstream facts must not be mistaken for legacy identities',
  )
  // 反向断言的另一半：这些事实确实还在仓里（改名没把上游常量一起改掉）。
  const indexText = readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  assert.match(indexText, new RegExp('www\\.' + ALLOWED_FACTS[0] + '\\.cn'))
  const bundleText = readFileSync(path.join(root, 'lib', 'bundle.js'), 'utf8')
  assert.match(bundleText, /\.workbuddy-plugin|\.codebuddy-plugin/)
})

test('obsolete docs/ material is gone and docs/ keeps only the live baseline', () => {
  const removed = [
    'INSTALLATION-AND-TEST-REPORT.md',
    'connector-upgrade-test-report.md',
    join('dsh-', 'workbuddy', '-helper-design.md'),
    'workbuddy-connector-reverse-engineering.md',
    'workbuddy-own-login.md',
    'ui-13-assistant-panel.png',
    'ui-14-connector-market.png',
    'ui-15-skill-market.png',
    'ui-16-armory-market.png',
    'ui-17-skill-markets.png',
  ]
  const dir = path.join(root, 'docs')
  const present = existsSync(dir) ? readdirSync(dir) : []
  for (const name of removed) {
    assert.ok(!present.includes(name), 'docs/' + name + ' should have been deleted in 1.7')
  }
  // 目录一致性：docs/ 下不该出现任何"报告/截图/旧设计文档"形态的残留文件。
  const stale = present.filter(function (name) {
    return (
      name.endsWith('.png') || /-report|-REPORT|reverse-engineering|own-login|design\.md/.test(name)
    )
  })
  assert.deepEqual(stale, [], 'unexpected leftovers in docs/: ' + stale.join(', '))
  assert.ok(
    present.includes('e2e-baseline.md'),
    'docs/e2e-baseline.md stays until group 5 rewrites it',
  )
})

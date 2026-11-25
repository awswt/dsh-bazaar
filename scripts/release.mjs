#!/usr/bin/env node
/**
 * 一次改动 = 一个版本 + 一份可下载的 release 产物。
 *
 *   node scripts/release.mjs                  # patch（0.6.16 → 0.6.17）
 *   node scripts/release.mjs --minor          # 0.6.16 → 0.7.0
 *   node scripts/release.mjs --major
 *   node scripts/release.mjs --dry-run        # 只打印将要发生什么
 *   node scripts/release.mjs --no-push        # 本地提交 + 打 tag，不推
 *   node scripts/release.mjs --no-artifacts   # 跳过 npm pack（离线/调试）
 *   node scripts/release.mjs --no-github      # 本地提交/tag/push，但不发 GitHub Release
 *   node scripts/release.mjs -m "feat: xxx" -w "新增：设置页登录入口" -w "修复：xxx"
 *
 * 流程：测试 → bump → **构建 release 产物** → commit → tag → push → **发 GitHub Release 并上传 tgz**。
 *
 * 为什么先跑测试再 bump：版本号是"这份代码可信"的唯一信号，测试挂了就不该有新版本号，
 * 否则别人装到的是带 bug 的版本，只会让人怀疑"是不是又没装新代码"。
 *
 * 为什么不能只打 tag：tag 指向一个 commit，别人没法直接装。真正能装的是 npm pack 出来的
 * tarball —— 所以每次发布都在 `release/vX.Y.Z/` 产一份 tgz + SHA256SUMS，
 * 并把给人看的说明写进仓库里的 `docs/releases/vX.Y.Z.md`（那份会跟着 commit 走）。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createRunner, forward, npmInvocation, tapPassCount } from './spawn-util.mjs'

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const packagePath = path.join(root, 'package.json')
const releaseRoot = path.join(root, 'release')
const notesDir = path.join(root, 'docs', 'releases')

/** 子进程一律"捕获后经 stdout 转发"，见 scripts/spawn-util.mjs 里的长注释。 */
const run = createRunner(root)

function parseArgs(argv) {
  const options = { bump: 'patch', dryRun: false, push: true, artifacts: true, github: true, message: null, what: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-push') options.push = false
    else if (arg === '--no-artifacts') options.artifacts = false
    else if (arg === '--no-github') options.github = false
    else if (arg === '--minor') options.bump = 'minor'
    else if (arg === '--major') options.bump = 'major'
    else if (arg === '--patch') options.bump = 'patch'
    else if (arg === '-m' || arg === '--message') {
      options.message = argv[index + 1] ?? null
      index += 1
    } else if (arg === '-w' || arg === '--what') {
      const line = argv[index + 1]
      if (line === undefined || line === '') throw new Error('--what needs a line of text')
      options.what.push(line)
      index += 1
    } else if (arg === '-h' || arg === '--help') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(version).trim())
  if (match === null) throw new Error(`not a semver version: ${version}`)
  const [, major, minor, patch] = match
  if (kind === 'major') return `${Number(major) + 1}.0.0`
  if (kind === 'minor') return `${major}.${Number(minor) + 1}.0`
  return `${major}.${minor}.${Number(patch) + 1}`
}

async function testFiles() {
  const entries = await readdir(path.join(root, 'test'))
  return entries
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join('test', name))
}

/** 上一个 release tag；没有就返回 null（首次发布不该因为 `git describe` 报错而中断）。 */
function previousTag() {
  const result = spawnSync('git', ['describe', '--tags', '--abbrev=0'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  return String(result.stdout ?? '').trim() || null
}

function commitsSince(tag) {
  const args = tag === null ? ['log', '--oneline', '-20'] : ['log', '--oneline', `${tag}..HEAD`]
  const output = run('git', args, { capture: true })
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

function changedFiles() {
  const output = run('git', ['status', '--porcelain'], { capture: true })
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** 只有本包的 tgz 是对外产物；别把 npm pack 顺带打出来的日志当文件。 */
async function packTarball(version, outDir) {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const pack = npmInvocation(['pack', '--pack-destination', outDir, '--json'])
  const output = run(pack.command, pack.args, { capture: true })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  const filename = entry?.filename
  if (typeof filename !== 'string' || filename === '') {
    throw new Error(`npm pack did not report a filename: ${output.slice(0, 400)}`)
  }
  const file = path.join(outDir, path.basename(filename))
  const info = await stat(file)
  const bytes = await readFile(file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (!path.basename(file).includes(version)) {
    // 版本号不对说明 bump 没落到 package.json 上，产物名字会是旧的——那发布出去就是错的包。
    throw new Error(`packed ${path.basename(file)} but expected version ${version} in the name`)
  }
  return { file, name: path.basename(file), bytes: info.size, sha256: digest }
}

function renderNotes({ version, previous, artifact, testCount, testFilesCount, commits, changes, message, what }) {
  const lines = []
  lines.push(`# v${version}`)
  lines.push('')
  lines.push(`- 发布版本：\`v${version}\``)
  if (previous !== null) lines.push(`- 上一个版本：\`${previous}\``)
  lines.push(`- 提交说明：${message}`)
  lines.push(`- 测试：${testCount ?? '?'} 条通过（${testFilesCount} 个测试文件）`)
  lines.push('')
  // 变更日志的正文。提交说明是一句话，版本日志要能回答"这版多了什么、修了什么"——
  // 所以允许 --what 逐条传，每条写一行；没传就退化成从 changes 里能看出的东西。
  const entries = Array.isArray(what) ? what.filter(line => typeof line === 'string' && line.trim() !== '') : []
  if (entries.length > 0) {
    lines.push('## 本次新增与修复')
    lines.push('')
    for (const line of entries) lines.push(`- ${line}`)
    lines.push('')
  }
  if (artifact !== null) {
    lines.push('## 安装包')
    lines.push('')
    lines.push('```text')
    lines.push(`release/v${version}/${artifact.name}`)
    lines.push(`sha256  ${artifact.sha256}`)
    lines.push(`bytes   ${artifact.bytes}`)
    lines.push('```')
    lines.push('')
    lines.push('安装：')
    lines.push('')
    lines.push('```bash')
    lines.push(`dsh plugin --profile <profile> add /absolute/path/to/${artifact.name}`)
    lines.push('```')
    lines.push('')
  }
  if (changes.length > 0) {
    lines.push('## 本次改动的文件')
    lines.push('')
    lines.push('```text')
    for (const line of changes) lines.push(line)
    lines.push('```')
    lines.push('')
  }
  if (commits.length > 0) {
    lines.push(`## ${previous === null ? '最近提交' : `${previous} 之后的提交`}`)
    lines.push('')
    for (const line of commits) lines.push(`- ${line}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/**
 * GitHub token 只从环境变量或 git credential 动态读取——绝不写进源码、文档、日志或 commit。
 * 用 git credential fill 注入 stdin，避免 token 出现在命令行（`ps` 可见）。
 */
function githubToken() {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const input = 'protocol=https\nhost=github.com\n\n'
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  const line = String(result.stdout ?? '')
    .split('\n')
    .map(item => item.trim())
    .find(item => item.startsWith('password='))
  if (line === undefined) return null
  const token = line.slice('password='.length).trim()
  return token !== '' ? token : null
}

/** 出网一律 https + 固定 host，URL 由代码拼，不接受外部输入，避免出网闸门被绕过。 */
const GITHUB_API = 'https://api.github.com'
const GITHUB_REPO = 'awswt/dsh-bazaar'

async function githubRequest(url, { method = 'GET', token, headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-bazaar-release',
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${method} ${url} failed (${response.status}): ${text.slice(0, 600)}`)
  return text === '' ? null : JSON.parse(text)
}

/** 创建 GitHub Release 并上传 tgz；返回 html_url 供日志核对。 */
async function publishGithubRelease({ tag, notes, artifact, token }) {
  const release = await githubRequest(`${GITHUB_API}/repos/${GITHUB_REPO}/releases`, {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: notes,
      draft: false,
      prerelease: false,
    }),
  })
  if (artifact !== null) {
    const bytes = await readFile(artifact.file)
    const uploadUrl = String(release?.upload_url ?? '').replace(/\\{\\?.*$/, '')
    await githubRequest(`${uploadUrl}?name=${encodeURIComponent(artifact.name)}`, {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/gzip' },
      body: bytes,
    })
  }
  return release?.html_url ?? `${GITHUB_API}/repos/${GITHUB_REPO}/releases/tags/${tag}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('usage: node scripts/release.mjs [--patch|--minor|--major] [--dry-run] [--no-push] [--no-artifacts] [--no-github] [-m message] [-w "one change line" ...]')
    return
  }

  const raw = await readFile(packagePath, 'utf8')
  const manifest = JSON.parse(raw)
  const nextVersion = bumpVersion(manifest.version, options.bump)
  const files = await testFiles()
  if (files.length === 0) throw new Error('no test/*.test.mjs found — refusing to release untested code')

  const tag = `v${nextVersion}`
  console.log(`release ${manifest.version} -> ${nextVersion} (${options.bump}), ${files.length} test files`)
  if (options.dryRun) {
    console.log('dry run: would run tests, write package.json, build release/, commit, tag and push')
    console.log(`dry run: artifacts would land in release/${tag}/ and docs/releases/${tag}.md`)
    return
  }

  console.log('\n[1/7] tests')
  const tap = run(process.execPath, ['--test', ...files], { capture: true })
  forward(tap)
  const testCount = tapPassCount(tap)
  if (testCount === null) throw new Error('could not read the test count out of the TAP output — refusing to release blind')

  console.log('\n[2/7] bump version')
  // 只替换 version 这一行，保留原有缩进与字段顺序，diff 里不该出现大面积噪声。
  const nextRaw = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${nextVersion}$2`)
  if (nextRaw === raw) throw new Error('could not locate "version" in package.json')
  await writeFile(packagePath, nextRaw, 'utf8')

  const previous = previousTag()
  const commits = commitsSince(previous)
  const changes = changedFiles()
  const message = options.message ?? `chore(release): ${tag}`

  let artifact = null
  if (options.artifacts === true) {
    console.log('\n[3/7] build release artifacts')
    artifact = await packTarball(nextVersion, path.join(releaseRoot, tag))
    console.log(`  ${artifact.name}  ${artifact.bytes} bytes`)
    console.log(`  sha256 ${artifact.sha256}`)
  } else {
    console.log('\n[3/7] build release artifacts — skipped (--no-artifacts)')
  }

  const notes = renderNotes({
    version: nextVersion, previous, artifact, testCount,
    testFilesCount: files.length, commits, changes, message, what: options.what,
  })
  await mkdir(notesDir, { recursive: true })
  const notesPath = path.join(notesDir, `${tag}.md`)
  await writeFile(notesPath, notes, 'utf8')
  console.log(`  notes  docs/releases/${tag}.md`)

  console.log('\n[4/7] commit')
  run('git', ['add', '-A'])
  const staged = run('git', ['diff', '--cached', '--name-only'], { capture: true }).trim()
  if (staged === '') {
    console.log('nothing staged — reverting version and stopping')
    await writeFile(packagePath, raw, 'utf8')
    return
  }
  run('git', ['commit', '-m', message])

  console.log('\n[5/7] tag')
  // -a 而不是轻量 tag：注释里放 release 说明，`git show vX.Y.Z` 就能看到这次发了什么。
  run('git', ['tag', '-a', tag, '-F', path.join('docs', 'releases', `${tag}.md`)])
  console.log(`  ${tag}`)

  if (options.push !== true) {
    console.log('\n[6/7] push — skipped (--no-push)')
    forward('\n[7/7] GitHub Release — skipped (tag not pushed)\n')
    console.log(`\nreleased ${tag} locally (not pushed)`)
    return
  }
  console.log('\n[6/7] push')
  run('git', ['push', 'origin', 'HEAD'])
  // tag 单独推：HEAD 成功而 tag 冲突时，至少要让人看到是 tag 这一步失败，而不是整体静默。
  run('git', ['push', 'origin', tag])

  let releaseUrl = null
  if (options.github === true) {
    forward('\n[7/7] GitHub Release\n')
    const token = githubToken()
    if (token === null) throw new Error('no GitHub token: set GITHUB_TOKEN/GH_TOKEN or configure git credential')
    releaseUrl = await publishGithubRelease({ tag, notes, artifact, token })
    forward(`  ${releaseUrl}\n`)
    // 发完立刻核对 latest：脚本自己先确认，不能等用户去网页上发现发错版本。
    const latest = await githubRequest(`${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`, { token })
    if (latest?.tag_name !== tag) {
      throw new Error(`GitHub latest is ${latest?.tag_name ?? '(none)'}, expected ${tag}`)
    }
    forward(`  verified latest = ${latest.tag_name}\n`)
  } else {
    forward('\n[7/7] GitHub Release — skipped (--no-github)\n')
  }

  console.log(`\nreleased ${tag}`)
  console.log('\n--- release info ---')
  console.log(`version   ${tag}${previous === null ? '' : `  (previous ${previous})`}`)
  console.log(`tests     ${testCount} passed in ${files.length} files`)
  if (artifact !== null) {
    console.log(`tarball   release/${tag}/${artifact.name}  (${artifact.bytes} bytes)`)
    console.log(`sha256    ${artifact.sha256}`)
  } else {
    console.log('tarball   (not built: --no-artifacts)')
  }
  console.log(`notes     docs/releases/${tag}.md`)
  console.log(`tag       ${tag} (annotated)`)
  console.log(`commit    ${message}`)
  if (releaseUrl !== null) forward(`release   ${releaseUrl}\n`)
  console.log('install   dsh plugin --profile <profile> add <path-to-tarball>')
}

// 只在被直接执行时跑发布；被 import（测试）时只暴露纯函数，否则一 import 就去 push。
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch(error => {
    console.error(`release failed: ${error?.message ?? error}`)
    process.exitCode = 1
  })
}

export { bumpVersion, parseArgs, renderNotes, run, forward, githubToken, publishGithubRelease }

/**
 * 插件自更新：查 GitHub 的 latest Release，把 tgz 下载下来、校验后覆盖当前安装副本。
 *
 * 为什么放在 lib/ 而不是 scripts/：这是运行时能力（设置页点「立即更新」触发），
 * 不是发布时的命令行步骤；release.mjs 只负责发，这里只负责收。两者各自读 token，
 * 不互相 import——scripts/ 不属于 lib/ 的依赖方向。
 *
 * 出网闸门：AGENTS.md 说所有 provider 出网走 assertAllowedUrl 的逐 provider allowHosts。
 * 但这里访问的是 GitHub 运维端点，不是任何 provider 的市场域名，塞进 workbuddy 的
 * allowHosts 只会污染那张表。因此这里单独把 URL **由代码写死**，并对下载来的 asset
 * 地址做 host 白名单校验——判定同样只有一处（assertAssetUrl），不许调用方传任意 URL。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { x as tarExtract } from 'tar'

const GITHUB_API = 'https://api.github.com'
const GITHUB_REPO = 'awswt/dsh-bazaar'
const ASSET_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'api.github.com'])
const DEFAULT_TIMEOUT_MS = 30000

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0。忽略 v 前缀与 prerelease 后缀。 */
export function compareVersions(left, right) {
  const parts = (value) =>
    String(value ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((piece) => Number(piece) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  return 0
}

/** release asset 的下载地址只能来自 GitHub 自己的域名，拒绝 URL 注入。 */
function assertAssetUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw))
  } catch {
    throw new Error('update asset URL is invalid')
  }
  if (parsed.protocol !== 'https:' || !ASSET_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`update asset host not allowed: ${parsed.hostname}`)
  }
  return parsed.toString()
}

/**
 * 运行时读 token：只认环境变量，绝不落盘、绝不进日志。
 * 公开仓库读 latest 不强制要 token；带上只是为了避开匿名限流。
 */
function runtimeToken() {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

export function createUpdateService(options = {}) {
  const ownDir = path.dirname(fileURLToPath(import.meta.url))
  // 默认更新「自己所在的包」：仓库开发与宿主安装两态共用一套逻辑，不猜 profile 路径。
  const packageRoot = options.packageRoot ?? path.dirname(ownDir)
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const token = options.token === undefined ? runtimeToken() : options.token
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-bazaar-updater',
    ...(token !== null && token !== undefined && token !== ''
      ? { Authorization: `Bearer ${token}` }
      : {}),
  }
  const headersOf = (extra) => ({ ...headers, ...(extra ?? {}) })
  let currentVersion = options.currentVersion ?? null

  async function readCurrentVersion() {
    if (currentVersion !== null) return currentVersion
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    currentVersion = String(manifest.version ?? '0.0.0')
    return currentVersion
  }

  async function check() {
    const version = await readCurrentVersion()
    const url = `${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`
    const response = await fetchImpl(url, {
      headers: headersOf(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`check update failed (${response.status})`)
    }
    const data = await response.json()
    const latestVersion = String(data?.tag_name ?? '').replace(/^v/i, '')
    const asset = (Array.isArray(data?.assets) ? data.assets : []).find((item) =>
      /\.tgz$/i.test(item?.name ?? ''),
    )
    return {
      currentVersion: version,
      latestVersion,
      updateAvailable: latestVersion !== '' && compareVersions(latestVersion, version) > 0,
      htmlUrl: data?.html_url ?? `${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`,
      assetUrl: asset?.browser_download_url ?? null,
      assetName: asset?.name ?? null,
      assetDigest: asset?.digest ?? null,
      publishedAt: data?.published_at ?? null,
      notes: typeof data?.body === 'string' ? data.body.slice(0, 2000) : null,
    }
  }

  async function install() {
    const info = await check()
    if (info.updateAvailable !== true) {
      return {
        ok: true,
        alreadyCurrent: true,
        version: info.currentVersion,
        message: '当前已是最新版本',
      }
    }
    if (info.assetUrl === null) throw new Error('latest release has no tgz asset')

    const response = await fetchImpl(assertAssetUrl(info.assetUrl), {
      headers: headersOf(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`download update failed (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const expected =
      typeof info.assetDigest === 'string' && info.assetDigest.startsWith('sha256:')
        ? info.assetDigest.slice('sha256:'.length)
        : null
    if (expected !== null) {
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('update asset sha256 mismatch — refusing to install')
      }
    }

    const parent = path.dirname(packageRoot)
    const stage = await mkdtemp(path.join(os.tmpdir(), 'dsh-bazaar-update-'))
    try {
      const archive = path.join(stage, 'package.tgz')
      const unpacked = path.join(stage, 'unpacked')
      await writeFile(archive, bytes)
      await mkdir(unpacked, { recursive: true })
      // npm pack 的产物顶层是 package/，strip:1 把这一层剥掉；tar.x 默认拒绝路径穿越。
      await tarExtract({ file: archive, cwd: unpacked, strip: 1 })
      // 先验证结构再动现网副本：解出来的不是本插件就立刻停手。
      await readFile(path.join(unpacked, 'package.json'), 'utf8')
      await readFile(path.join(unpacked, 'lib', 'index.js'), 'utf8')

      const backup = path.join(
        parent,
        `${path.basename(packageRoot)}.bak-${info.currentVersion}-${Date.now()}`,
      )
      await cp(packageRoot, backup, { recursive: true })
      // 逐文件覆盖而不是重命名目录：运行中的包目录可能仍被占用，重命名会失败。
      await cp(unpacked, packageRoot, { recursive: true, force: true })
      currentVersion = info.latestVersion
      options.logger?.info?.(`bazaar: updated to ${info.latestVersion}, backup at ${backup}`)
      return {
        ok: true,
        alreadyCurrent: false,
        version: info.latestVersion,
        backup,
        message: `已更新到 v${info.latestVersion}；请重启 DSH 生效。`,
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  return {
    check,
    install,
    compareVersions,
    get currentVersion() {
      return currentVersion
    },
  }
}

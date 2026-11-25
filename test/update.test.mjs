import assert from 'node:assert/strict'
import test from 'node:test'

import { compareVersions, createUpdateService } from '../lib/update.js'

test('compareVersions：v 前缀、prerelease 后缀、缺段都按语义处理', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('v1.2.0', '1.1.9'), 1)
  assert.equal(compareVersions('v2.0.0-beta.1', '1.9.9'), 1)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
})

function releaseWith(asset) {
  return {
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/awswt/dsh-bazaar/releases/tag/v9.9.9',
    published_at: '2026-01-01T00:00:00Z',
    body: 'notes',
    assets: [asset],
  }
}

test('check：从 latest release 解析版本与 tgz asset，并带上注入的 token', async () => {
  const calls = []
  const service = createUpdateService({
    currentVersion: '1.0.0',
    token: 'unit-test-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () =>
          releaseWith({
            name: 'other.zip',
            browser_download_url: 'https://github.com/x/other.zip',
          }),
      }
    },
  })
  const info = await service.check()
  assert.equal(info.latestVersion, '9.9.9')
  assert.equal(info.updateAvailable, true)
  assert.equal(info.assetUrl, null, '非 tgz asset 不能被选中')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.github.com/repos/awswt/dsh-bazaar/releases/latest')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer unit-test-token')
})

test('check：HTTP 失败抛可读错误，不返回伪成功', async () => {
  const service = createUpdateService({
    currentVersion: '1.0.0',
    token: null,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  })
  await assert.rejects(() => service.check(), /check update failed \(403\)/)
})

test('install：已是最新版本时只检查、不下载、不覆盖', async () => {
  let calls = 0
  const service = createUpdateService({
    currentVersion: '9.9.9',
    token: null,
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: async () =>
          releaseWith({
            name: 'dsh-bazaar-9.9.9.tgz',
            browser_download_url: 'https://github.com/x/a.tgz',
          }),
      }
    },
  })
  const result = await service.install()
  assert.equal(result.alreadyCurrent, true)
  assert.equal(calls, 1, '只有一次 check，没有下载请求')
})

test('install：拒绝非 GitHub 域名的 asset（URL 注入反向控制）', async () => {
  let calls = 0
  const service = createUpdateService({
    currentVersion: '1.0.0',
    token: null,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            releaseWith({
              name: 'evil.tgz',
              browser_download_url: 'https://evil.example.com/evil.tgz',
            }),
        }
      }
      throw new Error('should not download')
    },
  })
  await assert.rejects(() => service.install(), /update asset host not allowed/)
  assert.equal(calls, 1, 'assertAssetUrl 在下载前就拦截')
})

test('install：asset 摘要不符时拒绝安装（不落盘覆盖）', async () => {
  let calls = 0
  const service = createUpdateService({
    currentVersion: '1.0.0',
    token: null,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            releaseWith({
              name: 'dsh-bazaar-9.9.9.tgz',
              browser_download_url: 'https://github.com/x/dsh-bazaar-9.9.9.tgz',
              digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            }),
        }
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
    },
  })
  await assert.rejects(() => service.install(), /sha256 mismatch/)
  assert.equal(calls, 2)
})

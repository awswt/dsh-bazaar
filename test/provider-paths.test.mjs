/**
 * providerId 准入与目录拼装的用例（任务 2.2）。
 *
 * 覆盖 spec 的两个场景：含穿越片段/大写/超长/空串一律拒，合法 id 正常放行并落到
 * <base>/providers/<id>/；外加一条 spec 没写但同样关键的：注册被绕过时，拼装处仍是道墙。
 */

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PROVIDER_ID_PATTERN, validateContract } from '../lib/provider/contract.js'
import { CODES } from '../lib/provider/errors.js'
import {
  PROVIDERS_DIR_NAME,
  assertProviderId,
  providerDir,
  providersRoot,
  safeJoin,
} from '../lib/provider/paths.js'
import { tempDirSync } from './temp.mjs'

const fn = async function () {
  return {}
}
const fullContract = function (id) {
  return {
    apiVersion: 1,
    id,
    displayName: '示例专家库',
    capabilities: { expertMarket: true },
    impl: { expertMarket: { listExperts: fn, getExpert: fn } },
  }
}

test('非法 providerId 一律拒绝且码名固定', () => {
  const rejected = [
    '../workbuddy',
    'WorkBuddy',
    'work_buddy',
    'a'.repeat(33),
    '',
    '1abc',
    '-abc',
    'demo/../x',
    'a/b',
    'workbuddy\\x',
    42,
    null,
    undefined,
  ]
  for (const id of rejected) {
    const failure = assertProviderId(id)
    assert.equal(failure.ok, false, String(id) + ' 必须被拒')
    assert.equal(failure.code, CODES.PROVIDER_INVALID_ID)
    assert.ok(failure.message.includes('providerId'), failure.message)
  }
})

test('合法 providerId 放行并给出规范落点', () => {
  const base = path.resolve(tmpdir(), 'bazaar-paths-case')
  for (const id of ['a', 'workbuddy', 'my-lib-2', 'z'.repeat(32)]) {
    const result = providerDir(base, id)
    assert.equal(result.ok, true, id + ' 必须放行')
    assert.equal(result.path, path.join(base, PROVIDERS_DIR_NAME, id))
    assert.ok(result.path.startsWith(path.resolve(base, PROVIDERS_DIR_NAME) + path.sep))
  }
})

test('拼装处的第二道防线拦住越出 provider 子树的片段', () => {
  const base = path.resolve(tmpdir(), 'bazaar-paths-case')
  // 跨 provider：alpha 无论怎么拼都拿不到 beta 的目录。
  for (const segments of [
    ['..', 'beta', 'vault', 'token.json'],
    ['..'],
    ['..', '..', 'etc', 'passwd'],
    [path.resolve(base, 'other.json')],
    ['/etc/passwd'],
  ]) {
    const failure = safeJoin(base, 'alpha', ...segments)
    assert.equal(failure.ok, false, segments.join('/') + ' 必须被拦下')
    assert.equal(failure.code, CODES.PARAM_INVALID)
    assert.equal(failure.escaped, true, '报错要说清越界来自片段，而不是把矛头指向 id')
  }
  // 合法子路径照常通过（第二道不能顺手把正常拼装也毙掉）。
  assert.equal(
    safeJoin(base, 'alpha', 'accounts', 'cn', 'x.json').path,
    path.join(base, PROVIDERS_DIR_NAME, 'alpha', 'accounts', 'cn', 'x.json'),
  )
})

test('非字符串片段按参数非法拒绝而不是抛出 TypeError', () => {
  const failure = safeJoin(path.resolve(tmpdir(), 'b'), 'alpha', 42)
  assert.equal(failure.ok, false)
  assert.equal(failure.code, CODES.PARAM_INVALID)
  assert.ok(failure.field.startsWith('segments['), failure.field)
})

test('两道防线同源：白名单只有一份 pattern，注册与拼装判定一致', () => {
  assert.equal(PROVIDER_ID_PATTERN.source, '^[a-z][a-z0-9-]{0,31}$')
  const ids = [
    '../workbuddy',
    'WorkBuddy',
    'work_buddy',
    'a'.repeat(33),
    '',
    'workbuddy',
    'my-lib-2',
    'a',
  ]
  for (const id of ids) {
    const admitted = assertProviderId(id).ok === true
    const registered = validateContract(fullContract(id)).ok === true
    assert.equal(admitted, registered, id + '：注册判定与路径判定必须同结论')
  }
})

test('路径模块绝不碰磁盘：非法 id 不会在 providers 下留下目录', () => {
  const base = tempDirSync('bazaar-paths-')
  const before = readdirSync(base)
  assert.deepEqual(before, [])
  providerDir(base, '../evil')
  providerDir(base, 'WorkBuddy')
  safeJoin(base, 'demo', '..', '..', 'evil')
  providerDir(base, 'legit')
  assert.deepEqual(readdirSync(base), [], '任何一次拼装都不该创建目录')
})

test('bazaarDir 为空时拒绝拼装而不是退化成相对路径', () => {
  for (const bad of ['', undefined, null, 0]) {
    const failure = providersRoot(bad)
    assert.equal(failure.ok, false, String(bad) + ' 必须被拒')
    assert.equal(failure.code, CODES.PARAM_INVALID)
    assert.equal(failure.field, 'bazaarDir')
  }
})

test('providerDir 与 safeJoin 的关系是同一实现，不给两处各写一遍的机会', () => {
  const base = path.resolve(tmpdir(), 'bazaar-paths-case')
  assert.deepEqual(providerDir(base, 'workbuddy'), safeJoin(base, 'workbuddy'))
})

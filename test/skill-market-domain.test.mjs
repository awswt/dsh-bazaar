/**
 * 技能域测试矩阵（任务 3.8，技能域独立成组）。
 *
 * 与 provider-contract*.test.mjs 的分工：那些文件钉契约形状与派发判定；本文件钉技能域在
 * 真实链路里的行为——两域（skillMarket / memoryMarket）并列标注、单库故障隔离、跨库同名
 * 冲突、落位失败不留半份目录、以及范围变更只动自己分区。
 *
 * 安装走的是**真** lib/skill-install.js：冲突检测读的是磁盘上的归属元数据，用假实现替不掉。
 * 出网被换成 fakeFetch，落盘落在 mkdtemp 出来的临时工作区里。
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

import { createActiveProviderSet } from '../lib/provider/active-set.js'
import { createDomainDispatcher } from '../lib/provider/dispatch.js'
import { createDomainViews } from '../lib/provider/domains.js'
import { CODES } from '../lib/provider/errors.js'
import { createProviderRegistry } from '../lib/provider/registry.js'
import { createWorkbuddyProvider } from '../lib/providers/workbuddy/index.js'
import { SessionManager } from '../lib/session.js'
import { tempDirSync } from './temp.mjs'
import { installSkill, listInstalledSkills } from '../lib/skill-install.js'

const CDN_HOST = 'cdn.example.com'
const DOWNLOAD_URL = 'https://' + CDN_HOST + '/skills/shared-skill.zip'

const SKILL_MD = [
  '---',
  'name: shared-skill',
  'display_name: 共享技能',
  'description: 两个库都会上架的同名技能',
  'version: 1.0.0',
  '---',
  '',
  '# 共享技能',
  '',
].join('\n')

function workspace() {
  return tempDirSync('bazaar-skill-domain-')
}

function packageBytes(files) {
  const entries = {}
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text)
  return zipSync(entries)
}

function fakeFetch(bytes) {
  const calls = []
  const impl = async function (url) {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  impl.calls = calls
  return impl
}

function fakePortal() {
  const posts = []
  return {
    posts,
    async post(route, body) {
      posts.push({ route, body })
      if (route.endsWith('/skill/get-by-ids')) {
        return {
          success: true,
          data: {
            total_count: 1,
            skills: [{ skill_id: 'skill_1', name: 'shared-skill', download_url: DOWNLOAD_URL }],
          },
        }
      }
      throw new Error('unexpected portal route: ' + route)
    },
  }
}

function sessionAdapter() {
  const state = new Map()
  return {
    state,
    async readActive(sessionId) {
      const partition = state.get(sessionId)
      return partition === undefined ? undefined : partition.activeProviders
    },
    async writeActive(sessionId, ids) {
      state.set(sessionId, { activeProviders: ids.slice() })
      return { ok: true, activeProviders: ids.slice() }
    },
    async clearProvider(providerId) {
      for (const [sessionId, partition] of state) {
        state.set(sessionId, {
          activeProviders: (partition.activeProviders ?? []).filter(function (id) {
            return id !== providerId
          }),
        })
      }
      return { ok: true, providerId }
    },
  }
}

function wiring() {
  const session = sessionAdapter()
  const registry = createProviderRegistry({ session })
  const active = createActiveProviderSet(registry, { session, defaultProvider: '' })
  const dispatcher = createDomainDispatcher(registry, {
    resolveActive: function (sessionId) {
      return active.activeFor(sessionId)
    },
  })
  const views = createDomainViews({ registry, active, dispatcher })
  return { session, registry, active, dispatcher, views }
}

/**
 * 技能库假实现。installSkill 转调真 lib/skill-install.js：归属元数据与冲突判定都在那里，
 * 用假实现替掉就等于什么都没测。异常按契约折成失败信封（provider 层不得抛）。
 */
function skillProvider(id, options = {}) {
  const calls = []
  const capabilities = options.capabilities ?? { skillMarket: true }
  const skills = options.skills ?? []
  const impl = {}
  if (capabilities.skillMarket === true) {
    impl.skillMarket = {
      async listSkills(params) {
        calls.push(['listSkills', params])
        if (options.listFailure !== undefined) return options.listFailure
        return {
          items: skills.map(function (item) {
            return { ...item }
          }),
          total: skills.length,
        }
      },
      async installSkill(params) {
        calls.push(['installSkill', params])
        try {
          const result = await installSkill({
            portal: options.portal ?? fakePortal(),
            providerId: id,
            skillId: params.skillId,
            workspace: params.workspace,
            allowHosts: [CDN_HOST],
            fetchImpl:
              options.fetchImpl ?? fakeFetch(packageBytes({ 'shared-skill/SKILL.md': SKILL_MD })),
            force: params.force === true,
          })
          return {
            slug: result.installed.slug,
            installedPath: result.installed.path,
            providerId: result.installed.providerId,
            files: result.files,
          }
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : CODES.PARAM_INVALID
          return {
            ok: false,
            code,
            message: error instanceof Error ? error.message : String(error),
            ...(error !== null && typeof error === 'object' && error.details !== undefined
              ? error.details
              : {}),
          }
        }
      },
    }
  }
  if (capabilities.memoryMarket === true) {
    impl.memoryMarket = {
      async listMemorySkills() {
        calls.push(['listMemorySkills'])
        if (options.memoryFailure !== undefined) return options.memoryFailure
        return { items: options.memorySkills ?? [], total: (options.memorySkills ?? []).length }
      },
      async searchMemory(params) {
        calls.push(['searchMemory', params])
        if (options.memoryFailure !== undefined) return options.memoryFailure
        return { items: [], total: 0 }
      },
    }
  }
  return {
    calls,
    apiVersion: 1,
    id,
    displayName: options.displayName ?? id + ' 库',
    capabilities,
    impl,
  }
}

function managerWith(views) {
  const dataDir = tempDirSync('bazaar-skill-session-')
  return new SessionManager({
    ctx: {
      agents: {
        get: function () {
          return undefined
        },
        list: function () {
          return []
        },
      },
      skills: {
        async list() {
          return []
        },
        async snapshot() {
          return { skills: [], complete: true }
        },
        async get() {
          return undefined
        },
        registerProvider() {
          return function () {}
        },
      },
    },
    market: {},
    bundles: {},
    config: { dataDir },
    getViews: function () {
      return views
    },
  })
}

test('技能列表按库分组，skillMarket 与 memoryMarket 两个来源并列标注', async () => {
  const w = wiring()
  const alpha = skillProvider('alpha', {
    skills: [{ id: 's1', name: '市场技能' }],
    memorySkills: [{ id: 'm1', name: '记忆技能' }],
    capabilities: { skillMarket: true, memoryMarket: true },
  })
  await w.registry.register(alpha)
  await w.session.writeActive('s1', ['alpha'])

  const listed = await w.views.listSkills({ sessionId: 's1' })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  const group = listed.groups[0]
  assert.equal(group.status, 'ok')
  assert.deepEqual(
    group.items.map(function (item) {
      return item.source
    }),
    ['skillMarket', 'memoryMarket'],
  )
  assert.equal(group.items[0].providerId, 'alpha')
  assert.equal(group.sources.skillMarket.status, 'ok')
  assert.equal(group.sources.memoryMarket.status, 'ok')
})

test('未声明技能市场的库标成 undeclared，已声明它的库照常返回', async () => {
  const w = wiring()
  // 一个域都不声明的库：它既不提供技能市场也不提供记忆市场，但注册本身是合法的。
  const expertOnly = skillProvider('expert-only', { capabilities: {} })
  const skills = skillProvider('skills', { skills: [{ id: 's1', name: '市场技能' }] })
  const first = await w.registry.register(expertOnly)
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = await w.registry.register(skills)
  assert.equal(second.ok, true, JSON.stringify(second))
  await w.session.writeActive('s1', ['expert-only', 'skills'])

  const listed = await w.views.listSkills({ sessionId: 's1' })
  assert.equal(listed.ok, true)
  assert.equal(listed.groups[0].status, 'undeclared')
  assert.equal(listed.groups[0].code, CODES.CAPABILITY_UNDECLARED)
  assert.equal(expertOnly.calls.length, 0)
  assert.equal(listed.groups[1].status, 'ok')
  assert.equal(listed.groups[1].items.length, 1)
})

test('记忆市场缺宿主插件时报 MEMORY_UNAVAILABLE，不伪造空列表', async () => {
  const w = wiring()
  const provider = createWorkbuddyProvider({
    portal: {
      async listSkills() {
        return { items: [], total: 0 }
      },
    },
    config: {},
  })
  await w.registry.register(provider)
  await w.session.writeActive('s1', ['workbuddy'])

  const listed = await w.views.listSkills({ sessionId: 's1' })
  assert.equal(listed.ok, true)
  const group = listed.groups[0]
  assert.equal(group.sources.memoryMarket.status, 'unavailable')
  assert.equal(group.sources.memoryMarket.code, CODES.MEMORY_UNAVAILABLE)
  assert.match(group.sources.memoryMarket.message, /dsh-mnemon/)
  assert.match(group.sources.memoryMarket.message, /未安装/)
})

test('安装技能必须带 providerId；未注册的库不产生任何出网', async () => {
  const w = wiring()
  const alpha = skillProvider('alpha')
  await w.registry.register(alpha)

  const missing = await w.views.installSkill({ skillId: 'skill_1', workspace: workspace() })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, CODES.PROVIDER_REQUIRED)
  assert.equal(missing.field, 'providerId')

  const unknown = await w.views.installSkill({
    providerId: 'ghost',
    skillId: 'skill_1',
    workspace: workspace(),
  })
  assert.equal(unknown.code, CODES.PROVIDER_UNKNOWN)
  assert.equal(alpha.calls.length, 0)
})

test('跨库同名技能被拦下并指出已有来源，force 只解残留锁不解冲突', async () => {
  const w = wiring()
  const root = workspace()
  const alpha = skillProvider('alpha')
  const beta = skillProvider('beta')
  await w.registry.register(alpha)
  await w.registry.register(beta)

  const first = await w.views.installSkill({
    providerId: 'alpha',
    skillId: 'skill_1',
    workspace: root,
  })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.providerId, 'alpha')

  const conflict = await w.views.installSkill({
    providerId: 'beta',
    skillId: 'skill_1',
    workspace: root,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, CODES.SKILL_NAME_CONFLICT)
  assert.match(conflict.message, /alpha/)

  const forced = await w.views.installSkill({
    providerId: 'beta',
    skillId: 'skill_1',
    workspace: root,
    force: true,
  })
  assert.equal(forced.code, CODES.SKILL_NAME_CONFLICT, 'force 只用于破残留锁，不该绕过归属判定')
})

test('同库重装是升级：替换旧文件且归属不变，不产生重复目录', async () => {
  const w = wiring()
  const root = workspace()
  // 两次安装给的包不同：第二次不含 stale.md，重装必须把它清掉（整体替换，不是叠加）。
  const packages = [
    packageBytes({
      'shared-skill/SKILL.md': SKILL_MD,
      'shared-skill/stale.md': 'old\n',
    }),
    packageBytes({ 'shared-skill/SKILL.md': SKILL_MD }),
  ]
  let served = 0
  const fetchImpl = async function () {
    const bytes = packages[Math.min(served, packages.length - 1)]
    served += 1
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  const alpha = skillProvider('alpha', { fetchImpl })
  await w.registry.register(alpha)
  await w.session.writeActive('s1', ['alpha'])

  const first = await w.views.installSkill({
    providerId: 'alpha',
    skillId: 'skill_1',
    workspace: root,
  })
  assert.equal(first.ok, true, JSON.stringify(first))
  const target = path.join(root, '.dsh', 'skills', 'shared-skill')
  assert.equal(await fs.readFile(path.join(target, 'stale.md'), 'utf8'), 'old\n')

  const second = await w.views.installSkill({
    providerId: 'alpha',
    skillId: 'skill_1',
    workspace: root,
  })
  assert.equal(second.ok, true)
  await assert.rejects(fs.stat(path.join(target, 'stale.md')), /ENOENT/)
  const listing = await listInstalledSkills(root)
  assert.deepEqual(
    listing.map(function (skill) {
      return skill.slug
    }),
    ['shared-skill'],
  )
  assert.equal(listing[0].providerId, 'alpha')
})

test('越界条目被拦下，且工作区里不留半份目录', async () => {
  const w = wiring()
  const root = workspace()
  const alpha = skillProvider('alpha', {
    fetchImpl: fakeFetch(
      packageBytes({
        'pkg/SKILL.md': SKILL_MD,
        'pkg/../../escaped.txt': 'pwned\n',
      }),
    ),
  })
  await w.registry.register(alpha)

  const result = await w.views.installSkill({
    providerId: 'alpha',
    skillId: 'skill_1',
    workspace: root,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.PARAM_INVALID)
  await assert.rejects(fs.stat(path.join(root, 'escaped.txt')), /ENOENT/)
  const entries = await fs.readdir(path.join(root, '.dsh', 'skills')).catch(function () {
    return []
  })
  assert.deepEqual(
    entries.filter(function (name) {
      return name.startsWith('.staging-')
    }),
    [],
    '失败不许留下 staging 目录',
  )
  assert.equal(entries.includes('shared-skill'), false)
})

test('条目数超限报 SKILL_PACKAGE_TOO_LARGE 且不留半份目录', async () => {
  const w = wiring()
  const root = workspace()
  const files = { 'shared-skill/SKILL.md': SKILL_MD }
  for (let index = 0; index < 401; index += 1) files['shared-skill/f' + index + '.md'] = 'x\n'
  const alpha = skillProvider('alpha', { fetchImpl: fakeFetch(packageBytes(files)) })
  await w.registry.register(alpha)

  const result = await w.views.installSkill({
    providerId: 'alpha',
    skillId: 'skill_1',
    workspace: root,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, CODES.SKILL_PACKAGE_TOO_LARGE)
  const entries = await fs.readdir(path.join(root, '.dsh', 'skills')).catch(function () {
    return []
  })
  assert.equal(entries.includes('shared-skill'), false)
})

test('并发安装同一技能：串行排队后目录完整，不出现半成品', async () => {
  const w = wiring()
  const root = workspace()
  const alpha = skillProvider('alpha', {
    fetchImpl: fakeFetch(
      packageBytes({
        'shared-skill/SKILL.md': SKILL_MD,
        'shared-skill/references/checklist.md': '- 条目\n',
      }),
    ),
  })
  await w.registry.register(alpha)

  const [first, second] = await Promise.all([
    w.views.installSkill({ providerId: 'alpha', skillId: 'skill_1', workspace: root }),
    w.views.installSkill({ providerId: 'alpha', skillId: 'skill_1', workspace: root }),
  ])
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, true, JSON.stringify(second))

  const target = path.join(root, '.dsh', 'skills', 'shared-skill')
  assert.match(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), /name: shared-skill/)
  assert.equal(
    await fs.readFile(path.join(target, 'references', 'checklist.md'), 'utf8'),
    '- 条目\n',
  )
  const entries = await fs.readdir(path.join(root, '.dsh', 'skills'))
  assert.deepEqual(
    entries.filter(function (name) {
      return name.startsWith('.')
    }),
    [],
    '锁与 staging 都该被清干净',
  )
})

test('技能范围变更只影响自己分区，另一库的选择原样保留', async () => {
  const w = wiring()
  const alpha = skillProvider('alpha', {
    skills: [{ id: 's1', name: 'alpha-skill' }],
    capabilities: { skillMarket: true },
  })
  const beta = skillProvider('beta', {
    skills: [{ id: 's2', name: 'beta-skill' }],
    capabilities: { skillMarket: true },
  })
  await w.registry.register(alpha)
  await w.registry.register(beta)
  const manager = managerWith(w.views)

  await manager.writeActive('s1', ['alpha', 'beta'])
  const partitionOf = function (view, providerId) {
    return view.skillsByProvider.find(function (entry) {
      return entry.providerId === providerId
    })
  }

  const before = await manager.setSkills(
    's1',
    { globalMode: 'selected', globalNames: ['xlsx'] },
    { providerId: 'alpha' },
  )
  assert.equal(partitionOf(before, 'alpha').globalMode, 'selected')

  const after = await manager.setSkills(
    's1',
    { globalMode: 'all', globalNames: [] },
    { providerId: 'beta' },
  )
  assert.equal(partitionOf(after, 'beta').globalMode, 'all')
  assert.equal(
    partitionOf(after, 'alpha').globalMode,
    'selected',
    '改 beta 的范围不该顺手把 alpha 改回 all',
  )
  assert.deepEqual(partitionOf(after, 'alpha').globalNames, ['xlsx'])
})

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { tempDir } from './temp.mjs'

const dataDir = await tempDir('oh-host-')
const sections = []
const providers = []
const commands = []
const listeners = new Map()
let fiberDisposed = 0

function makeScopedContext() {
  return {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    skills: {
      registerProvider(create) {
        const control = { invalidate() {} }
        providers.push(create(control))
        return () => {
          providers.pop()
        }
      },
    },
  }
}

const globalSkills = [
  { name: 'xlsx', description: 'Spreadsheet work', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'filesystem' },
  { name: 'docx', description: 'Document work', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'filesystem' },
]

const agent = {
  id: 'sess-integration',
  session: { header: { cwd: process.cwd() } },
  ctx: {
    async plugin(plugin, config) {
      const scoped = makeScopedContext()
      plugin(scoped, config)
      return {
        async dispose() {
          fiberDisposed += 1
          sections.splice(0, sections.length)
          providers.splice(0, providers.length)
        },
      }
    },
  },
}

const ctx = {
  tools: {
    register(definition) {
      ctx.registeredTool = definition
    },
  },
  agents: {
    get(id) {
      return id === agent.id ? agent : undefined
    },
    list() {
      return [agent]
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  skills: {
    async list() {
      return globalSkills
    },
    async snapshot() {
      return { skills: globalSkills, complete: true }
    },
    async get(name) {
      return globalSkills.find(skill => skill.name === name)
    },
    registerProvider(create) {
      const control = { invalidate() {} }
      providers.push(create(control))
      return () => {}
    },
  },
  get(name) {
    if (name === 'commands') {
      return {
        register(definition) {
          commands.push(definition)
        },
      }
    }
    return undefined
  },
  on(event, listener) {
    listeners.set(event, listener)
  },
  effect(callback) {
    callback()
  },
  logger: {
    warn() {},
    info() {},
  },
}

apply(ctx, {
  dataDir,
  authMode: 'auto',
  localRoots: [path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins')],
  marketBaseUrl: 'https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace',
})

assert.equal(typeof ctx.registeredTool?.execute, 'function', 'tool must be registered')
assert.equal(commands.length, 1, 'command must be registered')
assert.equal(commands[0].name, 'bazaar')

// 连接器视图自 3.x 起按 provider 分组：顶层不再有 `connector` 字段，账号规模挂在 accounts 下。
const connector = JSON.parse(await ctx.registeredTool.execute({ action: 'connector' }, { agent }))
assert.equal(connector.action, 'connector')
assert.equal(connector.subaction, 'list')
assert.equal(typeof connector.catalogTotal, 'number')
assert.equal(typeof connector.connectedCount, 'number')
assert.equal(JSON.stringify(connector).includes('accessToken'), false)

// 选择必须带库：同一 id 在不同库里可能是两个专家，缺 provider 时会被 PROVIDER_REQUIRED 拦下。
const selected = JSON.parse(
  await ctx.registeredTool.execute({ action: 'expert', expertId: 'ai-agent-engineer', provider: 'workbuddy' }, { agent }),
)
assert.equal(selected.applied, true)
assert.equal(selected.expert.id, 'ai-agent-engineer')
assert.equal(typeof selected.expert.displayName, 'string')
assert.equal(selected.expert.displayName, '程枢')
assert.equal(sections.some(section => section.name.startsWith('bazaar:expert:')), true)
assert.equal(providers.some(provider => provider.name.startsWith('bazaar-expert-')), true)

const skills = JSON.parse(await ctx.registeredTool.execute({ action: 'skills' }, { agent }))
assert.equal(skills.global.length, 2)
assert.equal(skills.expert.some(skill => skill.name === 'agent-craft'), true)

const marketView = JSON.parse(await ctx.registeredTool.execute({ action: 'market', query: '逆向' }, { agent }))
// portalAvailable 只说明「本机有没有可用的门户凭据」，不保证实时取数一定成功（凭据过期、
// 网络不通都会让 live 调用失败）。所以按 source 分两支断言：实时成功时钉住门户数据，
// 回落快照时必须带一条 warning —— 静默回落会让用户以为看到的就是实时结果。
if (marketView.source === 'portal') {
  assert.equal(marketView.marketTotal >= 10000, true)
  const reverseItem = marketView.items.find(item => item.id === 'ex_QvM298ih8T8g')
  assert.equal(reverseItem?.profession, '软件逆向分析工程师')
  assert.equal(
    reverseItem?.installed,
    true,
    JSON.stringify({
      plugin: reverseItem?.plugin,
      localTotal: marketView.localTotal,
      sample: marketView.items.slice(0, 3).map(item => [item.id, item.plugin, item.source, item.installed]),
    }),
  )
} else {
  assert.equal(marketView.source, 'cos')
  assert.equal(typeof marketView.marketTotal, 'number')
  assert.equal(Array.isArray(marketView.items), true)
  assert.equal(marketView.items.length > 0, true, '快照也必须能列出专家，空列表说明回落路径断了')
  if (marketView.portalAvailable === true) {
    assert.equal(typeof marketView.warning, 'string', '门户可用但实时取数失败时必须带 warning')
  }
}

const reverse = JSON.parse(
  await ctx.registeredTool.execute({ action: 'expert', expertId: 'rea-reverse-engineer', provider: 'workbuddy' }, { agent }),
)
assert.equal(reverse.applied, true)
assert.equal(reverse.expert.id, 'rea-reverse-engineer')
assert.equal(reverse.expert.displayName, 'REA 逆向功能分析专家')
assert.equal(reverse.skills.expertNames.includes('rea-analysis'), true)

const cleared = JSON.parse(await ctx.registeredTool.execute({ action: 'off' }, { agent }))
assert.equal(cleared.applied, false)
assert.equal(cleared.expert, null)
assert.equal(fiberDisposed >= 1, true)
assert.equal(sections.length, 0)
assert.equal(providers.length, 0)

console.log(JSON.stringify({
  ok: true,
  tool: ctx.registeredTool.name,
  command: commands[0].name,
  connector: {
    installed: connector.installed,
    accounts: connector.accountCount,
    usable: connector.usableAccountCount,
  },
  selectedExpert: selected.expert.id,
  selectedSkills: skills.expert.map(skill => skill.name),
  market: {
    source: marketView.source,
    publicTotal: marketView.publicTotal,
    localTotal: marketView.localTotal,
    matched: marketView.matched,
    portalAvailable: marketView.portalAvailable,
  },
  reverseExpert: reverse.expert.displayName,
  cleared: cleared.applied === false,
  fiberDisposed,
}, null, 2))

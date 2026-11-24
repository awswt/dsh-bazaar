/**
 * 最小可用 provider：契约的活样例（任务 2.7）。
 *
 * 这个文件的价值在于「能被真的注册进去、列举出来、按域派发」，而不是功能齐全：
 * 它只读同目录的 data/experts.json，**不联网、不登录、不写盘**，也不落在 lib/ 里
 * （package.json 的 files 不含 examples，因此它不会随包发布）。
 *
 * 三个刻意的选择，抄的时候请照抄：
 * 1. 只声明 expertMarket。capabilities 是「我真的能提供什么」的声明，不是待办清单；
 *    声明了却没实现，注册期就会被 PROVIDER_IMPL_MISSING 挡下（见 lib/provider/contract.js）。
 *    未声明的域即使被调用，也由派发层统一回 BAZAAR_CAPABILITY_UNDECLARED。
 * 2. 失败一律返回 { ok:false, code, message }，绝不 throw。域方法的抛错会被边界层
 *    折成 BAZAAR_PROVIDER_THROWN，那等于把「我违约了」写进日志。
 * 3. 成功返回领域结构本身（{items,total,source} / {item}），不套 {ok:true}。
 *    ok 由派发层与注册表统一加，provider 自己加会出现 {ok:true, ok:true} 的两层壳。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 本文件的错误码只需与宿主登记表同名，不强制 import 宿主的 errors.js：
 * 样例要能整段复制到宿主之外（比如一个独立插件仓）后仍然跑得起来。
 * 码名清单见 docs/provider-integration.md。
 */
const CODES = Object.freeze({
  PARAM_INVALID: 'BAZAAR_PARAM_INVALID',
  EXPERT_NOT_FOUND: 'BAZAAR_EXPERT_NOT_FOUND',
  MARKET_UNAVAILABLE: 'BAZAAR_MARKET_UNAVAILABLE',
})

const PROVIDER_ID = 'minimal-example'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function fail(code, message, details) {
  const envelope = { ok: false, code, message }
  if (details !== undefined && details !== null) Object.assign(envelope, details)
  return envelope
}

/**
 * 读数据文件。缺文件、坏 JSON、形状不对都在这里一次说清：
 * 样例被拷走时最常见的就是「忘了带 data/」和「手改 JSON 少个逗号」。
 */
function loadCatalog(dataFile) {
  const file = dataFile ?? path.join(HERE, 'data', 'experts.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error('无法读取样例数据 ' + file + ': ' + (error?.message ?? String(error)))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('样例数据不是合法 JSON ' + file + ': ' + (error?.message ?? String(error)), {
      cause: error,
    })
  }
  if (!Array.isArray(parsed?.experts)) {
    throw new Error('样例数据缺少 experts 数组：' + file)
  }
  return parsed.experts
}

const clampPage = function (value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1
}

const clampPageSize = function (value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 24) : 12
}

/** 匹配口径：名称 / 摘要 / 标签任一命中即算（样例不引入分词，够用就好）。 */
function matches(row, query) {
  if (query === '') return true
  const needle = query.toLowerCase()
  const haystack = [row.name, row.summary, row.category, ...(row.tags ?? [])]
    .filter((part) => typeof part === 'string')
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/**
 * 构造 provider 契约对象。
 *
 * @param {object} [options]
 * @param {string} [options.dataFile] 数据文件路径，默认同目录 data/experts.json
 */
export function createMinimalProvider(options = {}) {
  const catalog = loadCatalog(options.dataFile)

  async function listExperts(params = {}) {
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    const categoryId = params.categoryId
    const page = clampPage(params.page)
    const pageSize = clampPageSize(params.pageSize)

    const filtered = catalog.filter((row) => {
      if (categoryId !== undefined && categoryId !== null && categoryId !== '') {
        if (row.categoryId !== categoryId) return false
      }
      return matches(row, query)
    })
    const start = (page - 1) * pageSize
    return {
      items: filtered.slice(start, start + pageSize).map((row) => ({ ...row })),
      total: filtered.length,
      // source 是「这份数据从哪来」的自述：多库并列时界面靠它区分来源。
      source: 'local-json',
    }
  }

  async function getExpert(params = {}) {
    const id = params.id
    if (typeof id !== 'string' || id === '') {
      return fail(CODES.PARAM_INVALID, 'getExpert 需要字符串 id', { field: 'id' })
    }
    const row = catalog.find((entry) => entry.id === id)
    if (row === undefined) {
      return fail(CODES.EXPERT_NOT_FOUND, '示例库里没有 id 为 ' + id + ' 的专家', {
        providerId: PROVIDER_ID,
        expertId: id,
      })
    }
    return { item: { ...row } }
  }

  return {
    apiVersion: 1,
    id: PROVIDER_ID,
    displayName: '本地 JSON 示例库',
    capabilities: {
      // 只声明真的实现了的那一域：其余四域在派发层会被 CAPABILITY_UNDECLARED 挡下，
      // 这正是「声明面决定可用域」那条规则的活样例。
      expertMarket: true,
      skillMarket: false,
      memoryMarket: false,
      connectorMarket: false,
      account: false,
    },
    // 断网环境也能跑：本样例一个外部主机都不访问，白名单刻意留空。
    allowHosts: [],
    impl: {
      expertMarket: { listExperts, getExpert },
    },
  }
}

export default createMinimalProvider

/**
 * 自检入口：`node examples/minimal-provider/index.mjs` 走一遍真实的注册表与派发层。
 * 用动态 import 而不是顶层 import 宿主的模块，是为了让这个文件在宿主之外也能单独工作
 * （拷走后只有自检走不通，契约对象本身照样能用）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const { createProviderRegistry } = await import('../../lib/provider/registry.js')
  const { createDomainDispatcher } = await import('../../lib/provider/dispatch.js')

  const registry = createProviderRegistry({})
  const registered = await registry.register(createMinimalProvider())
  process.stdout.write('register: ' + JSON.stringify(registered.ok) + '\n')
  process.stdout.write('list: ' + JSON.stringify(registry.list().map((p) => p.id)) + '\n')

  const dispatcher = createDomainDispatcher(registry, { resolveActive: () => [PROVIDER_ID] })
  const listed = await dispatcher.call({
    providerId: PROVIDER_ID,
    domain: 'expertMarket',
    method: 'listExperts',
    params: { query: '示例' },
  })
  process.stdout.write('listExperts: ' + JSON.stringify(listed) + '\n')

  const undeclared = await dispatcher.call({
    providerId: PROVIDER_ID,
    domain: 'skillMarket',
    method: 'listSkills',
    params: {},
  })
  process.stdout.write('未声明域被拦: ' + JSON.stringify(undeclared) + '\n')
}

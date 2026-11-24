/**
 * 跨 provider 的分组返回层（任务 3.1–3.3、3.6）。
 *
 * 三层分工：注册表管「谁注册了、声明了哪些域」，派发层管「把一次调用送到某个 provider
 * 并把异常折成信封」，本文件管第三件事——把同一个域请求按 providerId 拆成多组、逐组
 * 调用、逐组收拢结果，最后在外层补 providerId 与 qualifiedName。
 *
 * 三条纪律直接来自 spec，写在一起是因为它们互相约束：
 * 1. 未注册或未激活的 provider 不出现，且它的数据源不被请求。实现方式是「只对目标组调
 *    dispatcher」，而不是「全量取数后再过滤」——后者会为了显示一家库去唤另一家的接口，
 *    多库就多一次出网与一次限流额度。
 * 2. 单库失败只标该组（status 为 error，带 code 与 message），其它组照常返回。整表失败
 *    会让一次限流变成面板全红，用户失去「其它库还能用」这个事实。
 * 3. 只补 providerId / qualifiedName，不重排 provider 自己返回的字段。专家结构复用源仓
 *    portal/market 的归一结果，另立 DTO 会让两处字段慢慢漂移。
 */

import { CODES, fail, ok } from './errors.js'
import { assertProviderId } from './paths.js'

/** 单页上限：provider 实现自己的默认值更小（workbuddy 12），这里只是防呆。 */
const MAX_PAGE_SIZE = 100

function positiveInt(value, field) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined }
  const number = Number(value)
  if (Number.isInteger(number) === false || number < 1) {
    // spec 明确要求不静默用默认值：pageSize 为 0 或 page 为负数必须被拦下并指明字段。
    return fail(
      CODES.PARAM_INVALID,
      field + ' 必须是大于 0 的整数（收到 ' + JSON.stringify(value) + '）',
      {
        field: field,
      },
    )
  }
  return { ok: true, value: number }
}

function pageOptions(params) {
  const page = positiveInt(params.page, 'page')
  if (page.ok === false) return page
  const pageSize = positiveInt(params.pageSize, 'pageSize')
  if (pageSize.ok === false) return pageSize
  return {
    ok: true,
    page: page.value ?? 1,
    pageSize: pageSize.value === undefined ? undefined : Math.min(pageSize.value, MAX_PAGE_SIZE),
  }
}

function registeredList(registry) {
  const ids = registry.ids()
  return ids.length === 0 ? '无' : ids.join(', ')
}

function unknownProvider(registry, providerId) {
  return fail(
    CODES.PROVIDER_UNKNOWN,
    'provider ' +
      JSON.stringify(providerId) +
      ' 未注册（当前已注册：' +
      registeredList(registry) +
      '，可用 providers 动作重新列举）',
    { providerId: providerId, registered: registry.ids() },
  )
}

/**
 * @param {object} deps
 * @param {object} deps.registry createProviderRegistry() 的返回值
 * @param {object} deps.active createActiveProviderSet() 的返回值
 * @param {object} deps.dispatcher createDomainDispatcher() 的返回值
 */
export function createDomainViews(deps) {
  const registry = deps.registry
  const active = deps.active
  const dispatcher = deps.dispatcher

  /**
   * 本次请求要返回哪几组。
   *
   * 显式 providers 用于「点某个库的重试」：只重发那一家（spec 要求重试只重发失败库）。
   * 缺省取会话活跃集，顺序即活跃集顺序（spec 要求组顺序与 activeProviders 一致）。
   */
  async function targetGroups(sessionId, providers) {
    if (Array.isArray(providers) && providers.length > 0) {
      const records = []
      for (let index = 0; index < providers.length; index += 1) {
        const id = providers[index]
        const admitted = assertProviderId(id)
        if (admitted.ok === false) {
          return fail(admitted.code, 'providers[' + index + '] 非法：' + admitted.message, {
            field: 'providers[' + index + ']',
            providerId: id,
          })
        }
        const record = registry.getRecord(id)
        if (record === undefined) return unknownProvider(registry, id)
        records.push(record)
      }
      return ok(records)
    }
    const ids = await active.activeFor(sessionId)
    const records = []
    for (const id of ids) {
      const record = registry.getRecord(id)
      // 活跃集里出现未注册 id 说明注销与写入交错；跳过而不是整表失败，其它库还能用。
      if (record !== undefined) records.push(record)
    }
    return ok(records)
  }

  function undeclared(code) {
    return code === CODES.CAPABILITY_UNDECLARED
  }

  /**
   * 一个 provider 一个组。status 三态是面板的渲染依据：
   * - ok：有结果（空结果也算 ok，空态不是错误态）
   * - undeclared：该库没声明这个域（能力未声明，不是故障）
   * - error：取数失败（分区内重试的入口）
   */
  function groupOf(record, outcome, decorateItem) {
    const base = {
      providerId: record.id,
      displayName: record.displayName,
      capabilities: record.capabilities,
    }
    if (outcome.ok === false) {
      return {
        ...base,
        status: undeclared(outcome.code) ? 'undeclared' : 'error',
        code: outcome.code,
        message: outcome.message,
        items: [],
        total: 0,
        matchedTotal: 0,
        hasMore: false,
      }
    }
    const items = Array.isArray(outcome.items) ? outcome.items.map(decorateItem) : []
    const total = Number.isFinite(Number(outcome.total)) ? Number(outcome.total) : items.length
    const matchedTotal = Number.isFinite(Number(outcome.matchedTotal))
      ? Number(outcome.matchedTotal)
      : total
    return {
      ...base,
      status: 'ok',
      items: items,
      total: total,
      matchedTotal: matchedTotal,
      hasMore: Boolean(outcome.hasMore),
      source: outcome.source,
      stale: outcome.stale,
      warning: outcome.warning,
    }
  }

  /**
   * 跨库同名才加限定前缀；只有一个库返回该名时 qualifiedName 就等于 displayName。
   *
   * 前缀只出现在展示字段里：id 与 providerId 保持原值，选择动作仍按双键提交，
   * 因此「点带前缀的条目」不会把前缀写进会话状态。
   */
  function qualify(groups) {
    const seen = new Map()
    const displayOf = function (item) {
      return typeof item.displayName === 'string' && item.displayName !== ''
        ? item.displayName
        : item.id
    }
    for (const group of groups) {
      for (const item of group.items) {
        const name = displayOf(item)
        if (seen.has(name) === false) seen.set(name, [])
        seen.get(name).push(group.providerId)
      }
    }
    for (const group of groups) {
      for (const item of group.items) {
        const name = displayOf(item)
        const owners = seen.get(name) ?? []
        item.qualifiedName = owners.length > 1 ? group.displayName + ' · ' + name : name
      }
    }
    return groups
  }

  function flatten(groups) {
    const items = []
    for (const group of groups) {
      for (const item of group.items) items.push(item)
    }
    return items
  }

  /**
   * 专家列表（3.1 / 3.2）。分页按 provider 分区独立生效：一个库翻到第 3 页不该把另一个
   * 库也推进到第 3 页——两个库的条目数本来就不一样。
   */
  async function listExperts(params = {}) {
    const paging = pageOptions(params)
    if (paging.ok === false) return paging
    const targets = await targetGroups(params.sessionId, params.providers)
    if (targets.ok === false) return targets

    const groups = []
    for (const record of targets.items) {
      const outcome = await dispatcher.call({
        domain: 'expertMarket',
        method: 'listExperts',
        providerId: record.id,
        params: {
          query: typeof params.query === 'string' ? params.query : '',
          categoryId: params.categoryId,
          page: paging.page,
          pageSize: paging.pageSize,
        },
      })
      groups.push(
        groupOf(record, outcome, function (item) {
          return { ...item, providerId: record.id }
        }),
      )
    }
    qualify(groups)
    return ok({
      groups: groups,
      items: flatten(groups),
      activeProviders: groups.map(function (group) {
        return group.providerId
      }),
      page: paging.page,
      pageSize: paging.pageSize,
    })
  }

  /** 专家详情（3.3）：双键定位。缺 providerId 一律 PROVIDER_REQUIRED，不代选。 */
  async function getExpert(params = {}) {
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    if (providerId === '') {
      return fail(
        CODES.PROVIDER_REQUIRED,
        '专家详情必须带 providerId：同一 id 在不同库里可能是两个专家，请先选库（providers 动作可列举当前集合）',
        { field: 'providerId', registered: registry.ids() },
      )
    }
    const id = typeof params.id === 'string' ? params.id.trim() : ''
    if (id === '') return fail(CODES.PARAM_INVALID, '专家详情必须带 id', { field: 'id' })
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    const record = registry.getRecord(providerId)
    if (record === undefined) return unknownProvider(registry, providerId)

    const outcome = await dispatcher.call({
      domain: 'expertMarket',
      method: 'getExpert',
      providerId: providerId,
      params: { id: id },
    })
    if (outcome.ok === false) return outcome
    const item = outcome.item
    if (item === null || typeof item !== 'object') {
      return fail(
        CODES.EXPERT_NOT_FOUND,
        'provider ' + providerId + ' 没有返回专家 ' + JSON.stringify(id),
        {
          providerId: providerId,
          id: id,
        },
      )
    }
    const displayName =
      typeof item.displayName === 'string' && item.displayName !== '' ? item.displayName : item.id
    return ok({
      item: {
        ...item,
        providerId: providerId,
        providerDisplayName: record.displayName,
        displayName: displayName,
        qualifiedName: displayName,
      },
    })
  }

  /**
   * 技能列表（3.6）：同一 provider 内 skillMarket 与 memoryMarket 两个来源并列。
   *
   * 来源不可用时记在该组的 sources 里，而不是把整组变成错误——技能市场挂了，用户仍然
   * 应该看见「记忆市场未安装」这条更具体的原因。未声明则记 undeclared，绝不写成空数组。
   */
  async function collectSkillGroup(record, params) {
    const sources = {}
    const items = []
    const failures = []

    const market = await dispatcher.call({
      domain: 'skillMarket',
      method: 'listSkills',
      providerId: record.id,
      params: { query: params.query, page: params.page, pageSize: params.pageSize },
    })
    if (market.ok === false) {
      sources.skillMarket = {
        status: undeclared(market.code) ? 'undeclared' : 'unavailable',
        code: market.code,
        message: market.message,
      }
      failures.push(market)
    } else {
      sources.skillMarket = { status: 'ok', total: Number(market.total ?? 0) }
      for (const item of Array.isArray(market.items) ? market.items : []) {
        items.push({ ...item, providerId: record.id, source: 'skillMarket' })
      }
    }

    const memory = await dispatcher.call({
      domain: 'memoryMarket',
      method: 'listMemorySkills',
      providerId: record.id,
      params: { query: params.query, page: params.page, pageSize: params.pageSize },
    })
    if (memory.ok === false) {
      sources.memoryMarket = {
        status: undeclared(memory.code) ? 'undeclared' : 'unavailable',
        code: memory.code,
        message: memory.message,
      }
      failures.push(memory)
    } else {
      sources.memoryMarket = {
        status: 'ok',
        total: Number(memory.total ?? 0),
        available: memory.available,
      }
      for (const item of Array.isArray(memory.items) ? memory.items : []) {
        items.push({ ...item, providerId: record.id, source: 'memoryMarket' })
      }
    }

    const usable = Object.values(sources).some(function (source) {
      return source.status === 'ok'
    })
    let status = 'ok'
    let code
    let message
    if (usable === false) {
      const declaredButFailing = failures.find(function (failure) {
        return undeclared(failure.code) === false
      })
      if (declaredButFailing === undefined) {
        status = 'undeclared'
        code = CODES.CAPABILITY_UNDECLARED
        message = 'provider ' + record.id + ' 未声明技能市场或记忆市场'
      } else {
        status = 'error'
        code = declaredButFailing.code
        message = declaredButFailing.message
      }
    }

    return {
      providerId: record.id,
      displayName: record.displayName,
      capabilities: record.capabilities,
      status: status,
      code: code,
      message: message,
      sources: sources,
      items: items,
      total: items.length,
    }
  }

  async function listSkills(params = {}) {
    const paging = pageOptions(params)
    if (paging.ok === false) return paging
    const targets = await targetGroups(params.sessionId, params.providers)
    if (targets.ok === false) return targets
    const groups = []
    for (const record of targets.items) {
      groups.push(
        await collectSkillGroup(record, {
          query: params.query ?? '',
          page: paging.page,
          pageSize: paging.pageSize,
        }),
      )
    }
    return ok({
      groups: groups,
      items: flatten(groups),
      activeProviders: groups.map(function (group) {
        return group.providerId
      }),
      page: paging.page,
      pageSize: paging.pageSize,
    })
  }

  async function searchMemory(params = {}) {
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (query === '')
      return fail(CODES.PARAM_INVALID, 'searchMemory 需要 query', { field: 'query' })
    const resolved =
      providerId === ''
        ? await active.resolveProvider(params.sessionId, undefined)
        : await active.resolveProvider(params.sessionId, providerId)
    if (resolved.ok === false) return resolved
    return dispatcher.call({
      domain: 'memoryMarket',
      method: 'searchMemory',
      providerId: resolved.providerId,
      params: { query: query, limit: params.limit },
    })
  }

  /**
   * 技能安装（3.7）。providerId 必填：落盘目录跨库共用 <projectRoot>/.dsh/skills/<slug>/，
   * 没有归属就无从判断「同名目录是谁装的」，冲突检测也就失效了。
   */
  async function installSkill(params = {}) {
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    if (providerId === '') {
      return fail(
        CODES.PROVIDER_REQUIRED,
        '安装技能必须带 providerId（技能归属按库记录，冲突检测依赖它）',
        {
          field: 'providerId',
          registered: registry.ids(),
        },
      )
    }
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    if (registry.getRecord(providerId) === undefined) return unknownProvider(registry, providerId)
    const skillId = typeof params.skillId === 'string' ? params.skillId.trim() : ''
    if (skillId === '')
      return fail(CODES.PARAM_INVALID, 'installSkill 需要 skillId', { field: 'skillId' })
    return dispatcher.call({
      domain: 'skillMarket',
      method: 'installSkill',
      providerId: providerId,
      params: {
        skillId: skillId,
        force: params.force === true,
        workspace: params.workspace,
      },
    })
  }

  // ---------------------------------------------------------------- 连接器域（组 4）

  /**
   * 连接器条目的状态归一化：给 status 筛选一个稳定的取值，不依赖 provider 的内部表示。
   * 顺序刻意——正在连接优先于已连接，已连接优先于仅绑定。
   */
  function connectorStatusOf(item) {
    if (item?.state?.connecting === true) return 'connecting'
    if (item?.state?.connected === true) return 'connected'
    if (item?.state?.reason?.code === 'action-required') return 'action-required'
    if (item?.bound === true) return 'bound'
    return 'disconnected'
  }

  /**
   * 状态与关键词同时筛选（4.1）：两个条件同时生效（AND），而不是二选一。
   * 三入口（面板 / 模型工具 / HTTP）都走本函数，因此结论不可能分裂。
   */
  function filterConnectors(items, query, status) {
    if (query === '' && status === '') return items
    return items.filter(function (item) {
      if (query !== '') {
        const text = [
          item.id,
          item.name,
          item.displayName,
          item.vendor,
          item.summary,
          item.category,
          ...(Array.isArray(item.tags) ? item.tags : []),
        ]
          .filter((value) => typeof value === 'string')
          .join(' ')
          .toLowerCase()
        if (text.includes(query) === false) return false
      }
      if (status !== '') {
        if (status === 'enabled') return item.enabled !== false
        if (status === 'disabled') return item.enabled === false
        if (connectorStatusOf(item) !== status) return false
      }
      return true
    })
  }

  /** 连接器列表（4.1）：按 provider 分组，每组独立分页无关的筛选。 */
  async function listConnectors(params = {}) {
    const targets = await targetGroups(params.sessionId, params.providers)
    if (targets.ok === false) return targets
    const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
    const status = typeof params.status === 'string' ? params.status.trim().toLowerCase() : ''
    const groups = []
    for (const record of targets.items) {
      const outcome = await dispatcher.call({
        domain: 'connectorMarket',
        method: 'listConnectors',
        providerId: record.id,
        params: { query: query, status: status },
      })
      if (outcome.ok === true) {
        outcome.items = filterConnectors(
          Array.isArray(outcome.items) ? outcome.items : [],
          query,
          status,
        )
        outcome.total = outcome.items.length
        outcome.matchedTotal = outcome.items.length
      }
      groups.push(
        groupOf(record, outcome, function (item) {
          return { ...item, providerId: record.id }
        }),
      )
    }
    qualify(groups)
    return ok({
      groups: groups,
      items: flatten(groups),
      activeProviders: groups.map(function (group) {
        return group.providerId
      }),
      query: query,
      status: status,
    })
  }

  /** 单条连接器详情（4.2）：双键定位，缺 providerId 不代选，无明文密钥由 provider 保证。 */
  async function getConnector(params = {}) {
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    if (providerId === '') {
      return fail(
        CODES.PROVIDER_REQUIRED,
        '连接器详情必须带 providerId：同一 id 在不同库里可能是两个连接器',
        { field: 'providerId', registered: registry.ids() },
      )
    }
    const id = typeof params.id === 'string' ? params.id.trim() : ''
    if (id === '') return fail(CODES.PARAM_INVALID, '连接器详情必须带 id', { field: 'id' })
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    const record = registry.getRecord(providerId)
    if (record === undefined) return unknownProvider(registry, providerId)
    const outcome = await dispatcher.call({
      domain: 'connectorMarket',
      method: 'getConnector',
      providerId: providerId,
      params: { id: id },
    })
    if (outcome.ok === false) return outcome
    const item = outcome.item
    if (item === null || typeof item !== 'object') {
      return fail(
        CODES.CONNECTOR_NOT_FOUND,
        'provider ' + providerId + ' 没有连接器 ' + JSON.stringify(id),
        {
          providerId: providerId,
          id: id,
        },
      )
    }
    return ok({ item: { ...item, providerId: providerId } })
  }

  /** 连接器动作（4.2/4.3）：单 provider 派发；动作集合由 provider 内部收敛。 */
  async function connectorAction(params = {}) {
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    if (providerId === '') {
      return fail(
        CODES.PROVIDER_REQUIRED,
        '连接器动作必须带 providerId（授权状态按库隔离，写入必须落到确定的一家）',
        { field: 'providerId', registered: registry.ids() },
      )
    }
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    if (registry.getRecord(providerId) === undefined) return unknownProvider(registry, providerId)
    return dispatcher.call({
      domain: 'connectorMarket',
      method: 'connectorAction',
      providerId: providerId,
      params: { ...params, providerId: providerId },
    })
  }

  // ---------------------------------------------------------------- 账号域（组 4）

  /** 账号列表（4.5）：按 provider 分组；token 由 provider 脱敏，这里不碰。 */
  async function listAccounts(params = {}) {
    const targets = await targetGroups(params.sessionId, params.providers)
    if (targets.ok === false) return targets
    const groups = []
    for (const record of targets.items) {
      const outcome = await dispatcher.call({
        domain: 'account',
        method: 'listAccounts',
        providerId: record.id,
        params: {},
      })
      groups.push(
        groupOf(record, outcome, function (item) {
          return { ...item, providerId: record.id }
        }),
      )
    }
    qualify(groups)
    return ok({
      groups: groups,
      items: flatten(groups),
      activeProviders: groups.map(function (group) {
        return group.providerId
      }),
    })
  }

  /** 账号动作（4.5/4.6）：登录三段式、刷新均由 provider 内部落地并即时持久化。 */
  async function accountAction(params = {}) {
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    if (providerId === '') {
      return fail(
        CODES.PROVIDER_REQUIRED,
        '账号动作必须带 providerId（账号按库分目录存放，写入必须落到确定的一家）',
        { field: 'providerId', registered: registry.ids() },
      )
    }
    const admitted = assertProviderId(providerId)
    if (admitted.ok === false) return admitted
    if (registry.getRecord(providerId) === undefined) return unknownProvider(registry, providerId)
    return dispatcher.call({
      domain: 'account',
      method: 'accountAction',
      providerId: providerId,
      params: { ...params, providerId: providerId },
    })
  }

  return {
    listExperts,
    getExpert,
    listSkills,
    searchMemory,
    installSkill,
    listConnectors,
    getConnector,
    connectorAction,
    listAccounts,
    accountAction,
    _internals: { targetGroups, groupOf, qualify, filterConnectors, connectorStatusOf },
  }
}

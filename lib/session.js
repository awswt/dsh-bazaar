/**
 * Session state, one file per conversation, grouped by provider.
 *
 * Every conversation selects one expert per library and keeps its own skill
 * scope per library, so the on-disk shape is grouped rather than flat:
 *
 *   { schemaVersion, sessionId, revision, activeProviders, experts, skills, updatedAt }
 *
 *   experts.<providerId>  { id, plugin, version, displayName, root, source, ... }
 *   skills.<providerId>   { globalMode, globalNames, expertNames }
 *
 * `saveState()` is the only writer: it bumps `revision`, stamps `updatedAt`
 * and replaces the file atomically through `writeJsonAtomic`. Per-session
 * mutations are serialised by a promise queue, so two panels clicking at the
 * same time cannot interleave a read-modify-write.
 *
 * The child plugin is mounted before the previous one is disposed; its names
 * carry the generation suffix, so a failed switch leaves the previous persona
 * in place instead of tearing it down.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { PROVIDER_ID_PATTERN } from './provider/contract.js'
import { CODES, fail, ok } from './provider/errors.js'
import { SessionExpertPlugin } from './session-plugin.js'
import { ensureDir, nowIso, readJson, sha256, writeJsonAtomic } from './util.js'

const SCHEMA_VERSION = 2

function defaultSkills() {
  return { globalMode: 'all', globalNames: [], expertNames: [] }
}

function isProviderId(value) {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value)
}

function codedError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined && details !== null && typeof details === 'object') {
    Object.assign(error, details)
  }
  return error
}

function normalizeSkills(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  return {
    globalMode: source.globalMode === 'selected' ? 'selected' : 'all',
    globalNames: uniqueStrings(Array.isArray(source.globalNames) ? source.globalNames : []),
    expertNames: uniqueStrings(Array.isArray(source.expertNames) ? source.expertNames : []),
  }
}

function normalizeSkillsMap(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const skills = {}
  for (const [providerId, partition] of Object.entries(source)) {
    if (!isProviderId(providerId)) continue
    skills[providerId] = normalizeSkills(partition)
  }
  return skills
}

function normalizeExpertsMap(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const experts = {}
  for (const [providerId, ref] of Object.entries(source)) {
    if (!isProviderId(providerId)) continue
    if (ref === null || typeof ref !== 'object') continue
    experts[providerId] = { ...ref, displayName: displayNameOf(ref) }
  }
  return experts
}

function mergedSkills(skills) {
  const partitions = Object.entries(skills ?? {})
  if (partitions.length === 1) return { ...partitions[0][1] }
  const globalNames = []
  const expertNames = []
  let selected = false
  for (const [, partition] of partitions) {
    if (partition.globalMode === 'selected') selected = true
    for (const name of partition.globalNames) if (!globalNames.includes(name)) globalNames.push(name)
    for (const name of partition.expertNames) if (!expertNames.includes(name)) expertNames.push(name)
  }
  return { globalMode: selected ? 'selected' : 'all', globalNames, expertNames }
}

function countSkills(skills) {
  let total = 0
  for (const partition of Object.values(skills ?? {})) {
    total += (partition.globalMode === 'all' ? 0 : partition.globalNames.length) + partition.expertNames.length
  }
  return total
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    sessionId: state.sessionId,
    revision: state.revision,
    activeProviders: state.activeProviders.slice(),
    experts: Object.fromEntries(Object.entries(state.experts).map(([key, ref]) => [key, { ...ref }])),
    skills: Object.fromEntries(
      Object.entries(state.skills).map(([key, partition]) => [
        key,
        {
          globalMode: partition.globalMode,
          globalNames: partition.globalNames.slice(),
          expertNames: partition.expertNames.slice(),
        },
      ]),
    ),
    updatedAt: state.updatedAt,
  }
}

function restoreState(target, snapshot) {
  for (const key of Object.keys(target.experts)) delete target.experts[key]
  for (const key of Object.keys(target.skills)) delete target.skills[key]
  target.revision = snapshot.revision
  target.activeProviders = snapshot.activeProviders.slice()
  for (const [key, ref] of Object.entries(snapshot.experts)) target.experts[key] = { ...ref }
  for (const [key, partition] of Object.entries(snapshot.skills)) {
    target.skills[key] = {
      globalMode: partition.globalMode,
      globalNames: partition.globalNames.slice(),
      expertNames: partition.expertNames.slice(),
    }
  }
  target.updatedAt = snapshot.updatedAt
}

export class SessionManager {
  constructor(options) {
    this.ctx = options.ctx
    this.market = options.market
    this.bundles = options.bundles
    this.config = options.config ?? {}
    // Lazy: the domain views are built after this manager, but only used at
    // request time, so a getter keeps the construction order free.
    this.getViews = typeof options.getViews === 'function' ? options.getViews : () => undefined
    this.sessionsDir = path.join(this.config.dataDir, 'sessions')
    this.maxSelectedSkills = this.config.maxSelectedSkills ?? 64
    this.states = new Map()
    this.live = new Map()
    this.packages = new Map()
    this.warnings = new Map()
    this.queues = new Map()
    this.generation = 0
  }

  getAgent(sessionId) {
    try {
      return this.ctx.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  listAgents() {
    try {
      const agents = this.ctx.agents?.list?.()
      return Array.isArray(agents) ? agents : []
    } catch {
      return []
    }
  }

  defaultState(sessionId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      revision: 0,
      activeProviders: [],
      experts: {},
      skills: {},
      updatedAt: nowIso(),
    }
  }

  stateFile(sessionId) {
    return path.join(this.sessionsDir, sha256(sessionId) + '.json')
  }

  async loadState(sessionId) {
    const cached = this.states.get(sessionId)
    if (cached !== undefined) return cached
    const stored = await readJson(this.stateFile(sessionId), undefined)
    const state = this.normalizeState(stored, sessionId)
    this.states.set(sessionId, state)
    return state
  }

  normalizeState(value, sessionId) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return this.defaultState(sessionId)
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      revision: Number.isFinite(Number(value.revision)) ? Number(value.revision) : 0,
      activeProviders: uniqueStrings(Array.isArray(value.activeProviders) ? value.activeProviders : []).filter(isProviderId),
      experts: normalizeExpertsMap(value.experts),
      skills: normalizeSkillsMap(value.skills),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
    }
  }

  /** The only writer. Nothing else may touch the sessions directory. */
  async saveState(state) {
    state.revision += 1
    state.updatedAt = nowIso()
    await ensureDir(this.sessionsDir)
    await writeJsonAtomic(this.stateFile(state.sessionId), state)
    this.states.set(state.sessionId, state)
    return state
  }

  queue(sessionId, task) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(sessionId, next.catch(() => undefined))
    return next
  }

  warn(sessionId, providerId, message) {
    let bucket = this.warnings.get(sessionId)
    if (bucket === undefined) {
      bucket = new Map()
      this.warnings.set(sessionId, bucket)
    }
    bucket.set(providerId, message)
    this.ctx.logger?.warn?.('bazaar: %s', message)
  }

  clearWarning(sessionId, providerId) {
    const bucket = this.warnings.get(sessionId)
    if (bucket === undefined) return
    if (providerId === undefined) bucket.clear()
    else bucket.delete(providerId)
    if (bucket.size === 0) this.warnings.delete(sessionId)
  }

  warningList(sessionId) {
    const bucket = this.warnings.get(sessionId)
    if (bucket === undefined) return []
    return [...bucket.entries()].map(([providerId, message]) => ({ providerId, message }))
  }

  packageKey(sessionId, providerId) {
    return sessionId + '\u0000' + providerId
  }

  /**
   * Active-library set, read side of the provider registry adaptor.
   *
   * A session that never persisted state answers `undefined`, not `[]`: the
   * registry must tell "the user has not chosen yet" (seed from
   * `defaultProvider`) from "the user chose nothing" (an empty set stays
   * empty, no fallback). Collapsing both into `[]` either resurrects a
   * deselected library or silently swallows a misconfigured defaultProvider.
   */
  async readActive(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    try {
      if (this.states.has(sessionId) === false && existsSync(this.stateFile(sessionId)) === false)
        return undefined
      const state = await this.loadState(sessionId)
      return state.activeProviders.slice()
    } catch {
      return []
    }
  }

  /** Active-library set, write side of the provider registry adaptor. */
  writeActive(sessionId, providerIds) {
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      state.activeProviders = uniqueStrings(Array.isArray(providerIds) ? providerIds : [])
      await this.saveState(state)
      return ok({ sessionId, activeProviders: state.activeProviders.slice() })
    })
  }

  /** Registry hook: drop every trace of one library, keep the others intact. */
  async clearProvider(providerId) {
    if (!isProviderId(providerId)) {
      return fail(CODES.PARAM_INVALID, 'providerId 非法：' + JSON.stringify(providerId), { field: 'providerId' })
    }
    const sessions = new Set([
      ...this.states.keys(),
      ...this.live.keys(),
      ...this.warnings.keys(),
    ])
    let cleared = 0
    for (const sessionId of sessions) {
      const touched = await this.queue(sessionId, async () => {
        const state = await this.loadState(sessionId)
        const hadExpert = Object.hasOwn(state.experts, providerId)
        const hadSkills = Object.hasOwn(state.skills, providerId)
        const hadActive = state.activeProviders.includes(providerId)
        if (!hadExpert && !hadSkills && !hadActive) return false
        delete state.experts[providerId]
        delete state.skills[providerId]
        state.activeProviders = state.activeProviders.filter(id => id !== providerId)
        this.packages.delete(this.packageKey(sessionId, providerId))
        this.clearWarning(sessionId, providerId)
        await this.saveState(state)
        return true
      })
      if (touched !== true) continue
      cleared += 1
      if (!this.live.has(sessionId)) continue
      const state = await this.loadState(sessionId)
      await this.disposeLive(sessionId).catch(() => undefined)
      const agent = this.getAgent(sessionId)
      if (agent !== undefined && Object.keys(state.experts).length > 0) {
        await this.mount(agent, state).catch(error => {
          this.ctx.logger?.warn?.('bazaar: remount after unregister failed: %s', String(error))
        })
      }
    }
    return ok({ providerId, cleared })
  }

  /**
   * Resolve the library a request targets.
   *
   * An explicit id wins and is validated on its own. Without one we only
   * accept an unambiguous session: exactly one active library. Everything
   * else is a caller error, because guessing would write into someone else's
   * partition.
   */
  requireProviderId(state, explicit) {
    const wanted = typeof explicit === 'string' ? explicit.trim() : ''
    if (wanted !== '') {
      if (!isProviderId(wanted)) {
        throw codedError(CODES.PARAM_INVALID, 'providerId 非法：' + JSON.stringify(explicit), { field: 'providerId' })
      }
      return wanted
    }
    const active = state.activeProviders
    if (active.length === 1) return active[0]
    if (active.length === 0) {
      throw codedError(
        CODES.PROVIDER_REQUIRED,
        '尚未选择专家库：请在会话面板勾选一家库，或调用时传 provider 参数（providers 动作可列举当前集合）',
        { field: 'providerId' },
      )
    }
    throw codedError(
      CODES.PROVIDER_REQUIRED,
      '当前会话有 ' + active.length + ' 个活跃专家库，无法代为选择：请传 provider 参数',
      { field: 'providerId', activeProviders: active.slice() },
    )
  }

  /**
   * Resolve one expert entry and the payload used to mount it.
   *
   * The listing/detail layer already knows how to talk to every provider, so
   * we go through it when it is wired; the market/bundle pair stays as the
   * built-in provider's bundle expander (prompt text and shipped skills).
   */
  async resolveEntry(providerId, expertId) {
    const views = this.getViews()
    if (views !== undefined) {
      const detail = await views.getExpert({ providerId, id: expertId })
      if (detail.ok !== true) {
        // 本地包先于「查不到」：市场快照只收录上架条目，用户把专家下载到本地插件目录之后
        // 完全可能离线使用。门户不可达或快照里没有这个 id，都不等于本机没有这个专家。
        // packageFor 对内置库走 bundles.ensure，其中的 findLocal 会直接命中本地目录。
        const local = await this.findLocalEntry(providerId, expertId)
        if (local !== undefined) {
          return { item: local, pkg: await this.packageFor(providerId, local) }
        }
        throw codedError(detail.code ?? CODES.PROVIDER_THROWN, detail.message ?? '专家详情不可用', {
          providerId,
          expertId,
        })
      }
      return { item: detail.item, pkg: await this.packageFor(providerId, detail.item) }
    }
    const resolved = await this.resolveExpert(expertId)
    return { item: resolved.expert, pkg: await this.bundles.ensure(resolved.expert) }
  }

  /**
   * Expand one provider entry into prompt text and skills.
   *
   * Only the built-in provider ships a downloadable bundle; a provider that
   * hands out its instructions inline (the example provider does) is mounted
   * from what it returned.
   */
  /**
   * Look an expert up in the local plugin directories of the built-in provider.
   *
   * Only the built-in provider has local roots; a third-party provider owns its
   * own storage and must answer through getExpert. Returns undefined when the
   * id is not on disk, so the caller keeps the original market error.
   */
  async findLocalEntry(providerId, expertId) {
    const builtin = typeof this.config.providerId === 'string' ? this.config.providerId : 'workbuddy'
    if (providerId !== builtin || this.bundles === undefined) return undefined
    const needle = String(expertId ?? '').trim().toLowerCase()
    if (needle === '') return undefined
    const locals = await this.bundles.listLocal()
    return locals.find((item) => {
      return [item.id, item.plugin, item.agentName]
        .filter((value) => typeof value === 'string' && value !== '')
        .some((value) => value.toLowerCase() === needle)
    })
  }

  async packageFor(providerId, item) {
    const builtin = typeof this.config.providerId === 'string' ? this.config.providerId : 'workbuddy'
    if (providerId === builtin && this.bundles !== undefined) {
      const pkg = await this.bundles.ensure(item)
      return {
        version: pkg.version,
        displayName: pkg.displayName ?? item.displayName,
        root: pkg.root,
        prompt: pkg.prompt,
        skills: Array.isArray(pkg.skills) ? pkg.skills : [],
        source: pkg.source,
      }
    }
    const prompt = typeof item.prompt === 'string' ? item.prompt : ''
    return {
      version: item.version,
      displayName: item.displayName,
      root: typeof item.root === 'string' && item.root !== '' ? item.root : '',
      prompt,
      skills: Array.isArray(item.skills) ? item.skills : [],
      source: typeof item.source === 'string' ? item.source : providerId,
    }
  }

  async resolveExpert(idOrPlugin) {
    const needle = typeof idOrPlugin === 'string' ? idOrPlugin.trim() : ''
    if (needle !== '' && !needle.startsWith('ex_')) {
      const installed = await this.bundles.listLocal().catch(() => [])
      const hit = installed.find(item =>
        [item.id, item.plugin, item.agentName].some(value => String(value ?? '').toLowerCase() === needle.toLowerCase()),
      )
      if (hit !== undefined) return { expert: hit, stale: false, marketSource: 'local' }
    }
    try {
      return await this.market.getExpert(needle)
    } catch (error) {
      const local = await this.bundles.findLocal({ id: needle, plugin: needle, agentName: needle })
      if (local === undefined) throw error
      return {
        expert: { id: needle, plugin: needle, agentName: needle, displayName: needle },
        marketSource: 'local',
        stale: false,
      }
    }
  }

  /**
   * Select one expert inside one library's partition.
   *
   * `options.providerId` is the explicit library; without it the session must
   * have exactly one active library. A library that is not in the active set
   * is refused instead of silently activated, and a library that is not
   * selected yet becomes active together with its first expert.
   */
  selectExpert(sessionId, expertId, options) {
    const explicit = typeof options === 'string' ? options : options?.providerId
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      const before = cloneState(state)
      const providerId = this.requireProviderId(state, explicit)
      if (state.activeProviders.length > 0 && !state.activeProviders.includes(providerId)) {
        throw codedError(
          CODES.PROVIDER_REQUIRED,
          'provider ' + providerId + ' 不在本会话的活跃集里（当前：' + state.activeProviders.join(', ') + '）：请先在面板勾选该库',
          { field: 'providerId', providerId, activeProviders: state.activeProviders.slice() },
        )
      }
      const needle = typeof expertId === 'string' ? expertId.trim() : ''
      if (needle === '') {
        throw codedError(CODES.PARAM_INVALID, 'expertId 不能为空', { field: 'expertId' })
      }
      const { item, pkg } = await this.resolveEntry(providerId, needle)
      const partition = state.skills[providerId] ?? defaultSkills()
      const expertNames = (Array.isArray(pkg.skills) ? pkg.skills : [])
        .map(skill => skill.name)
        .filter(name => typeof name === 'string' && name !== '')
        .slice(0, this.maxSelectedSkills)
      const prompt = typeof pkg.prompt === 'string' ? pkg.prompt : ''
      state.experts[providerId] = {
        id: item.id,
        plugin: item.plugin ?? item.agentName ?? item.id,
        version: pkg.version ?? item.version,
        displayName: displayNameOf({ displayName: pkg.displayName ?? item.displayName, id: item.id }),
        root: pkg.root,
        source: pkg.source,
        promptChars: prompt.length,
        promptTruncated: false,
      }
      state.skills[providerId] = {
        globalMode: partition.globalMode,
        globalNames: partition.globalNames.slice(),
        expertNames,
      }
      if (!state.activeProviders.includes(providerId)) state.activeProviders.push(providerId)
      this.packages.set(this.packageKey(sessionId, providerId), { item, pkg })
      const agent = this.getAgent(sessionId)
      if (agent !== undefined) {
        try {
          await this.mount(agent, state)
        } catch (error) {
          restoreState(state, before)
          this.packages.delete(this.packageKey(sessionId, providerId))
          throw error
        }
      }
      await this.saveState(state)
      this.clearWarning(sessionId, providerId)
      return this.view(sessionId)
    })
  }

  /** Drop every selection of this session and unmount the child plugin. */
  clear(sessionId) {
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      await this.disposeLive(sessionId)
      state.activeProviders = []
      state.experts = {}
      state.skills = {}
      for (const key of [...this.packages.keys()]) {
        if (key.startsWith(sessionId + '\u0000')) this.packages.delete(key)
      }
      await this.saveState(state)
      this.clearWarning(sessionId)
      return this.view(sessionId)
    })
  }

  /**
   * Patch the skill scope of one library's partition.
   *
   * `patch.providerId` selects the library; without it the session must have
   * exactly one active library, so a scope change can never leak across
   * partitions.
   */
  setSkills(sessionId, patch, options) {
    const explicit = patch?.providerId ?? (typeof options === 'string' ? options : options?.providerId)
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      const providerId = this.requireProviderId(state, explicit)
      const current = state.skills[providerId] ?? defaultSkills()
      const mode = patch?.globalMode === 'selected'
        ? 'selected'
        : patch?.globalMode === 'all'
          ? 'all'
          : current.globalMode
      const globalNames = Array.isArray(patch?.globalNames)
        ? uniqueStrings(patch.globalNames).slice(0, this.maxSelectedSkills)
        : current.globalNames.slice()
      const expertNames = Array.isArray(patch?.expertNames)
        ? uniqueStrings(patch.expertNames).slice(0, this.maxSelectedSkills)
        : current.expertNames.slice()
      // Mutate the partition in place: a mounted child plugin holds this very
      // object as its live partition, so replacing it would leave that provider
      // reading a stale copy while the panel shows the new scope.
      const partition = state.skills[providerId]
      if (partition === undefined) {
        state.skills[providerId] = { globalMode: mode, globalNames, expertNames }
      } else {
        partition.globalMode = mode
        partition.globalNames = globalNames
        partition.expertNames = expertNames
      }
      if (!state.activeProviders.includes(providerId)) state.activeProviders.push(providerId)
      await this.saveState(state)
      this.live.get(sessionId)?.refresh?.()
      return this.view(sessionId)
    })
  }

  /**
   * Mount the child plugin with every selected library at once.
   *
   * The new fiber is registered before the old one is disposed, and every
   * registered name carries the generation suffix, so the switch is atomic from
   * the model's point of view.
   */
  async mount(agent, state) {
    const sessionId = agent.id
    const generation = String(++this.generation)
    const entries = []
    for (const [providerId, ref] of Object.entries(state.experts)) {
      const cached = this.packages.get(this.packageKey(sessionId, providerId))
      let pkg = cached?.pkg
      if (pkg === undefined) {
        try {
          pkg = await this.packageFor(providerId, ref)
          this.packages.set(this.packageKey(sessionId, providerId), { item: ref, pkg })
        } catch (error) {
          this.warn(
            sessionId,
            providerId,
            'expert "' + (ref.displayName ?? ref.id) + '" of provider ' + providerId + ' could not be restored: ' + (error instanceof Error ? error.message : String(error)),
          )
          continue
        }
      }
      // The partition must live in the state map: the child plugin keeps the
      // reference and later scope edits mutate that same object.
      let partition = state.skills[providerId]
      if (partition === undefined) {
        partition = defaultSkills()
        state.skills[providerId] = partition
      }
      entries.push({
        providerId,
        expert: ref,
        prompt: typeof pkg.prompt === 'string' ? pkg.prompt : '',
        expertSkills: Array.isArray(pkg.skills) ? pkg.skills : [],
        partition,
      })
    }
    let ready
    const fiber = await agent.ctx.plugin(SessionExpertPlugin, {
      state,
      experts: entries,
      // A thunk, not a snapshot: the merged scope changes on every panel edit
      // while the plugin keeps running, and the provider must see the new one.
      selection: () => mergedSkills(state.skills),
      globalSkills: this.ctx.skills,
      generation,
      onReady(handle) {
        ready = handle
      },
    })
    const previous = this.live.get(sessionId)
    this.live.set(sessionId, {
      fiber,
      state,
      entries,
      refresh: typeof ready?.refreshSkills === 'function' ? ready.refreshSkills : undefined,
      generation,
    })
    if (previous !== undefined) {
      try {
        await previous.fiber.dispose()
      } catch (error) {
        this.ctx.logger?.warn?.('bazaar: previous fiber dispose failed: %s', String(error))
      }
    }
  }

  async disposeLive(sessionId) {
    const live = this.live.get(sessionId)
    if (live === undefined) return
    this.live.delete(sessionId)
    await live.fiber.dispose()
  }

  view(sessionId) {
    const state = this.states.get(sessionId) ?? this.defaultState(sessionId)
    const live = this.live.get(sessionId)
    const experts = Object.entries(state.experts).map(([providerId, ref]) => ({ providerId, ...ref }))
    const skillsByProvider = Object.entries(state.skills).map(([providerId, partition]) => ({
      providerId,
      globalMode: partition.globalMode,
      globalNames: partition.globalNames.slice(),
      expertNames: partition.expertNames.slice(),
    }))
    const warnings = this.warningList(sessionId)
    return {
      sessionId,
      revision: state.revision,
      applied: live !== undefined,
      activeProviders: state.activeProviders.slice(),
      experts,
      expert: experts.length === 1 ? experts[0] : null,
      skills: mergedSkills(state.skills),
      skillsByProvider,
      skillCount: countSkills(state.skills),
      warning: warnings.length === 0 ? null : warnings.map(item => item.message).join('; '),
      warnings,
    }
  }

  async listSkills(sessionId, options) {
    const agent = this.getAgent(sessionId)
    if (agent === undefined) throw new Error('session is not live: ' + sessionId)
    const state = await this.loadState(sessionId)
    const live = this.live.get(sessionId)
    const cwd = agent.session?.header?.cwd ?? process.cwd()
    const global = await this.ctx.skills.list({ cwd, scope: undefined })
    const merged = mergedSkills(state.skills)
    const explicit = typeof options === 'string' ? options : options?.providerId
    const providerIds = explicit !== undefined && explicit !== ''
      ? [this.requireProviderId(state, explicit)]
      : Object.keys(state.experts)
    return {
      globalMode: merged.globalMode,
      global: global.map(skill => ({
        name: skill.name,
        description: skill.description,
        enabled: merged.globalMode === 'all' || merged.globalNames.includes(skill.name),
      })),
      expert: this.expertSkillList(live, state, providerIds),
      providers: this.providerSkillList(live, state),
    }
  }

  expertSkillList(live, state, providerIds) {
    const rows = []
    for (const entry of live?.entries ?? []) {
      if (!providerIds.includes(entry.providerId)) continue
      const partition = state.skills[entry.providerId] ?? defaultSkills()
      for (const skill of entry.expertSkills) {
        rows.push({
          name: skill.name,
          description: skill.description,
          providerId: entry.providerId,
          enabled: partition.expertNames.includes(skill.name),
        })
      }
    }
    return rows
  }

  providerSkillList(live, state) {
    return Object.keys(state.experts).map(providerId => {
      const entry = (live?.entries ?? []).find(candidate => candidate.providerId === providerId)
      const partition = state.skills[providerId] ?? defaultSkills()
      return {
        providerId,
        displayName: state.experts[providerId]?.displayName ?? providerId,
        globalMode: partition.globalMode,
        globalNames: partition.globalNames.slice(),
        expertNames: partition.expertNames.slice(),
        skills: (entry?.expertSkills ?? []).map(skill => ({
          name: skill.name,
          description: skill.description,
          enabled: partition.expertNames.includes(skill.name),
        })),
      }
    })
  }

  /**
   * Read-only snapshot for the composer panel.
   *
   * Unlike `listSkills`, this works before the session has an Agent: a blank
   * conversation can open the panel, pick an expert and toggle global skills.
   */
  async panelState(sessionId) {
    const state = await this.loadState(sessionId)
    const live = this.live.get(sessionId)
    const agent = this.getAgent(sessionId)
    const cwd = agent?.session?.header?.cwd ?? process.cwd()
    const merged = mergedSkills(state.skills)
    let global = []
    try {
      global = await this.ctx.skills.list({ cwd, scope: undefined })
    } catch {
      global = []
    }
    return {
      ...this.view(sessionId),
      globalSkills: global.map(skill => ({
        name: skill.name,
        description: skill.description,
        enabled: merged.globalMode === 'all' || merged.globalNames.includes(skill.name),
      })),
      expertSkills: this.expertSkillList(live, state, Object.keys(state.experts)),
    }
  }

  async onAgentCreated(agent) {
    return this.queue(agent.id, async () => {
      const state = await this.loadState(agent.id)
      if (Object.keys(state.experts).length === 0) return
      await this.mount(agent, state)
    })
  }

  onAgentDisposed(sessionId) {
    const live = this.live.get(sessionId)
    if (live !== undefined) {
      this.live.delete(sessionId)
      void live.fiber.dispose().catch(() => undefined)
    }
  }

  async reconcile() {
    for (const agent of this.listAgents()) {
      if (!this.live.has(agent.id)) {
        await this.onAgentCreated(agent).catch(() => undefined)
      }
    }
  }

  async disposeAll() {
    const entries = [...this.live.values()]
    this.live.clear()
    for (const entry of entries) {
      try {
        await entry.fiber.dispose()
      } catch {
        continue
      }
    }
  }
}

function displayNameOf(expert) {
  const value = expert.displayName
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return value.zh ?? value.en ?? expert.id
  return expert.id
}

function uniqueStrings(values) {
  return [...new Set(values.filter(item => typeof item === 'string' && item !== ''))]
}

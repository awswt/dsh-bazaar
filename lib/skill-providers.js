/**
 * Session-scoped skill providers.
 *
 * Two kinds of provider are installed through `agent.ctx`, both agent-scoped:
 *
 *   bazaar-expert-<providerId>-<gen>   rank 200   skills shipped by that library's expert
 *   bazaar-filter-<gen>               rank 1000  shadows every global skill and flips
 *                                                invocation flags for the session selection
 *
 * The generation suffix lets a switch mount the new child plugin before the old
 * one is disposed, so a failed switch leaves the previous persona intact. The
 * provider id is part of the expert provider name because one session can hold
 * one expert per library at the same time; the global filter stays single
 * because the global scope is not per library.
 *
 * The native `dsh-tool-skill` consumer reads the catalog with `scope: agent`,
 * so every provider here is visible to that agent only. No global skill file is
 * touched and no `skill` tool is shadowed.
 */

const EXPERT_RANK = 200
const FILTER_RANK = 1000
const HIDDEN = Object.freeze({ modelInvocable: false, userInvocable: false })

function nameSet(names) {
  return new Set(Array.isArray(names) ? names.filter(name => typeof name === 'string') : [])
}

function selectedSet(mode, names) {
  if (mode !== 'selected') return undefined
  return nameSet(names)
}

/**
 * Publish one library's expert skills to this agent.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx agent-scoped context
 * @param {Array<{name: string, description: string, whenToUse?: string, content: string, path?: string, root: string, invocation?: {modelInvocable: boolean, userInvocable: boolean}}>} expertSkills
 * @param {{expertNames: string[]}} partition that library's skill partition (live reference)
 * @param {string} providerId library id, part of the provider name
 * @param {string} suffix generation suffix
 * @returns {() => void} invalidates the provider catalog after a selection change
 */
export function installExpertSkillProvider(ctx, expertSkills, partition, providerId, suffix = '0') {
  if (!Array.isArray(expertSkills) || expertSkills.length === 0) return () => {}
  const providerName = `bazaar-expert-${providerId}-${suffix}`
  const namespace = `bazaar.expert.${providerId}`
  const byName = new Map(expertSkills.map(skill => [skill.name, skill]))
  let invalidate = () => {}

  const provider = {
    name: providerName,
    async list() {
      const enabled = nameSet(partition?.expertNames)
      return {
        candidates: expertSkills.map(skill => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          invocation: enabled.has(skill.name)
            ? (skill.invocation ?? { modelInvocable: true, userInvocable: true })
            : HIDDEN,
          source: 'custom',
          provider: providerName,
          namespace,
          path: skill.path,
          resourceBase: { kind: 'directory', path: skill.root },
          rank: EXPERT_RANK,
          locator: { name: skill.name },
        })),
        complete: true,
      }
    },
    async get(candidate) {
      if (!nameSet(partition?.expertNames).has(candidate.name)) return undefined
      const skill = byName.get(candidate.name)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.content,
        path: skill.path,
        resourceBase: { kind: 'directory', path: skill.root },
        invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
        source: 'custom',
        provider: providerName,
        namespace,
      }
    },
  }

  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    return provider
  })

  return () => invalidate()
}

/**
 * Shadow every skill in the global catalog with an agent-local candidate.
 *
 * - selected skill   -> keep the original invocation policy
 * - unselected skill -> both invocation flags false, so neither the model
 *                       catalog nor the `/name` gesture can see it
 *
 * `scope: undefined` reads the global layer only and avoids recursing into
 * this provider. The selection is the union of every library's partition:
 * a session with two libraries is in `selected` mode as soon as either one
 * narrowed its scope.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx agent-scoped context
 * @param {{snapshot: Function, get: Function}} globalSkills host-level skill registry
 * @param {{globalMode: 'all'|'selected', globalNames: string[]} | (() => {globalMode: 'all'|'selected', globalNames: string[]})} selection live merged selection, or a thunk that returns the current one
 * @param {string} suffix generation suffix
 * @returns {() => void} invalidates the provider catalog after a selection change
 */
export function installGlobalSkillFilter(ctx, globalSkills, selection, suffix = '0') {
  if (globalSkills === undefined || globalSkills === null) {
    throw new Error('bazaar: global skill registry is unavailable')
  }
  const providerName = `bazaar-filter-${suffix}`
  const selectionOf = typeof selection === 'function' ? selection : () => selection
  let invalidate = () => {}

  const provider = {
    name: providerName,
    async list(options) {
      const snapshot = await globalSkills.snapshot({
        cwd: options.cwd,
        signal: options.signal,
        scope: undefined,
      })
      const current = selectionOf()
      const enabled = selectedSet(current?.globalMode, current?.globalNames)
      return {
        candidates: snapshot.skills.map(skill => ({
          ...skill,
          rank: FILTER_RANK,
          locator: { name: skill.name },
          invocation: enabled === undefined || enabled.has(skill.name)
            ? skill.invocation
            : HIDDEN,
        })),
        complete: snapshot.complete,
      }
    },
    async get(candidate, options) {
      const current = selectionOf()
      const enabled = selectedSet(current?.globalMode, current?.globalNames)
      if (enabled !== undefined && !enabled.has(candidate.name)) return undefined
      return globalSkills.get(candidate.name, {
        cwd: options.cwd,
        signal: options.signal,
        scope: undefined,
      })
    },
  }

  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    return provider
  })

  return () => invalidate()
}

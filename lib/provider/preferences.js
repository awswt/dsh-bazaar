/**
 * Provider 的全局启用/禁用偏好：设置页「Provider 栏」开关的唯一落点。
 *
 * 为什么需要它，以及为什么它不放在会话状态里：
 * - 会话状态（lib/session.js）回答的是「这次对话用了哪几家库」，逐会话、可多选；
 * - 这里的开关回答的是「这台机器上允不允许这家库出现在界面里」，全局、只有一个答案。
 *   两者混在一起会立刻出现「A 会话禁用、B 会话启用」这种无法向用户解释的状态：
 *   设置页只有一个开关，它必须只有一个真相。
 *
 * 三条纪律：
 * 1. **缺省即启用**：偏好文件里没有某个 id = 这家库是启用的。新注册的 provider 不需要
 *    任何额外动作就能出现在面板上（否则「装了却看不见」会被当成插件坏了）。
 * 2. **只记显式 false**：写 true 时把该键删掉，文件里留下的永远是「被禁用过的库」。
 *    这样文件大小随禁用数量增长，而不是随注册过的库数量增长。
 * 3. **原子替换 + 串行写**：两个面板同时拨开关时不能出现半写文件。写入走
 *    「临时文件 + rename」，同一实例内的写入按 promise 队列串行。
 *
 * 本模块只碰 <dataDir>/preferences.json 一个文件，绝不 mkdir 任何 provider 子目录——
 * 「问了一句偏好就凭空多出目录」会破坏 spec 的目录隔离断言。
 */

import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { CODES, fail, ok } from './errors.js'
import { assertProviderId } from './paths.js'

const SCHEMA_VERSION = 1
const FILE_NAME = 'preferences.json'

function nowIso() {
  return new Date().toISOString()
}

/**
 * 原子写：先写同目录临时文件再 rename。读取方要么看到旧文件、要么看到新文件，
 * 不会看到半个 JSON——半份偏好最坏的后果是「所有库突然都被当成禁用」，界面全空。
 */
async function writeAtomic(fsImpl, file, value) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36)
  await fsImpl.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  await fsImpl.rename(temp, file)
}

/** 只留显式 false 的合法 id；其余一律丢弃（脏文件不能让界面变成一片空白）。 */
function normalize(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const raw = source.enabled !== null && typeof source.enabled === 'object' ? source.enabled : {}
  const enabled = {}
  for (const [id, flag] of Object.entries(raw)) {
    if (flag !== false) continue
    if (assertProviderId(id).ok !== true) continue
    enabled[id] = false
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : nowIso(),
  }
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir bazaar 数据根目录（与 settings.dataDir 同源）
 * @param {object} [deps.fs] 单测替换用（readFile / writeFile / rename / mkdir）
 */
export function createProviderPreferences(deps) {
  const dataDir = typeof deps?.dataDir === 'string' ? deps.dataDir.trim() : ''
  const fsImpl = deps?.fs ?? fsPromises
  const file = dataDir === '' ? '' : path.join(dataDir, FILE_NAME)
  /** 进程内缓存：偏好是全局小对象，每次读盘会让 settings 页每帧都等一次 IO。 */
  let cache = null
  /** 写串行链：两次拨开关不能交错成「后写的被先写的覆盖」。 */
  let chain = Promise.resolve()

  function enqueue(task) {
    const next = chain.then(task, task)
    chain = next.then(
      function () {
        return undefined
      },
      function () {
        return undefined
      },
    )
    return next
  }

  async function load() {
    if (cache !== null) return cache
    if (file === '') {
      cache = normalize(undefined)
      return cache
    }
    let raw
    try {
      raw = JSON.parse(await fsImpl.readFile(file, 'utf8'))
    } catch {
      raw = undefined
    }
    cache = normalize(raw)
    return cache
  }

  async function persist(state) {
    if (file === '') return
    await writeAtomic(fsImpl, file, state)
  }

  return {
    /** 偏好文件位置（设置页把它当「这些开关存在哪」的证据，只读展示）。 */
    file: file,

    /**
     * 是否启用。未记录 = 启用（见文件头第 1 条纪律）。
     * 读失败按启用处理：读不到偏好时把整站变空，比「多显示一家库」糟得多。
     */
    async isEnabled(providerId) {
      const admitted = assertProviderId(providerId)
      if (admitted.ok === false) return false
      const state = await load()
      return state.enabled[admitted.id] !== false
    },

    /** 显式禁用的 id 列表（设置页与诊断用；未列出的都是启用）。 */
    async disabledIds() {
      const state = await load()
      return Object.keys(state.enabled)
    },

    /** 批量过滤：返回 ids 里仍处于启用状态的那些，保持入参顺序。 */
    async filterEnabled(ids) {
      const list = Array.isArray(ids) ? ids : []
      const state = await load()
      return list.filter(function (id) {
        return typeof id === 'string' && state.enabled[id] !== false
      })
    },

    /**
     * 写一个开关。`enabled === true` 时删键（回到缺省），`false` 时记 false。
     * providerId 非法即拒，不落任何写入。
     */
    async setEnabled(providerId, enabled) {
      const admitted = assertProviderId(providerId)
      if (admitted.ok === false) return admitted
      if (typeof enabled !== 'boolean') {
        return fail(CODES.PARAM_INVALID, 'enabled 必须是布尔值', {
          field: 'enabled',
          providerId: admitted.id,
        })
      }
      return enqueue(async function () {
        const state = await load()
        const next = {
          schemaVersion: SCHEMA_VERSION,
          enabled: { ...state.enabled },
          updatedAt: nowIso(),
        }
        if (enabled === true) delete next.enabled[admitted.id]
        else next.enabled[admitted.id] = false
        await persist(next)
        cache = next
        return ok({ providerId: admitted.id, enabled: enabled })
      })
    },

    _internals: { normalize: normalize, SCHEMA_VERSION: SCHEMA_VERSION },
  }
}

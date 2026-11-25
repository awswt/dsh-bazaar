/**
 * 本地工具定义工厂。
 *
 * 为什么不直接用 `@deepseek-ai/dsh-tools` 的 `defineTool`：它是宿主内部包，一旦声明成
 * `dependencies`，包管理器就会在 profile 里装一份副本。副本自己的 `peerDependencies`
 * 精确锁在「安装当时的宿主版本」上；宿主升级之后，启动预检
 * （`dsh-app-boot` 的 `evaluatePluginCompatibility`）会按运行时版本判定这份副本不兼容，
 * 把它置成 `state: disabled`——于是 `tools` 服务没有提供者，所有依赖 tools 的插件一起
 * 挂起，宿主直接启动失败。这是 1.0.0 的真实事故，代价是用户整个 dsh 起不来。
 *
 * 工具定义只是普通数据：宿主 `ToolsService.register()` 接受的形态是
 * `{ name, description, parameters, output: { schema, render }, execute }`，其中
 * `parameters` 就是标准 JSON Schema。所以这里直接构造这个对象，不需要任何跨包身份，
 * 也就不需要把宿主内部包列为运行依赖。
 *
 * 与宿主实现的差异（刻意，由 `test/tool-def.test.mjs` 守住）：
 * - 参数 spec 展开成标准 JSON Schema（object 根），宿主与各 LLM 适配层都按这个形态消费；
 * - 参数校验只覆盖必填与标量类型——本插件的工具参数没有 enum / items / 嵌套对象，
 *   复刻一套完整的 JSON Schema 校验器只会引入与宿主不同的第二套语义。校验失败抛普通
 *   `Error`，照旧被工具自身的 try/catch 折成 `ERROR: ...` 文本；
 * - 不支持宿主独有的呈现钩子语义，只做透传。
 *
 * 新增工具参数若需要 enum / items / 嵌套对象，先在本文件扩展展开规则并补用例，
 * 不要在调用点手写已经展开的 schema——判定必须只有一处。
 */

/** 本插件工具参数用到的标量类型。扩展前先看本文件开头的差异说明。 */
const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean'])

/**
 * 把「逐属性声明」展开成标准 JSON Schema。
 *
 * 输入形态与宿主一致：`{ action: { type: 'string', required: true, description } }`。
 * `required` 是声明级标志，不属于 JSON Schema 的属性描述，展开时要摘掉。
 *
 * @param spec - 逐属性声明表。
 * @returns `{ type: 'object', properties, required? }`。
 */
function parametersToJsonSchema(spec) {
  if (spec === undefined) return { type: 'object', properties: {} }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('defineTool(options): parameters must be a plain object of property specs')
  }
  const properties = {}
  const required = []
  for (const key of Object.keys(spec)) {
    const declared = spec[key]
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new TypeError(`defineTool(options): parameter "${key}" must be a plain object`)
    }
    // 显式解构而不是 delete：声明对象可能被调用方复用，不能改写它。
    const { required: isRequired, ...rest } = declared
    if (rest.type !== undefined && !SCALAR_TYPES.has(rest.type)) {
      throw new TypeError(
        `defineTool(options): parameter "${key}" declares unsupported type "${rest.type}" ` +
          `(supported: ${[...SCALAR_TYPES].join(', ')})`,
      )
    }
    properties[key] = { ...rest }
    if (isRequired === true) required.push(key)
  }
  return required.length === 0
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/**
 * 逐个参数比对声明，返回路径式违规列表（空数组表示通过）。
 *
 * 模型生成的参数可能整体不是对象（`null`、字符串、数组），也可能多带未声明字段；
 * 前者拒绝，后者放行——多出来的字段不影响本插件的取值逻辑，为此报错只会制造噪声。
 *
 * @param schema - `parametersToJsonSchema()` 的产物。
 * @param args - 未受信的候选参数。
 * @returns 违规描述列表。
 */
function argsViolationsOf(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be an object']
  }
  const violations = []
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) violations.push(`${key} is required`)
  }
  for (const key of Object.keys(schema.properties)) {
    const value = args[key]
    if (value === undefined) continue
    const { type } = schema.properties[key]
    if (type === undefined) continue
    let ok
    if (type === 'string') ok = typeof value === 'string'
    else if (type === 'boolean') ok = typeof value === 'boolean'
    else if (type === 'integer') ok = Number.isInteger(value)
    else ok = typeof value === 'number' && Number.isFinite(value)
    if (!ok) violations.push(`${key} must be ${type}`)
  }
  return violations
}

/**
 * 可选钩子的透传表：宿主认得这些键就继续用，不认得也不会被本工厂吞掉。
 * 本插件当前一个都没用到，保留是为了新增工具时不必再改这里。
 */
const PASSTHROUGH_KEYS = [
  'finalizeContent',
  'projectContent',
  'presentCall',
  'presentResult',
  'isConcurrencySafe',
]

/**
 * 定义一个工具。
 *
 * 返回值的形状就是宿主 `ToolsService.register()` 直接吃的定义对象，调用点照旧写
 * `ctx.tools.register(defineTool({ ... }))`。
 *
 * @param options - `{ name, description, parameters, output: { schema, render }, execute }`。
 * @returns 可直接注册的工具定义。
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('defineTool(options): options must be an object')
  }
  const { name, description, parameters, output } = options
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('defineTool(options): name must be a non-empty string')
  }
  // run_code 是 PTC 模式的呈现传输保留名，宿主也会拒；在这里提前拒能更早暴露笔误。
  if (name === 'run_code') {
    throw new Error(`defineTool: tool name "${name}" is reserved and cannot be registered`)
  }
  if (typeof options.execute !== 'function') {
    throw new TypeError(`defineTool(${name}): execute must be a function`)
  }
  if (output === null || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError(`defineTool(${name}): output must be { schema, render }`)
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`defineTool(${name}): timeoutMs must be a positive finite number`)
    }
  }
  const parameterSchema = parametersToJsonSchema(parameters)
  const userExecute = options.execute
  const userRender = output.render

  const tool = {
    name,
    description,
    parameters: parameterSchema,
    output: {
      schema: output.schema ?? { type: 'string' },
      render: (args, value) => userRender(args, value),
    },
    async execute(args, exec) {
      const violations = argsViolationsOf(parameterSchema, args)
      if (violations.length > 0) {
        throw new Error(`${name}: invalid arguments: ${violations.join('; ')}`)
      }
      return userExecute(args, exec)
    },
  }
  if (output.presentationMeta !== undefined) tool.output.presentationMeta = output.presentationMeta
  if (options.deferLoading !== undefined) tool.deferLoading = options.deferLoading
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  for (const key of PASSTHROUGH_KEYS) {
    if (options[key] !== undefined) tool[key] = options[key]
  }
  return tool
}

## Purpose

定义 bazaar 的 provider 契约与注册表：第三方或内置上游以 `apiVersion: 1` 的声明式契约注册进插件，插件在注册时校验契约版本、`providerId` 白名单与能力声明，并把「账号、凭据、缓存、会话状态」按 `providerId` 分区隔离。注册表是界面页签、模型工具、斜杠命令与 HTTP 路由共同的唯一数据源——所有入口读同一份已注册集合与活跃集合，不各自推断。

## ADDED Requirements

### Requirement: provider 契约必须声明 apiVersion 为 1

注册进 bazaar 的 provider SHALL 在声明中携带 `apiVersion` 字段，本版唯一合法值为 `1`。注册表 MUST 在登记前校验该字段：缺失或不为 `1` 时 MUST 拒绝注册并返回 `BAZAAR_PROVIDER_API_VERSION`，且 MUST NOT 留下任何半登记状态（既不出现在列举结果中，也不占用该 `id`）。

provider 声明中的其余必填字段为 `id`、`displayName`、`capabilities`，缺失任一字段时 MUST 拒绝注册，错误信息 MUST 指明缺失的字段名。

#### Scenario: 契约版本不符被拦下

- **WHEN** 某 provider 以 `apiVersion: 2` 调用 `bazaar.providers.register`
- **THEN** 注册被拒绝，返回错误码 `BAZAAR_PROVIDER_API_VERSION`
- **THEN** `bazaar.providers.list()` 的结果中不含该 `id`
- **THEN** 以同一 `id` 携带 `apiVersion: 1` 再次注册可以成功（版本不符未占用该 id）

#### Scenario: 缺失必填字段被拦下

- **WHEN** 某 provider 声明 `apiVersion: 1` 与合法 `id`，但未提供 `displayName` 或 `capabilities`
- **THEN** 注册被拒绝，错误信息中指出缺失的字段名（`displayName` 或 `capabilities`）
- **THEN** 该 `id` 仍可被后续携带完整字段的注册占用

#### Scenario: 合法声明被放行

- **WHEN** 某 provider 声明 `apiVersion: 1`、`id: demo`、`displayName: '示例专家库'`、`capabilities: { expertMarket: true }`
- **THEN** 注册成功，`bazaar.providers.get('demo')` 返回该声明
- **THEN** 该 provider 只声明了专家市场，技能市场、记忆市场、连接器市场、账号五域在其注册记录中标记为未声明

#### Scenario: 同一注册意图经三种入口判定一致

- **WHEN** 依次通过插件启动时的自动注册、用户手动触发的注册、以及热更新后重新加载三条路径注册同一份 `apiVersion: 1` 声明
- **THEN** 三条路径的判定结果一致（均成功），且 `bazaar.providers.list()` 中该 `id` 只出现一次
- **THEN** 三条路径对 `apiVersion: 2` 的同一份声明均返回 `BAZAAR_PROVIDER_API_VERSION`

### Requirement: provider 必须同时提供声明面与行为面

provider 契约 MUST 由声明面（元信息）与行为面（承载域方法的 `impl` 对象）两部分组成。凡 `capabilities.<域> === true` 的域，`impl.<域>` MUST 存在且其必需方法 MUST 为函数。

校验 MUST 在登记前完成：缺任一必需方法时 MUST 拒绝注册并返回 `BAZAAR_PROVIDER_IMPL_MISSING`，信息 MUST 同时指明 `providerId`、域与缺失方法名，且 MUST NOT 留下半登记状态。域方法 MUST 为异步函数、接受单个普通对象入参、返回平铺 JSON；失败 MUST 以 `{ok:false, code, message}` 表达而 MUST NOT 抛异常穿透。

#### Scenario: 声明了域但缺行为面被拦下

- **WHEN** 某 provider 声明 `capabilities: { skillMarket: true }`，但 `impl` 只提供 `listSkills` 而未提供 `installSkill`
- **THEN** 注册被拒绝，返回 `BAZAAR_PROVIDER_IMPL_MISSING`，信息中同时含该 `providerId`、`skillMarket` 与 `installSkill`
- **THEN** `bazaar.providers.list()` 中不含该 `id`

#### Scenario: 未声明的域不要求行为面

- **WHEN** 某 provider 只声明 `capabilities: { expertMarket: true }`，`impl` 仅提供 `expertMarket.listExperts` 与 `expertMarket.getExpert`
- **THEN** 注册成功，不因缺少 `skillMarket`/`memoryMarket`/`connectorMarket`/`account` 的方法而被拒

#### Scenario: 域方法以返回码表达失败而不抛异常

- **WHEN** 调用某 provider 的 `expertMarket.listExperts` 且其上游返回鉴权失败
- **THEN** 该调用正常返回一个对象，其 `ok` 为 `false` 且带 `code`（如 `BAZAAR_MARKET_AUTH_REQUIRED`）与 `message`
- **THEN** 注册表与路由层不因该返回值而抛出未捕获异常

#### Scenario: 行为面经三条入口判定一致

- **WHEN** 分别通过模型工具、HTTP 路由与面板操作触发同一 provider 的 `listExperts`
- **THEN** 三条入口都调用同一个 `impl.expertMarket.listExperts`，返回的条目集合与 `source` 字段一致

### Requirement: 五域各自的必需方法集合

每个能力域的必需方法 MUST 为：`expertMarket` 需 `listExperts` 与 `getExpert`；`skillMarket` 需 `listSkills` 与 `installSkill`；`memoryMarket` 需 `listMemorySkills` 与 `searchMemory`；`connectorMarket` 需 `listConnectors`、`getConnector` 与 `connectorAction`；`account` 需 `listAccounts` 与 `accountAction`。

方法 MUST 为异步函数、接受单个普通对象入参、返回平铺 JSON；失败 MUST 以 `{ ok: false, code, message }` 表达而不抛异常穿透。返回体 MUST 复用既有领域结构，MUST NOT 为同一语义另立平行 DTO；外层只补 `providerId` 与 `qualifiedName` 两个字段。各方法的入参与返回字段名见下方场景。

#### Scenario: 五域方法的入参与返回字段名固定

- **WHEN** 任一 provider 实现五域方法
- **THEN** 入参名与可选性 MUST 与下方列举一致：`listExperts({query?,categoryId?,page?,pageSize?})`；`getExpert({id})`；`listSkills({query?,page?,pageSize?})`；`installSkill({skillId,force?})`（`skillId` 是市场技能 id；`slug` 是 `skillSlug()` 从市场元数据推导出的落盘名，属返回体字段而非入参）；`listMemorySkills({query?,page?,pageSize?})`；`searchMemory({query,limit?})`；`listConnectors({query?,status?})`；`getConnector({id})`；`connectorAction({action,id?,params?})`；`listAccounts({})`；`accountAction({action,accountId?,region?,token?,loginId?})`
- **THEN** 返回体字段名 MUST 与下方列举一致：`listExperts` 返回 `{items,total,source,warning?}`；`getExpert` 返回 `{item}`；`listSkills` 与 `listMemorySkills`、`searchMemory` 返回 `{items,total}`；`installSkill` 返回 `{slug,installedPath,providerId}`；`listConnectors` 返回 `{items,total,categories}`；`getConnector` 返回 `{item}`；`connectorAction` 与 `accountAction` 返回 `{action,result}`；`listAccounts` 返回 `{own,all,pending,summary}`
- **THEN** 同一语义的条目结构在各 provider 之间一致，调用方无需按 provider 分支解析

#### Scenario: 缺一个必需方法即被拒

- **WHEN** 某 provider 声明 `capabilities: { connectorMarket: true }`，`impl.connectorMarket` 只提供 `listConnectors` 与 `getConnector`，未提供 `connectorAction`
- **THEN** 注册被拒绝，返回 `BAZAAR_PROVIDER_IMPL_MISSING`，信息中指出 `connectorMarket` 与 `connectorAction`

#### Scenario: 必需方法齐备时放行

- **WHEN** 某 provider 声明 `capabilities: { account: true }`，`impl.account` 提供 `listAccounts` 与 `accountAction`
- **THEN** 注册成功，该域的入口动作均可正常进入实现
#### Scenario: 额外方法与契约版本演进

- **WHEN** 某 provider 以 `apiVersion: 1` 注册，其 `impl.expertMarket` 除 `listExperts` 与 `getExpert` 外还提供了额外方法 `rankExperts`
- **THEN** 注册放行（额外方法既不构成缺方法，也不构成版本不符）
- **THEN** 该额外方法不进入本版契约承诺：调用方 MUST NOT 依赖它，插件 MUST NOT 把它接进任何入口
- **THEN** 若要新增或删除任一必需方法，MUST 提升 `apiVersion` 并在 spec 中登记新版本的必需方法集合；在 `apiVersion: 1` 下静默增删必需方法 MUST 被视为破坏性变更

#### Scenario: 返回体不另立 DTO

- **WHEN** 内置 provider 与示例 provider 都返回专家列表
- **THEN** 两个返回体的条目字段集合相同（复用同一专家结构），差异只在 `providerId` 与 `qualifiedName`
- **THEN** 调用方无需按 provider 分支解析返回值

### Requirement: providerId 必须匹配白名单

`providerId` SHALL 匹配 `^[a-z][a-z0-9-]{0,31}$`，即小写字母开头、仅含小写字母/数字/连字符、长度不超过 32。注册表 MUST 在登记前校验；不匹配时 MUST 拒绝注册并返回 `BAZAAR_PROVIDER_INVALID_ID`。

该校验是路径穿越防线：`providerId` 直接参与数据目录与凭证名的拼装，未通过校验的取值 MUST NOT 出现在任何文件路径中。

#### Scenario: 含路径穿越片段的 id 被拦下

- **WHEN** 某 provider 以 `id: '../workbuddy'`、`id: 'WorkBuddy'`、`id: 'work_buddy'` 或长度 33 的 id 尝试注册
- **THEN** 每次注册均被拒绝，返回 `BAZAAR_PROVIDER_INVALID_ID`
- **THEN** `<DSH_HOME>/bazaar/providers/` 下不新增任何目录

#### Scenario: 合法 id 被放行

- **WHEN** 某 provider 以 `id: workbuddy`、`id: my-lib-2`、`id: a` 尝试注册
- **THEN** 注册成功，且该 id 对应的数据目录为 `<DSH_HOME>/bazaar/providers/<id>/`
- **THEN** 该 id 对应的默认凭证名为 `BAZAAR_<ID>_TOKEN`（id 中的连字符转为下划线并大写，如 `MY-LIB-2` → `BAZAAR_MY_LIB_2_TOKEN`）

#### Scenario: 同一 provider 经不同入口查询结果一致

- **WHEN** 分别用模型工具的列举动作、`GET /dsh-bazaar/providers`、以及会话状态文件中的 `activeProviders` 去解析同一个 `providerId`
- **THEN** 三处对该 id 的合法性判定一致：合法 id 三处均可解析，非法 id 三处在自己的入口处各自拒绝（注册时未被登记者不会出现在任何列举结果中）

### Requirement: 能力声明决定可用域与界面呈现

provider SHALL 通过 `capabilities` 逐域声明自己的能力，键为 `expertMarket`、`skillMarket`、`memoryMarket`、`connectorMarket`、`account`。

未声明的域 MUST NOT 出现在任何界面区域中，且对该域的调用 MUST 返回 `BAZAAR_CAPABILITY_UNDECLARED` 并指明该 provider 与缺失的域名。声明了某域但当前无数据时 MUST 返回空结果，MUST NOT 返回错误。

#### Scenario: 未声明域的调用被拦下

- **WHEN** 某 provider 只声明 `capabilities: { expertMarket: true }`，调用方请求该 provider 的技能安装
- **THEN** 返回 `BAZAAR_CAPABILITY_UNDECLARED`，错误信息中含该 `providerId` 与 `skillMarket`
- **THEN** 该 provider 的界面分区中不出现技能市场区块

#### Scenario: 已声明域的空数据被放行

- **WHEN** 某 provider 声明了 `skillMarket`，但其技能列表当前为空
- **THEN** 返回空列表与成功状态，不返回 `BAZAAR_CAPABILITY_UNDECLARED`
- **THEN** 该 provider 的技能区块显示空态文案，而不是错误态

#### Scenario: 声明了账号但用户未登录被放行

- **WHEN** 某 provider 声明了 `account`，当前无任何已登录账号
- **THEN** 账号区返回未登录状态与登录入口，不返回 `BAZAAR_CAPABILITY_UNDECLARED`
- **THEN** 该 provider 的其他已声明域（如专家市场）仍可正常返回公开数据

#### Scenario: 同一能力判断在面板与工具路径上一致

- **WHEN** 分别经面板渲染、模型工具调用、HTTP 路由查询三条路径访问某 provider 未声明的 `connectorMarket`
- **THEN** 三条路径均以 `BAZAAR_CAPABILITY_UNDECLARED` 结束，且错误信息中的 `providerId` 与域名一致

### Requirement: 注册表提供注册、注销、列举与查询

注册表 SHALL 在 `ctx.bazaar` 上暴露 `providers.register`、`providers.unregister`、`providers.list`、`providers.get` 四个方法。

`register` 成功后 MUST 立即可被 `list` 与 `get` 观察到；`unregister` 成功后 MUST 从 `list` 中消失、`get` 返回未注册，且该 provider 的活跃状态与会话状态条目 MUST 一并清除。同一 `id` 重复注册 MUST 返回 `BAZAAR_PROVIDER_DUPLICATE`；注销后同一 `id` 重新注册 MUST 被允许并按全新注册处理。

清除 MUST 走唯一写入口 `saveState()`（原子写 + 按会话串行队列），按 `providerId` 只清 `activeProviders`/`experts`/`skills` 中该库的分区，其它 provider 条目 MUST 原样保留；MUST NOT 依赖读侧 `normalizeState()` 的过滤替代写侧清除。

#### Scenario: 重复注册被拦下

- **WHEN** 已存在 `id: workbuddy` 的注册记录，再次以同一 `id` 注册
- **THEN** 第二次注册被拒绝，返回 `BAZAAR_PROVIDER_DUPLICATE`
- **THEN** 原有注册记录保持不变，`bazaar.providers.get('workbuddy')` 仍返回首次注册的声明

#### Scenario: 注销时只清该 provider 的会话条目

- **WHEN** 会话中 `activeProviders` 为 `['workbuddy','demo']`、两库各有一个已选专家，此时 `unregister('demo')`
- **THEN** 落盘后的会话状态中 `activeProviders` 只剩 `['workbuddy']`，`experts` 与 `skills` 不再含 `demo` 分区
- **THEN** `workbuddy` 的 `activeProviders` 条目、已选专家与技能范围逐字段保持原值，且写入经 `saveState()` 完成一次原子替换

#### Scenario: 注销后同名重新注册被放行

- **WHEN** 先 `unregister('demo')`，随后以同一 `id: demo` 重新注册
- **THEN** 重新注册成功，`list()` 中 `demo` 出现一次
- **THEN** 该 provider 在会话状态中的旧条目已随注销清除，重新注册后该会话的 `activeProviders` 中不含 `demo`（需用户重新选择）

#### Scenario: 注销后旧路由与旧页签不残留

- **WHEN** 卸载一个已注册 provider，随后重新渲染设置页与会话面板
- **THEN** 设置页不再出现该 provider 的页签，会话面板不再出现该 provider 的分区
- **THEN** 指向该 provider 的 HTTP 路由返回 `BAZAAR_PROVIDER_UNKNOWN`，而不是 404 或静默空结果

#### Scenario: 四个方法对同一集合的观察一致

- **WHEN** 先注册 A 与 B，再注销 A，随后分别调用 `list()`、`get('A')`、`get('B')` 与直接读取 HTTP 列举路由
- **THEN** `list()` 与 HTTP 列举路由均只含 B；`get('A')` 返回 `BAZAAR_PROVIDER_UNKNOWN`；`get('B')` 返回 B 的声明

### Requirement: 各 provider 的凭据、数据目录与缓存必须相互隔离

注册表 MUST NOT 向任何 provider 传递其他 provider 的凭证、数据目录或缓存。凭证名 MUST 由 `providerId` 推导（默认 `BAZAAR_<ID>_TOKEN`，可由 `credentialRef` 覆盖）；数据目录 MUST 为 `<DSH_HOME>/bazaar/providers/<providerId>/`，其下含 `accounts`、`vault`、`cache` 三个子目录。

以 A provider 身份读取 B provider 的凭证或目录 MUST 被拒绝。同一 provider 下切换多个账号 MUST 被允许。

#### Scenario: 跨 provider 读取凭据被拦下

- **WHEN** `id: alpha` 的 provider 在解析凭证时请求 `BAZAAR_BETA_TOKEN`（即另一个已注册 provider 的凭证名）
- **THEN** 该请求被拒绝，错误信息指明凭证归属的 `providerId` 与请求方不一致
- **THEN** `alpha` 自己的凭证解析不受影响

#### Scenario: 同 provider 多账号切换被放行

- **WHEN** `id: workbuddy` 下已登录两个账号，用户从账号一切换到账号二
- **THEN** 切换成功，两个账号的记录分别位于 `<DSH_HOME>/bazaar/providers/workbuddy/accounts/` 下的不同文件中
- **THEN** 切换后 `alpha` 等其他 provider 的账号记录未被读写

#### Scenario: 无凭证的 provider 被放行

- **WHEN** 某示例 provider 未声明 `account` 且不声明凭证名，直接请求公开数据
- **THEN** 请求按其声明的 `allowHosts` 正常发出，不因缺少凭证而报错
- **THEN** 该 provider 的 `vault` 目录不被创建

#### Scenario: 目录归属在三条路径上一致

- **WHEN** 分别经设置页缓存清理、模型工具账号动作、HTTP 账号路由去读写 `id: workbuddy` 的数据
- **THEN** 三条路径解析出的目录均为 `<DSH_HOME>/bazaar/providers/workbuddy/` 下的对应子目录，无一条路径落到 `<DSH_HOME>/bazaar/providers/` 根或其他 provider 目录

### Requirement: 当前 provider 集合是唯一的取值来源

`defaultProvider` SHALL 默认为空。新会话的 `activeProviders` MUST 初始为空。

当 `activeProviders` 为空时：面板 MUST 显示「尚未选择专家库」空态；模型工具在未传 `provider` 时 MUST 返回 `BAZAAR_PROVIDER_REQUIRED` 引导错误，MUST NOT 静默回落到首个已注册 provider；斜杠命令与 HTTP 路由 MUST 采用同一判定。

当配置中的 `defaultProvider` 指向未注册的 id 时，系统 MUST 报出 `BAZAAR_PROVIDER_UNKNOWN` 并回落到首个已注册 provider（按时注册顺序的首个），同时在面板显示提示。

#### Scenario: 空活跃集时工具调用被拦下

- **WHEN** 某会话的 `activeProviders` 为空，调用 `bazaar_helper` 且未传 `provider`
- **THEN** 返回 `BAZAAR_PROVIDER_REQUIRED`，错误信息含「尚未选择专家库」引导文案
- **THEN** 不返回任何 provider 的专家列表（不回落首个已注册）

#### Scenario: 默认 provider 指向未注册 id 被拦下并回落

- **WHEN** 配置 `defaultProvider: ghost`，而注册表中只有 `workbuddy`
- **THEN** 系统报出 `BAZAAR_PROVIDER_UNKNOWN`，并在面板显示「默认专家库 ghost 未注册」提示
- **THEN** 新会话的 `activeProviders` 回落为 `['workbuddy']`，工具调用可正常返回 workbuddy 的数据

#### Scenario: 显式清空活跃集被放行

- **WHEN** 某会话原本 `activeProviders: ['workbuddy','demo']`，用户取消勾选全部 provider
- **THEN** 写入成功，`activeProviders` 变为 `[]`，`revision` 递增
- **THEN** 再次查询返回空态，不返回错误

#### Scenario: 面板、工具、命令、路由读取同一集合

- **WHEN** 会话活跃集为 `['workbuddy']`，分别触发面板专家列表、`bazaar_helper` 的专家动作、`/bazaar expert` 命令与 `GET /dsh-bazaar/state`
- **THEN** 四处呈现/返回的 provider 集合均为 `['workbuddy']`
- **THEN** 在面板勾选加入 `demo` 后再次触发上述四处，四处均为 `['workbuddy','demo']`

### Requirement: 设置页与面板的 provider 区域由注册表驱动并标注状态

设置页 MUST 为每个已注册 provider 渲染一个页签，页签标题取 `displayName`（存在 `icon` 时一并渲染）；会话面板顶部 MUST 为每个已注册且声明了对应域的 provider 渲染一个多选开关。该开关组 MUST NOT 标记为必填——全不勾选是合法空态，设置页与面板 MUST NOT 因未选择任何 provider 而阻止浏览。

界面 MUST 明确标注以下状态：provider 列举进行中（加载中）、列举失败（错误态 + 重试入口）、无任何已注册 provider（空态，含「尚未选择专家库」引导）、某 provider 单域故障（仅该 provider 分区内的错误态 + 重试入口，其他分区不受影响）。

#### Scenario: 无已注册 provider 时显示空态

- **WHEN** 注册表为空时打开设置页
- **THEN** 页面显示空态文案与「暂无可用专家库」说明，不渲染任何页签
- **THEN** 不显示错误态，也不显示加载中

#### Scenario: 单个 provider 加载失败只影响自身分区

- **WHEN** `workbuddy` 与 `demo` 均已注册，`demo` 的专家列表请求失败
- **THEN** `demo` 分区显示错误态文案与该分区内的重试按钮
- **THEN** `workbuddy` 分区正常显示专家列表，页面整体不显示错误，`demo` 分区不被隐藏

#### Scenario: 客户端绕过禁用态直接提交被服务端拒绝

- **WHEN** 某 provider 的账号区处于「未登录」禁用态（凭据未配置），客户端绕过界面直接调用该 provider 的账号刷新动作
- **THEN** 服务端返回明确错误（凭据未配置类错误码），而非静默成功
- **THEN** 该 provider 的账号区在下次渲染时仍为未登录态，未产生账号记录

#### Scenario: 页签切换不改变其他 provider 的加载状态

- **WHEN** 设置页有 `workbuddy`、`demo`、`beta` 三个页签，`beta` 正在加载中，用户切到 `workbuddy` 页签
- **THEN** `workbuddy` 页签内容完整呈现
- **THEN** 切回 `beta` 时其加载中状态仍然有效，不因切换被重置为成功或错误

### Requirement: 注册到会话可见的完整链路

从 provider 注册到模型可用 MUST 构成一条可逐字段验证的链路：注册 → 列举 → 面板页签与开关渲染 → 会话活跃集落盘 → 系统提示注入 → 模型工具可见。

该链路中每一步的产出 MUST 可被下一跳观察到，且任一步失败 MUST NOT 让后续步骤呈现出「成功」的假象。

#### Scenario: 注册后经五跳到达模型工具

- **WHEN** 以 `apiVersion: 1` 注册 `id: demo`（声明 `expertMarket`），随后打开设置页、在会话面板勾选 `demo`、并查询该会话状态与工具列举
- **THEN** `bazaar.providers.list()` 返回的 `demo` 条目含 `id: 'demo'`、`displayName`、`capabilities.expertMarket: true`
- **THEN** 设置页出现标题为 `displayName` 的 `demo` 页签；会话面板顶部出现 `demo` 开关且为已勾选
- **THEN** `<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json` 中 `activeProviders` 含 `'demo'`，`revision` 大于写入前的值，`updatedAt` 为本次写入时间
- **THEN** 该会话的系统提示中只包含 `demo` 已选专家的内容区块，不含 `workbuddy` 的专家区块
- **THEN** `bazaar_helper` 的 `providers` 动作返回的 `demo` 条目 `active: true`

#### Scenario: 链路中途失败不产生假成功

- **WHEN** 注册 `demo` 成功，但活跃集写入失败（会话状态文件不可写）
- **THEN** 面板显示写入失败的错误态与重试入口，`demo` 开关回到写入前的状态
- **THEN** 该会话的系统提示与模型工具可见范围内均不含 `demo`，`activeProviders` 保持写入前的值

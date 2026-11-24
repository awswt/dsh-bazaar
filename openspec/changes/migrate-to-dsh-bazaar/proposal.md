## Why

`dsh-workbuddy-helper` 把「专家选择 / 技能市场 / 连接器市场 / 账号登录」四件事硬绑在一个上游（WorkBuddy）上：上游域名、凭证名、市场模式、登录端点、允许出网的 host 全部写死在插件里（`lib/index.js:18-21`、`:41-72`），换一家上游就得改一遍插件代码、再发一次包。

本变更把它升级为 `dsh-bazaar`：插件自己只保留**注册表 + 五域编排 + 两个前端屏**，具体上游以 provider 形式在运行时注册进来。现在做的成本最低——当前只有一个上游、五域各只有一处实现，抽契约的改动面最小；再等下去，每多接一个上游就要重复改一遍状态文件、工具门控与两屏 UI，而「同一会话里同时用两个专家库」这个用户已经提出的诉求将无处落地。

## What Changes

- **BREAKING** 包与全部对外标识更名：`dsh-workbuddy-helper` → `dsh-bazaar`，工具 `workbuddy_helper` → `bazaar_helper`，命令 `workbuddy-helper` → `bazaar`，路由前缀 `/dsh-workbuddy-helper` → `/dsh-bazaar`，设置页条目 id `workbuddy-helper-account` → `bazaar-account`（order 数值 `25` 不变）、会话面板入口 id `workbuddy-helper-expert-picker` → `bazaar-expert-picker`（order `26` 不变），CSS 前缀 `wbh-` → `bz-`，错误码 `WORKBUDDY_HELPER_*` → `BAZAAR_*`，凭证名 `WB_EXPERT_TOKEN` → `BAZAAR_<PROVIDER_ID>_TOKEN`，数据目录 `<DSH_HOME>/workbuddy-helper` → `<DSH_HOME>/bazaar`，bundle 元文件 `.workbuddy-helper-bundle.json` → `.bazaar-bundle.json`，登录 id 前缀 `wbh_` → `bz_`，e2e 环境变量 `WBH_LIB_ROOT` → `BAZAAR_LIB_ROOT`，prompt section 与 skill provider 名 `workbuddy-helper:*` / `workbuddy-helper-expert-*` / `workbuddy-helper-filter-*` → `bazaar:*` / `bazaar-expert-*` / `bazaar-filter-*`，自探测包名 `node_modules/dsh-workbuddy-helper` → `node_modules/dsh-bazaar`。不保留旧名别名，破坏性由 1.0.0 承担。
- **新增 provider 契约与注册表（本变更的核心）**：provider 以 `apiVersion: 1` 声明契约版本，注册时校验；用 `capabilities` 声明自己提供五域中的哪些能力（专家市场 / 技能市场 / 记忆市场 / 连接器市场 / 账号）；注册点为 `ctx.bazaar`，方法为 `bazaar.providers.register / unregister / list / get`；provider 声明 `displayName` 与可选 `icon`，界面据此自动渲染页签与开关，不再有「已知上游」的硬编码分支。
- **五域实现下沉为一个内置 provider**：仓库内只内置 `workbuddy` 一个 provider，承载原有的专家双源（在线市场 + 公开快照）、技能市场（含委托给 `dsh-mnemon` 的记忆市场）、连接器市场、账号登录。`marketMode`（`portal`/`cos`/`auto`）与全部具体端点从插件配置降为 workbuddy provider 的内部实现细节，不再是插件级配置项。
- **数据布局按 provider 分区**：`<DSH_HOME>/bazaar/providers/<providerId>/{accounts,vault,cache}/` 存放各上游自己的账号、凭据库与缓存；会话状态按会话分文件 `<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json`（文件名取 sessionId 的 SHA-256 摘要，沿用源仓 `lib/session.js:65-67`，避免任意字符变成非法文件名或路径片段），内部按 `providerId` 分组，结构为 `{ activeProviders, experts: {<providerId>: ref}, skills: {<providerId>: {globalMode, globalNames, expertNames}}, revision, updatedAt }`。切换专家库不再覆盖另一个库的选择。
- **多库并存成为常态**：`defaultProvider` 默认为空。为空时新会话的 `activeProviders` 为空、面板显示「尚未选择专家库」空态、工具调用未传 provider 时返回引导错误而不是静默回落到第一个已注册 provider；配置指向未注册 id 时报错并回落首个已注册 provider。
- **界面重做为 provider 分组形态**：设置页由「一页账号」改为**每 provider 一个页签**（账号 / 凭据 / 缓存 / 连接器授权四块）；会话辅助面板顶部改为 **provider 多选开关 + 按 provider 分组并列**，单个 provider 故障只在自己的分区显示错误与重试，不整体报错、不静默隐藏；多库同名条目标注 provider 限定前缀。
- **`providerId` 白名单**：`^[a-z][a-z0-9-]{0,31}$`，注册时校验。它是路径穿越防线——`providerId` 直接参与数据目录拼装。
- **移除 dsh-armory 依赖**：现有连接器面板复用 `dsh-armory` 的远端 `mcpManager` 承载目录与授权（`lib/client.js:308`、`lib/client.js:2522`）。本变更把这部分彻底移除，不留回落分支。
- **连接器市场本版只做五件事**：列表、筛选、详情、OAuth 授权、复制配置片段。「一键写入宿主配置并重载」不在本变更交付范围内（留待 1.1.0）。
- **新增示例 provider**：`examples/minimal-provider/` 读本地 JSON、不联网、不登录、不进 `lib/`、不进生产路径，只被测试与文档引用，用来证明契约可被第三方实现。
- **质量门与发布物料**：保留 `node --test`（用例数不低于现有 226 条）+ 逐文件语法检查 + 行尾规整脚本；新增 eslint、prettier 与 `.github/workflows/ci.yml`（`ubuntu-latest` × node 22.19 / 24）；新增「旧名残留扫描」，除允许清单（`providerId=workbuddy`、上游域名、`.workbuddy-plugin`）外，`lib`/`scripts`/`test`/`README`/`AGENTS` 不得出现 `workbuddy-helper`、`workbuddy_helper`、`wbh-`。完整物料推送到 GitHub；不做 npm publish。
- **配置面收敛（破坏性）**：`authMode` 的六个取值中 `auto` 与 `workbuddy-connector` 依赖 `dsh-connect-workbuddy` 的 vault 兼容层，本版不读旧目录，故删除——保留 `none`（默认，匿名只读公开快照）/`bearer`/`header`/`cookie` 四值；`headerName`（默认 `Authorization`）与 `headerPrefix`（默认 `Bearer `）落在 `providers.<id>` 下。同时删除 `connectorRegion`、`allowPublicMarketAuth`、`accountsDir`、`legacyVaultDir`、`localRoots`、`manifestPath`、`portalPrefix` 七个配置键；源仓另有两个仅供 vault 兼容层使用的键 `dshHome` 与 `vaultDir` 随兼容层一并删除，而测试注入用的 `fetchImpl` **保留**为 `providers.<id>.fetchImpl`（它是测试注入 HTTP 替身的唯一入口，删掉会让「226 用例原样跑通」不成立）：账号库改由 `providers/<providerId>/accounts/` 推导，市场路由前缀、快照清单路径与本地专家根目录收进内置 provider 内部常量，回环与主机白名单下沉到 `providers.<id>.allowHosts`/`allowInsecureLoopback`。`maxPackageBytes`（32 MiB）、`maxEntries`（400）、`maxTotalBytes`（96 MiB）作为 provider 级限制登记。上述删除项与枚举值逐条进 `CHANGELOG.md` 的 1.0.0「移除」段。
- **不做的事**：不做旧数据迁移（不探测 `<DSH_HOME>/workbuddy-helper` 与 `<DSH_HOME>/workbuddy-vault`，静默忽略）；无数据库、无 DDL；`engines` 与发布脚本机制保持不变；`providerId=workbuddy`、上游域名、桌面端目录 `.codebuddy-plugin`/`.workbuddy-plugin` 保持原样。

## Related Surface

下表逐条对应 clarify.md「关联场景清点（Related-Surface Survey）」的结论，划界结论与用户确认的一致（15 条纳入本变更——其中 #16 为部分纳入，上游域名与桌面端目录常量保持原样；2 条排除——#14 dsh-armory 复用彻底移除、#17 旧目录兼容不做）。

编号口径：clarify 的 19 行中，「设置页插槽与 id」与「会话面板入口」两行在本表合并为 #5，「上游域名与桌面端目录」一行不单列编号（见表后说明），因此 19 − 1（合并）− 1（不编号）= 本表 17 行。

| # | 关联面 | 代码证据 | 划界结论 |
|---|---|---|---|
| 1 | 模型工具注册 | `lib/index.js:490-492`（`name: 'workbuddy_helper'`）、参数表 `:501-575` | 纳入：更名 `bazaar_helper`，新增 `provider` 参数与 `providers` 列举动作；未传 `provider` 且会话无活跃 provider 时返回引导错误 |
| 2 | 斜杠命令注册 | `lib/index.js:596-599`（`name: 'workbuddy-helper'`）、入参提示 `:601` | 纳入：更名 `/bazaar`，命令语法接受 provider 限定前缀 |
| 3 | HTTP 路由前缀 | `lib/webui.js:5`（`PREFIX = '/dsh-workbuddy-helper'`）、13 条路由 `:355-941` | 纳入：改为 `/dsh-bazaar`，保留原有「注册时清理本前缀残留路由」的自愈逻辑（`lib/webui.js:196-233`） |
| 4 | 前端路由表 | `lib/client.js:50-64`（`ROUTES`，13 条） | 纳入：前缀改 `/dsh-bazaar`，按 provider 取数的路由增加 `/providers/<providerId>` 分组段，另增 provider 列举与活跃集写入两条 |
| 5 | 设置页插槽与 id | `lib/client.js:45-48`（`settings.section`、`settings.section.icon`、`workbuddy-helper-account`、`SETTINGS_ENTRY_ORDER = 25`），注册于 `:2559-2560` 与 `:2576`；会话面板入口 `:41-42`（`ENTRY_ID`、`ENTRY_ORDER = 26`），注册于 `:2530-2531` | 纳入：设置页 id 改 `bazaar-account`、入口 id 改 `bazaar-expert-picker`；两个 order 是数值常量（25 / 26），保持不变；两处 `inject` 共用同一常量，禁止一处硬编码一处读常量 |
| 6 | 会话状态读写 | `lib/session.js:40-52`（`states`/`live`/`warnings`/`queues`）、`:65-102`（`stateFile`/`loadState`/`normalizeState`/`saveState`） | 纳入：会话状态由「单专家 + 单技能组」改为按 `providerId` 分组的 `activeProviders`/`experts`/`skills`，沿用原子写与 `revision` 递增 |
| 7 | 会话子插件 | `lib/session-plugin.js:20-26`（`name`、`inject`、prompt section、skill provider 名） | 纳入：名字前缀改 `bazaar-*`；系统提示分区与技能 provider 仍按 generation 后缀隔离，确保换库失败时旧人格不丢 |
| 8 | 连接器工具门控 | `lib/connectors.js:401`（`applyQueue`）、`:1015-1025`（`applyNow` → `scoped.restrict({ deny })`）、`:1427-1444`（`agent/created`/`agent/disposed`/`agent/pre-step`/`tools/change` 四个钩子） | 纳入：deny 集合按 `providerId` 分组计算、在会话级合并成一次 `restrict`；判据仍是「该 provider 在本会话是否活跃」，不放进单个连接器工具内部（源仓已证会误触） |
| 9 | 出网安全校验 | `lib/auth.js:169-196`（`assertAllowedUrl`：协议、userinfo、host 白名单、loopback 例外；`redact` 在 `:198`）、`lib/index.js:56-57`（`allowHosts` / `allowInsecureLoopback` 插件级默认） | 纳入：白名单与 loopback 例外下沉到 provider 级，由 provider 自己声明；四个出网入口（在线市场 / 公开快照 / 登录 / 连接器刷新）共用同一处校验——源仓现状只覆盖市场与快照，登录侧走自有 `baseForRegion`（`lib/wb-login.js:62-78`，抛普通 `Error`、不产生 `BAZAAR_*` 码），1.0.0 MUST 把登录与连接器刷新一并收口到 `assertAllowedUrl` |
| 10 | 凭据解析 | `lib/auth.js:90`、`:157`（默认 `WB_EXPERT_TOKEN`）、`lib/index.js:52`（`credentialRef` 默认值） | 纳入：改为 `BAZAAR_<PROVIDER_ID>_TOKEN`（内置为 `BAZAAR_WORKBUDDY_TOKEN`），可按 `providers.<id>.credentialRef` 覆盖；取值仍走宿主 credential 服务，配置中不出现明文 token（`lib/auth.js:23-30` 拒绝内联密钥） |
| 11 | 错误码 | `lib/auth.js:26/71/76/88/94/108/115/174/177/183/187`、`lib/market.js:357/361/364`、`lib/portal.js:323/377/383/386`（共 15 个——`lib/portal.js` 的 4 行里 3 行与 `lib/market.js` 同名，distinct 仍为 15） | 纳入：全部改为 `BAZAAR_*`，语义与触发条件不变；新增 provider 注册类与 provider 不存在类错误码 |
| 12 | dsh-mnemon 包探测 | `lib/mnemon.js:25-35`（`ownProfileDir` 反向推断，`:35` 判定 `node_modules/dsh-workbuddy-helper` 是否存在） | 纳入：探测目标改为本包 `node_modules/dsh-bazaar`；记忆市场仍委托给该插件自己的技能管理页，不自建记忆能力 |
| 13 | 登录 id 生成 | `lib/wb-login.js:407`（`wbh_${randomUUID()}`）、`:26`（`WB_CLIENT_UA` 客户端 UA） | 纳入：前缀改 `bz_`；UA 属于上游事实，保持原样 |
| 14 | dsh-armory 复用 | `lib/client.js:308`、`lib/client.js:2522`（两处 `ctx.get('remote.mcpManager')`）、降级文案 `:314` | **排除**：本变更彻底移除该依赖，不留回落分支。理由：`remote.mcpManager` 是宿主内部服务，惰性解析受挂载顺序影响（`lib/client.js:304-312` 的注释即为绕过手段），且其语义无法承载「按 provider 分别门控」 |
| 15 | e2e 脚本 | `scripts/e2e.mjs:251`（`node_modules/dsh-workbuddy-helper/lib`）、`:342`/`:393`（工具名）、`:461`（仓库地址）、`:467`/`:624`/`:636`（安装路径断言）、`:672`（loader 断言）、`:686`/`:722`/`:730`（schema 断言文案） | 纳入：环境变量、工具名、仓库地址与全部断言文案随更名同步改写 |
| 16 | bundle 元文件与桌面端目录常量 | `.workbuddy-helper-bundle.json` 元文件、`PLUGIN_DIRS` 常量 | 纳入（部分）：元文件更名 `.bazaar-bundle.json`；`PLUGIN_DIRS` 指向的 `.codebuddy-plugin`/`.workbuddy-plugin` 是上游事实，保持原样 |
| 17 | 旧目录兼容 | `<DSH_HOME>/workbuddy-helper`、`<DSH_HOME>/workbuddy-vault`（`lib/index.js:60`、`:65-67`、`lib/wb-vault.js:8-10`） | **排除**：不做旧数据迁移，不探测、不提示、不迁移；用户如需沿用历史账号须自行重新登录 |

上游域名（市场 4 域名：`www.workbuddy.cn` / `www.workbuddy.ai` / `openplatform-cdn.codebuddy.cn` / `acc-1258344699.cos.accelerate.myqcloud.com`，`lib/index.js:18-21`；登录侧另有 2 个新域名：`www.codebuddy.cn` / `www.codebuddy.ai`，`lib/wb-login.js:37-52` 的 `REGIONS`，其中 `:48` 注释明确国际版两个品牌域名都要在白名单；`www.workbuddy.ai` 同属市场与登录两侧，去重后共 **6 个**——**登录链路 1.0.0 MUST 改造为经同一份 `assertAllowedUrl` 校验**，故 workbuddy provider 的 `allowHosts` 默认值必须同时含市场域名与登录域名，否则 cn 或 global 登录会被判 `BAZAAR_HOST_DENIED`）与登录区域常量（`lib/wb-login.js:37` 起）同样属上游事实，不在更名范围内——它们现在归 workbuddy provider 所有。

## 契约变更点

本变更无数据库、无 DDL：全部持久化状态都是 JSON 文件（布局见 What Changes）。契约变更集中在进程内 provider 接口、模型工具、斜杠命令、HTTP 路由、错误码与凭据名六处。

### 1. 进程内 provider 注册契约（新增）

| 项 | 内容 |
|---|---|
| 注册点 | `ctx.bazaar`（宿主上下文挂载点，新增） |
| 方法 | `bazaar.providers.register(provider)` / `unregister(providerId)` / `list()` / `get(providerId)`（均为新增） |
| provider 必填字段 | `apiVersion`（本版唯一合法值 `1`）、`id`（须匹配 `^[a-z][a-z0-9-]{0,31}$`）、`displayName`、`capabilities` |
| provider 可选字段 | `icon`、`allowHosts`（该 provider 允许出网的 host 白名单）、`allowInsecureLoopback`（默认 `false`，仅对本 provider 生效）、`credentialRef`（默认 `BAZAAR_<ID>_TOKEN`） |
| `capabilities` 键 | `expertMarket`、`skillMarket`、`memoryMarket`、`connectorMarket`、`account`，逐域声明 |
| provider 行为面（新增） | 上表为**声明面**；契约同时 MUST 携带 `impl` 字段承载**行为面**：`capabilities.<域> === true` 时 `impl.<域>` 必须存在且其必需方法均为函数，否则注册被拒（`BAZAAR_PROVIDER_IMPL_MISSING`，指明 providerId + 域 + 方法名）。五域方法集合：`expertMarket: { listExperts, getExpert }`、`skillMarket: { listSkills, installSkill }`、`memoryMarket: { listMemorySkills, searchMemory }`、`connectorMarket: { listConnectors, getConnector, connectorAction }`、`account: { listAccounts, accountAction }`；入参与返回体的字段名固定：`listExperts({ query?, categoryId?, page?, pageSize? }) → { items, total, source, warning? }`、`getExpert({ id }) → { item }`、`listSkills({ query?, page?, pageSize? }) → { items, total }`、`installSkill({ slug, force? }) → { slug, installedPath, providerId }`、`listMemorySkills({ query?, page?, pageSize? }) → { items, total }`、`searchMemory({ query, limit? }) → { items, total }`、`listConnectors({ query?, status? }) → { items, total, categories }`、`getConnector({ id }) → { item }`、`connectorAction({ action, id?, params? }) → { action, result }`、`listAccounts({}) → { own, all, pending, summary }`、`accountAction({ action, accountId?, region?, token?, loginId? }) → { action, result }`；条目结构复用源仓既有形状（不另立 DTO），外层只补 `providerId` 与 `qualifiedName`；实现细节与取舍见 `design.md` 的 D13 |
| 兼容性影响 | 全新接口，无历史调用方；旧版插件不注册 provider，本变更后不会再被加载 |

### 2. 模型工具（修改）

| 项 | 内容 |
|---|---|
| 方法+路径 | 工具名 `workbuddy_helper` → `bazaar_helper`（**修改**，破坏性） |
| 请求变化 | 新增 `provider`（字符串，provider 标识）与 `action=providers`（列举已注册 provider）；其余参数名与语义保持不变 |
| 响应变化 | `status` / `market` / `skills` / `connector` / `account` 的返回体按 `providerId` 分组；新增 `providers` 结果集（每项含 `id`、`displayName`、`capabilities`、`active`） |
| 兼容性影响 | 旧工具名解析不到；调用方（含 e2e 脚本与命令别名）同步改写。未传 `provider` 且会话无活跃 provider 时返回 `BAZAAR_PROVIDER_REQUIRED`，不回落 |

### 3. 斜杠命令（修改）

| 项 | 内容 |
|---|---|
| 命令名 | `workbuddy-helper` → `bazaar`（**修改**，破坏性） |
| 入参 | 新增可选的 provider 前置段（`bazaar <providerId> <action> ...`）；不带 provider 时等同于工具的「未指定 provider」语义 |
| 兼容性影响 | 旧命令名不再注册 |

### 4. HTTP 路由（修改 + 新增）

全部路由以 `/dsh-bazaar` 为前缀。按 provider 取数的资源在路径中带 `/providers/<providerId>` 分组段；会话作用域的资源仍以 `sessionId` 作为请求参数传递（与现状一致）。所有写路由保留原有的同源校验（跨源请求返回 403）与方法校验（不匹配返回 405）。

| 方法 + 路径 | 变更标记 | 请求/响应变化 |
|---|---|---|
| `GET /dsh-bazaar/providers` | 新增 | 返回已注册 provider 列表：`id`、`displayName`、`icon`、`capabilities`、账号与凭据摘要；供设置页页签与会话面板开关渲染 |
| `GET /dsh-bazaar/providers/<providerId>/experts` | 修改（原 `/dsh-workbuddy-helper/experts`） | 请求参数 `query`/`categoryId`/`page`/`pageSize` 不变；响应条目新增 `providerId`、`qualifiedName`（多库同名时的限定名） |
| `GET /dsh-bazaar/providers/<providerId>/skill-market` | 修改 | 参数不变；响应条目新增 `providerId`、`source`（技能市场 / 记忆市场） |
| `POST /dsh-bazaar/providers/<providerId>/skill-install` | 修改 | 请求体 `skillId`/`force` 不变；响应新增 `providerId`、`installedPath`；跨库同名时返回 `BAZAAR_SKILL_NAME_CONFLICT` 并指出已有来源 |
| `GET /dsh-bazaar/providers/<providerId>/connectors` | 修改 | 参数不变；响应条目新增 `providerId`、`capabilities` 中该域是否声明 |
| `GET /dsh-bazaar/providers/<providerId>/connectors/state` | 修改 | 响应按 provider 分区的授权/连接状态；不再返回 dsh-armory 桥接来源 |
| `POST /dsh-bazaar/providers/<providerId>/connectors/session` | 修改 | 会话内启用/停用某连接器；请求体新增 `providerId` 冗余字段（与路径一致，不一致时拒绝） |
| `POST /dsh-bazaar/providers/<providerId>/connectors/action` | 修改 | 动作集收敛为 `list`/`state`/`authorize`/`poll`/`cancel`/`copy-config`/`remove`（`state` 读已存授权状态，`poll` 推进进行中的授权，二者不可互相替代；`remove` 承载界面上的「清除授权」——移除已存授权记录并使其工具不可用，`cancel` 只把进行中的授权推进到取消终态、不动已存记录）；`connect`/`repair`/`repairConnect`/`reauthorize`/`disconnect`/`unbind`/`enable`/`disable` 不再提供（源仓 `disconnect` 等价于删记录，被 `remove` 取代；`repairConnect`/`reauthorize` 是 `connect` 的别名，见 `lib/index.js:337-345` 与 `lib/connector-flow.js:16`；写入宿主配置能力留待 1.1.0） |
| `GET /dsh-bazaar/providers/<providerId>/accounts` | 修改 | 响应保留 `own`/`all`/`pending`/`summary`；不再返回兼容层 vault 来源 |
| `POST /dsh-bazaar/providers/<providerId>/accounts/action` | 修改 | 动作集 `list`/`login`/`poll`/`cancel`/`refresh`/`remove`；`import`（迁移旧 vault）移除 |
| `GET /dsh-bazaar/state?sessionId=` | 修改（原 `/dsh-workbuddy-helper/state`） | 响应体由单专家结构改为 `activeProviders` + 按 provider 分组的 `experts`/`skills`，并保留 `revision`、`warning` |
| `POST /dsh-bazaar/sessions/active-providers` | 新增 | 请求体 `{ sessionId, providerIds: string[] }`；返回更新后的会话状态；未注册 id 被拒绝 |
| `POST /dsh-bazaar/select` | 修改 | 请求体新增必填 `providerId`；缺失时返回 `BAZAAR_PROVIDER_REQUIRED` |
| `POST /dsh-bazaar/skills` | 修改 | 请求体新增必填 `providerId`，技能集合写入该 provider 分区 |
| `POST /dsh-bazaar/off` | 修改 | 请求体新增可选 `providerId`；给出时只清空该 provider 的选择，省略时清空全部活跃 provider 的选择 |

### 5. 错误码（修改 + 新增）

源仓既有 **15** 个错误码中 **13** 个逐条更名 `WORKBUDDY_HELPER_*` → `BAZAAR_*`，触发条件与语义不变：`BAZAAR_AUTH_INLINE`（配置里出现明文密钥，`lib/auth.js:26`）、`BAZAAR_CREDENTIALS_MISSING`（宿主凭据服务不可用，`:88`）、`BAZAAR_AUTH_MISSING`（凭据未配置或为空，`:94`）、`BAZAAR_AUTH_HEADER_MISSING`（`authMode=header` 却无 `headerName`，`:108`）、`BAZAAR_AUTH_MODE`（认证模式不支持，`:115`）、`BAZAAR_URL_INVALID`（URL 解析失败，`:174`）、`BAZAAR_URL_USERINFO`（URL 带 userinfo，`:177`）、`BAZAAR_URL_INSECURE`（非 HTTPS 且无回环例外，`:183`）、`BAZAAR_HOST_DENIED`（host 不在该 provider 的 `allowHosts`，`:187`）、`BAZAAR_MARKET_AUTH_REQUIRED`（在线市场需要认证，`lib/market.js:357`）、`BAZAAR_MARKET_RATE_LIMITED`（`:361`）、`BAZAAR_MARKET_UNAVAILABLE`（`:364`）、`BAZAAR_PORTAL_AUTH_REQUIRED`（门户需要认证，`lib/portal.js:323`）。**删除 2 个**：`BAZAAR_CONNECTOR_MISSING` 与 `BAZAAR_CONNECTOR_NO_TOKEN`——它们的唯一触发点是 `workbuddy-connector` 分支对 `dsh-connect-workbuddy` vault 兼容层的依赖（源仓 `lib/auth.js:71`、`:76`），本版不读旧目录、兼容层整体移除，两码随之消失；其「拿不到 token 就不发请求」的语义由 `BAZAAR_AUTH_MISSING` 覆盖，两码进 `CHANGELOG.md` 的 1.0.0「移除」段。新增 16 个：`BAZAAR_PROVIDER_REQUIRED`（未指定 provider 且会话无活跃 provider）、`BAZAAR_PROVIDER_UNKNOWN`（providerId 未注册）、`BAZAAR_PROVIDER_INVALID_ID`（白名单不匹配）、`BAZAAR_PROVIDER_API_VERSION`（契约版本不符）、`BAZAAR_PROVIDER_IMPL_MISSING`（声明了某域但未提供该域的必需方法，用于 provider 行为面校验）、`BAZAAR_PROVIDER_DUPLICATE`（同 id 重复注册）、`BAZAAR_PROVIDER_ID_MISMATCH`（路径中的 providerId 与请求体不一致）、`BAZAAR_CAPABILITY_UNDECLARED`（调用了 provider 未声明的域）、`BAZAAR_SKILL_NAME_CONFLICT`（跨库同名技能）、`BAZAAR_PARAM_INVALID`（分页 / 区域等入参非法或缺失）、`BAZAAR_EXPERT_NOT_FOUND`（专家详情按 `id` 查不到）、`BAZAAR_SKILL_SLUG_INVALID`（原始名称规整后仍不合 slug 白名单）、`BAZAAR_SKILL_PACKAGE_TOO_LARGE`（技能包超过 `maxPackageBytes` / `maxTotalBytes` 上限）、`BAZAAR_MEMORY_UNAVAILABLE`（宿主缺少记忆插件，错误信息须带插件名）、`BAZAAR_CONNECTOR_NOT_FOUND`（连接器按 `id` 查不到）、`BAZAAR_CONNECTOR_ACTION_UNSUPPORTED`（该 provider 未支持该连接器动作）、`BAZAAR_LOGIN_EXPIRED`（登录或轮询已过期：源仓 `lib/wb-login.js:298-299` 超时、`:421` 会话不存在、`:422-424` 另一区域标签页发起，现状均为裸 `Error` 字符串无码，1.0.0 统一为本码）。上述 17 个新增码与 `design.md` 的 D13 域方法失败码逐条对应（`BAZAAR_PROVIDER_ID_MISMATCH` 除外，它在路由入口比对路径与请求体时产生，见 design 的 Rule Boundary 第 8 条）。

### 6. 凭据与数据目录（修改）

| 项 | 内容 |
|---|---|
| 凭证名 | `WB_EXPERT_TOKEN` → `BAZAAR_<PROVIDER_ID>_TOKEN`（内置 provider 为 `BAZAAR_WORKBUDDY_TOKEN`），可由 `providers.<id>.credentialRef` 覆盖；仍只经宿主 credential 服务解析，配置中不落明文 |
| 数据目录 | `<DSH_HOME>/workbuddy-helper` → `<DSH_HOME>/bazaar`；账号、凭据库、缓存下沉到 `providers/<providerId>/{accounts,vault,cache}` |
| 会话状态文件 | `<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json`（文件名为 sessionId 的 SHA-256 摘要，沿用源仓 `lib/session.js:65-67`；结构见 What Changes）；不读取旧目录 |
| 兼容性影响 | 旧目录不迁移、不探测；旧账号需重新登录 |

## Implementation Outline

1. **搬仓不动逻辑。** 把源仓 `lib/`、`scripts/`、`test/` 原样搬进新仓，先跑通现有 226 条用例与逐文件语法检查，得到「只有目录变了、行为没变」的基线。
2. **换身份标记。** 按 What Changes 的更名清单把包名、工具名、命令名、路由前缀、设置项 id、CSS 前缀、错误码、凭证名、数据目录、元文件名、登录 id 前缀、e2e 环境变量一次换净；随后跑「旧名残留扫描」把漏网的旧名顶出来，允许清单之外出现旧名即判失败。
3. **抽出 provider 契约与注册表。** 定义 `apiVersion: 1` 的契约形状与五域能力声明，把注册/注销/列举/查询做成一个注册表；注册时校验契约版本与 `providerId` 白名单（白名单同时也是路径穿越防线），同 id 重复注册直接报错。
4. **把五域实现下沉成内置 provider。** 专家双源、技能市场（含委托给记忆插件的记忆市场）、连接器市场、账号登录四块搬进 `providers/workbuddy/`；市场模式与全部上游端点成为该 provider 内部细节，插件级配置里不再出现。
5. **重写会话状态。** 会话状态从「一个专家 + 一组技能」改为按 provider 分组的活跃集、专家选择、技能选择三段；写入仍走原子写 + 版本号递增，写入入口只有一个并按 provider 分组，避免两个库互相覆盖。
6. **重做两个前端屏。** 设置页改成每 provider 一个页签（账号 / 凭据 / 缓存 / 连接器授权）；会话面板顶部改成 provider 多选开关，下方按 provider 分组并列，单个 provider 出错只红自己那一块并给重试。
7. **重构连接器门控。** 门控判据改为「该 provider 在本会话是否活跃」，在会话级把各 provider 的停用工具集合按 provider 分组算出再合并成一次限制；生命周期钩子（创建 / 每步 / 销毁 / 工具变更）保持原有接线方式，避免漏接导致「看起来正常但从不生效」。
8. **移除 dsh-armory 依赖。** 删掉两处远端服务取值与全部降级分支，连接器市场只保留列表、筛选、详情、OAuth 授权、复制配置片段五件事。
9. **补示例与降级路。** 加一个读本地 JSON、不联网不登录的示例 provider，只为证明契约可被第三方实现；同时把它用作「provider 声明了哪些能力、没声明的域怎么按空态处理」的活样例。
10. **落质量门与物料。** 补 eslint、prettier 与 CI 工作流，重写 README、`AGENTS.md`、`docs/` 与发布说明，删掉过时文档与截图，最后把完整物料提交并推送到 GitHub。

以上第 1 步对应「行为不变」的基线，第 2 至 4 步对应关联面 1 至 3、7、10 至 13、15 至 16 的适配，第 5 至 7 步对应关联面 4 至 9 的适配，第 8 步对应关联面 14 的排除，第 9 步对应示例 provider，第 10 步对应发布物料与质量门。

## Rule Boundary

| 规则 | 该拦的条件 | 该放的例外与合法反例（附应有处理） | 判定挂载点 |
|---|---|---|---|
| provider 注册准入 | `apiVersion` 不等于 `1`，或 `id` 不匹配 `^[a-z][a-z0-9-]{0,31}$`，或同 id 重复注册 | 注销后同 id 重新注册（放行，按新注册处理）；不同 id 携带不同 `apiVersion`（各自独立判定）；内置 workbuddy 与示例 provider 并存（放行，各自独立注册） | 注册表注册动作本身：校验先于登记，失败即拒绝且不产生半登记状态 |
| 能力声明边界 | 调用方请求某 provider 未声明的域（如只声明专家市场却调技能安装） | provider 声明了该域但当前返回空列表（放行，空态而非错误）；声明了账号但用户未登录（放行，引导登录） | 每个域的入口动作：先查该 provider 的能力声明，再进入实现 |
| 凭据与数据目录隔离 | 以 A provider 的身份读取 B provider 的凭证名或数据目录 | 同一 provider 下切换多个账号（放行）；同一 provider 的登录、刷新、市场请求共用自身凭证（放行）；示例 provider 无凭证（放行，走免鉴权路径） | 凭证解析与目录拼装同在一处：目录恒由 `providerId` 推导，凭证名恒由 `providerId` 推导，注册表不向任何 provider 传递他人的凭证或路径 |
| 出网主机校验 | 目标 host 不在该 provider 的 `allowHosts` 内；或非 HTTPS 且未获 loopback 例外 | provider 显式声明 `allowInsecureLoopback: true` 且目标为本机回环（放行，仅对该 provider 生效）；HTTPS 且 host 在白名单内（放行） | 四个出网入口（在线市场、公开快照、登录、连接器刷新）共用的同一处地址校验；技能包下载是独立的第 5 个出网点，同样经该函数 |
| 会话状态写入隔离 | 写入时把一个 provider 的选择写到另一个 provider 的分区 | 重复选择同一 provider 的同一条目（放行，幂等覆盖）；只清空某一个 provider 的选择（放行，其余分区不动）；同时点亮多个 provider（放行，各自独立分区） | 会话状态唯一写入入口：先按 `providerId` 分组，再原子落盘并递增版本号 |
| 活跃集与空默认值 | 调用方未指定 provider 且会话无任何活跃 provider；请求体里的 `providerId` 未注册；路径中的 `providerId` 与请求体不一致 | 配置的默认 provider 未注册（拦下并回落首个已注册，同时给出明确提示）；正常指定已注册且活跃的 provider（放行）；显式清空活跃集后再查询（放行，返回空态而非错误） | 面板、模型工具、命令、路由读取同一份「当前 provider 集合」，不各自推断 |
| 连接器工具门控 | 某 provider 在本会话未活跃，其连接器工具仍会被模型调用 | 已活跃 provider 的全部连接器工具（放行）；无活跃 provider 时（放行，不产生任何停用项）；同一会话内多个 provider 各有停用集合（放行，合并后一并生效） | 会话级工具限制动作：按 provider 分组算停用集合再合并，不放进单个连接器工具内部 |
| 连接器市场写配置边界 | 请求把连接器配置写入宿主并触发热重载 | 复制配置片段到剪贴板（放行）；发起 OAuth 授权并轮询结果（放行）；查看连接状态与详情（放行） | 连接器市场动作分发：写入类动作在本版直接以「留待后续版本」拒绝，不静默降级为写半份配置 |
| 技能同名冲突 | 跨 provider 安装同名技能 | 同一 provider 重复安装同名技能（放行，幂等覆盖）；不同 provider 安装不同名技能（放行，各自落位） | 技能安装落位动作：落盘路径与元数据写入在同一处，冲突判定读已有元数据里的来源 id |
| 旧名与新定位点 | 对外标识仍使用旧名（`workbuddy-helper`、`workbuddy_helper`、`wbh-` 前缀等） | 允许清单内的上游事实（`providerId=workbuddy`、上游域名、桌面端目录 `.workbuddy-plugin`/`.codebuddy-plugin`） | 残留扫描：扫 `lib`/`scripts`/`test`/`README`/`AGENTS`，命中即失败 |

同一业务意图的等价执行路径（逐条结论）：

- 选专家：面板点选 → 通过；模型工具调用 → 通过（同一份状态入口与同一套校验）；斜杠命令 → 通过；直接调写接口 → 通过。四条路径都必须带 `providerId`，缺失一律同一错误码。
- 安装技能：面板安装 → 通过；模型工具安装 → 通过；命令安装 → 通过。三条路径共用同一处落位与冲突判定。
- 查看连接器状态：面板拉取 → 通过；模型工具查询 → 通过；直接调状态路由 → 通过。三者读同一份按 provider 分区的状态。
- 登录账号：设置页发起 → 通过；模型工具发起 → 通过；命令发起 → 通过。三者落到该 provider 自己的账号目录，且都要求区域与申请时一致。
- 写活跃集：面板多选开关 → 通过；直接调活跃集接口 → 通过。两者走同一个写入入口并按 provider 分组。

## 界面影响

本变更涉及用户可见界面，涉及两屏，交互与状态语义都有实质变化：

- **设置页（新增每 provider 一个页签）**：用户在此查看每个上游的登录状态、凭据是否已配置（只脱敏展示名称与配置状态，不显示值）、缓存占用与清理、连接器授权状态；默认 provider 未选择时显示空态。
- **会话辅助面板（由四页签改为「provider 多选开关 + 分组并列」）**：用户在此同一会话里同时点亮多个专家库、在分组里挑专家、搜索与按分类筛选、查看技能市场与记忆市场两个来源；单库故障只影响自己的分区。

界面细节（区块划分、字段状态、空/加载/错误三态、以及必填/禁用/只读的可见线索）由 `prototype/index.html` 承载，不在本文件重复描述。两屏均已经用户逐屏确认（用户答复「屏a,b都认可。继续吧」），确认结论已回写 `clarify.md` 的「Users & Scenarios」小节。

## Capabilities

### New Capabilities

- `provider-registry`: provider 契约与注册表——`apiVersion: 1` 注册校验、五域能力声明、注册/注销/列举/查询、`providerId` 白名单与重复注册、多 provider 隔离、空默认 provider 的取值语义。
- `expert-market`: 专家市场——列表/筛选/详情、在线市场与公开快照双源、多库并列与 provider 限定前缀、选择必须携带 providerId、单 provider 故障隔离。
- `skill-market`: 技能市场与记忆市场——真实安装落位与元数据归属、跨库同名冲突、跨库不得互改、记忆市场委托与不可用降级。
- `connector-market`: 连接器市场——列表/筛选/详情/OAuth 授权/复制配置片段、会话级工具门控按 providerId 分组 deny 并合并、本版不写宿主配置的边界。
- `account-auth`: 账号与凭据——三段式登录、凭据按 provider 分目录存取与脱敏、出网主机校验下沉 provider 级、`BAZAAR_*` 错误码。

### Modified Capabilities

无。`openspec/specs/` 下当前没有既有主 spec（仅有占位文件），五个能力全部为新增，因此本变更没有 MODIFIED / REMOVED / RENAMED 需求。

## Impact

- **代码**：`lib/` 全部 20 个模块（注册表与五域编排为新增，`connectors.js`、`session.js`、`session-plugin.js`、`auth.js`、`webui.js`、`client.js` 有结构级改动）；`scripts/e2e.mjs` 断言与路径全部改写；`test/` 现有 22 个用例文件随更名调整，并新增契约校验、隔离、门控、降级四类用例；新增 `examples/minimal-provider/`。
- **配置**：`cordis.patch.yml` 的插件 id 与 name 更名；`marketMode`/`marketBaseUrl`/`portalBaseUrl` 等插件级配置项移除，改为 provider 内部细节；`peerDependencies` 的 `@deepseek-ai/dsh` 区间由 `>=0.2.0-rc.1 <0.3.0-0` 放宽到 `>=0.2.0-rc.1 <0.4.0-0`；`engines` 不变。
- **依赖**：完全移除对 `dsh-armory` 的运行时复用（`lib/client.js:308`、`:2522`）；`dsh-mnemon` 仍为可选探测目标（只探测、不引入依赖）；运行依赖 `fflate`/`tar`/`yaml` 不变。
- **数据**：新增 `<DSH_HOME>/bazaar` 目录树与按 provider 分区的会话状态文件；旧目录 `<DSH_HOME>/workbuddy-helper`、`<DSH_HOME>/workbuddy-vault` 不读取、不迁移。
- **对外契约**：包名、工具名、命令名、路由前缀、设置项 id、错误码、凭证名全部改变，属破坏性变更，由 1.0.0 承担；不提供旧名别名。
- **文档与发布**：`README.md`、`AGENTS.md`、`CHANGELOG.md`、`docs/`（含删除过时文档与 5 张旧截图）、新增 `.github/workflows/ci.yml`；完整物料推送到 GitHub，不做 npm publish。
- **留待 1.1.0**：连接器「一键写入宿主配置并重载」不在本变更交付范围内。
- **界面基准**：`DESIGN.md` 已在本阶段产出（与 `AGENTS.md` 同层，`@google/design.md lint` 零 error 零 warning），登记宿主 `--dsw-alias-*` 令牌、7 档字号、5 档圆角与状态色对比度结论；原型与后续两屏实现均以其为视觉基准，界面改动需先改 `DESIGN.md` 再改代码。

# 技术设计 — migrate-to-dsh-bazaar

## Context

本仓当前只有 `openspec/`、`DESIGN.md` 与占位的 `README.md`；全部实现将从源仓（旧名 `dsh-workbuddy-helper`，下文简称「源仓」）搬入。设计必须贴合它的既有形状，而不是另起一套。

**源仓实测形状（决定改造代价的四件事）**

1. **单上游硬编码在注册层**：上游域名常量写在插件入口（`lib/index.js:18-21`），一份 `settings` 对象把市场、门户、凭据、目录、白名单全塞在插件级（`lib/index.js:41-71`）。第二家上游要接进来，只能改这同一个对象。
2. **五域实现彼此耦合**：专家市场（`lib/market.js`、`lib/portal.js`）、技能安装（`lib/skill-install.js`、`lib/skill-providers.js`）、连接器（`lib/connector.js`、`lib/connectors.js`、`lib/connector-flow.js`、`lib/mcp-patch.js`）、账号（`lib/wb-login.js`、`lib/wb-vault.js`、`lib/wb-accounts.js`）通过 `lib/index.js` 的闭包互相直接引用，没有域边界，也没有「谁声明了哪个域」的概念。
3. **会话状态是单专家形状**：`defaultState()`（`lib/session.js:54-63`）只有 `expert` + `skills` 两组，`normalizeState()`（`:77-94`）按这个形状归一，`saveState()`（`:96-102`）靠 `writeJsonAtomic` + `revision` 自增落盘，写入口由 `queue()`（`:104-109`）按 sessionId 串行化。多库并存必须是「同一文件内按 providerId 分组」，否则一次切换就是两次跨文件写。
4. **两处安全判定各有唯一落点**：门控在会话级工具层（`lib/connectors.js:960-980` 算 deny、`:1015-1025` 的 `applyNow()` 调 `scoped.restrict({ deny })`，由 `:1427`/`:1430`/`:1434`/`:1442` 四个钩子驱动），出网校验在 `assertAllowedUrl`（`lib/auth.js:169-190`）。这两处是仅有的、能被所有入口共用的判定点；把它们挪进某个域实现内部，等价路径就会绕过。

**宿主能力边界（设计只能落在这里面）**：`ctx.tools.register`（工具注册）、`tools.restrict({ deny })`（agent 作用域工具收窄，返回 dispose）、`ctx.on` 的 `agent/created`/`agent/disposed`/`agent/pre-step`/`tools/change`、`ctx.credentials.resolve/describe`（凭据服务）、`ctx.skills.list`、`agent.ctx.plugin(SessionExpertPlugin)`（会话子插件）；HTTP 侧是 `registerWebUi` 注册的裸路由。

**约束**：本变更无数据库、无 DDL（见 Data Model）；运行依赖不变（`fflate`/`tar`/`yaml`）；`engines` 不变（`^22.19.0 || >=24.0.0`）；测试必须离线可跑（`node --test`，provider 抽象用测试内本地假 HTTP server）；`lib/` 现在是 20 个模块、`test/` 22 个文件共 226 条用例，改名与重构必须带着它们一起走。

动机与范围不在本文重复：见 `proposal.md` 的 Why / What Changes / Related Surface，需求细节见 `specs/` 下五份 delta。

## Goals / Non-Goals

**Goals:**

- 定义一份能被仓外第三方实现、且失败可诊断的 provider 契约（`apiVersion: 1` + 五域能力声明），并把注册表做成插件内唯一的值来源。
- 五域实现整体下沉到一个 provider 内后，插件级配置只剩与上游无关的三项，`marketMode` 与全部端点不再是插件概念。
- 每条业务规则只有一个挂载点：工具门控在会话级工具层、出网判定在一处地址校验、路径与凭据名恒由 `providerId` 推导、技能落位与冲突判定同在一处。
- 会话状态改为「一文件、按 providerId 分组」，切库不互相覆盖，写路径保持原子与串行。
- 两屏的必填、禁用、只读与服务端校验同源：界面上灰掉的东西，服务端也拦。
- 质量门一条命令可验（`node --test` + 逐文件 `node --check` + `eslint` + `prettier --check`），旧名残留由自动化扫描兜底。

**Non-Goals:**

- 不做连接器「一键写入宿主配置并重载」——1.1.0 交付，只出现在本文的 Migration Plan Roadmap 里。
- 不发布 npm（`npm publish` 不执行；`publishConfig` 字段保留不动，避免把「不发布」写成结构缺失）。
- 不做旧数据迁移：不探测、不提示、不读取 `<DSH_HOME>` 下的旧目录残留。
- 不做 provider 生态的第三方发布机制：无 registry 服务端、无市场索引、无版本协商服务；`examples/minimal-provider/` 只是契约的活样例。
- 不引入数据库、ORM、迁移框架，也不把 JSON 状态换成 sqlite。
- 不拆分前端为多包、不改宿主插槽协议（仍是 `conversation.input.left` + `settings.section`/`settings.section.icon`），不重写 `lib/client.js` 的 React 骨架。
- 不新增运行依赖，不放宽 `engines`，不给旧标识留别名。

## Decisions

### D1. 多 provider 注册表，而不是继续单上游硬编码

**选了什么**：新增注册表（`lib/provider/registry.js`）与契约校验（`lib/provider/contract.js`），五域实现搬进 `lib/providers/workbuddy/`；插件入口只负责挂 `ctx.bazaar`（方法面 `bazaar.providers.register` / `unregister` / `list` / `get`）、拼装两屏路由、接线门控。四个方法构成 provider 集合的全部读写口：`register` 与 `unregister` 是仅有的两条写路径，`list` 与 `get` 是仅有的两条读路径，任何调用方都不直接持有 provider 对象表。

**为什么**：源仓把上游事实写在注册层（`lib/index.js:18-21`、`:41-71`），接第二家就只能改插件入口，而插件入口同时承载工具、命令、路由、会话、门控五件事——每接一家上游都要重新回归这五件。把上游事实收进 provider 后，插件入口的改动与上游数量无关。

**备选**：(a) 维持单上游、只做更名——多上游价值为零，以后接第二家要二次重构，已否；(b) provider 拆成独立 npm 包——首版要维护两套发布节奏与 peer 依赖矩阵，属过度设计，1.1.0 之后再考虑拆（见 Migration Plan）；(c) 只做能力探测（按配置开关部分域）而不做 provider 抽象——域的归属仍然硬编码，同名冲突与故障隔离都无处落。

### D2. 契约形状与 `apiVersion` 的校验时机

**选了什么**：契约对象为 `{ apiVersion, id, displayName, icon?, capabilities, allowHosts?, allowInsecureLoopback?, credentialRef? }`；`apiVersion` 是整数，本版只接受 `1`；校验发生在 `register()` 内部、登记之前，失败即返回 `BAZAAR_PROVIDER_API_VERSION` / `BAZAAR_PROVIDER_INVALID_ID` / `BAZAAR_PROVIDER_DUPLICATE`，**不产生半登记状态**（不写目录、不挂路由、不进可列举集合）。

**为什么**：源仓没有任何版本字段，能力扩张时无法划兼容边界。把校验放在「登记之前」而不是「首次调用时」有两点好处：错误在加载期就暴露（而不是模型调到某个域才炸），且注册表里不存在「登记了但用不了」的条目——列举、页签、开关都只看到能用的 provider。

**备选**：(a) 校验延后到首次域调用（懒校验）——省一次检查，但会出现「页签渲染了、点进去报错」的半可用状态；(b) 用字符串版本（`'1.0'`）——比较语义要自己定义，整数足够且不可解析歧义；(c) 不带版本、靠能力键是否有无来判断——能力集合会变，缺键与未实现在 JSON 里不可区分。

**挂载与兼容语义**：`apiVersion` 不符时整条 provider 被拒（不是逐域降级）——因为契约形状本身可能变了，逐域容忍会让注册表持有形状未知的对象。

### D3. `defaultProvider` 为空时不静默回落

**选了什么**：`defaultProvider` 默认空串。为空时：新会话 `activeProviders` 为空数组 → 面板渲染「尚未选择专家库」空态并给入口 → 模型工具未传 `provider` 且会话无活跃 provider 时返回 `BAZAAR_PROVIDER_REQUIRED`。**只有**当配置里的 `defaultProvider` 指向一个**未注册**的 id 时，才回落到首个已注册 provider，并同时给出明确提示（这是配置错误，不是正常空值）。

**为什么**：源仓只有一个上游，`expert` 为 `null` 就等价于「未选择」；多库之后，「没选」与「默认用第一个」是两种不同语义，静默回落会让用户以为自己在用 A 库、实际调的是 B 库的专家与凭据——这是凭据串用最容易发生的地方（`clarify.md` 里用户列出的第一条最怕误操作）。

**备选**：(a) 空值回落首个已注册——省一次点击，代价是把「用户没决定」变成「插件替他决定」；(b) 首次启动自动把第一个 provider 写进 `defaultProvider`——把隐式决定固化成持久配置，更难撤销；(c) 空值时直接报错不让用——把空态（合法状态）当错误处理，与 spec 的空态场景冲突。

### D4. 会话状态：一文件多 provider，而不是一 provider 一文件

**选了什么**：`<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json` 一个文件，内含 `activeProviders`、`experts`（按 providerId 分组）、`skills`（按 providerId 分组）、`revision`、`updatedAt`。文件名沿用源仓 `sha256(sessionId)`（`lib/session.js:65-67`）而不是裸 sessionId，避免任意字符变成非法文件名或路径片段。

**为什么**：会话内的三个操作天然跨 provider——「点亮/熄灭一家库」要动 `activeProviders`、「切库」要同时看两家库的已选专家、「清空」要按库分区清。一 provider 一文件时，这些操作要么变成多文件事务（无跨文件原子性），要么先读后写多处（并发下互相覆盖）。单文件 + `writeJsonAtomic`（`lib/util.js:45-50`：tmp 文件 0600 写入后 `rename` 原子替换）+ `revision` 自增 + 单会话 promise 队列（`lib/session.js:104-109`）把「切库不互相覆盖」变成结构性保证，而不是靠调用方自觉。

**备选**：(a) `sessions/<sessionId>/<providerId>.json` 一库一文件——分区天然隔离，但活跃集无处落（要么再来一个 `active.json`，要么活跃集散落在目录列表里），且「同时点亮两家」是两次写、无原子性；(b) 直接写进宿主会话记录——宿主没有为插件开放的会话状态写口，做不到；(c) 内存态 + 只在退出时落盘——崩溃即丢，源仓已经因为状态丢失被迫改成即时写（`lib/session.js:96-102`）。

**代价**：单文件意味着任意 provider 的写都会重写整份文件（写放大）。本变更的会话状态只有几十个键，可接受；若将来专家级技能选择变成长列表，再按 providerId 拆子文件，`schemaVersion` 已预留（见 Data Model）。

### D5. 门控挂载点：会话级工具层，不放进连接器工具内部

**选了什么**：保留源仓的挂载位置——`applyNow()`（`lib/connectors.js:1015-1025`）在 agent 作用域调 `scoped.restrict({ deny })`，由 `agent/created` / `agent/disposed` / `agent/pre-step` / `tools/change` 四个钩子（`:1427`、`:1430`、`:1434`、`:1442`）驱动；改动只在 deny 集合的计算：`connectorNamesFor()`（`:960-980`）从「本会话停用的连接器」改为「未活跃 provider 的连接器并集 + 该 provider 内被停用的连接器」，按 providerId 分组计算后在会话级合并成一次 restrict。

**为什么**：源仓在注释里已经写明为什么不能放进单个工具内部（`lib/connectors.js:20-22`：门控走 `tools.restrict({ deny })`，只在当前 agent 的工具视图上收窄，不改全局注册）。放进工具内部意味着每个工具实现自己判一遍——新增入口（模型工具、命令、直接路由）就多一条漏判的路径；而 `tools.restrict` 是宿主在「工具集合」这一层做的收窄，对所有入口一律生效，包括本插件没写过的入口。

**备选**：(a) 在工具执行的 handler 里判活跃集——只覆盖模型工具这一条入口，且要在每个 handler 里重复；(b) 停用 provider 时把它注册的工具整批注销——影响全局注册（其它会话跟着失去工具），且热重载后要重建；(c) 用 prompt 层告知模型「别调」——没有强制力。三条都被否。

### D6. 去 dsh-armory：自建连接器域，不做回退分支

**选了什么**：删除 `lib/client.js:308` 与 `:2522` 两处 `ctx.get('remote.mcpManager')` 与全部降级文案/分支，连接器域在 1.0.0 只交付五件事：列表、筛选、详情、OAuth 授权（`authorize`/`poll`/`cancel`）、复制配置片段。动作集从源仓的 `list|state|connect|repair|repairConnect|reauthorize|disconnect|unbind|enable|disable`（`lib/index.js:29`、`:337-355`）收敛为 `list|state|authorize|poll|cancel|copy-config|remove`——`state` 读已存授权状态，`poll` 推进进行中的授权（与 account 域同构），两者不可互相替代；`cancel` 只把进行中的授权推进到取消终态，`remove` 才移除已存授权记录（源仓的 `disconnect` 等价于删记录，被 `remove` 取代，否则界面的「清除授权」无服务端动作可挂）。

**为什么**：`remote.mcpManager` 是宿主内部服务，惰性解析受挂载顺序影响（源仓不得不在两处按需解析并保留回退），而且它的语义是「装一个连接器插件到本机」——没有「按 provider 分别门控」的位置。多 provider 门控要求「不活跃的库其连接器工具在该会话不可用」，这一点只能在我们的会话级工具层表达，托管给 armory 就永远接不上。

**备选**：(a) 保留 armory 作为可选增强——两条连接器来源的语义会分叉（armory 的门控在它那边，我们的门控在会话级），同一意图两条判定；(b) 只删 UI 复用、保留服务调用——服务仍按宿主挂载顺序成败，故障面不变；(c) 本轮就把「写入宿主配置」自研补齐——引入 MCP 配置写入与热重载，属 1.1.0 的独立风险面。

### D7. 前端：保留 `lib/client.js` 骨架 + provider 驱动，不拆分重写

**选了什么**：`lib/client.js`（2612 行）继续以现有的单文件 `factory` 形状维护，改动集中在四处：常量与路由表（`PACKAGE_ID`/`ENTRY_ID`/`SETTINGS_ENTRY_ID`/`ROUTES`，实测 `:39`、`:41`、`:47`、`:50-64`；`ENTRY_ORDER` 在 `:42`、`SETTINGS_ENTRY_ORDER` 在 `:48`）、注入方式（数据从「单上游一次性拉取」改为「先 `GET /dsh-bazaar/providers` 拿集合，再按 provider 分组取数」）、渲染结构（设置页 `SettingsAccountCard` 改页签式；面板改多选开关 + 分组卡片）、删除 armory 桥接（两处 `remote.mcpManager` 取值与相关状态）。

**为什么**：两屏的原型（`prototype/index.html`）与 `DESIGN.md` 已经把组件、状态语义、aria 承载定死，改的是「数据从哪来、按什么分组渲染」，不是组件体系。拆成多文件要引入构建步骤（宿主侧客户端插件是单文件加载，见 `window.__ModuleLoader__.load`，`lib/client.js:21`），会把 `hook-order`、`settings-card` 这类静态扫描测试的锚点全部作废。

**备选**：(a) 拆成多模块 + 打包——引入构建链与产物治理，本变更的实质是架构抽象而非前端工程化；(b) 用新框架重写两屏——原型已确认，重写等于把已确认的交互重新赌一次；(c) 保持单上游单面板、只加一个下拉切换——与「多库同时活跃、故障隔离、同名限定前缀」三个已确认结论直接冲突（`clarify.md` 的界面形态）。

### D8. eslint 存量用 `eslint-suppressions.json` 双模式，不一次性清零

**选了什么**：接入 `@eslint/js` recommended + 少量自定义（`no-unused-vars`、`no-console` 只对 `scripts/`、`eqeqeq`），覆盖 `lib`/`scripts`/`test`；存量违规登记进 `eslint-suppressions.json`，CI 按 `--suppress-all --prune-suppressions` 双模式跑（存量按清单放行、`--prune-suppressions` 让已修好的条目自动出清）。为堵住「双模式顺手把新违规也登记成已接受」这个缺口，CI 额外断言一件事：本次改动新增的抑制条目数必须为 0（清单只允许减少或保持），因此新代码违规仍然必报。

**为什么**：`lib/client.js` 2612 行、`lib/connectors.js` 1502 行，一次性清零会把「架构迁移」变成「风格大扫除」，diff 无法评审；而完全关掉规则又等于没有门。抑制清单是文件级的、可逐条消失的债务台账——新代码必报，存量按条目偿还。

**备选**：(a) 直接全量修——diff 淹没真实改动；(b) 只在新增目录（`lib/provider/`、`lib/providers/`）启用——迁移后的老模块永不收敛；(c) 用 `eslint-disable` 行内注释——散落且不可统计。

### D9. prettier 只对改动文件强制，存量走 ignore

**选了什么**：prettier 配置 `singleQuote`、无分号、`printWidth: 100`、LF；`.prettierignore` 排除存量文件；CI 的 `prettier --check` 只检查本次改动/新建的文件集合（清单随任务组维护）。

**为什么**：源仓 20 个模块里已有大量非 prettier 形状（缩进不一、对象换行不一），全量格式化会与 D8 的抑制清单互相踩（格式化移动行号，抑制条目失配）。只对改动文件强制，既保证新代码一致，也不让存量格式成为阻塞。

**备选**：(a) 全量格式化一次——巨大 diff + 抑制清单失效；(b) 完全不接 prettier——两屏原型与新增 provider 目录会继续各写各的；(c) 用 editorconfig 代替——管不到换行与引号这类会被评审反复挑的点。

### D10. 五个 capability 与模块落位

| Capability | 新路径（`lib/`） | 来源模块（旧名路径，替换关系） |
|---|---|---|
| `provider-registry` | `provider/registry.js`、`provider/contract.js`、`provider/paths.js`、`provider/errors.js` | 新增；`util.js` 的 `safeJoin`/`sha256`/`writeJsonAtomic`（`lib/util.js:45-70`）改用不复制 |
| `expert-market` | `providers/workbuddy/market.js`、`providers/workbuddy/portal.js`、`providers/workbuddy/experts.js` | `market.js`（`MarketClient`）、`portal.js`（`PortalMarket`、`normalizePortalExpert`） |
| `skill-market` | `providers/workbuddy/skills.js`、`skill-install.js`、`skill-providers.js`、`providers/workbuddy/memory.js` | `skill-install.js`（落位/锁/frontmatter）、`skill-providers.js`（技能 provider 注册）、`mnemon.js`（记忆插件探测，仅探测） |
| `connector-market` | `providers/workbuddy/connectors.js`、`providers/workbuddy/connector.js`、`providers/workbuddy/connector-flow.js`、`connectors.js`（会话门控） | `connectors.js`（store + 门控 `applyNow`/四钩子）、`connector.js`（`WorkBuddyConnector`）、`connector-flow.js`（操作注册表/深链/凭据字段） |
| `account-auth` | `providers/workbuddy/login.js`、`providers/workbuddy/accounts.js`、`providers/workbuddy/vault.js`、`auth.js` | `wb-login.js`、`wb-accounts.js`、`wb-vault.js`、`auth.js`（`resolveAuth`/`describeAuth`/`assertAllowedUrl`/`redact`/`AuthError`） |
| 跨域（不属任何 capability，编排层） | `index.js`（插件入口）、`session.js`（会话状态）、`session-plugin.js`（会话子插件）、`webui.js`（HTTP 路由）、`client.js`（两屏）、`bundle.js`（专家包下载）、`mcp-patch.js`（保留、1.0.0 不引用）、`mnemon.js`（探测）、`util.js` | 同名源模块 |

**划分依据**：一个 capability 的实现只能出现在它自己那一行（`skill-install.js` 与 `connectors.js` 保留在 `lib/` 顶层是因为它们承载「落位/门控」这类与上游无关的机制，被 provider 调而不是 provider 自己实现）。`mcp-patch.js` 保留但 1.0.0 无引用：它是 1.1.0 连接器写入宿主配置的现成原料（见 Migration Plan Roadmap），删掉等于把已验证的 patch 约定（server 名规范化、字段托管）扔掉。

### D11. `package.json` exports 重排

| 新 subpath | 目标 | 替代的旧 subpath |
|---|---|---|
| `./provider` | `./lib/provider/index.js` | 新增（契约与注册表） |
| `./providers/workbuddy` | `./lib/providers/workbuddy/index.js` | 合并 `./wb-login`、`./wb-vault`、`./wb-accounts`、`./connector-flow`、`./skill-providers`、`./market`、`./portal`、`./connector`（`WorkBuddyConnector` 类，被 `./wb-accounts` 与 `./connector-flow` 依赖；D10 已把它搬到 `lib/providers/workbuddy/connector.js`，旧 subpath 一并消失——仓外从此不能再以 `dsh-bazaar/connector` 导入，属 BREAKING，已进 CHANGELOG 移除清单） |
| `./client` | `./lib/client.js` | 不变（仅前缀与数据来源改） |
| `./auth` | `./lib/auth.js` | 不变（`assertAllowedUrl` 仍在此，供 provider 共用） |
| `./connectors` | `./lib/connectors.js` | 不变（会话门控与连接器 store） |
| `./skill-install` | `./lib/skill-install.js` | 不变 |
| `./session-plugin` | `./lib/session-plugin.js` | 不变 |
| `./bundle` | `./lib/bundle.js` | 不变 |
| `./mnemon` | `./lib/mnemon.js` | 不变 |
| `./mcp-patch` | `./lib/mcp-patch.js` | 不变（1.0.0 无内部引用，保留给 1.1.0） |
| `./cordis.patch.yml`、`./package.json` | 原文件 | 不变 |

**为什么保留细粒度 subpath**：`./auth`、`./skill-install`、`./connectors` 已被源仓的测试直接 import（例如 `test/core.test.mjs:8-14` 引 `../lib/auth.js`/`../lib/util.js`），收成一个大入口会让测试只能走插件入口，测不到单点判定。**为什么合并五个 `./wb-*`**：这五个 subpath 是「单上游」的产物——名字里带上游，且都只被插件入口自己用；合并进 `./provider` 与 `./providers/workbuddy` 后，仓外没有理由再直接依赖某个上游的内部模块。

### D12. 示例 provider 的定位与摆放位置

**选了什么**：`examples/minimal-provider/`，读本地 JSON、不联网、不登录、无凭据；不放进 `lib/`，不被 `lib/index.js` import，只被测试与 `docs/provider-integration.md` 引用。

**为什么**：契约要靠「换一家实现」来验证，只靠内置 provider 验证等于自己证明自己对。放在 `examples/` 且不进生产路径，能同时满足两个相反要求：测试里它是真 provider（走同一套 register/能力声明/错误码），发布产物里它不存在（`files` 不含 `examples/`）。

**备选**：(a) 作为第二个内置 provider 随插件注册——用户会看到一个空库，且示例数据与真实数据混在一起；(b) 只在文档里给代码片段——片段不会被 CI 执行，会随契约漂移；(c) 放进测试目录——测试目录被 `files` 排除同样如此，但示例也无法被文档直接引用路径。

### D13. provider 行为面：声明面之外的域方法契约

**选了什么**：provider 契约由**两部分**组成，缺一不可。

1. **声明面**（D2 已定）：`{ apiVersion, id, displayName, icon?, capabilities, allowHosts?, allowInsecureLoopback?, credentialRef? }`。
2. **行为面**（本条新增）：契约对象的 `capabilities.<域>` 为 `true` 时，该 provider **MUST** 同时提供该域的域方法对象；未声明为 `true` 的域，注册表 MUST NOT 调用其域方法（即使对象上存在该键）。行为面在契约对象上以 `impl` 字段承载：

```js
{
  apiVersion: 1,
  id: 'workbuddy',
  displayName: 'WorkBuddy 专家库',
  capabilities: { expertMarket: true, skillMarket: true, memoryMarket: true, connectorMarket: true, account: true },
  impl: {
    expertMarket:    { listExperts, getExpert },
    skillMarket:     { listSkills, installSkill },
    memoryMarket:    { listMemorySkills, searchMemory },
    connectorMarket: { listConnectors, getConnector, connectorAction },
    account:         { listAccounts, accountAction },
  },
}
```

**域方法签名与返回形状**（全部 `async`，入参为单个普通对象，入参缺省由注册表补默认值；返回形状是**扁平可 JSON 序列化对象**，`ok: false` + `code` + `message` 表示业务失败，不抛异常——沿用源仓 `lib/index.js:202-482` 的 `run()` 约定「参数错误返回文本而非抛异常」）：

| 域 | 方法 | 入参 | 成功返回 | 该域自有的失败码 |
|---|---|---|---|---|
| `expertMarket` | `listExperts` | `{ query?, categoryId?, page?, pageSize? }` | `{ items: Expert[], total: number, source: 'portal'\|'cos'\|'local', warning?: string }` | `BAZAAR_MARKET_AUTH_REQUIRED` / `BAZAAR_MARKET_RATE_LIMITED` / `BAZAAR_MARKET_UNAVAILABLE` / `BAZAAR_PORTAL_AUTH_REQUIRED` / `BAZAAR_PARAM_INVALID`（`page`/`pageSize` 非法或越界） |
| `expertMarket` | `getExpert` | `{ id }` | `{ item: Expert }` | 同上 + `BAZAAR_EXPERT_NOT_FOUND` |
| `skillMarket` | `listSkills` | `{ query?, page?, pageSize? }` | `{ items: Skill[], total: number }` | `BAZAAR_MARKET_*` |
| `skillMarket` | `installSkill` | `{ skillId, force? }`（`skillId` 是市场技能 id，源仓 `lib/skill-install.js:298-299`；`slug` 是 `skillSlug()` 的**推导产物**，不是入参） | `{ slug, installedPath, providerId }` | `BAZAAR_SKILL_NAME_CONFLICT` / `BAZAAR_SKILL_SLUG_INVALID` / `BAZAAR_SKILL_PACKAGE_TOO_LARGE` |
| `memoryMarket` | `listMemorySkills` | `{ query?, page?, pageSize? }` | `{ items: Skill[], total }` | `BAZAAR_MEMORY_UNAVAILABLE`（宿主缺记忆插件，须带插件名） |
| `memoryMarket` | `searchMemory` | `{ query, limit? }` | `{ items: MemoryHit[], total }` | 同上 |
| `connectorMarket` | `listConnectors` | `{ query?, status? }` | `{ items: Connector[], total, categories }` | `BAZAAR_CONNECTOR_*` |
| `connectorMarket` | `getConnector` | `{ id }` | `{ item: Connector }`（不含明文密钥） | `BAZAAR_CONNECTOR_NOT_FOUND` |
| `connectorMarket` | `connectorAction` | `{ action, id?, params? }`，`action ∈ list\|state\|authorize\|poll\|cancel\|copy-config\|remove` | `{ action, result }` | `BAZAAR_CONNECTOR_NOT_FOUND` / `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED` |
| `account` | `listAccounts` | `{}` | `{ own, all, pending, summary }` | `BAZAAR_AUTH_*` |
| `account` | `accountAction` | `{ action, accountId?, region?, token?, loginId? }`，`action ∈ list\|login\|poll\|cancel\|refresh\|remove` | `{ action, result }` | `BAZAAR_AUTH_*` |

`Expert` / `Skill` / `Connector` / `MemoryHit` 的字段形状**不在此另立 DTO**：直接复用源仓既有返回结构（专家来自 `lib/market.js` 与 `lib/portal.js` 的归一结果、技能来自 `lib/skill-install.js` 的 frontmatter 解析、连接器来自 `lib/connector.js` 的卡片结构），注册表只在其外层补 `providerId` 与 `qualifiedName`（多库同名时的限定名）。这条约束的目的就是防止出现第二套 DTO。

`BAZAAR_PROVIDER_ID_MISMATCH` **不属域方法失败码**：它在路由入口比对路径段与请求体 `providerId` 时产生（见 Rule Boundary 第 8 条），域方法永远收不到这个码；`BAZAAR_SKILL_PACKAGE_TOO_LARGE` 的体积上限取 `providers.<id>.maxPackageBytes`（默认 32 MiB）与 `maxTotalBytes`（默认 96 MiB），见 Data Model 的 provider 字段表。

**注册时校验行为面**：`register()` 在 D2 的版本/id/必填字段校验之后、登记之前，再校验「每个为 `true` 的能力域在 `impl` 上存在且其每个必需方法均为函数」，不满足返回 `BAZAAR_PROVIDER_IMPL_MISSING` 并指明缺失的 `providerId + 域名 + 方法名`，同样不产生半登记状态。

**为什么**：只定义声明面等于只告诉第三方「你可以声明什么」而不告诉他「你要实现什么」。三个具体后果在设计阶段就能看出来：①`examples/minimal-provider/` 是契约的活样例，没有方法面就无接口可写；②tasks 2.8 要求「内置与示例两个 provider 并存的隔离用例」，示例无法实例化则该矩阵写不出来；③`docs/provider-integration.md` 作为契约手册会缺掉最核心的一章。本变更的自我定位是「provider 契约与注册表是核心」（`proposal.md:10`），行为面缺失会让这个核心在文档层不成立。

把校验放在注册期而不是首次调用期，与 D2 同一理由：`list`/`get`/页签/开关只应看到**能用的** provider，而不是「登记了但某个域一调就崩」的。

**备选**：(a) 不定义方法名，只要求 provider 自己实现路由与界面——注册表就退化成一张名单，插件无法统一渲染页签、无法统一门控、无法统一错误码，等于放弃抽象；(b) 定义成宿主侧的 class 继承基类——契约要能被仓外第三方实现，继承一个内部基类会把内部实现细节变成公开 ABI；(c) 用 TypeScript 接口 + 构建期检查——本仓是纯 ESM + `node --check`，无构建步骤，运行期校验是唯一可执行的形式；(d) 允许 provider 只实现部分方法、缺失的域回落为空列表——与 `capabilities` 的语义冲突（声明了却返回空会被当成「没有数据」而不是「没实现」），错误会被静默吞掉。

**代价**：契约对象比纯声明多一个 `impl` 字段（约 10 行代码量）；`apiVersion: 1` 的方法集合一旦发布就是公开 ABI，后续增删方法必须走 `apiVersion` 升级——这是有意的：让破坏性变更显式化，而不是悄悄加个可选方法。

## Data Model

**本变更是 JSON 文件持久化，无数据库、无 DDL、无迁移脚本。** 所有状态的「表结构」就是文件布局与字段形状；等价信息量以字段表给出（类型 / 可空性 / 默认值 / 归一规则），不使用 `CREATE TABLE`。

### 文件布局

```
<DSH_HOME>/bazaar/
├── providers/
│   └── <providerId>/                     # providerId 匹配 ^[a-z][a-z0-9-]{0,31}$，目录名即 id
│       ├── accounts/<region>/<accountId>.json
│       ├── vault/<region>/<accountId>.json
│       ├── connectors.json
│       └── cache/
│           ├── manifest.json
│           ├── manifest.meta.json
│           ├── bundles/
│           └── downloads/
└── sessions/<sha256(sessionId)>.json
```

- `<DSH_HOME>` 由 `resolveDshHome()` 解析（`lib/util.js:6-10`，`DSH_HOME` 环境变量优先，否则 `~/.dsh`）；`dataDir` 默认 `<DSH_HOME>/bazaar`（旧值 `<DSH_HOME>/workbuddy-helper`，源仓 `lib/index.js:60`）。
- `accountId` 由 uid 哈希得到（源仓 `lib/wb-vault.js:53` 的 `accountIdOf`），目录列表不泄露 uid。账号文件路径形状沿用源仓 `<root>/<region>/<accountId>.json`（`lib/wb-vault.js:141`、`:145`），只是 `root` 从 `<dataDir>/accounts` 变成 `providers/<providerId>/accounts`。
- `vault/` 是该 provider 自己的密钥材料槽（0600）：与 `accounts/` 分开是因为账号记录会被列表接口整体读出（只回脱敏摘要），而密钥材料不应跟随账号列表的读写路径。1.0.0 的内置 provider 不向 `vault/` 落文件（凭据走宿主 credential 服务），目录懒创建。
- `cache/` 的四个子项是源仓既有形状：`manifest.json`/`manifest.meta.json`（`lib/market.js:62-63`）、`bundles/`/`downloads/`（`lib/bundle.js:68-69`）。
- 旧目录 `<DSH_HOME>/workbuddy-helper`、`<DSH_HOME>/workbuddy-vault` **不读取、不探测、不提示**；`importFromVault`（`lib/wb-vault.js:380-392`）随之删除，账号动作集里不再有 `import`。

### 文件一：`providers/<providerId>/accounts/<region>/<accountId>.json`

| 字段 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `schemaVersion` | number | 否 | `1` | 结构演进判断位 |
| `region` | `'cn' \| 'global'` | 否 | 由登录时区域决定 | 与目录层 `region` 必须一致，不一致视为损坏记录并跳过 |
| `account.uid` | string | 否 | `''` | 上游账号标识；参与 `accountId` 哈希 |
| `account.nickname` | string | 否 | `''` | 展示用 |
| `account.uin` | string | 否 | `''` | 上游字段，可空串 |
| `account.avatarUrl` | string \| null | 是 | `null` | 展示用 |
| `auth.domain` | string | 否 | `''` | 该账号的域（区域判定证据） |
| `auth.token` | string | 是 | 缺省表示无 | **永不出现在任何响应体**；只经 `describe` 输出 `hasToken` |
| `auth.refreshToken` | string | 是 | 缺省表示无 | 同上（`hasRefreshToken`） |
| `expiresAt` | number（epoch ms） | 否 | `0` | `0` 表示不限期 |
| `refreshExpiresAt` | number（epoch ms） | 否 | `0` | 同上 |
| `refreshedAtMs` | number | 否 | `0` | 最近刷新时刻 |
| `updatedAt` | string（ISO） | 否 | `nowIso()` | 审计字段 |

派生字段（`describeAccount`，`lib/wb-vault.js:53-70`）`hasToken`/`hasRefreshToken`/`expired`/`refreshExpired`/`usable` **不落盘**，每次读取按当前时间计算。写盘权限：`mode: 0o600`（沿源仓 `lib/wb-vault.js:200` 的写法）。

### 文件二：`providers/<providerId>/connectors.json`

| 字段 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `version` | number | 否 | `1` | 源仓 `emptyStore()` 同形状（`lib/connectors.js:437-439`） |
| `configs` | `Record<connectorId, ConfigRecord>` | 否 | `{}` | 只在真正改状态时落条目（`peekRecord` 只读不写，`lib/connectors.js:437-441`） |
| `configs.<id>.bound` | boolean | 否 | `false` | 是否已绑定本机 |
| `configs.<id>.enabled` | boolean | 否 | `true` | 全局停用即会话内工具消失（`lib/connectors.js:966-970`） |
| `configs.<id>.headers` | `Record<string,string>` | 否 | `{}` | 复制配置片段用；含密钥的条目由 `redact` 处理 |
| `configs.<id>.env` | `Record<string,string>` | 否 | `{}` | 同上 |
| `configs.<id>.credentials` | `Record<string,string>` | 否 | `{}` | 凭据字段值；**只写不读回响应** |
| `configs.<id>.token` | string | 否 | `''` | 兼容字段（1.0.0 不再写宿主 patch，但保留读取以维持旧记录形状） |
| `configs.<id>.patchManaged` | boolean | 否 | `false` | 1.0.0 恒为 `false`（不写宿主配置），字段保留给 1.1.0 |
| `configs.<id>.updatedAt` | number | 否 | `0` | 审计 |
| `sessions` | `Record<sessionId, string[]>` | 否 | `{}` | 该会话内被停用的连接器 id 集合（源仓 `disabled` map 的持久化形状） |
| `uiOpens` | `Record<connectorId, {serverName, configId, at, sessionId}>` | 否 | `{}` | 「上次去过授权页」的留痕（`lib/connectors.js:462-470` 的语义），只为诊断 |

写入采用「读缓存 → 改 → 整体序列化 → tmp + rename」（`lib/connectors.js:433-468`，`storePath()` 在 `:433`、`saveStore()` 在 `:457`；`:419-431` 是 toolsService 注入段），并按 store 一条 promise 队列串行化。

### 文件三：`sessions/<sha256(sessionId)>.json`

| 字段 | 类型 | 可空 | 默认 | 说明 |
|---|---|---|---|---|
| `schemaVersion` | number | 否 | `1` | 源仓 `SCHEMA_VERSION`（`lib/session.js:6`） |
| `sessionId` | string | 否 | 调用方传入 | 回写字段，便于人工排查（文件名是哈希） |
| `activeProviders` | string[] | 否 | `[]` | 去重后按 providerId 升序；只含已注册 id |
| `experts` | `Record<providerId, ExpertRef>` | 否 | `{}` | 键不存在 = 该库未选择；`ExpertRef` 见下 |
| `skills` | `Record<providerId, SkillScope>` | 否 | `{}` | 同上 |
| `revision` | number | 否 | `0` | 每次成功写 +1（`lib/session.js:96-102`） |
| `updatedAt` | string（ISO） | 否 | `nowIso()` | 审计字段 |

`ExpertRef`（沿用源仓 `state.expert` 的字段集合，`lib/session.js:151-160`）：

| 字段 | 类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | string | 否 | — |
| `plugin` | string | 否 | `id` |
| `version` | string | 是 | `null` |
| `displayName` | string | 否 | `id`（`displayName` 为对象时取 `zh ?? en ?? id`，同 `lib/session.js:360-365`） |
| `root` | string | 是 | `null` |
| `source` | `'portal' \| 'cos' \| 'local'` | 否 | `'local'` |
| `promptChars` | number | 是 | `null` |
| `promptTruncated` | boolean | 否 | `false` |

`SkillScope`：

| 字段 | 类型 | 可空 | 默认 | 归一规则 |
|---|---|---|---|---|
| `globalMode` | `'all' \| 'selected'` | 否 | `'all'` | 其它值 → `'all'`（源仓 `lib/session.js:88`） |
| `globalNames` | string[] | 否 | `[]` | 去空串、去重，上限 `maxSelectedSkills`（默认 64，插件级配置） |
| `expertNames` | string[] | 否 | `[]` | 同上 |

### 会话状态的读写语义（切库不互相覆盖）

1. **唯一写入口**：`session.saveState()` 一处。所有写路径（面板开关、`POST /dsh-bazaar/sessions/active-providers`、`POST /dsh-bazaar/select`、`POST /dsh-bazaar/skills`、`POST /dsh-bazaar/off`、模型工具、斜杠命令）都先构造完整 state 再落盘，不直接 `fs.writeFile`。
2. **按 providerId 分组**：`experts[pid]` 与 `skills[pid]` 的写入只触碰自己的键；写 A 库不构造 B 库的对象，从结构上不会覆盖。
3. **活跃集与选择解耦**：`POST /dsh-bazaar/sessions/active-providers` 只改 `activeProviders`，**不动** `experts`/`skills`（熄灭再点亮，历史选择仍在）；`POST /dsh-bazaar/off` 带 `providerId` 时只清该库一个分区，省略时只清 `activeProviders` 里各库的分区，历史（非活跃）分区保持。
4. **原子写**：序列化为 `JSON.stringify(state, null, 2) + '\n'` → 写 `<file>.tmp-<pid>-<base36(now)>`（`mode: 0o600`）→ `rename` 覆盖（`writeJsonAtomic`，`lib/util.js:45-50`）。不出现「写了一半的文件」；崩溃只可能丢掉本次改动，不会留下坏 JSON。
5. **串行化**：每个 sessionId 一条 promise 队列（`lib/session.js:104-109`），并发请求排队执行，后写者看到的是前写者的结果。
6. **版本号**：成功写入前 `revision += 1` 并刷新 `updatedAt`；读取时 `revision` 只作诊断与前端缓存失效判断，不做乐观锁（单进程宿主 + 串行队列已足够，见 Risks 的第二条）。
7. **归一**：读取时一律过 `normalizeState()`（形状沿 `lib/session.js:77-94`）：缺字段补默认、非法枚举回落、非字符串数组元素剔除、`activeProviders` 过滤掉未注册 id（并把被过滤的情况记为 warning 返回，不静默改配置）。

### 配置文件结构（`config`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 与源仓一致（`lib/index.js:39`） |
| `defaultProvider` | string | `''` | 空串 = 未设置；非空但未注册 → 报错并回落首个已注册（见 D3） |
| `dataDir` | string | `<DSH_HOME>/bazaar` | 只影响根目录，provider 子目录恒由 id 推导 |
| `maxSelectedSkills` | number | `64` | 与上游无关的限制，保留插件级 |
| `maxPromptChars` | number | `60000` | 同上 |
| `providers.<providerId>` | object | `{}` | provider 级参数，见下 |

`providers.<providerId>` 的字段（只有 provider 自己读，插件入口不解释）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `portalBaseUrl` | string | `https://www.workbuddy.cn` | 门户市场地址 |
| `marketBaseUrl` | string | `https://<COS host>/workbuddy/expert-marketplace` | 快照市场地址 |
| `regions` | `('cn' \| 'global')[]` | `['cn', 'global']` | **登录区域的候选集**：决定屏 A 下拉里出现哪几项（缺省两项都出现）。它**不是默认选中值**——界面 MUST NOT 预选任一区域（见 `specs/account-auth` 的「未选登录区域时界面拦下且不发请求」）；候选集为空数组视为配置错误。源仓无此键（`lib/wb-login.js:37-52` 的 `REGIONS` 恒含 cn/global 两项），新增它是为了让 provider 能裁剪候选 |
| `timeoutMs` | number | `20000` | 出网超时 |
| `retries` | number | `1` | 出网重试 |
| `cacheTtlMs` | number | `21600000` | 市场缓存 TTL |
| `staleWhileErrorMs` | number | `604800000` | 出错时用旧缓存的窗口 |
| `allowHosts` | string[] | provider 自带上游域名集合。workbuddy 为**市场 4 域名**（`www.workbuddy.cn`、`www.workbuddy.ai`、`openplatform-cdn.codebuddy.cn`、`acc-1258344699.cos.accelerate.myqcloud.com`）+ **登录侧新增 2 域名**（`www.codebuddy.cn`、`www.codebuddy.ai`，源仓 `lib/wb-login.js:49` 的 `global.hosts` 含后者且 `:48` 注释明确两个都要在白名单），去重后共 **6 个**（`www.workbuddy.ai` 同属市场与登录两侧，不重复计入） | 出网白名单；**逐 provider 独立**。登录链路 1.0.0 MUST 改造为经同一份 `assertAllowedUrl`，故默认值必须同时覆盖市场与登录两侧，否则 cn 或 global 登录会被判 `BAZAAR_HOST_DENIED` |
| `allowInsecureLoopback` | boolean | `false` | 仅对本 provider 放行本机 http |
| `credentialRef` | string | `BAZAAR_<UPPER_SNAKE(id)>_TOKEN` | 覆盖默认凭据名 |
| `authMode` | `'none' \| 'bearer' \| 'header' \| 'cookie'` | `'none'` | 认证模式。源仓的 `auto` 与 `workbuddy-connector` 依赖旧 vault 兼容层，本版删除（见 proposal 的配置面收敛）；`none` 即匿名，仅可读公开快照 |
| `headerName` | string | `'Authorization'` | `bearer` 模式下的认证头名；`header` 模式下必填，缺失 → `BAZAAR_AUTH_HEADER_MISSING`（源仓 `lib/auth.js:107-109`） |
| `headerPrefix` | string | `'Bearer '` | `bearer` 下的值前缀；`header` 下默认空串（源仓 `:110`） |
| `maxPackageBytes` | number | `33554432` | 技能包体积上限（32 MiB，源仓 `lib/skill-install.js:20`）；超出 → `BAZAAR_SKILL_PACKAGE_TOO_LARGE` |
| `maxEntries` | number | `400` | 技能包条目数上限（源仓 `:21`）；超出按同一错误码拒绝 |
| `maxTotalBytes` | number | `100663296` | 解压后总量上限（96 MiB，源仓 `:22`）；超出按同一错误码拒绝 |
| `fetchImpl` | `typeof fetch` | `undefined`（回落全局 `fetch`） | **仅供测试注入 HTTP 替身**，1.0.0 保留：源仓 `fetchImpl` 在 `test/` 下出现 118 次（114 行），是离线跑通 226 用例的唯一途径，删掉「原样跑通基线」不成立。生产配置不应设置它 |

`dshHome` 与 `vaultDir` 两个源仓键**随 vault 兼容层一并删除**（`vaultDir` 是兼容层的读目录，`dshHome` 只服务它的默认值推导；`test/` 下共 79 个 `file:line` 引用（`vaultDir` 60 行、`dshHome` 35 行，去重后 79 行）需随兼容层用例一并移除）。

`marketMode`（portal/cos/auto）**不在配置里**：它降为 workbuddy provider 的内部选择（先门户、失败回落快照；源仓 `lib/market.js:39-43` 的注释即此语义），插件入口与注册表都不知道它的存在。

### 凭据 ref 规则

- 默认名：`BAZAAR_<UPPER_SNAKE(providerId)>_TOKEN`，`UPPER_SNAKE` 即大写字并把 `-` 换成 `_`；内置 provider 因此是 `BAZAAR_WORKBUDDY_TOKEN`（旧名 `WB_EXPERT_TOKEN`，源仓 `lib/auth.js:90`、`:157`、`lib/index.js:52`）。
- 覆盖：`providers.<id>.credentialRef` 优先；注册表只把 providerId 交给 provider，不替它决定名字。
- 解析：只经宿主 credential 服务（`resolveAuth` 的 `bearer`/`header`/`cookie` 三支，`lib/auth.js:87-115`；`authMode=none` 不取凭据、直接匿名请求），走 `headerName`/`headerPrefix` 拼装认证头（默认 `Authorization` + `Bearer `），配置里出现明文密钥一律以 `BAZAAR_AUTH_INLINE` 拦下（源仓 `rejectInlineSecret`）。源仓的 `auto`/`workbuddy-connector` 两支依赖 `dsh-connect-workbuddy` vault 兼容层，本版删除。
- 隔离：凭据名恒由 providerId 推导，注册表不向任何 provider 传递他人的名字或路径，因此 A 库无法凭名字读到 B 库的 token。

### 不做旧数据迁移（显式声明）

不探测旧目录 `<DSH_HOME>/workbuddy-helper`、`<DSH_HOME>/workbuddy-vault`，不读其中的 `connectors.json`、账号 JSON 或 bundle 元文件，不在日志或界面提示「发现旧数据」。旧账号需要用户重新登录；旧连接器授权需要重新授权。理由见 proposal 的 Related Surface 第 17 条与 Migration Plan 的回滚说明。

## Rule Boundary Attachment

八条规则的挂载点与「为何不被其它执行路径误触」。全部挂载点都在**被多条入口共用的那一层**，不放进单个域实现内部。

### 1. 会话级工具门控（`connector-market`）

- **挂载层级**：会话级工具层。`applyNow()`（`lib/connectors.js:1015-1025`）在 `agent.ctx.get('tools').restrict({ deny })` 上收窄当前 agent 的工具视图；触发点是 `agent/created`（`:1427`）、`agent/disposed`（`:1430`）、`agent/pre-step`（`:1434`）、`tools/change`（`:1442`）四个钩子，由 `applyQueue`（`:401`）按 agent 串行化重放。**不在**任何单个连接器工具的 handler 内部。
- **判定内容**：`connectorNamesFor()`（`:960-980`）改为「按 providerId 分组」——对每个已注册 provider，若它在本会话未活跃，则把该 provider 的连接器 server 派生的工具名全部收入 deny；若活跃，则只收该 provider 内部被停用的连接器。分组结果在会话级取并集，一次 restrict。
- **为何不误触其它流程**：deny 集合的**构造**只枚举本插件自己算出的名字（`toolNamesFor(config, definitions)`，源仓 `:977`），来源是本插件持有的 `connectors.json` 与本插件的 provider 集合；宿主 MCP 工具名带 `mcp__<server>__` 前缀，只有本插件登记过的 connector id 才能被展开成名字。合并语义是**并集且不覆盖**：`tools.restrict` 是宿主在 agent 作用域上的叠加收窄，本插件只 add 自己那一份 deny、返回自己的 dispose，不枚举、不重写、不注销其它插件（含其它会话门控插件）已登记的 deny 条目；`dispose()`（`:1453-1461`）只释放自己持有的 restrict 句柄。因此「别的插件也在同一 agent 上 restrict」时，两份 deny 同时生效，互不吞并。
- **为何不放工具内部**：工具内部判定只覆盖「模型工具」一条入口；本插件的连接器工具还会被命令、直接路由、其它插件的会话复用。放进工具内部等于每新增一个入口就多一处漏判。源仓注释（`:20-22`）已经写明这套机制的选择理由。
- **失败语义**：门控失败不中断该步（`agent/pre-step` 里 `try/catch` 吞掉，`:1434-1441`），但会记 warn 并在下一次 `tools/change` 重放；「看起来正常但从不生效」由 `connector-gate` 类用例兜住。

### 2. 出网地址校验（`account-auth`）

- **挂载层级**：同一处校验函数 `assertAllowedUrl(raw, config)`（`lib/auth.js:169-190`）。源仓现状是「市场与快照已接入、登录与连接器刷新未接入」：市场 3 处（`lib/market.js:81`、`:345`、`:353`）、快照 3 处（`lib/portal.js:329`、`:355`、`:372`）已调用；登录 4 处（`lib/wb-login.js:194`、`:251`、`:303`、`:363`）走的是自有 `baseForRegion`（`lib/wb-login.js:62-78`，只校验 `https:` 与已知 host，抛普通 `Error`、不产生 `BAZAAR_*` 码），**1.0.0 MUST 改造为经同一 `assertAllowedUrl`**；连接器刷新（`lib/connector.js:241`/`:283` 调 `refreshCredential`）随登录一并收口。另有独立的第 5 个出网点——技能包下载（`lib/skill-install.js:269`），不属于四入口但同样经该函数。全部点位改为一律传入**该 provider 自己的** `urlConfig`；`urlConfig` 由注册表在 `register()` 时从 `allowHosts`/`allowInsecureLoopback` 派生并冻结、随 `impl` 一并持有，域方法经闭包访问，**不出现在方法入参里**（故 `installSkill` 签名无需新增字段）。
- **判定内容**：协议非 `https` 且未获回环例外 → `BAZAAR_URL_INSECURE`；URL 带 userinfo → `BAZAAR_URL_USERINFO`；解析失败 → `BAZAAR_URL_INVALID`；host 不在该 provider 的 `allowHosts` → `BAZAAR_HOST_DENIED`。四种都是抛错，**不降级为「不带凭据继续请求」**。
- **为何不误触**：`allowHosts` 与 `allowInsecureLoopback` 从插件级（源仓 `lib/index.js:56-57`）下沉到 `providers.<id>`，每个 provider 只拿自己那一份配置对象；校验函数本身无全局状态、不读环境变量、不做记忆化，A 库的回环例外对 B 库不可见。插件入口不再持有任何全局白名单，因此也没有「改一处、四路一起放宽」的路径。
- **等价路径**：四个出网入口（在线市场 / 公开快照 / 登录 / 连接器刷新）判定的唯一差别是传入的 provider 配置。登录与连接器刷新在源仓本就是同一处实现（`lib/connector.js:22` import `wb-login` 的 `refreshCredential`），改造后两者都经 `assertAllowedUrl`——一致性由「同一函数 + 同一份 provider `urlConfig`」保证，而不是由源仓现状保证；市场与快照各自独立调用，同样按同一 provider 配置断言结果一致。

### 3. `providerId` 白名单：既是输入校验也是路径防线（`provider-registry`）

- **挂载层级**：注册表注册动作（`register()` 内部，登记之前）+ 路径拼装函数（`provider/paths.js`）。
- **判定内容**：`^[a-z][a-z0-9-]{0,31}$`，不匹配 → `BAZAAR_PROVIDER_INVALID_ID`，整条 provider 被拒。目录恒由这个已校验的 id 拼接：`path.join(dataDir, 'providers', id, ...)`，并在拼接后再过一次 `safeJoin`（`lib/util.js:63-70`：解析后必须落在根内，Windows 下大小写归一）作为第二道。
- **为何不误触**：白名单只在「新 id 进入系统」这一处判定（注册），之后的路径拼装只消费已通过校验的 id，不再重复判定，因此不存在「某条路径忘了判」的缝隙；而 `safeJoin` 是纯函数、无配置、无例外开关，任何调用方拿到的越界结果都是 `undefined` 而不是一个被修正过的路径。
- **等价路径**：HTTP 路径里的 `<providerId>`、工具参数 `provider`、命令里的前置段、配置里的 `defaultProvider` 四条入口都先过注册表 `get(id)`；未注册即 `BAZAAR_PROVIDER_UNKNOWN`，格式非法即 `BAZAAR_PROVIDER_INVALID_ID`——两种错误不合并，避免把「打错字」和「试图穿越」混为一谈。

### 4. 能力未声明（`provider-registry`）

- **挂载层级**：每个域的入口动作（专家列表/详情/选择、技能市场/安装、记忆市场、连接器列表/详情/授权、账号列表/登录），进入实现之前先查该 provider 的 `capabilities`。
- **判定内容**：未声明 → `BAZAAR_CAPABILITY_UNDECLARED`（服务端错误码），界面渲染「未声明 · 不适用」块而不是空态。声明了但当前无数据 → 正常空态（不是错误）。
- **为何不误触**：判定读的是该 provider 自己的声明，不看全局开关，也不看「其它 provider 有没有声明」；示例 provider 只声明 `expertMarket` 时，它的技能与账号块是「未声明」，而内置 provider 的同样域不受影响。
- **等价路径**：界面禁用（灰掉搜索框/入口）与服务端错误码同源——界面读的是同一个 `capabilities` 字段，绕过界面直接调接口仍拿到同一个码（用例覆盖「客户端绕过禁用态直接提交」）。

### 5. 跨库技能同名冲突（`skill-market`）

- **挂载层级**：技能安装落位动作（`skill-install.js` 的 `installSkill()`，源仓 `:296`）：落盘路径与元数据写入在同一处，冲突判定读**已有安装元数据里的 `providerId`**，不读界面状态。
- **判定内容**：目标 `<projectRoot>/.dsh/skills/<slug>/` 已存在且其元数据 `providerId` 与本 providerId 不同 → `BAZAAR_SKILL_NAME_CONFLICT` 并指出已有来源（providerId + displayName）。`force` 只用于打断残留锁目录（`.lock-<slug>`，源仓 `:354`、`:217`），**不解冲突**——同一库重装同名技能是幂等覆盖（放行）。
- **为何不误触**：判定条件是「已安装条目的 providerId ≠ 本次 providerId」，同库重装、不同库不同名、不同库同名但目标是另一个 slug 三种情况都不会命中；判定与落位同一入口，所以面板、模型工具、命令、直接路由四条安装路径拿到同一结果（`force` 不是绕过开关，只是锁策略）。

### 6. 会话状态写入隔离（`expert-market` / `skill-market`）

- **挂载层级**：唯一写入口 `session.saveState()`（见 Data Model 的读写语义）。
- **判定内容**：写 `experts[pid]`/`skills[pid]` 只触碰自己的键；活跃集写入不改选择；`off` 带 providerId 只清一个分区。
- **为何不误触**：分组键就是 providerId（已过白名单），写入前先 `get(pid)` 确认已注册，未注册直接 `BAZAAR_PROVIDER_UNKNOWN`，因此不存在「把 A 库的选择写进 B 库分区」的入口——B 的键只有 B 的写路径能构造。

### 7. 重复注册与路由/页签残留（`provider-registry`）

- **挂载层级**：注册表 `register()`/`unregister()` 与路由注册的 effect 生命周期（`registerWebUi` 的释放逻辑，源仓 `lib/webui.js:222-228`：注册前先删掉以本插件前缀开头的陈旧路由条目）。
- **判定内容**：同 id 重复注册 → `BAZAAR_PROVIDER_DUPLICATE`（不覆盖、不合并）；注销后同 id 重新注册放行；注销或热重载后，该 provider 的路由与页签条目不残留。
- **为何不误触**：清理只匹配本插件前缀 `/dsh-bazaar`（不按 providerId 前缀模糊匹配，避免误删其它插件的 `/dsh-bazaarish`），且清理发生在「注册同一前缀」的同一个 effect 内，配对成对；注销只移除该 id 的条目，其它 provider 的页签与路由不动。

### 8. 路径与请求体 `providerId` 一致性（`connector-market`）

- **挂载层级**：路由入口的 providerId 解析处（`webui.js` 处理 `POST /dsh-bazaar/providers/<providerId>/connectors/session` 与 `.../connectors/action` 时），在把请求交给 provider 之前；**不在**连接器实现内部，也不在单个动作分支里。
- **判定内容**：请求体的 `providerId` MUST 与路径段完全一致；字段缺失或值不同 → `BAZAAR_PROVIDER_ID_MISMATCH`，错误信息同时指出路径值与请求体值，且两个 provider 都不发生任何写入。
- **为何不误触**：这两条写路由是全插件仅有的「同一请求里出现两个 providerId」的形态（路径用于定位、请求体用于防误投），比对只在这一处做一次；其它入口（GET 路由、模型工具、命令、面板）的 providerId 只有一个来源，不存在两个值打架的场景，因此不会被这条规则命中。
- **等价路径**：路由入口比对与服务端实现（4.2）是同一处代码，绕过界面直接构造请求同样被拦（用例按此断言）。

## Interface & Implementation Mapping（界面与实现映射）

| Screen | 组件 · 路由 · 接口 | 状态标识与校验是否同源 |
|---|---|---|
| 屏 A · 设置页 `DSH 设置 › 扩展 › dsh-bazaar` | 组件：`lib/client.js` 的 `SettingsAccountCard`（设置项 id `bazaar-account`，`SETTINGS_ENTRY_ORDER = 25` 不变，`settings.section` 与 `settings.section.icon` 共用同一常量），页签容器 `role="tablist"` + 每 provider 一页签，页签内四块（账号 / 凭据 / 缓存 / 连接器授权）。路由/接口：`GET /dsh-bazaar/providers`（页签集合与 `capabilities`）、`GET /dsh-bazaar/providers/<providerId>/accounts`（`own`/`all`/`pending`/`summary`，只回脱敏摘要）、`POST /dsh-bazaar/providers/<providerId>/accounts/action`（`list`/`login`/`poll`/`cancel`/`refresh`/`remove`）、`GET /dsh-bazaar/providers/<providerId>/connectors/state`、`POST /dsh-bazaar/providers/<providerId>/connectors/action`（`list`/`state`/`authorize`/`poll`/`cancel`/`copy-config`/`remove`）。 | **同源：是（以服务端为唯一权威）**。①必填：**登录区域（国内版 / 国际版）为必选项**——界面由 5.1 渲染 `required` + `aria-required` + 可见文字「（必选）」且**不预选**任一区域，未选就点「登录」时下拉进入字段级出错态并**不发出请求**；**服务端**由 4.5 在登录入口对缺失或非法 `region` 返回 `BAZAAR_PARAM_INVALID`，绕过界面同样被拦（区域决定凭据发往哪套上游账号体系，猜错等于把令牌发错主机）。凭据值、账号标识、连接器授权状态为**只读**，接口只提供读路径与「替换/清除」写动作，没有任何接收凭据明文的入参，因此界面不是唯一防线。②禁用：凭据未配置时的「登录」按钮——界面由 5.4 渲染 `disabled` + `aria-disabled` + 原因文案，**服务端**由 4.6 在该 provider 的凭据解析处先判是否已配置（`describeAuth().configured === false` 时直接 `BAZAAR_AUTH_MISSING`），绕过按钮同样被拦。③未声明 `capabilities.account` / `connectorMarket` 时渲染「未声明 · 不适用」块，服务端对应域调用返回 `BAZAAR_CAPABILITY_UNDECLARED`（由 2.4 的域入口判定补齐）。④危险操作（清理缓存 / 退出登录 / 清除授权）二次确认在界面（5.4），服务端不提供批量或隐式清除入口（4.5、4.3）。 |
| 屏 B · 会话辅助面板（对话输入区左侧「集市」） | 组件：`lib/client.js` 的面板 entry（`ENTRY_ID = bazaar-expert-picker`，`ENTRY_ORDER = 26` 不变，插槽 `conversation.input.left`），顶部 provider 多选开关组（`role="group"` + 分组标题写明「可多选」，**不挂 `aria-required`**）、下方按库分组并列的卡片（每库含搜索框、分类 chip、专家/技能条目、分区级「重试」与错误区）。路由/接口：`GET /dsh-bazaar/providers`、`GET /dsh-bazaar/state?sessionId=`、`POST /dsh-bazaar/sessions/active-providers`、`GET /dsh-bazaar/providers/<providerId>/experts`、`POST /dsh-bazaar/select`、`GET /dsh-bazaar/providers/<providerId>/skill-market`、`POST /dsh-bazaar/providers/<providerId>/skill-install`、`POST /dsh-bazaar/skills`、`POST /dsh-bazaar/off`；模型工具 `bazaar_helper`（`provider` 参数 + `action=providers`）与命令 `/bazaar <providerId> <action>` 走同一批服务端校验。 | **同源：是（以服务端为唯一权威）**。①必填：本屏没有「用户必须填写」的字段——provider 开关组是**可选多选**，全不勾选是合法空态（服务端接受 `activeProviders: []`，见「显式清空活跃集被放行」），界面由 5.2 渲染为可选并给空态入口，MUST NOT 标为必填；真正的必填只在请求层：服务端在 `POST /dsh-bazaar/select` 与 `POST /dsh-bazaar/skills` 校验 `providerId` 必填且已注册、且该 provider 在 `activeProviders` 内，缺失/未活跃返回 `BAZAAR_PROVIDER_REQUIRED`、未注册返回 `BAZAAR_PROVIDER_UNKNOWN`，由 3.4 补齐（工具与命令侧读同一份活跃集，由 2.6 的「唯一取值来源」保证一致）。②禁用三处：跨库同名技能的「安装」按钮（界面 5.3 渲染 `disabled` + 冲突来源旁注，服务端 3.7 返回 `BAZAAR_SKILL_NAME_CONFLICT` 且 `force` 不覆盖）；未声明 `memoryMarket` 的记忆市场搜索框（界面 5.3，服务端 3.6 返回 `BAZAAR_CAPABILITY_UNDECLARED`）；未启用库的条目（界面 5.2，服务端按活跃集拒绝选择）。③只读：专家条目的「当前使用」徽标由 `GET /dsh-bazaar/state` 的 `experts[providerId]` 派生，界面无写入口（5.2），服务端不接受「设为当前」以外的隐式写入，写只发生在 `POST /dsh-bazaar/select`（3.4）。④同源校验点：屏幕上的「已选 / 应用中 / 冲突 / 未声明 / 加载中 / 出错」六种标识全部由接口返回的字段与错误码派生（5.2、5.3 负责渲染，3.4/3.6/3.7 负责产生），不存在界面自造状态。 |

## Risks / Trade-offs

- [单文件会话状态的写放大：任一 provider 的改动都重写整份会话文件] → 会话状态只有几十个键（活跃集 + 每库一条专家引用 + 每库一组技能名），单次写 < 8 KB；`schemaVersion` 已预留，若将来专家级技能列表变长，可按 providerId 拆子文件而不改文件名。
- [串行队列只在单进程内有效：两个宿主进程写同一 `DSH_HOME` 时仍可能互相覆盖] → 宿主的插件运行在单一进程内（`lib/session.js:104-109` 的队列即基于此假设）；原子 rename 保证不会出现半文件，最坏情况是丢掉一次改动。多进程场景不在 1.0.0 承诺范围内，`revision` 可用于事后诊断。
- [抑制清单会掩盖新增违规：`--suppress-all` 若被误用会把新写的违规一起登记成「已接受」] → CI 除双模式外再加一条门禁断言「新增抑制条目数必须为 0（只允许减少或保持）」，并配一条自测用例证明新违规确实会报错；清单文件的变更必须在 PR 里可见（review 时按条目增减审）。
- [`prettier --check` 只覆盖改动文件：清单靠任务组维护，漏登记就会出现未格式化的新文件] → 新增/改动的文件清单与任务组一一对应（每个任务末尾标注它产生的文件），CI 的 `files` 参数从该清单生成；遗漏由「目录一致性」静态用例兜（新增文件必须在清单里）。
- [删除 armory 后失去「一键装好连接器」的体验] → 1.0.0 明确只做「复制配置片段」并给出 `docs/provider-integration.md` 的手工步骤；写入宿主配置列入 1.1.0（见 Migration Plan），`mcp-patch.js` 保留为原料，避免二次实现。
- [示例 provider 只声明一个域，容易让人以为契约需要实现全部五域] → `docs/provider-integration.md` 明确「按需声明 + 未声明域返回 `BAZAAR_CAPABILITY_UNDECLARED`」，示例的 README 与测试断言同时写明这一点。
- [两屏状态语义与服务端校验分处两个任务组，容易漂移] → 每个状态语义任务都要求同名服务端拒绝用例（spec 里的「客户端绕过禁用态直接提交被拒绝」场景），并把「同源」写进 Interface Mapping 的补齐任务号；漂移由 5.5（静态扫描：两处 id 一致、旧路由清理、hook 顺序）与 5.6（两屏 e2e：必填/禁用/只读各断言一条服务端拒绝）兜住。
- [改名是破坏性变更，旧配置引用旧键会静默失效] → 不保留别名（D1/D11 的理由），由 CHANGELOG 1.0.0 与 `docs/releases/v1.0.0.md` 逐条列出破坏点；旧目录不探测也不提示，避免用户以为数据还在用。
- [`peerDependencies` 放宽到 `<0.4.0-0` 会引入未验证的宿主版本] → 放宽只针对 minor 边界（`>=0.2.0-rc.1 <0.4.0-0`），CI 的 node 22.19/24 两档不覆盖宿主版本组合；若宿主 0.4 出现插槽或 `tools.restrict` 语义变化，按 Migration Plan 的回滚步骤回退版本号区间。

## Migration Plan

**部署步骤（1.0.0 发布流程）**

1. 以源仓 `lib`/`scripts`/`test` 全量入仓为基线，先确认 226 条用例与逐文件 `node --check` 在本地全绿（不改行为的参照点）。
2. 依序落五个任务组：仓骨架与身份改名（含质量门工具链与 CI）→ provider 契约与注册表 → 专家/技能 provider 化 → 连接器/账号 provider 化 → 前端两屏与仓库文档。文档与发布物料作为随行任务并入最相关的功能组，不单独成组；每组结束时 `npm test` 必须绿（组内自带用例与质量门，不设收尾组）。
3. 注册表与内置 provider 同时可用后，用 `examples/minimal-provider/` 跑一次「两个 provider 并存」的端到端回归（本地假 HTTP server，不触公网）。
4. 全量质量门：`node --test`（用例数 ≥ 226，五域矩阵齐全）、逐文件 `node --check`、`eslint`、`prettier --check`、`scripts/normalize-eol.mjs`。
5. 物料齐备后提交并 push 到 `git@github.com:awswt/dsh-bazaar.git`。**`npm publish` 不执行**（`publishConfig` 字段保留，只是不动它）。
6. 安装侧验证（用户自测）：在 `$DSH_HOME` 干净的环境中装包 → 设置页出现每 provider 一个页签 → 面板开关点亮后可选专家 → 复制配置片段得到文本。

**回滚策略**

- 包级回滚：退回上一版（`dsh-workbuddy-helper` 的最后版本）即可——本变更没有跨版本数据契约：旧目录不被读取，新目录 `<DSH_HOME>/bazaar` 不被旧版读取，两者互不污染，回滚不需要清理。
- 数据级回滚：`<DSH_HOME>/bazaar` 可整体删除（内容全部可再生：账号需重新登录、市场缓存自动重建、会话状态重建为空态）。
- 配置级回滚：`providers.<id>` 的键在旧版不存在，旧版会忽略；`defaultProvider`/`dataDir` 亦然。若宿主版本不兼容（`peerDependencies` 放宽带来的风险），把区间收窄回 `>=0.2.0-rc.1 <0.3.0-0` 并发补丁版。
- 代码级回滚：provider 抽象引入后，`lib/provider/` 与 `lib/providers/workbuddy/` 是纯增量的目录；回滚到「单上游」需要还原 `lib/index.js` 的接线与各域模块的引用关系，属大改动，因此发布前必须完成第 3 步的双 provider 回归。

**1.1.0 Roadmap（不在本变更交付范围内，不进入 tasks.md）**

1. **连接器「一键写入宿主配置并重载」**：复用已保留的 `lib/mcp-patch.js`（server 名规范化、托管字段、`upsertMcpServers`/`setMcpDisabled`/`removeMcpServer`）与 `connectors.json` 的 `patchManaged` 字段，在 1.0.0 的七项动作集（`list|state|authorize|poll|cancel|copy-config|remove`）基础上扩入 `connect|repair|unbind|enable|disable`；门控仍在会话级工具层，写入后由 `tools/change` 触发重放。风险面独立（写宿主 profile 的 `cordis.patch.yml` + 触发热重载），因此单列版本。
2. provider 拆成可独立发布的包（`@dsh-bazaar/provider-workbuddy`），注册表契约不变，`apiVersion` 仍为 `1`；届时再评估 `apiVersion: 2` 的边界。
3. 第二个真实上游接入，用 `examples/minimal-provider/` 的同一契约验证「零改动插件入口」。
4. 记忆市场是否升格为独立 provider（当前委托 `dsh-mnemon` 探测，见 `lib/mnemon.js:46-100`）。

## Open Questions

- `mcp-patch.js` 在 1.1.0 里是「继续复用」还是「按新宿主 API 重写」——两条路都不改 1.0.0 的契约与代码，等宿主 MCP 配置写入 API 稳定后再定。
- eslint 抑制清单的收敛节奏（每版清多少条）——纯债务管理节奏，不影响 1.0.0 的行为与任务拆解。
- 第二个真实 provider 的域名与能力面——`allowHosts` 与 `capabilities` 都是数据，等有具体上游再填。
- `docs/e2e-baseline.md` 里是否需要登记宿主版本组合矩阵——取决于宿主发布节奏，与本次两屏实现无关。

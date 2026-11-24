# AGENTS.md

本仓是 DeepSeek Harness 的多 provider 集市插件：一层 provider 注册表 + 五域编排（专家 / 技能 / 记忆 / 连接器 / 账号）+ 两个前端屏（设置页、会话面板）。仓库只内置一个 provider（`workbuddy`），其余靠注册。

改代码前先读本文件。这里的每条「判定只在一处」和每条坑都对应一份用例；绕开它们不是更快，是把已经踩过的坑重新踩一遍。

## 命令

| 目的                       | 命令                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 跑全部用例                 | `npm test`（= `node --test test/*.test.mjs`，39 个文件 / 384 条）                                                                                                                                                                                       |
| 质量门                     | `npm run check`（= `node scripts/quality-gate.mjs`，六步全绿才算过）                                                                                                                                                                                    |
| ESLint（存量走压制清单）   | `npm run lint`                                                                                                                                                                                                                                          |
| 看真实违规（不吃压制清单） | `npm run lint:live`                                                                                                                                                                                                                                     |
| 重写压制基线               | `npx eslint lib scripts test --suppress-all --suppressions-location ./eslint-suppressions.json`（只在**消除**违规后跑；先 `--prune-suppressions` 清死条目再重写，两者在 ESLint 10 下互斥，所以 `npm run lint:baseline` 这条脚本暂时不可用，见下方纪律） |
| 格式化                     | `npm run format` / `npm run format:check`                                                                                                                                                                                                               |
| 行尾                       | `npm run eol`（dry-run）/ `npm run eol:write`                                                                                                                                                                                                           |
| 两屏离线回放               | `node scripts/e2e.mjs --plan ui`（不装包、不起模型、不出网）                                                                                                                                                                                            |
| 全链路 e2e                 | `node scripts/e2e.mjs`（需要本机 `dsh` CLI，会写临时 `DSH_HOME`）                                                                                                                                                                                       |

## 模块地图

三层，依赖只能向下，不能成环。

| 层                   | 文件                                                                                                                                                                                                                                                                | 职责                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **注册层**           | `lib/provider/{contract,registry,active-set,errors,dispatch,domains,paths,routes,status,index}.js`                                                                                                                                                                  | provider 契约校验（`apiVersion: 1` + 五域 `capabilities`）、注册/注销、活跃集与默认库解析、五域分发与故障折叠、路径与凭据名推导、`/dsh-bazaar/providers/*` 路由、provider 状态（凭据/缓存） |
| **内置 provider 层** | `lib/providers/workbuddy/{index,market,portal,connector-store}.js` + 它独占的基建 `lib/{auth,skill-install,connectors,connector,connector-flow,skill-providers,wb-login,wb-vault,wb-accounts}.js`                                                                   | 一家库的全部上游事实：专家中心双源、技能市场（含委托记忆插件的记忆市场）、连接器市场与 MCP patch、账号登录与令牌；`marketMode`（portal/cos/auto）就住在这里，是 provider 内部选择，不是配置 |
| **编排层**           | `lib/index.js`（插件入口、工具、命令、配置）、`lib/session.js`（会话状态）、`lib/session-plugin.js`（agent 侧提示词与技能提供方）、`lib/webui.js`（`/dsh-bazaar/*` 平面路由）、`lib/client.js`（前端两屏，单文件 factory）、`lib/{bundle,mnemon,mcp-patch,util}.js` | 装配：建注册表 → 注册内置 provider → 建活跃集 / 分发器 / 域视图 → 挂路由、工具、命令、两个 slot                                                                                             |

依赖方向（可用 import 自证，注册层不得出现反向引用）：

- `lib/provider/*` 只 import `lib/provider/*`——注册层不认识任何具体上游，也不认识 `lib/index.js`。
- `lib/providers/workbuddy/*` 向下 import 注册层的 `errors.js` / `paths.js` 和共享基建 `auth.js` / `util.js` / `skill-install.js`；**不** import `lib/index.js`、`lib/webui.js`、`lib/client.js`。
- `lib/index.js` 在最上层，import 以上两层；`lib/session.js` 只用注册层的 `contract.js` / `errors.js`；`lib/webui.js` 只用 `auth.js` / `connector-flow.js` / `provider/errors.js` / `skill-install.js`。

新增一家库＝在 `lib/providers/<id>/` 实现契约并注册，不改注册层；若某段逻辑需要改注册层才能接进去，说明它其实是契约缺口，写进 `docs/provider-integration.md` 而不是塞特例。

## 两条「只判定一处」

### 1. 会话级工具门控只在 `connectorNamesFor()` 里判定

`lib/connectors.js:980` 的 `connectorNamesFor(agent)` 是 deny 集合的唯一计算点：它读 active set、读本会话停用表、按 `providerId` 分组，并且只对「归属本 provider」的条目下判断——`const owner = typeof config.providerId === 'string' ? config.providerId : providerId`，`if (owner !== providerId) continue`（别的 provider 由它自己的门控算，这里不越权）。

然后 `applyNow()`（`lib/connectors.js:1060`）取并集，只调一次 `scoped.restrict({ deny })`。钩子（`agent/created`、`agent/disposed`、`agent/pre-step`、`tools/change`）只负责触发重放，**不**各自算一遍集合。

为什么不让钩子自己判定：四处钩子各算一次就会出现「三处放行、一处拦截」的组合，排查时看到的 deny 和实际生效的 deny 不是同一个东西。要改门控语义，改 `connectorNamesFor()` 并补齐用例。

### 2. 出网校验只在 `assertAllowedUrl()` 里判定

`lib/auth.js:194` 的 `assertAllowedUrl(raw, config)` 是所有出网入口的唯一闸门：拒绝非 https（`BAZAAR_URL_INSECURE`）、URL 带 userinfo（`BAZAAR_URL_USERINFO`）、host 不在 `providers.<id>.allowHosts`（`BAZAAR_HOST_DENIED`）、非法 URL（`BAZAAR_URL_INVALID`）。`allowHosts` / `allowInsecureLoopback` 是**逐 provider** 的，不做全局合并。

四个出网入口（在线市场、公开快照、登录、连接器刷新）加技能包下载都走它。不要在 provider 里手写 `fetch(url)`——`assertAllowedUrl` 漏一次，`allowHosts` 就降级成建议。`authMode` 与令牌只在这一层之后出现，`auto` 与 `workbuddy-connector` 两个取值已删除。

## 会话状态：按会话单文件、按 provider 分组、原子替换

- 一个会话一个文件：`<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json`（`lib/session.js:187`）。
- 文件里按 `providerId` 分组存专家与技能（`activeProviders` / `experts[]` / `skillsByProvider[]`）；一家库的选择不会覆盖另一家。
- **只有一个写者**：`lib/session.js:214-219` 是唯一写入口（注释原文 “The only writer. Nothing else may touch the sessions directory.”），写入前 `ensureDir`，再 `writeJsonAtomic` 整体替换——不做「读-改-写」的原地拼接，避免半写文件。
- 读路径给默认值（`readJson(..., undefined)`），文件不存在就是空态，不报错；启动时按目录清扫（`:295-301`）回收已消失会话的状态。
- 状态变更一律经 `SessionManager`，不要在 webui 路由或工具处理器里直接碰文件。

## 质量门与压制清单纪律

`npm run check` 六步：行尾（`normalize-eol.mjs` dry-run 必须 `rewrite 0/N`）→ 逐文件 `node --check`（`lib/` `scripts/` `test/`）→ 用例数与条数（`MIN_TESTS = 226`）→ ESLint（存量走 `eslint-suppressions.json`）→ **压制清单增量门禁** → Prettier（强制面＝未被 `.prettierignore` 排除的文件）。

ESLint 跑两遍是刻意的：`--suppress-all` 的清单按 `file+rule` 记**计数**，同一个文件同一条规则再犯一次会被既有计数默默吃掉，只看退出码会漏。第二遍用空清单拿原始违规，与提交的基线对账，`diffSuppressionBaseline()` 对「新条目」和「计数增长」都判失败。

纪律：

- 压制条目只减不增。要消违规就真改，不能改就降低该规则的**适用面**（例如把 `no-console` 的例外写成转发的 `forward()`），一步都不许用「加一条 suppression」当修复。
- 消掉违规后重写基线（`npx eslint lib scripts test --suppress-all --suppressions-location ./eslint-suppressions.json`），并在同一个提交里说明消了哪几条。
- 确定性工具报出的问题若只能用压制手段解决（注解、注释抑制、规则排除、平台状态标注、构建开关），属于**豁免申请**：在压制处写明理由，交审查者裁定；被驳回就移除压制并真实修复。用平台状态当豁免不算修复。
- `.prettierignore` 是登记表，不是排除池：只写精确路径与目录，不写通配。新文件必须落在受管集合里（`test/baseline.test.mjs` 会反向断言：受管文件未被忽略、没有死条目、没有通配）。
- 用例必须带反向控制：断言「违规会被抓到」再断言「当前代码没违规」，否则扫描器写坏了照样全绿。

## 坑位清单

1. **门控重入会静默吞掉变更**（`lib/connectors.js:1038-1058`）。旧实现用一个模块级 `applying` 布尔做重入保护，而 `setSession()` 自己会调一次 `reapply()`，紧接着调用方的 `reapply(agent)` 命中布尔直接返回——「取消本会话停用」这类真实变更被丢掉，deny 一直是旧的。现在是每 agent 一条 promise 队列（`applyQueue`）：并发排队，谁也不会被吞。改这段别再退回布尔。
2. **deny 用了旧值就永远不生效**（`lib/connectors.js:1063-1069`）。`applyNow()` 里的 `key` 必须由**本次刚算出的** `deny` 生成（`deny.slice().sort().join(',')`），不能拿 `applied` 里缓存的 key 或上一次的 deny 去算；一旦 key 没变，`previous.key === key` 直接 return，`restrict` 不会被调用，旧 deny 继续生效。
3. **路由残留会让热重载用失效闭包应答**（`lib/webui.js`）。注册前按 `ownRoutePath()` 清理自己前缀的陈旧条目——判据是 `key === PREFIX || key.startsWith(PREFIX + '/')`，不是裸 `startsWith(PREFIX)`，否则会误删别的插件的 `/dsh-bazaar-next/*`、`/api/dsh-bazaar/*`。provider 分组路由另外由 `releaseProviderRoutes()` 在 dispose 时先释放（`lib/index.js` 的 `ctx.effect` 顺序：先路由，后连接器与会话）。
4. **两处 armory 取值已删除，别再捡回来**。旧前端在两处读 `ctx.get('remote.mcpManager')` 并各带一套降级分支（军械库不可用就退成本地视图）；1.0.0 全部删除，`lib/client.js` 只走 `/dsh-bazaar/*` 自己的路由。`lib/` 里现在只剩注释提到 armory（`mcp-patch.js` 说明 patch 约定对齐 dsh-armory 2.5.9，`connectors.js:757` 说明折叠约定）。任何 `remote.mcpManager` 都是回归。

## 其它既定约束

- **前端两屏是单文件 factory**：`lib/client.js` 保持 `window.__ModuleLoader__.load({id, factory})` 单文件形态，不拆分、不改 `conversation.input.left` / `settings.section` / `settings.section.icon` 三个 slot 名，不改 `order`（25 / 26），不改 id（`bazaar-account` / `bazaar-expert-picker`）；两个设置项必须读同一个 id 常量。CSS 前缀只用 `bz-`。
- **钩子只在函数顶层**：组件里每个 `return` 都必须排在全部 `React.use*` 之后。条件式钩子会让宿主 pill 整个崩掉，`DialogBoundary` 只能保住对话框自己（`test/hook-order.test.mjs` 守着这条）。
- **状态必须有文字**：加载 / 空 / 出错 / 禁用 / 只读都用文字标签 + `aria-*` 表达，颜色只做辅助；禁用与只读不是一回事。
- **不迁移旧数据**：不探测、不提示、不读取 1.0.0 之前的数据目录与兼容层 vault 目录（旧名逐条列在 `CHANGELOG.md` 的移除清单里）。
- **不发布 npm**：物料只推 GitHub，安装走 `dsh plugin --profile <profile> add <spec>`。
- **`providers.<id>.fetchImpl` 保留**：它是测试注入点（`test/` 里 114 行依赖），不是给人配的。
- **改协议先改契约**：五域新增字段要在 `lib/provider/domains.js` 与 `docs/provider-integration.md` 同步，前端只消费契约里的字段。

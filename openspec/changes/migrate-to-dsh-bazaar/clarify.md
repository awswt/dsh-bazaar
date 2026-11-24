# clarify — migrate-to-dsh-bazaar

## Decisions（决策结论）

### 问题与意图

- **不是纯改名，而是升级为「多上游集市」**：把原本写死单一上游（WorkBuddy）的四个市场域改造为 provider 可插拔，同一套界面与模型工具可并列接入多个专家库。理由：用户明确要求「项目名字变更、插件内相关内容一并变更」，且接受把一次性迁移做成可扩展架构，避免以后接第二家上游时二次重构。
- **迁移方式**：新仓 `dsh-bazaar` 全新起点，不保留源仓 git 历史；源仓 `dsh-workbuddy-helper` 保持只读存档。新仓文档**不声明迁移关系**（用户明确选择）。

### 命名与标识（全量替换，无过渡别名）

| 维度 | 源仓 | 新仓 |
|---|---|---|
| 包名 / npm 名 | `dsh-workbuddy-helper` | `dsh-bazaar`（unscoped，npm 已确认未被占用） |
| 仓库 remote | `git@github.com:awswt/dsh-workbuddy-helper.git` | `git@github.com:awswt/dsh-bazaar.git` |
| 模型工具 | `workbuddy_helper`（`lib/index.js:492` 唯一注册点） | `bazaar_helper` |
| 斜杠命令 | `workbuddy-helper`（`lib/index.js:596-599`） | `bazaar` |
| HTTP 路由前缀 | `/dsh-workbuddy-helper`（`lib/webui.js:5`） | `/dsh-bazaar` |
| 设置页条目 id | `workbuddy-helper-account`（`lib/client.js:47`），order 为数值常量 `SETTINGS_ENTRY_ORDER = 25`（`:48`） | `bazaar-account` / order 保持 `25` |
| 会话面板入口 id | `workbuddy-helper-expert-picker`（`lib/client.js:41`），order `ENTRY_ORDER = 26`（`:42`） | `bazaar-expert-picker` / order 保持 `26` |
| 插件 name 导出 | `dsh-workbuddy-helper`（`lib/index.js:35`） | `dsh-bazaar` |
| 客户端插件 id | `dsh-workbuddy-helper`（`lib/client.js:22`、`PACKAGE_ID` 于 `:39`） | `dsh-bazaar` |
| 设置页可见标签 | `workbuddy-helper`（`lib/client.js:2561` 的 `label`） | `bazaar` |
| 自探测包名 | `dsh-workbuddy-helper`（`lib/connectors.js:31` `SELF_PACKAGE`、`lib/mnemon.js:35`） | `dsh-bazaar` |
| prompt section / skill provider 名 | `workbuddy-helper:expert:<gen>`、`workbuddy-helper:skill-scope:<gen>`（`lib/session-plugin.js:32/47`）、`workbuddy-helper-expert-<gen>`、`workbuddy-helper-filter-<gen>`（`lib/skill-providers.js:42/115`） | `bazaar:expert:<gen>`、`bazaar:skill-scope:<gen>`、`bazaar-expert-<gen>`、`bazaar-filter-<gen>` |
| UI 类名前缀 | `wbh-`（`lib/client.js`） | `bz-` |
| 错误码前缀 | `WORKBUDDY_HELPER_*` | `BAZAAR_*` |
| 凭据 ref | `WB_EXPERT_TOKEN`（`lib/auth.js:90/157`、`lib/index.js:52`） | `BAZAAR_<PROVIDER_ID>_TOKEN`（内置即 `BAZAAR_WORKBUDDY_TOKEN`），可 `providers.<id>.credentialRef` 覆盖 |
| 数据目录 | `<DSH_HOME>/workbuddy-helper`（`lib/index.js:60`） | `<DSH_HOME>/bazaar` |
| 旧 vault 目录 | `<DSH_HOME>/workbuddy-vault`（`lib/index.js:66`） | `<DSH_HOME>/bazaar/providers/<providerId>/vault` |
| bundle 元文件 | `.workbuddy-helper-bundle.json` | `.bazaar-bundle.json` |
| 登录 id 前缀 | `wbh_`（`lib/wb-login.js:407`） | `bz_` |
| e2e 环境变量 | `WBH_LIB_ROOT`（`scripts/e2e.mjs:260`） | `BAZAAR_LIB_ROOT` |
| 插件 id / name | `workbuddy-helper` / `dsh-workbuddy-helper` | `bazaar` / `dsh-bazaar` |

- **不保留旧工具名/命令名别名**：用户明确「无过渡期」。破坏性变更由新仓 1.0.0 承载。
- **保留不改的上游事实**：`providerId = workbuddy`、上游域名（`www.workbuddy.cn` / `www.codebuddy.cn` / `www.workbuddy.ai` / `www.codebuddy.ai` / `openplatform-cdn.codebuddy.cn` / COS 快照域名）、桌面端目录 `.codebuddy-plugin` / `.workbuddy-plugin`。理由：这些是上游真实事实，改了就接不上真服务。
- **界面文案不暴露 providerId**：显示 `displayName`（如「WorkBuddy 专家库」）；仅多库同名冲突等需要精确指认的场合才用 id 作限定前缀。

### 范围

- 纳入：`lib/`、`scripts/`、`test/`、`package.json`、`cordis.patch.yml`、`.gitignore`、`.gitattributes`、`LICENSE`、`README.md`、`AGENTS.md`、`CHANGELOG.md`、`docs/`（重写 + 删除旧文件 + 删除 5 张截图）、新增 `.github/workflows/ci.yml`、新增 `examples/minimal-provider/`。
- 排除：npm publish（用户原话「npm 不处理」）；旧数据迁移（完全不探测、不提示 `<DSH_HOME>/workbuddy-helper` 与 `workbuddy-vault` 残留，静默忽略）；dsh-armory 依赖（彻底移除，不保留回退分支）；连接器「一键写入宿主配置并重载」（推 1.1.0）。
- 保留：`engines` 不变（`^22.19.0 || >=24.0.0`）；`scripts/release.mjs` 机制与 `docs/releases/vX.Y.Z.md` 约定不变。

### 数据模型（JSON 文件布局，无数据库、无 DDL）

```
<DSH_HOME>/bazaar/
  providers/<providerId>/
    accounts/          # 账号与登录态
    vault/             # 凭据存取
    cache/             # 市场缓存
  sessions/<sha256(sessionId)>.json
    { schemaVersion, sessionId,
      activeProviders: string[],
      experts:  { <providerId>: ref },
      skills:   { <providerId>: { globalMode, globalNames, expertNames } },
      revision, updatedAt }
```

- **会话状态按会话分文件、按 providerId 分组**：切库不互相覆盖；写入沿用现有 `writeJsonAtomic` + `revision` 自增。
- **文件名沿用源仓既有做法**：`sessions/<sha256(sessionId)>.json`（源仓 `lib/session.js:65-67` 的 `stateFile()` 即 `path.join(sessionsDir, '${sha256(sessionId)}.json')`），不是原文所写的裸 `<sessionId>.json`；这样任意字符的 sessionId 都不会变成非法文件名或路径片段。
- **顶层字段沿用源仓形状并加 `schemaVersion`**：源仓 `defaultState()`（`lib/session.js:54-63`）与 `normalizeState()`（`:77-94`）都有 `schemaVersion` 与 `sessionId` 两个回写字段，本变更保留（便于以后数据结构演进时判断是否需要迁移），新增 `activeProviders` / `experts` / `skills` 三张按 providerId 分组的表。
- **写盘权限**：沿用源仓 `writeJsonAtomic`（`lib/util.js:45-50`）的做法 —— 临时文件以 `mode: 0o600` 写入后 `rename` 原子替换，账号与凭据目录继承该权限；不额外引入权限库。
- **`providerId` 白名单** `^[a-z][a-z0-9-]{0,31}$`：该值参与目录拼接，是路径穿越防线，注册时即校验。
- **技能安装落位不变**：`<projectRoot>/.dsh/skills/<slug>/`，元数据记 `providerId`，跨库不得互改。

### 业务规则

- **provider 契约带 `apiVersion: 1`**：注册时校验，不匹配直接报错（用户选择带版本字段，便于以后加能力时划清兼容边界）。
- **五域能力声明**：`capabilities.{expertMarket, skillMarket, memoryMarket, connectorMarket, account}`；provider 未声明的域不出现在 UI，调用时返回明确错误。
- **仓内只内置 `workbuddy` 一个 provider**；另加 `examples/minimal-provider/`（读本地 JSON，不联网不登录，不进 `lib/`、不进生产路径，仅被测试与文档引用）。
- **`marketMode`（portal/cos/auto）与具体端点降为 workbuddy provider 内部实现细节**；registry 只要求返回统一专家列表。
- **`defaultProvider` 默认空**：为空时新会话 `activeProviders` 为空、面板显示「尚未选择专家库」空态并提供入口、模型工具未传 `provider` 时返回引导错误（**不静默回落首个已注册**）；配置指向未注册 id 时报错并回落首个已注册。
- **多库同名冲突**：技能跨库同名时报错并指出已有来源（**不自动加后缀**，理由：自动改名会让用户分不清哪个真正装上了）。

### 规则边界（该拦 / 该放 / 等价路径）

| 规则 | 该拦条件 | 该放的例外与合法反例 | 判定挂载点 |
|---|---|---|---|
| 凭据隔离 | provider A 读不到 B 的 token 与 dataDir | 同一 provider 内部多账号正常切换 | registry 不向 provider 传他人凭据/路径；所有取凭据动作统一 |
| 出网主机校验 | 主机不在该 provider `allowHosts` 内报 `HOST_DENIED`；非回环的 http 报 `URL_INSECURE` | provider 显式 `allowInsecureLoopback: true` 时可对本机 http（默认关，且只影响自己） | 四个出网入口（在线市场、快照、登录、连接器刷新）共用同一 `assertAllowedUrl`；源仓现状只有市场与快照已接入，登录与连接器刷新 1.0.0 MUST 改造接入 |
| 连接器工具门控 | 会话未激活的 provider，其连接器工具在该会话被 deny | 已激活的多个 provider 各自工具都放行 | **会话级工具层**按 providerId 分组算 deny 并合并；不挂在单个连接器工具内部（源仓已证会误触） |
| 状态写入隔离 | 不同 providerId 的状态互不写 | 同 provider 重复选择幂等 | 统一走按 providerId 分组的同一写入口 |
| 重复注册 / 路由残留 | 同 id 重复注册报错；热更新后旧前缀路由必须清理 | unregister 后重新注册同名允许 | 注册与清理在同一 effect 生命周期内配对 |
| 空 defaultProvider | 未传 provider 返回引导错误 | 配置指向未注册 id 时回落首个已注册并报错提示 | 面板、工具、路由读同一份「当前 provider 集合」 |
| 技能同名冲突 | 跨库装同名技能报错并指出已有来源 | 同一库重装同一技能幂等覆盖 | 安装落位与元数据写入同一入口 |

### 集成边界

- **彻底移除 dsh-armory 依赖**（源仓 `lib/client.js:308` 与 `lib/client.js:2522` 两处 `ctx.get('remote.mcpManager')`，`lib/connectors.js` 内无该调用）：不复用其卡片流程、不保留回退分支。
- **连接器域 1.0.0 范围**：列表 / 筛选 / 详情 / OAuth 授权 / 复制配置片段。「一键写入宿主配置并重载」推 1.1.0，**不进 tasks**，仅写入 design 的 Migration Plan 与 `docs/architecture.md` 的 Roadmap。
- **测试不调公网**：provider 抽象用测试内本地 HTTP 假服务验证；上游仍指向真实 workbuddy 域名配置，但不发起真实请求。
- **`peerDependencies`**：`@deepseek-ai/dsh` `">=0.2.0-rc.1 <0.4.0-0"`（放宽上限到该 minor 边界，不声称无限兼容）。

### 质量门

- 沿用：`node --test`（用例数不低于 226）+ 逐文件 `node --check` + `scripts/normalize-eol.mjs`。
- 新增 eslint（`@eslint/js` recommended + 少量自定义 `no-unused-vars` / `no-console` 限 scripts / `eqeqeq`，覆盖 `lib` `scripts` `test`）；存量用 `eslint-suppressions.json` 登记，CI 以 `--suppress-all --prune-suppressions` 双模式使存量不阻塞、新增必报。
- 新增 prettier（`singleQuote`、无分号、`printWidth 100`、LF）；只对新建/本次改动文件强制，`.prettierignore` 排除存量，避免超大 diff。
- 新增 `.github/workflows/ci.yml`：`ubuntu-latest` + node 22.19 / 24 两档，跑 `npm test` + `node --check` + `eslint` + `prettier --check`。
- 测试策略：复用源仓可改名的用例资产（assert 目标换新标识与 provider 路径），provider 契约/隔离/门控/降级等新规则新写；保留并重写源仓静态扫描型测试（hook 顺序、旧路由清理、Settings 两处 id 一致、目录一致性）；**新增旧名残留扫描**：除允许清单（`providerId=workbuddy`、上游域名、`.workbuddy-plugin`）外，`lib` `scripts` `test` `README` `AGENTS` 不得出现 `workbuddy-helper` / `workbuddy_helper` / `wbh-`，命中即失败。

### 发布动作

- 用户原话：「把完整物料推送到git,npm不处理」。本 change 的 tasks 含把完整物料提交并 push 到 GitHub；**npm publish 不做**。

## Users & Scenarios（用户与场景）

- **谁用**：DSH 用户——从个人开发者到小团队；把多人/多来源的专家库、技能市场、连接器、账号统一在一个面板里管理。
- **什么场景**：日常在会话里挑选并激活某个专家库的专家；需要在同一会话里同时用两家库的专家；安装市场技能到项目；给某个上游授权账号；排查某家库不可用。
- **多久一次**：会话级高频（每次开新会话选库），账号授权低频（首次或过期），技能安装低频。
- **最怕误操作什么**（用户列出的四条）：
  1. 凭据串用 / 把 token 发到不该发的主机；
  2. 切库丢配置、技能被别的库覆盖；
  3. 重复注册、热更新后路由残留导致报错；
  4. 测试不覆盖隔离与错误路径，改坏了没被发现。
- **改动后该一眼看出什么**（用户列出的四条）：
  1. 代码与界面里看不到旧名残留；
  2. 多库并列展示且单个故障被隔离（只红那一块）；
  3. 质量门一条命令可验；
  4. 设置页能分库看到各自的账号/凭据/缓存。
- **目标用户**：面向公开用户。1.0.0 只把完整物料推送到 GitHub 供安装（`publishConfig` 字段保留、本版不执行 `npm publish`），发布渠道在后续版本单独评估。
- **原型确认结论**：**屏 A、屏 B 均已确认通过**，确认对象是当前 `prototype/index.html`（1503 行 / 90081 字节，零外链、内联 JS 语法通过、间距与字号全对齐 `DESIGN.md`、aria 程序承载齐备）。用户对两处必填语义的最终答复均为「认可」（原话：「屏a,b都认可。继续吧」，其后对修订后的两处语义再次确认「认可（推荐）」）。
  - 屏 A（设置页）认可项：每 provider 一个页签、页签内固定四块（账号 / 凭据 / 缓存 / 连接器授权）、默认专家库空态置顶、页签自带状态徽标且出错只红内容区不动页签、凭据只出现「名称 + 是否已配置 + 脱敏值」永不可编辑、清理缓存与退出登录走二次确认并写明影响范围。
  - 屏 A 的唯一必填项是「登录区域（国内版 / 国际版）」：默认不预选，未选就点「登录」时该下拉进入字段级出错态并给出「错在哪 / 怎么改」，且不发出请求；服务端对缺失或非法 `region` 返回 `BAZAAR_PARAM_INVALID`。理由是区域决定令牌发往 `codebuddy.cn` 还是 `workbuddy.ai` 两套独立账号体系，猜错等于把令牌发错主机。
  - 屏 B（会话辅助面板）认可项：provider 多选开关（非单选下拉）、按库分组并列、单库故障只红自己分区并给重试（不隐藏不置空）、跨库同名专家加「库名 ·」前缀且选择按 `providerId` + `id` 双键提交、跨库同名技能标冲突并禁用安装、未声明 `memoryMarket` 时显示能力未声明而非空态。
  - 屏 B 没有必须填写的字段：provider 开关组标为「选择专家库（可多选）」+「可选」徽标，不挂 `aria-required`；全不勾选是合法终态（服务端接受 `activeProviders: []` 并回到空态）。真正的必填只在请求层——单次选择 / 安装请求缺少 `providerId` 才返回 `BAZAAR_PROVIDER_REQUIRED`，与界面标识同源。
  - 设计基准 `DESIGN.md` 先于原型产出并通过 `@google/design.md lint`（errors 0 / warnings 0 / infos 1 token-summary）；后续两屏实现以 `DESIGN.md` 为唯一视觉基准，界面改动需先改 `DESIGN.md` 再改代码。

## Related-Surface Survey

逐条带代码证据（源仓路径），划界结论均已由用户在访谈中确认。

| 关联面 | 代码证据 | 划界结论 |
|---|---|---|
| 模型工具注册 | `lib/index.js:490-492` | 本次改造：`bazaar_helper`，新增 `provider` 参数与 `providers` 列举 action |
| 斜杠命令注册 | `lib/index.js:596-599` | 本次改造：`/bazaar` |
| HTTP 路由前缀 | `lib/webui.js:5` | 本次改造：`/dsh-bazaar`，保留「注册时清理本插件前缀陈旧路由」逻辑 |
| 前端路由表（13 条） | `lib/client.js:50-64`（`ROUTES`） | 本次改造：前缀全改并加 `/providers/<id>` 段 |
| 设置页插槽与 id | `lib/client.js:45-48`（`settings.section`、`settings.section.icon`、`workbuddy-helper-account`、`SETTINGS_ENTRY_ORDER = 25`），注册于 `:2559-2560`、`:2576` | 本次改造：id 改 `bazaar-account`，order 保持 25，两处 `inject` 共用同一常量 |
| 会话面板入口 | `lib/client.js:41-42`（`ENTRY_ID`、`ENTRY_ORDER = 26`），注册于 `:2530-2531` | 本次改造：`bazaar-expert-picker`，order 保持 26 |
| 会话状态读写 | `lib/session.js:47-101`（`states`/`live`/`warnings`/`queues`、`stateFile`、`saveState`） | 本次改造：按会话分文件 + 按 providerId 分组 |
| 会话子插件 | `lib/session-plugin.js:20-26`（name、inject、prompt section、provider 名） | 本次改造：`bazaar-*` 前缀 |
| 连接器工具门控 | `lib/connectors.js:401`（`applyQueue`）、`:1015-1025`（`applyNow` → `:1024` `scoped.restrict({ deny })`）、`:1427`/`:1430`/`:1434`/`:1442`（`agent/created`、`agent/disposed`、`agent/pre-step`、`tools/change` 四个钩子） | 本次改造：按 providerId 分组算 deny、会话级合并 |
| 出网安全校验 | `lib/auth.js:169-196`（`assertAllowedUrl`）+ `lib/index.js:56-57`（`allowHosts` 默认值） | 本次改造：按 provider 分别校验，`allowInsecureLoopback` 下沉到 provider 级 |
| 凭据解析 | `lib/auth.js:90`、`:157`、`lib/index.js:52` | 本次改造：`BAZAAR_<ID>_TOKEN` |
| 错误码（15 个；`lib/portal.js` 的 3 个与 `lib/market.js` 同名） | `lib/auth.js:26/71/76/88/94`、`lib/market.js:357/361/364`、`lib/portal.js:323/377/383/386` | 本次改造：`BAZAAR_*` |
| dsh-mnemon 包探测 | `lib/mnemon.js:25-35`（`node_modules/dsh-workbuddy-helper` 存在性判定在 `:35`） | 本次改造：探测 `node_modules/dsh-bazaar`；记忆市场能力仍委托其探测 |
| 登录 id 生成 | `lib/wb-login.js:407`、`:26`（`WB_CLIENT_UA`） | 本次改造：`bz_` 前缀 |
| dsh-armory 复用 | `lib/client.js:308`、`lib/client.js:2522`（两处 `ctx.get('remote.mcpManager')`；`lib/connectors.js` 内无该调用） | **本次排除**：彻底移除，不保留回退分支 |
| e2e 脚本 | `scripts/e2e.mjs:251/342/393/461/467/496/514/624/636/672/686/722/730` | 本次改造：`BAZAAR_LIB_ROOT`、工具名、仓地址、断言文案 |
| bundle 元文件 / 目录常量 | `.workbuddy-helper-bundle.json`（`lib/bundle.js:125`、`:146`）、`PLUGIN_DIRS`（`:8`） | 元文件改名；`PLUGIN_DIRS` 保留（上游事实） |
| 旧目录兼容 | `<DSH_HOME>/workbuddy-helper`、`<DSH_HOME>/workbuddy-vault` | **本次排除**：不探测、不提示、静默忽略 |
| 上游域名与桌面端目录 | `PORTAL_HOSTS`、`CDN_HOSTS`、`REGIONS`、`PLUGIN_DIRS` | **本次排除**：保留不改 |

## Architecture Direction

**选定方向**：provider 契约（`apiVersion: 1`）+ 注册表 + 仓内只内置一家 provider；界面与模型工具成为 provider 之上的编排层。

**备选与权衡**：
- 备选 A「纯改名，不引入 provider」——工作量最小，但多上游价值为零，以后接第二家要二次重构。已否。
- 备选 B「provider 拆成独立 npm 包」——更纯的插件化，但首版就要维护两套发布节奏与 peer 依赖矩阵，属过度设计。已否，1.1.0 后可再拆。
- 备选 C「保留 armory 复用连接器 UI」——省事，但 `remote.mcpManager` 是宿主内部服务、按需解析还有挂载时序坑，多 provider 门控语义也接不上。已否。

**方案摘要（用户已确认，七要素）**

① 一句话 + 逐条变更：dsh-workbuddy-helper 在 dsh-bazaar 重开为「多上游集市」——同一套界面、同一套模型工具可并列接 WorkBuddy 及后续第三方专家库，各库凭据、数据、故障互不牵连。逐条变更见「命名与标识」「范围」「业务规则」三节。

② 是否触契约：触三类——模型工具契约（`bazaar_helper` 新增 `provider` 参数与 `providers` action，旧名不留别名）；HTTP 路由契约（`/dsh-workbuddy-helper/*` → `/dsh-bazaar/providers/<id>/*`）；文件状态契约（会话状态结构与目录布局变更）。无数据库、无 DDL。

③ 选定方案与备选权衡：见上。

④ 人话实施逻辑：
1. 先把源仓 `lib/` `scripts/` `test/` 全量搬进新仓，行为不动，226 条用例先在新仓跑绿；
2. 换身份标识（包名、工具名、命令、路由前缀、设置项 id、CSS 前缀、错误码、目录名、env 名），加「旧名残留扫描」兜底；
3. 抽 provider 契约与注册表（五域能力接口 + `ctx.bazaar.providers.register/unregister/list/get` + apiVersion 校验）；
4. 五域实现搬进 `providers/workbuddy/`（专家库双源、技能市场含记忆市场委托、连接器市场、账号登录），`marketMode` 降为内部细节；
5. 改前端两屏（设置页按 provider 分页签；会话面板多个多选开关 + 分组并列）；
6. 文档与发布物料重写，提交并 push。

⑤ 关联场景划界结论：见「Related-Surface Survey」全表。

⑥ 受影响 capability：`provider-registry`、`expert-market`、`skill-market`、`connector-market`、`account-auth`。

⑦ 规则边界结论：见「规则边界」全表（凭据隔离、出网主机校验、工具门控、状态写入隔离、重复注册与路由残留、空 defaultProvider、技能同名冲突）。

**界面形态**：会话可多活跃并存；面板顶为「provider 多选开关」+ 分组并列（**不是单选下拉**，与多活跃冲突已澄清）；单个 provider 故障只影响自己分区（显式错误态 + 重试），不整体报错、不静默隐藏；多库同名条目带 provider 限定前缀；选择必须带 `providerId`。

## Authoring Tier

- Tier: COMPLEX
- Rationale: 5 个 capability、五域跨组依赖、引入新外部契约（provider apiVersion）与新架构模式（注册表 + 分域编排）、5 个任务组且组件间有顺序依赖、工件量会显著占用上下文。

## 执行边界

下列边界按 `tasks.md` 的五个任务组列出（`config.yaml` 的 tasks 强制规则要求每组以实质变更为主体，故文档与发布物料已拆入各功能组，不单独成组）。`allowed_directories` 为可写目录，`allowed_packages` 为可写包路径，仓根散落文件在 `notes` 中逐项放行。

```yaml
task_groups:
  "1":
    allowed_directories:
      - "lib"
      - "test"
      - "scripts"
      - "docs"
      - ".github/workflows"
    allowed_packages:
      - "lib"
      - "test"
      - "scripts"
    notes: "源仓 lib/scripts/test 全量入仓 + 身份改名 + 质量门与 CI 落位 + 过时物料清理。仓根需单独放行的文件：package.json、cordis.patch.yml、eslint.config.js、eslint-suppressions.json、.prettierrc.json、.prettierignore、CHANGELOG.md。.github/workflows 仅允许新增 ci.yml；docs 在本组只允许删除（四份旧 md 与五张 png），不写新文档。不新增 lib/provider 与 lib/providers（属组 2）。残留扫描测试的扫描范围含仓库根文档，AGENTS.md 在本组尚不存在，测试须按文件缺席即跳过处理，不得因此失败。"
  "2":
    allowed_directories:
      - "lib/provider"
      - "lib/providers"
      - "lib"
      - "examples/minimal-provider"
      - "test"
      - "docs"
    allowed_packages:
      - "lib/provider"
      - "lib/providers/workbuddy"
      - "lib"
      - "test"
    notes: "新增 lib/provider/{registry,contract,paths,errors}.js、lib/providers/workbuddy/ 骨架、ctx.bazaar 挂载与 workbuddy 自注册、examples/minimal-provider/。examples 不得被 lib/ 引用（files 排除在组 1 设置）。lib 顶层仅限 index.js（挂载、自注册、模型工具新增 provider 参数与 providers 列举动作）与 auth.js 的凭据名推导与取值来源（源仓 :87-115 一带）；assertAllowedUrl（源仓 :169-196）不在本组，归组 4。不得在本组改动 connectors.js / session.js / client.js 的行为。docs 仅允许 docs/provider-integration.md。"
  "3":
    allowed_directories:
      - "lib/providers"
      - "lib"
      - "test"
    allowed_packages:
      - "lib/providers/workbuddy"
      - "lib"
      - "test"
    notes: "专家双源 + 技能市场 / 记忆市场下沉，会话状态改按 providerId 分组。lib 顶层仅限 session.js、session-plugin.js、skill-install.js、skill-providers.js；会话状态写入必须经唯一写入口 session.saveState()，不得新增第二条落盘路径。测试随实现同组，禁止另设测试组。"
  "4":
    allowed_directories:
      - "lib/providers"
      - "lib"
      - "test"
      - "docs"
    allowed_packages:
      - "lib/providers/workbuddy"
      - "lib"
      - "test"
    notes: "连接器 store 下沉、账号分目录、出网校验下沉到 provider 级、删除 armory 桥接。lib 顶层仅限 connectors.js（connectorNamesFor 按 providerId 分组 + applyNow 一次 restrict，四钩子接线不变）、auth.js（assertAllowedUrl 源仓 :169-196 下沉 + 凭据未配置时的 BAZAAR_AUTH_MISSING 拒绝）、webui.js（路由、路径与请求体 providerId 一致性校验、陈旧路由自愈）。不得把门控判定下放进单个连接器工具 handler；不得在本组引入写宿主配置的能力（留 1.1.0）。docs 仅允许 docs/architecture.md。"
  "5":
    allowed_directories:
      - "lib"
      - "test"
      - "scripts"
      - "docs"
    allowed_packages:
      - "lib"
      - "test"
      - "scripts"
    notes: "两屏改造集中在 lib/client.js（单文件 factory 形状不变，不拆分不重写），保留 conversation.input.left 与 settings.section / settings.section.icon 插槽、order 25 / 26 不变。scripts 仅允许 scripts/e2e.mjs（本地假服务，禁止真实调用生产接口）。静态扫描型用例与两屏 e2e 随实现同组。仓根需单独放行的文件：README.md、AGENTS.md。docs 仅允许 docs/e2e-baseline.md 与 docs/releases/。本组末尾执行提交与 push 到 git@github.com:awswt/dsh-bazaar.git，禁止执行 npm publish。"
```

## Initial Capabilities

- `provider-registry`：provider 契约（`apiVersion: 1`）、能力声明、注册/注销/列举、多 provider 隔离与 `providerId` 校验。
- `expert-market`：专家库列表/筛选/详情、在线与公开快照双源、多库并列与选择。
- `skill-market`：技能市场与记忆市场、技能真实安装落位、跨库同名冲突处理。
- `connector-market`：连接器列表/筛选/详情/OAuth 授权/复制配置片段、会话级工具门控。
- `account-auth`：账号登录、凭据存取、按 provider 分目录的 vault 与缓存、出网主机校验。

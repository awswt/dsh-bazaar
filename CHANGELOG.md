# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。
0.x 历史（`workbuddy_helper` 时期）不在本仓重述；本仓从 1.0.0 起算。

## 1.0.0

单上游插件升级为**多 provider 集市**：插件只保留 provider 注册表、五域编排与两个前端屏，
上游事实（域名、端点、凭据、市场模式）下沉到 `providers/<providerId>`。全部旧标识不留别名。

### 破坏性变更

- **包名**：`dsh-workbuddy-helper` → `dsh-bazaar`；仓库地址 `awswt/dsh-bazaar`。
- **模型工具名**：`workbuddy_helper` → `bazaar_helper`，并新增 `provider` 参数与 `providers` 列举动作。
- **斜杠命令**：`/workbuddy-helper` → `/bazaar`（含 `/bazaar providers`）。
- **HTTP 路由前缀**：`/dsh-workbuddy-helper/*` → `/dsh-bazaar/*`，按 provider 取数的路由新增 `/providers/<providerId>` 分组段，并新增 provider 列举与活跃集写入两条。
- **设置项 id**：`workbuddy-helper-account` → `bazaar-account`（`order` 保持 `25`）。
- **会话面板入口 id**：`workbuddy-helper-expert-picker` → `bazaar-expert-picker`（`order` 保持 `26`）。
- **CSS 类名前缀**：`wbh-` → `bz-`。
- **错误码前缀**：`WORKBUDDY_HELPER_*` → `BAZAAR_*`（消息文案同步）。
- **凭据名**：`WB_EXPERT_TOKEN` → 由 providerId 推导的 `BAZAAR_<UPPER_SNAKE(providerId)>_TOKEN`（内置库即 `BAZAAR_WORKBUDDY_TOKEN`），可被 `providers.<id>.credentialRef` 覆盖。
- **数据目录**：`<DSH_HOME>/workbuddy-helper` → `<DSH_HOME>/bazaar`，并按 provider 分区：`bazaar/providers/<providerId>/{accounts,vault,cache}/` 与 `bazaar/providers/<providerId>/connectors.json`。
- **会话状态结构**：由「单专家 + 单技能组」改为按 providerId 分组——`{ schemaVersion, sessionId, activeProviders, experts, skills, revision, updatedAt }`；文件名仍为 `sessions/<sha256(sessionId)>.json`。
- **bundle 元文件**：`.workbuddy-helper-bundle.json` → `.bazaar-bundle.json`。
- **登录 id 前缀**：`wbh_` → `bz_`。
- **e2e 环境变量**：`WBH_LIB_ROOT` → `BAZAAR_LIB_ROOT`。
- **prompt 分区与技能 provider 名**：`workbuddy-helper:*` / `workbuddy-helper-expert-*` / `workbuddy-helper-filter-*` → `bazaar:*` / `bazaar-expert-*` / `bazaar-filter-*`。
- **自探测包名**：`node_modules/dsh-workbuddy-helper` → `node_modules/dsh-bazaar`。
- **exports 合并**：`./wb-login`、`./wb-vault`、`./wb-accounts`、`./connector-flow`、`./skill-providers`、`./market`、`./portal`、`./connector` 八个 subpath 合并进新结构，新增 `./provider` 与 `./providers/workbuddy`；仓外 `import 'dsh-bazaar/connector'` 一类旧写法一律失效。
- **peerDependencies 放宽**：`@deepseek-ai/dsh` 由 `>=0.2.0-rc.1 <0.3.0-0` 改为 `>=0.2.0-rc.1 <0.4.0-0`。

### 移除

- **dsh-armory 复用**：连接器面板不再借用宿主内部 `remote.mcpManager`，两处取值与全部降级分支删除，不留回退。
- **账号 `import` 动作**：不再从外部 vault 目录导入账号记录。
- **连接器写入类动作**：`repair`/`repairConnect`/`reauthorize`/`unbind`/`enable`/`disable`/`disconnect` 与「一键写入宿主配置并重载」全部移除，动作集收敛为 `list`/`state`/`authorize`/`poll`/`cancel`/`copy-config`/`remove`；写入类动作返回 `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED`，「复制配置片段」只产出文本。
- **`authMode` 两个枚举值**：`auto` 与 `workbuddy-connector` 依赖旧 vault 兼容层，本版删除，保留 `none`（默认）/`bearer`/`header`/`cookie`。
- **七个配置键**：`connectorRegion`、`allowPublicMarketAuth`、`accountsDir`、`legacyVaultDir`、`localRoots`、`manifestPath`、`portalPrefix`——其语义或收进内置 provider 内部常量，或下沉为 `providers.<id>` 下的对应键。
- **两个仅服务兼容层的配置键**：`dshHome`、`vaultDir` 随 vault 兼容层一并删除。
- **两个错误码**：`BAZAAR_CONNECTOR_MISSING`、`BAZAAR_CONNECTOR_NO_TOKEN`（原 `WORKBUDDY_HELPER_*` 同名码），连接器缺失/无凭据改由 provider 级 `BAZAAR_AUTH_MISSING` 与 `BAZAAR_CONNECTOR_NOT_FOUND` 表达。
- **过时文档与截图**：连接器逆向报告、自有登录说明、安装与测试报告（含连接器升级测试报告）、旧设计文档共五份 md 与五张 UI png 删除，内容由重写的 `README.md`/`docs/architecture.md`/`docs/provider-integration.md`/`docs/e2e-baseline.md` 承接。

### 保留

- `providers.<id>.fetchImpl`：测试注入 HTTP 替身的唯一入口，删除会让「源仓 226 条用例原样跑通」不成立，故保留。
- 上游事实：`providerId = workbuddy`、上游域名、桌面端目录 `.codebuddy-plugin` / `.workbuddy-plugin` 保持原样。
- 运行依赖（`fflate` / `tar` / `yaml`）、`engines`（`^22.19.0 || >=24.0.0`）、`scripts/release.mjs` 机制与 `docs/releases/vX.Y.Z.md` 约定、`publishConfig` 字段。
- 界面插槽与排序：`conversation.input.left`、`settings.section` / `settings.section.icon`，`order` 25 / 26 不变。

### 修复

- **安装后宿主启动失败（1.0.0 内测事故）**：`@deepseek-ai/dsh-tools` 曾写在 `dependencies` 里，安装时被包管理器提升进 profile 成为一份独立副本；宿主升级后启动预检按运行时版本判定该副本的 `peerDependencies` 不兼容，把它置成 `disabled`，`tools` 服务失去提供者，`tool-executor-native` 与 `agent-loop` 两个 required 插件未激活，宿主以 fatal 退出。修法两半：工具定义改由 `lib/tool-def.js` 本地实现（与宿主 `defineTool` 同形，`ToolsService.register()` 的行为不变），且 `package.json` 的 `dependencies` 不再声明任何 `@deepseek-ai/*`。两半缺一即复发，`test/tool-def.test.mjs` 对「`dependencies` 里零宿主包」与「`lib/` 下零宿主 import」各有断言并带反向控制。

- **面板两处「读取失败」：插件根本没加载完（1.0.0 内测事故）**：`apply()` 里用裸赋值挂 `ctx.bazaar`，而宿主 cordis 的 `ctx` 是 Proxy，set trap 对未声明的属性直接抛 `cannot set property "bazaar" without provide`。`apply()` 是同步执行的，这一抛等于插件未加载——`lib/index.js:239` 已调用的 `ctx.inject(['webServer'])` 回调永不触发，13 条 `/dsh-bazaar/*` 路由一条也没注册，`ctx.tools.register()` 也没跑到，前端设置页报「专家库注册表读取失败」、会话面板报「会话状态读取失败」（两者都是 `/dsh-bazaar/providers`、`/dsh-bazaar/state` 拿到 404）。修法：`ctx.provide('bazaar', service)`，裸对象 ctx（测试夹具、第三方宿主）没有 `provide` 时退回普通赋值。`test/provider-entry.test.mjs` 的 `cordisLikeCtx()` 复现宿主 set trap 语义，先反证裸赋值会抛、再正向断言 provide 挂上了且路由注册成功。

### 不做的事

- **不迁移旧数据**：不探测、不提示、不读取旧数据目录（`<DSH_HOME>/workbuddy-helper`、`<DSH_HOME>/workbuddy-vault`）下的任何残留，升级后需重新登录并重新选择专家库。
- **不发布 npm**：`publishConfig` 字段保留，但 1.0.0 不执行 `npm publish`；物料只推 GitHub。
- **不交付连接器写宿主配置**：留待 1.1.0（见 `docs/architecture.md` Roadmap）。

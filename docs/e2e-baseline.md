# e2e 基线

本文件记录 **1.0.0 的验收基线**：跑在什么环境、用哪个假服务、覆盖了哪些用例、哪些还没覆盖。改测试或改基线，同一次提交里同步更新这里的条数与矩阵。

适用范围：本仓 `lib/`（三层）、`scripts/`、`test/`。不覆盖：真实上游（WorkBuddy 专家中心 / COS 市场 / 登录站点 / 连接器 OAuth）的线上行为、宿主 DSH 内部实现、浏览器渲染层。

## 1. 运行环境基线

| 项                               | 值                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 支持面（`package.json` engines） | `^22.19.0 \|\| >=24.0.0`                                                                                                         |
| 本地已实测                       | Node **v22.18.0**（Windows，`D:\Program Files\NodeJs\node.exe`，npm 11.5.2）                                                     |
| 第二条线（Node 24）              | **未在本机实测**：本机无 nvm/volta/fnm，仓库也没有 CI 矩阵（`.github/workflows/` 为空），因此 24.x 只按 engines 声明支持，未取证 |
| 已知偏差                         | 实测版本 22.18.0 比 engines 下限 22.19.0 低一个补丁号；用例全部通过，但这是**验证缺口**，升级到 ≥22.19.0 或补 CI 后需复验        |
| 包管理                           | `npm`（无 workspace、无 monorepo）                                                                                               |
| 依赖                             | 运行时只有 `fflate` / `tar` / `yaml`；测试**不引入** jsdom、playwright、msw 等新依赖                                             |
| 出网                             | `test/` 全部用例不出网；`node scripts/e2e.mjs --plan ui` 不出网；只有全链路 e2e（`--plan full                                    | connector-only | skills-only`）会访问上游，且需要本机 `dsh` CLI |

判定口径：一条用例只有在**真实代码 + 真实 HTTP + 真实 fetch** 上跑过才算数。前端两屏用 `test/ui-harness.mjs` 提供的迷你 React 运行时执行**真实 `lib/client.js` 组件**（不是复制一份实现），因此测的是交付物本身；但它是 DOM 替身，见 §9 的未覆盖面。

## 2. 本地假服务基线

两屏回放（`test/two-screen-e2e.test.mjs`）与部分服务端用例使用同一个本地假集市，特征固定：

- **监听**：`node:http` 起在 `127.0.0.1:0`（系统分配端口），`startBazaar()` 返回 `{state, baseUrl, close()}`；每个用例 `finally` 里 `close()`，不留监听。
- **禁止**：不接受外部网络、不读真实 `DSH_HOME`、不写仓库内文件；请求记录只存在内存里（`state.requests`），用例按 pathname 后缀取用。
- **两个 provider 夹具**：
  - `WORKBUDDY`（`id: workbuddy`，`displayName: WorkBuddy 专家库`）——五域能力全声明；
  - `DEMO`（`id: demo`，`displayName: 示例库`）——**不声明** `memoryMarket`，用来验证「未声明 → 禁用 + 写明原因」。
- **可注入的故障旋钮**（`createBazaar(config)`）：`failStatus`（某库状态接口 500）、`failExperts`（某库专家分组 `status:'error'`）、`credentialConfigured`（`workbuddy:true` / `demo:false`，验证凭据未配置时登录禁用）、`installed`（`pdf` 已由 `workbuddy` 安装，验证跨库同名冲突）。

假服务实现的路由（与真服务同形）：

| 方法 | 路径                                           | 用途 / 关键语义                                                                                                                    |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/dsh-bazaar/providers`                        | 列举注册表 + `activeProviders` + `defaultProvider`                                                                                 |
| POST | `/dsh-bazaar/providers/active`                 | 写活跃集；非数组 → 400 `BAZAAR_PARAM_INVALID`（field `activeProviders`）；未知 id → 400 `BAZAAR_PROVIDER_UNKNOWN`；**空数组 200**  |
| GET  | `/dsh-bazaar/state`                            | 会话状态（`activeProviders` / `experts` / `expert` / `skills` / `categories` / `warnings`）                                        |
| GET  | `/dsh-bazaar/experts?provider=`                | 单库专家分组；`failExperts` 时该分组 `status:'error'` + `BAZAAR_PROVIDER_THROWN`                                                   |
| GET  | `/dsh-bazaar/skill-market?provider=`           | 两个来源（`skillMarket` / `memoryMarket`）+ `installedBy`；`demo` 的 `memoryMarket` 为 `undeclared`                                |
| POST | `/dsh-bazaar/skill-install`                    | 跨库同名且非 `force` → 409 `BAZAAR_SKILL_NAME_CONFLICT`                                                                            |
| POST | `/dsh-bazaar/select`                           | 选专家，回写 `state.expert`                                                                                                        |
| GET  | `/dsh-bazaar/providers/<id>/status`            | provider 声明 + 凭据（脱敏 `••••9f3c`）+ 缓存；`failStatus` → 500                                                                  |
| GET  | `/dsh-bazaar/providers/<id>/accounts`          | 账号分组                                                                                                                           |
| POST | `/dsh-bazaar/providers/<id>/accounts/action`   | `login` 校验 `region ∈ {cn, global}`，否则 400 `BAZAAR_PARAM_INVALID`（field `region`，`admitted:['cn','global']`）；`remove` 清空 |
| GET  | `/dsh-bazaar/providers/<id>/connectors`        | 连接器列表（`github`，`transport: http`，2 个工具；仅 `workbuddy` 已授权）                                                         |
| POST | `/dsh-bazaar/providers/<id>/connectors/action` | 授权 / 清除授权等动作                                                                                                              |
| POST | `/dsh-bazaar/providers/<id>/cache/clear`       | 清缓存，回 `removedEntries`                                                                                                        |

其余路径一律 404 `BAZAAR_NOT_FOUND`——**假服务不猜**：前端要是打错路由，用例会红，而不是被兜底数据掩盖。

## 3. 用例矩阵（39 个文件 / 384 条）

| 域                         | 文件                                       | 条数 |
| -------------------------- | ------------------------------------------ | ---- |
| 契约与注册表               | `test/provider-contract.test.mjs`          | 9    |
|                            | `test/provider-contract-matrix.test.mjs`   | 8    |
|                            | `test/provider-registry.test.mjs`          | 10   |
|                            | `test/provider-active-set.test.mjs`        | 12   |
|                            | `test/provider-paths.test.mjs`             | 8    |
|                            | `test/provider-dispatch.test.mjs`          | 9    |
|                            | `test/provider-entry.test.mjs`             | 10   |
| 五域编排                   | `test/expert-market-domain.test.mjs`       | 11   |
|                            | `test/skill-market-domain.test.mjs`        | 10   |
| 路由与隔离                 | `test/provider-routes.test.mjs`            | 12   |
|                            | `test/provider-isolation.test.mjs`         | 5    |
|                            | `test/route-lifecycle.test.mjs`            | 2    |
|                            | `test/webui.test.mjs`                      | 8    |
| 内置 provider（workbuddy） | `test/portal-market.test.mjs`              | 4    |
|                            | `test/skill-install.test.mjs`              | 24   |
|                            | `test/wb-login.test.mjs`                   | 30   |
|                            | `test/wb-vault.test.mjs`                   | 23   |
|                            | `test/wb-accounts.test.mjs`                | 17   |
|                            | `test/wb-egress-urlconfig.test.mjs`        | 9    |
|                            | `test/mcp-patch.test.mjs`                  | 9    |
|                            | `test/mnemon.test.mjs`                     | 7    |
| 连接器与门控               | `test/connectors.test.mjs`                 | 4    |
|                            | `test/connector-gate.test.mjs`             | 5    |
|                            | `test/connector-controller.test.mjs`       | 10   |
|                            | `test/connector-flow.test.mjs`             | 11   |
|                            | `test/connector-layered.test.mjs`          | 16   |
|                            | `test/connector-provider-store.test.mjs`   | 15   |
|                            | `test/connector-real-shapes.test.mjs`      | 5    |
|                            | `test/connector-shared-state.test.mjs`     | 14   |
|                            | `test/connector-tool-enumeration.test.mjs` | 3    |
| 前端两屏（离线）           | `test/two-screen-e2e.test.mjs`             | 9    |
|                            | `test/settings-card.test.mjs`              | 5    |
|                            | `test/hook-order.test.mjs`                 | 4    |
| 会话与核心                 | `test/core.test.mjs`                       | 13   |
| 工程与静态扫描             | `test/baseline.test.mjs`                   | 5    |
|                            | `test/legacy-name-scan.test.mjs`           | 4    |
|                            | `test/quality-gate.test.mjs`               | 8    |
|                            | `test/release-script.test.mjs`             | 11   |
|                            | `test/e2e-helpers.test.mjs`                | 5    |

门禁：`scripts/quality-gate.mjs` 的 `MIN_TESTS = 226`；`test/baseline.test.mjs` 另设文件数下限（`lib ≥ 20`、`scripts ≥ 4`、`test ≥ 22`）并断言总条数 384。当前实测 `# tests 384 / # pass 384 / # fail 0`。

## 4. 两屏离线回放矩阵（9 条）

命令：`node scripts/e2e.mjs --plan ui`（不安装、不启模型、不出网，是最干净的验收入口）。

| #   | 屏幕 | 覆盖点                                                                                                                                                                                                                                                                                          |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 屏 A | 页签由注册表驱动（`role=tablist` + `aria-selected` + `aria-controls`），每页签固定四块 `账号 / 凭据 / 缓存 / 连接器授权`；凭据 `role="textbox" aria-readonly="true"` 且脱敏；切到未配置凭据的库时登录禁用 + `aria-disabled` + 写明原因                                                          |
| 2   | 屏 A | 注册表为空 → 不出页签，给「暂无已注册的专家库」空态                                                                                                                                                                                                                                             |
| 3   | 屏 A | 单库故障隔离：只有该页签 `data-error='true'`，切页签不发新请求，其它库不受影响；「重试」只重发失败那一家，「重放加载态」可重复观察加载态                                                                                                                                                        |
| 4   | 屏 A | 清理缓存与退出登录的二次确认：取消发 0 次请求，确认发 1 次；确认文案点名对象与影响范围                                                                                                                                                                                                          |
| 5   | 屏 A | **必填语义**：登录区域下拉 `required` + `aria-required` + 可见「必选」且不预选；未选点登录 → 0 次请求 + 原地 `aria-invalid` 锚定说明；**绕过界面直接提交 → 服务端 400 `BAZAAR_PARAM_INVALID`（field `region`）**                                                                                |
| 6   | 屏 B | **可选语义**：开关组 `role=group`、全屏无 `aria-required`、开关 `aria-checked='false'` + 「未启用」文字标签；全不勾选是合法空态（「尚未选择专家库」）；勾选写 `['workbuddy']`，清空写 `[]` 并**被服务端接受**，回到空态                                                                         |
| 7   | 屏 B | 多库并排 + 跨库同名前缀（`WorkBuddy 专家库 · 数据工程师`）；冲突条目给「冲突」标签、禁用安装、「禁用：已被 X 安装」、「查看已有安装」，点安装发 0 次请求；绕过界面直接安装 → 服务端 409 `BAZAAR_SKILL_NAME_CONFLICT`；未声明 `memoryMarket` 的库其记忆搜索禁用并写「禁用：未声明 memoryMarket」 |
| 8   | 屏 B | 单分区故障隔离：失败分区报错 + 隔离说明，另一库照常出条目；「重试」只带 `provider=demo` 发一次；搜索（`aria-label='搜索 <displayName> 的专家'`）防抖后带 `provider` + `query`，分类 chips 带 `categoryId`                                                                                       |
| 9   | 屏 B | 条目四态可辨：「禁用：未选择该专家库」/「选择」→ 一次 `/select` → 「当前使用」+ 禁用「已选」；`providerId` 以只读 `data-kind="readonly"` 标签展示                                                                                                                                               |

**服务端必拒 / 必收清单**（同一批断言里逐条取证）：

- 必拒：缺 `region` 或非法 `region` → `BAZAAR_PARAM_INVALID`（点名字段，不回落到账号服务）；跨库同名安装 → `BAZAAR_SKILL_NAME_CONFLICT`；路径段与请求体 `providerId` 不一致 → `BAZAAR_PROVIDER_ID_MISMATCH`；未知 provider → `BAZAAR_PROVIDER_UNKNOWN`。
- 必收：`activeProviders: []` 必须以 200 接受（空活跃集是合法状态，不是错误）。
- 只读：凭据值不可写（前端只读容器 + 服务端内联密钥 `BAZAAR_AUTH_INLINE` 拒绝）。

## 5. 全链路 e2e（需要本机 `dsh` CLI）

`node scripts/e2e.mjs [--plan full|connector-only|skills-only|ui]`，产物写 `<out>/report.json`（默认 `.workbuddy/e2e/run`，已 git-ignore）：

| plan             | 证明什么                                                                             | 前置           |
| ---------------- | ------------------------------------------------------------------------------------ | -------------- |
| `ui`             | 两屏离线回放 9 条全绿（TAP 计数写进 `report.json`）                                  | 仅 Node        |
| `connector-only` | 安装 → `--dump-config` 能加载本插件 → `bazaar_helper` 的 `action=connector` 能列目录 | 本机 `dsh` CLI |
| `skills-only`    | `action=skills` 的技能清单与过滤                                                     | 同上           |
| `full`           | 上面全部 + `action=expert` 的提示词合并                                              | 同上 + 网络    |

e2e 一律用临时 `DSH_HOME`（`--keep-home` 可保留现场排查），**绝不碰真实 `DSH_HOME`**；安装 spec 是 `git+https://github.com/awswt/dsh-bazaar.git`（`--source local` 时用 `file:<repo>`）。

## 6. 静态扫描的反向控制

扫描类用例现在都自带「反例必须先被抓住」的控制组，否则扫描器写坏了也会全绿：

| 文件                             | 反向控制                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/hook-order.test.mjs`       | 植入「条件 return 后调 hook」的坏函数必须被抓到；植入「pill 在 boundary 内」必须判 false；植入缺 `getDerivedStateFromError` 的 boundary 必须判失败 |
| `test/settings-card.test.mjs`    | 植入两个字面量 id 必须被判出 `uses 0 / literals 2`；植入 `.armory-panel` 必须被判为外来选择器                                                      |
| `test/baseline.test.mjs`         | 已知在忽略清单里的老文件必须判「被忽略」，一个不存在的假文件必须判「未忽略」                                                                       |
| `test/legacy-name-scan.test.mjs` | 允许事实表（`workbuddy`、四个上游 host、`BAZAAR_WORKBUDDY_TOKEN`、`providers/workbuddy`）必须命中时**不**报错                                      |

## 7. 未覆盖的面（明确记账）

- **真实浏览器渲染**：`test/ui-harness.mjs` 是迷你 React 运行时，覆盖组件树、状态机、`aria-*` 属性与文案，不覆盖 CSS 布局、层叠、焦点环、滚动与真实点击命中。两屏的样式一致性以 `DESIGN.md` 为准，靠人工对照 `design/prototype` 与设置页实机确认。
- **真实上游**：专家中心分页、COS 市场快照、扫码登录、连接器 OAuth 全程未在 CI 里跑；`--plan full` 只在有人值守时手动执行。
- **Node 24**：见 §1 的验证缺口。
- **Windows 以外的路径/大小写行为**：本机只验了 Windows；`safeJoin` 与路径推导另有用例覆盖跨平台差异，但未在 Linux/macOS 实机跑过。
- **宿主 DSH 的 slot 契约**：用假 ctx（`recordingCtx`）验证注册行为，不验证真宿主的渲染槽位。

## 8. 变更纪律

- 新增/删除用例：同步更新 §3 的条数与 `test/baseline.test.mjs` 的总数断言（以及需要时的 `MIN_TESTS`）。
- 新增前端状态：先在 §4 矩阵里加一行，再写用例；文案要与 `prototype/index.html`、`DESIGN.md` 一致。
- 新增假服务路由：必须与真服务同形（错误码、字段名、状态码），并在 §2 的表格里登记。
- 任何「本地假服务掩盖了真服务」的妥协都要写进 §7，而不是留在代码注释里。

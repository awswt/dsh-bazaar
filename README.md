# dsh-bazaar

DeepSeek Harness 的**多 provider 集市**：一个 provider 注册表 + 五域编排（专家 / 技能 / 记忆 / 连接器 / 账号）+ 两个前端屏。
上游事实（域名、端点、凭据、市场模式、页面结构）不再写在插件里，而是下沉进 `providers/<providerId>`。

1.0.0 内置且只内置一个 provider：`workbuddy`。新增一家库不需要改插件代码——注册后它的页签、开关、分区、路由与工具参数会按声明自动出现。

- 契约：provider 声明 `apiVersion: 1` 与 `capabilities`（五域任意组合），缺失能力显示「未声明 · 不适用」而不是空态。
- 身份：`providerId` 参与目录与凭据名推导，是唯一身份；界面只显示 `displayName`，id 仅作只读限定标签。
- 隔离：任一 provider 出错只红它自己的分区/页签，其它库的条目与状态不受影响；连接器工具门控与出网白名单同样逐 provider 独立。

## 安装

```bash
# 从 GitHub 装（1.0.0 的发布形态）
dsh plugin --profile <profile> add git+https://github.com/awswt/dsh-bazaar.git

# 开发时装工作树
dsh plugin --profile <profile> add file:/path/to/dsh-bazaar
```

`cordis.patch.yml` 会把插件层插进 profile 的 patch 层，宿主半侧随之挂载；重复安装/热重载不会堆叠路由（注册同一前缀时先清掉自己前缀的陈旧条目）。

- peer：`@deepseek-ai/dsh >=0.2.0-rc.1 <0.4.0-0`
- engines：`^22.19.0 || >=24.0.0`
- 运行依赖：`fflate` / `tar` / `yaml`
- **不发布 npm**：`publishConfig` 字段保留，物料只推 GitHub。

## 两个界面

### 屏 A · 设置页（设置 → bazaar）

页签集合由 `GET /dsh-bazaar/providers` 驱动：一家库一个页签，标题取 `displayName`，`role="tablist"` + `aria-selected`；单个库加载失败只让该页签内容报错，页签条照常可切换。注册表为空时整块给空态，不渲染假页签。

每个页签固定四块，顺序不变：

| 块         | 内容                                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账号       | 未登录给出「国内版 / 国际版」区域选择（`required` + `aria-required` + 可见「必选」，**不预选**）；未选区域点登录只在原地报错、不发请求（服务端同样以 `BAZAAR_PARAM_INVALID` 拒绝缺失 `region`）。已登录显示只读账号标识与到期时间。 |
| 凭据       | 凭证名 + 是否已配置 + **脱敏值**（`role="textbox" aria-readonly="true"`，没有编辑入口）。未配置时登录入口禁用并写明原因。                                                                                                           |
| 缓存       | 占用大小与条目数；「清理缓存」是危险操作，二次确认里写明影响范围与目录。                                                                                                                                                            |
| 连接器授权 | 授权状态（未授权 / 授权中 / 已授权只读）、复制配置片段、清除授权（二次确认后调用 `connectorAction: remove`）；未启用库的连接器禁用并写明「该专家库未启用」。                                                                        |

### 屏 B · 会话面板（输入框左侧「集市」）

- **专家库开关组**：`role="group"`，标题「选择专家库（可多选）」+「可选」标签；每个开关 `role="switch"` + `aria-checked`，另带「已启用 / 未启用」文字标签。**不是必填项**：全不勾选是合法空态，显示「尚未选择专家库」与入口，且不阻断浏览/搜索。
- **专家分区**：按勾选的库并列成组，每组自带搜索框、分类 chips、库内分页；条目四态可辨——`当前使用` / `应用中` / `已选` / `禁用：未选择该专家库`；跨库同名才加 `<displayName> ·` 前缀，不改真实 id。单库失败只红该分区并给「重试」。
- **技能分区**：每库两列来源——`skillMarket` 与 `memoryMarket`；跨库同名冲突显示「冲突」+ 禁用安装 +「禁用：已被 X 安装」+「查看已有安装」；未声明 `memoryMarket` 的库其记忆搜索框禁用并写明「禁用：未声明 memoryMarket」（不以「暂无条目」冒充空态）。

连接器与账号只在屏 A；屏 B 只保留会话级的选择（专家库 / 专家 / 技能安装）。

## 模型工具与命令

### `bazaar_helper`（工具）

| action           | 关键参数                                                                                              | 说明                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `status`         | —                                                                                                     | 当前会话的专家、技能、连接器摘要                                                            |
| `providers`      | —                                                                                                     | **列举注册表**：每家的 `id` / `displayName` / `capabilities` / `active` / `defaultProvider` |
| `experts`        | `provider=<id>` `query` `categoryId` `page` `pageSize`                                                | 分组并列的专家列表                                                                          |
| `expert`         | `expertId` `provider=<id>`                                                                            | 专家详情                                                                                    |
| `off`            | —                                                                                                     | 清空当前会话的选择                                                                          |
| `skills`         | —                                                                                                     | 当前技能作用域                                                                              |
| `skills install` | `skillId` `provider=<id>` `--force`                                                                   | 安装技能包（归属由库决定）                                                                  |
| `set-skills`     | `provider=<id>` `mode=all\|selected` `names=` `expertNames=`                                          | 设置某库的技能选择                                                                          |
| `skill-market`   | `provider=<id>` `query` `page` `pageSize`                                                             | 技能市场（含 `memoryMarket` 来源）                                                          |
| `connector`      | `connectorAction=list\|state\|authorize\|poll\|cancel\|copy-config\|remove` `connectorId`             | 连接器列表 / 状态 / 授权 / 复制配置片段 / 清除授权                                          |
| `account`        | `accountAction=list\|login\|poll\|cancel\|refresh\|remove` `accountId` `region=cn\|global` `loginId=` | 账号登录与维护                                                                              |
| `market`         | `query`                                                                                               | 内置库的专家市场检索                                                                        |
| `categories`     | —                                                                                                     | 专家分类                                                                                    |

`provider=<id>` 是跨动作的通用开关：不传时按当前会话的活跃集解析，**活跃集为空或有多个库时返回 `BAZAAR_PROVIDER_REQUIRED`**（提示里给出可用的 `provider` 值），不静默猜一家。

### `/bazaar`（斜杠命令）

```
/bazaar status
/bazaar providers
/bazaar experts provider=workbuddy 数据
/bazaar expert <expertId> provider=workbuddy
/bazaar off
/bazaar skills
/bazaar skills install <skillId> provider=workbuddy [--force]
/bazaar skills installed
/bazaar connector <list|state|authorize|poll|cancel|copy-config|remove> [id]
/bazaar account <list|login|poll|refresh|remove> [id] [region=cn|global] [loginId=<id>]
/bazaar market <query>
```

`provider=` / `categoryId=` 可以出现在任意位置（先摘开关再取位置参数）；缺省 action 是 `status`。

## 配置

插件级只剩三项，其余全部按 provider 分组：

```yaml
- id: bazaar
  name: dsh-bazaar
  config:
    enabled: true
    defaultProvider: '' # 空串 = 没有默认库，绝不静默取注册顺序第一家
    dataDir: '' # 空 = <DSH_HOME>/bazaar
    providers:
      workbuddy:
        authMode: none
        credentialRef: BAZAAR_WORKBUDDY_TOKEN
        headerName: Authorization
        headerPrefix: 'Bearer '
        allowHosts:
          [
            www.workbuddy.cn,
            www.workbuddy.ai,
            www.codebuddy.cn,
            www.codebuddy.ai,
            openplatform-cdn.codebuddy.cn,
            acc-1258344699.cos.accelerate.myqcloud.com,
          ]
        allowInsecureLoopback: false
        portalBaseUrl: https://www.workbuddy.cn
        marketBaseUrl: https://<cos host>/workbuddy/expert-marketplace
        regions: [cn, global]
        timeoutMs: 20000
        retries: 1
        cacheTtlMs: 21600000
        staleWhileErrorMs: 604800000
        maxPackageBytes: 33554432
        maxEntries: 400
        maxTotalBytes: 100663296
```

插件级：

| 键                | 默认                | 说明                                                                                   |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `enabled`         | `true`              | `false` 时整个插件不挂载                                                               |
| `defaultProvider` | `''`                | 指向未注册 id 时报 `BAZAAR_PROVIDER_UNKNOWN` 并回落首个已注册 provider，同时在面板提示 |
| `dataDir`         | `<DSH_HOME>/bazaar` | 插件数据根目录                                                                         |

`providers.<id>`（只由该 provider 读，插件入口不解释）：

| 键                                 | 默认                             | 说明                                                                                                                                                            |
| ---------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authMode`                         | `none`                           | 四值之一：`none`（匿名，只读公开快照）/ `bearer`（凭据作头值，配 `headerPrefix`）/ `header`（`headerName` 必填，缺失 → `BAZAAR_AUTH_HEADER_MISSING`）/ `cookie` |
| `headerName`                       | `Authorization`                  | 认证头名；`header` 模式必填                                                                                                                                     |
| `headerPrefix`                     | `Bearer `                        | 头值前缀；`header` 模式默认空串                                                                                                                                 |
| `credentialRef`                    | `BAZAAR_<UPPER_SNAKE(id)>_TOKEN` | 覆盖凭据名                                                                                                                                                      |
| `allowHosts`                       | provider 自带上游域名集合        | 出网白名单，逐 provider 独立                                                                                                                                    |
| `allowInsecureLoopback`            | `false`                          | 仅对本 provider 放行本机 http                                                                                                                                   |
| `portalBaseUrl`                    | `https://www.workbuddy.cn`       | 门户市场地址                                                                                                                                                    |
| `marketBaseUrl`                    | 快照市场地址                     | 快照市场地址                                                                                                                                                    |
| `regions`                          | `[cn, global]`                   | 登录区域**候选集**（决定下拉出现哪几项，不是默认选中值；界面永不预选）                                                                                          |
| `timeoutMs` / `retries`            | `20000` / `1`                    | 出网超时与重试                                                                                                                                                  |
| `cacheTtlMs` / `staleWhileErrorMs` | `21600000` / `604800000`         | 市场缓存 TTL 与出错时旧缓存窗口                                                                                                                                 |
| `maxPackageBytes`                  | `33554432`（32 MiB）             | 技能包体积上限，超出 → `BAZAAR_SKILL_PACKAGE_TOO_LARGE`                                                                                                         |
| `maxEntries`                       | `400`                            | 技能包条目数上限                                                                                                                                                |
| `maxTotalBytes`                    | `100663296`（96 MiB）            | 解压后总量上限                                                                                                                                                  |
| `fetchImpl`                        | 未设置（回落全局 `fetch`）       | **仅供测试注入 HTTP 替身**，生产配置不要设置                                                                                                                    |

`marketMode`（`portal` / `cos` / `auto`）不再出现在配置里：它降为内置 provider 的内部选择（先门户、失败回落快照）。

## 1.0.0 移除的东西

| 类别                   | 移除项                                                                                                                      | 替代                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `authMode` 枚举值      | `auto`、`workbuddy-connector`（依赖旧 vault 兼容层）                                                                        | `none`（默认）/ `bearer` / `header` / `cookie`                                |
| 配置键                 | `connectorRegion`、`allowPublicMarketAuth`、`accountsDir`、`legacyVaultDir`、`localRoots`、`manifestPath`、`portalPrefix`   | 收进内置 provider 内部常量，或下沉为 `providers.<id>` 的对应键                |
| 配置键（仅服务兼容层） | `dshHome`、`vaultDir`                                                                                                       | 随 vault 兼容层一并删除                                                       |
| 配置键                 | `marketMode`、插件级 `providerId` / `authMode` / `headerName` / `headerPrefix` / `allowHosts` 等                            | 全部下沉到 `providers.<id>`                                                   |
| 错误码                 | `BAZAAR_CONNECTOR_MISSING`、`BAZAAR_CONNECTOR_NO_TOKEN`                                                                     | `BAZAAR_AUTH_MISSING` / `BAZAAR_CONNECTOR_NOT_FOUND`                          |
| 连接器动作             | `connect`、`repair`、`repairConnect`、`reauthorize`、`disconnect`、`unbind`、`enable`、`disable`、写宿主配置并重载          | `list` / `state` / `authorize` / `poll` / `cancel` / `copy-config` / `remove` |
| 账号动作               | `import`（从外部 vault 导入）                                                                                               | 重新登录                                                                      |
| 运行时复用             | dsh-armory 的 `remote.mcpManager`（两处取值与全部降级分支）                                                                 | 本插件自带的连接器市场                                                        |
| exports                | `./wb-login`、`./wb-vault`、`./wb-accounts`、`./connector-flow`、`./skill-providers`、`./market`、`./portal`、`./connector` | `./provider`、`./providers/workbuddy`（仓外旧导入路径一律失效）               |

## 数据与凭据

```
<DSH_HOME>/bazaar/
├── providers/<providerId>/
│   ├── accounts/           # 该库的账号库
│   ├── vault/              # 该库的凭据库
│   ├── cache/              # 该库的市场缓存（可整目录删除，自动重建）
│   └── connectors.json     # 该库的连接器授权与配置记录
└── sessions/<sha256(sessionId)>.json
```

会话状态按会话分文件，内部按 `providerId` 分组（`{ schemaVersion, sessionId, activeProviders, experts, skills, revision, updatedAt }`），原子写入；切换专家库不会覆盖另一家的选择。

凭据名恒由 `providerId` 推导：`BAZAAR_<UPPER_SNAKE(providerId)>_TOKEN`（内置库即 `BAZAAR_WORKBUDDY_TOKEN`），可被 `providers.<id>.credentialRef` 覆盖。值只经宿主凭据服务解析，永不出现在任何响应体或日志里；配置里出现明文密钥一律以 `BAZAAR_AUTH_INLINE` 拦下。

## 不做的两件事

- **不迁移旧数据**：不探测、不提示、不读取 1.0.0 之前的数据目录与兼容层 vault 目录（旧名逐条列在 `CHANGELOG.md` 的移除清单里）。升级后需重新登录、重新选择专家库、重新授权连接器。
- **不发布 npm**：1.0.0 只推 GitHub 物料。

## 开发与校验

| 命令                                      | 作用                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm test`                                | `node --test test/*.test.mjs`（全量用例）                                                            |
| `npm run check`                           | 质量门：EOL / `node --check` / 用例数 / ESLint（含压制清单）/ 压制增量 / Prettier / 基线文件未被改动 |
| `npm run lint`                            | ESLint + `eslint-suppressions.json`                                                                  |
| `npm run format:check` / `npm run format` | Prettier 检查 / 写入（只覆盖受管文件，清单见 `.prettierignore`）                                     |
| `node scripts/e2e.mjs --plan ui`          | 两屏界面离线回放：不装包、不起模型、不出网                                                           |
| `node scripts/e2e.mjs`                    | 装到隔离 home 的全链路 e2e（需要本机 DSH CLI）                                                       |

## 文档

- [`docs/architecture.md`](docs/architecture.md)：模块分层与依赖方向
- [`docs/provider-integration.md`](docs/provider-integration.md)：接入一家新 provider 的契约与步骤
- [`docs/e2e-baseline.md`](docs/e2e-baseline.md)：e2e 基线与用例矩阵
- [`docs/releases/v1.0.0.md`](docs/releases/v1.0.0.md)：1.0.0 可见变更与升级说明
- [`CHANGELOG.md`](CHANGELOG.md)：逐条破坏性变更与移除项

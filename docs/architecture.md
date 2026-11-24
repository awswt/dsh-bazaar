# dsh-bazaar 架构说明（1.0.0）

本文描述 1.0.0 的分层、依赖方向、两处全局挂载点（会话门控与出网校验）、
会话状态的承载与写入语义，以及刻意留到后续版本的能力。它与
`openspec/changes/migrate-to-dsh-bazaar/` 下的 specs 同源：本文解释「为什么这样切」，
spec 定义「必须做到什么」。

## 1. 分层与依赖方向

依赖只朝一个方向流动，下层不认识上层：

```
插件入口 index.js           挂宿主能力、装配、生命周期
        │
        ├── provider/registry.js      provider 集合的唯一写/读口
        │        ├── contract.js      契约校验（注册前）
        │        ├── paths.js         providerId 白名单 + 目录/凭据名推导
        │        └── errors.js        统一 BAZAAR_* 错误信封
        │
        ├── provider/dispatch.js      域方法派发（谁家的哪个方法）
        ├── provider/domains.js       跨 provider 分组返回层（补 providerId/qualifiedName）
        ├── provider/routes.js        provider 集合 HTTP 路由
        │
        └── providers/<id>/           provider 实现（当前只有 workbuddy）
                 ├── index.js         实现五域契约
                 ├── portal.js        门户/账号接口
                 └── market.js        专家/技能市场接口
```

规矩：

- `index.js` 只负责装配，不自己算「该用哪家库」——集合、活跃集、派发各只有一处实例，
  面板（HTTP）、模型工具、斜杠命令读的是同一批对象，因此"四处一致"是结构性成立。
- provider 实现不认识 `index.js`、不认识 webui，只依赖 `provider/` 下的契约类型与工具。
- 顶层业务模块（`connectors.js`、`auth.js`、`wb-accounts.js`、`wb-vault.js`、`wb-login.js`）
  是可离线单测的纯逻辑，不含 DSH import；宿主能力只从 `index.js` 注入进来。
- 新增一家 provider = 实现五域契约 + `bazaar.providers.register()`，不改入口。

## 2. 两处全局挂载点

有两件事**必须**挂在统一的层上，绝不能下放进单个连接器/账号工具的实现里——
否则每新增一个入口就多一处漏判。

### 2.1 会话级工具门控（`connectors.js`）

- 判定集中在 `connectorNamesFor(agent)`：它按 providerId 收集「本会话停用的工具」与
  「全局停用的连接器工具」，归一成一份 `deny` 名字表。
- 落地集中在 `applyNow(agent)`：算一次 `deny`，去重排序后与当前 applied 比较，
  有变化才调用一次 `scoped.restrict({ deny })`，返回的 dispose 用于释放旧限制。
- 四个生命周期钩子驱动重算，接线保持不变：`agent/created`、`agent/disposed`、
  `agent/pre-step`、`tools/change`。任一钩子失败只记 warn，不中断该步。
- 门控只在宿主「工具集合」这一层收窄，对所有入口一律生效，包括本插件没写过的入口。
- 1.0.0 删除了 dsh-armory 桥接：不再从 `ctx.get('remote.mcpManager')` 取远端连接器
  状态机；连接器目录、授权状态与动作统一由 provider 的 `connectorMarket` 域提供。

### 2.2 出网校验（`auth.js` 的 `assertAllowedUrl`）

- `assertAllowedUrl(raw, urlConfig)` 是唯一落点，产出四个稳定错误码：
  `BAZAAR_URL_INVALID`、`BAZAAR_URL_USERINFO`、`BAZAAR_URL_INSECURE`、`BAZAAR_HOST_DENIED`。
- `urlConfig` 由注册表的 `register()` 从 provider 声明的 `allowHosts` /
  `allowInsecureLoopback` 派生并冻结，随实现对象持有，不作为方法入参传递——
  调用方无法临时放宽某一家库的白名单。
- 五个出网点都经此函数：在线市场、公开快照、登录、连接器刷新、技能包下载。
- `allowInsecureLoopback` 默认 false；即使打开也只放行回环地址，不对其它 host 生效。
- 凭据名恒由 providerId 推导（`BAZAAR_<ID>_TOKEN`），`credentialRef` 可显式覆盖，
  但跨库引用被拒；凭据未配置直接 `BAZAAR_AUTH_MISSING`，绝不带着空值冲向上游。
  错误、日志与持久化只写引用名（redact），不写凭据明文。

## 3. 会话状态：一文件、按 provider 分组、原子写

- 落点：`<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json`。文件名用 sessionId 的哈希，
  避免任意字符变成非法路径片段。
- 一个会话一个文件，内含 `activeProviders`、`experts`（按 providerId 分组）、
  `skills`（按 providerId 分组）、`revision`、`updatedAt`。切库只改自己那组，
  不互相覆盖。
- 写入保持原子与串行：先写临时文件再 rename；同一会话的写走一条队列，
  避免并发把 revision 写回旧值。
- 账号与连接器授权按 provider 分目录落盘：
  - `providers/<providerId>/accounts/<region>/<accountId>.json`（`accountId` 是 uid 哈希，
    目录 region 与记录 region 不一致的条目被跳过；列表/状态只回脱敏摘要，不含 token）；
  - `providers/<providerId>/connectors.json`（授权记录按 id 分组）。
- 登录三段式（发起 / 轮询 / 刷新）成功后**立刻落盘**，落库失败绝不呈现"已登录"；
  登录标识 `bz_` 前缀、进程内不落盘，重启即作废。
- 1.0.0 没有旧 vault 兼容层：账号总览 `summary` 只含
  `{count, usableCount, ownCount, dir}`，不含 `vaultCount` / `source`。

## 4. 写路由的 providerId 一致性

`/dsh-bazaar/providers/<providerId>/connectors/session` 与
`.../connectors/action` 是全插件仅有的「一个请求里出现两个 providerId」的形态：
路径段用于定位，请求体用于防误投。比对发生在路由入口、交给 provider 之前，
不在连接器实现内部，也不在单个动作分支里。字段缺失或值不同返回
`BAZAAR_PROVIDER_ID_MISMATCH`，错误同时指出路径值与请求体值，且两个 provider 都不写入。
绕过界面直接构造请求走同一处校验。

## 5. 界面与服务端同源

两屏的必填/禁用/只读语义都在服务端有对应的拒绝用例，界面不是唯一防线：

- 登录区域必选：界面 `required` + `aria-required` + 可见「（必选）」且不预选；
  服务端对缺失/非法 `region` 返回 `BAZAAR_PARAM_INVALID` 并指明字段。
- 凭据未配置：界面禁用登录按钮；服务端 `BAZAAR_AUTH_MISSING`，不入上游。
- 连接器动作集收敛为 `list|state|authorize|poll|cancel|copy-config|remove`；
  其余（repair/repairConnect/reauthorize/unbind/enable/disable）一律
  `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED`。`copy-config` 只产文本，`remove` 只删本库授权记录。

## 6. 后续版本 Roadmap（1.0.0 刻意不交付）

以下四项是 1.0.0 明确不交付、留到 1.1.0 的能力，与 `design.md` 的
Migration Plan「1.1.0 Roadmap」逐条对齐：

1. **连接器「一键写入宿主配置并重载」**：复用保留的 `lib/mcp-patch.js`
   （server 名规范化、托管字段、`upsertMcpServers`/`setMcpDisabled`/`removeMcpServer`）
   与 `connectors.json` 的 `patchManaged` 字段，在 1.0.0 的七动作集
   （`list|state|authorize|poll|cancel|copy-config|remove`）基础上扩入
   `connect|repair|unbind|enable|disable`；门控仍在会话级工具层，写入后由
   `tools/change` 触发重放。1.0.0 的 `copy-config` 只产出可复制文本片段，不写宿主配置、不重载。
2. **provider 拆成可独立发布的包**（`@dsh-bazaar/provider-workbuddy`）：注册表契约不变，
   `apiVersion` 仍为 `1`；届时再评估 `apiVersion: 2` 的边界。
3. **第二个真实上游接入**：用 `examples/minimal-provider/` 的同一契约验证「零改动插件入口」。
4. **记忆市场是否升格为独立 provider**：当前委托 `dsh-mnemon` 探测（见 `lib/mnemon.js:46-100`）。

此外，下列能力 1.0.0 同样不提供：自动打开与轮询上游 OAuth 授权页（授权交接只产出
可点开的 URL 与状态）、旧插件 `dsh-connect-workbuddy` 目录的自动迁移、多账号自动轮换
与故障转移、连接器的自动安装 / 卸载（目录只读、授权状态可查，安装交给上游管理页）。

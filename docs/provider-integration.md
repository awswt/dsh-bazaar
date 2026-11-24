# provider 契约与接入手册（apiVersion 1）

本文件是 bazaar 的 **provider 契约手册**：写给要把自己的专家库、技能市场、连接器目录接进 bazaar 的人，也写给在本仓里改注册表与派发层的人。可运行的活样例是 [`examples/minimal-provider/`](../examples/minimal-provider/)——先跑它，再回来看这一页，比反过来快。

- 契约的机检实现在 [`lib/provider/contract.js`](../lib/provider/contract.js)，注册表在 [`lib/provider/registry.js`](../lib/provider/registry.js)，域入口判定在 [`lib/provider/dispatch.js`](../lib/provider/dispatch.js)，目录与凭据名推导在 [`lib/provider/paths.js`](../lib/provider/paths.js)。
- 对外只需要 import 一个入口：`dsh-bazaar/provider`（源码位置 [`lib/provider/index.js`](../lib/provider/index.js)）。它导出常量、错误码、`validateContract`、`createProviderRegistry`、`createDomainDispatcher`，**不是**第二条注册通道——运行期注册只走 `ctx.bazaar.providers.register`。

---

## 1. 契约由两段组成

一份 provider 契约 = **声明面**（元信息，可 JSON 化）+ **行为面**（承载域方法的 `impl` 对象）。

```js
{
  apiVersion: 1,                       // 声明面：本版唯一合法值
  id: 'minimal-example',               // 声明面：同时是目录名与凭据名的来源
  displayName: '本地 JSON 示例库',      // 声明面：界面只显示它
  capabilities: { expertMarket: true },// 声明面：逐域能力开关
  allowHosts: [],                      // 可选：该库可出网的 host 白名单
  allowInsecureLoopback: false,        // 可选：仅对本库放行本机 http
  credentialRef: undefined,            // 可选：覆盖默认凭据名
  impl: {                              // 行为面：只要求"已声明域"的必需方法
    expertMarket: { listExperts, getExpert },
  },
}
```

两段都在**登记之前**校验完（`validateContract`）：任何一段不通过都直接返回失败信封，**不产出记录、不占用该 id**。这样注册表里不存在"登记了但用不了"的条目，失败的 id 也不会挡住后续一次合法的注册。

### 1.1 声明面字段

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `apiVersion` | 是 | 整数 | 本版只接受 `1`；写成字符串 `'1'` 或 `2` 都拒（`BAZAAR_PROVIDER_API_VERSION`） |
| `id` | 是 | string | 必须匹配 `^[a-z][a-z0-9-]{0,31}$`；小写字母开头，仅小写字母/数字/连字符，≤ 32 字符 |
| `displayName` | 是 | string | 人读名；空串视为缺失 |
| `capabilities` | 是 | object | 键只能取五域之一，值必须是布尔 |
| `icon` | 否 | string | 非空字符串，界面图标 |
| `allowHosts` | 否 | string[] | 每项必须是非空字符串；`[]` 合法（= 不放行任何 host） |
| `allowInsecureLoopback` | 否 | boolean | 默认 `false` |
| `credentialRef` | 否 | string | 非空字符串，形状须为 `BAZAAR_<NAME>_TOKEN` |

三处刻意的严格化，都是为了让"写错了"在注册期就炸，而不是在界面上表现为少一块：

1. **未知能力键一律拒绝。** 把 `expertMarket` 拼成 `expertmarket` 若被静默忽略，那条域等价于"没声明"——用户看到的是界面上少了一块，而不是一条错误。
2. **`allowHosts: []` 合法，给了字符串或混型拒。** 空数组的语义是"这个库不出网"，不是"没配"。
3. **可选字段形状不合按参数非法拒，不静默回落默认值。** 静默回落会让"我明明配了 `allowHosts`"的故障查不出来。

### 1.2 `id` 的两种用途

`id` 不只是标识符，它直接参与两处拼装，因此注册期与拼装期用的是**同一个正则**（`PROVIDER_ID_PATTERN`，两处都从 [`lib/provider/contract.js`](../lib/provider/contract.js) 取，不各抄一份）：

- **数据目录**：`<DSH_HOME>/bazaar/providers/<id>/`，其下三个子目录 `accounts` / `vault` / `cache`，外加连接器 store `connectors.json`。这四个落点由 [`providerLayout()`](../lib/provider/paths.js) 恒由 `providerId` 推导，**调用方不能指定目录**。
- **凭据名**：默认 `BAZAAR_<UPPER_SNAKE(id)>_TOKEN`（连字符转下划线并大写）。

第二道防线在 `safeJoin()`：即使注册被绕过、或调用方自己传了拼接片段，落点仍必须在该 provider 自己的子树内，锚点是 `providers/<id>` 而不是 `providers/`。绝对路径片段同样拦下（`escaped: true`）。`paths` 模块是**纯函数**：只算路径，绝不 `mkdir`、绝不读写——所以非法 id 不会在 `providers/` 下留下任何目录。

### 1.3 五域与必需方法

| 域 | 必需方法 |
| --- | --- |
| `expertMarket` | `listExperts`、`getExpert` |
| `skillMarket` | `listSkills`、`installSkill` |
| `memoryMarket` | `listMemorySkills`、`searchMemory` |
| `connectorMarket` | `listConnectors`、`getConnector`、`connectorAction` |
| `account` | `listAccounts`、`accountAction` |

这张表就是 v1 的公开 ABI。**增删其中任何一个方法都必须提升 `apiVersion` 并在 spec 登记新集合**；在 v1 下静默增删属破坏性变更。

- 只对 `capabilities.<域> === true` 的域要求方法。`impl` 里多写的方法既不被依赖，也不会被自动接进任何入口——入口只从 `methodSurface()` 取方法名。
- 声明零个能力域合法（此时不要求 `impl`），用于"先注册占位、后开域"的场景。

### 1.4 行为面纪律

四条，全部由边界兑现，provider 自己不用重复实现：

1. **不抛异常穿透。** 域方法抛了异常，派发层（`createDomainDispatcher().call()`）会把它折成 `BAZAAR_PROVIDER_THROWN` 并带上 `providerId`/`domain`/`method`。带 `code` 的错误原码透传。
2. **失败用返回码。** 返回 `{ ok: false, code, message }`（可平铺更多定位字段），而不是 throw。
3. **成功返回领域结构，不套 `ok`。** 直接返回 `{ items, total, source }` 这类领域对象；派发层统一补 `{ ok: true }`。`providerId` 与 `qualifiedName` 由分组返回层补，provider 不要自己补，否则两处各归一一次。
4. **不另立 DTO。** 同一语义的条目结构在各 provider 之间必须一致，调用方不需要按 provider 分支解析。

---

## 2. 五域方法签名与返回形状

入参一律是**单个普通对象**（不是位置参数），全部字段可选性如下。返回体的字段名固定，不允许换名。

### 2.1 `expertMarket`

```js
listExperts({ query?, categoryId?, page?, pageSize? })  // → { items, total, source, warning? }
getExpert({ id })                                       // → { item }
```

- `source` 标明这批条目来自哪条数据源（如 `'portal'`、`'snapshot'`、`'local-json'`），界面据此提示"当前为快照"。
- `warning` 可选，用于"数据可用但已降级"（例如门户失败回落快照）。降级必须留痕，否则用户以为看的是实时数据。
- `getExpert` 找不到时返回 `{ ok: false, code: 'BAZAAR_EXPERT_NOT_FOUND', message }`，**不要**返回 `{ item: null }`——后者会让界面渲染成一条空专家。

### 2.2 `skillMarket`

```js
listSkills({ query?, page?, pageSize? })  // → { items, total }
installSkill({ skillId, force? })         // → { slug, installedPath, providerId }
```

- `skillId` 是**市场技能 id**；`slug` 是从市场元数据推导出的落盘名，属**返回体字段**而非入参，落位为 `<projectRoot>/.dsh/skills/<slug>/`。
- 跨库同名安装必须返回 `BAZAAR_SKILL_NAME_CONFLICT`，不得覆盖已有目录。

### 2.3 `memoryMarket`

```js
listMemorySkills({ query?, page?, pageSize? })  // → { items, total }
searchMemory({ query, limit? })                 // → { items, total }
```

宿主未安装 `dsh-mnemon` 时返回 `{ ok: false, code: 'BAZAAR_MEMORY_UNAVAILABLE' }`，**不要**返回空列表——空列表会让用户以为"记忆市场是空的"，而实际是"这个能力根本不可用"。

### 2.4 `connectorMarket`

```js
listConnectors({ query?, status? })   // → { items, total, categories }
getConnector({ id })                  // → { item }
connectorAction({ action, id?, params? }) // → { action, result }
```

- `item` 结构：`{ id, name, packageName, version, description, toolCount, sampleTool, prefixes }`。
- 不支持的 `action` 返回 `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED`，并在信封里给出 `supported` 数组。

### 2.5 `account`

```js
listAccounts({})  // → { own, all, pending, summary }
accountAction({ action, accountId?, region?, token?, loginId? })  // → { action, result }
```

- `own` / `all` 是本库自己的账号与全局可见账号两个视图；`pending` 是进行中的登录会话；`summary` 含 `count` / `usableCount` / `ownCount` / `vaultCount` / `dir` / `source`。
- 已声明 `account` 但当前无人登录 = **正常空态**，返回未登录状态与登录入口，不是错误。

### 2.6 声明了域但没有数据 ≠ 错误

这是最容易踩反的一条：**能不能用看 `capabilities`，有没有数据看返回体**。已声明域的空结果必须是空列表 + 成功状态；把空态渲染成错误态，用户会去查一个并不存在的问题。

---

## 3. 注册、注销、列举、查询

运行期只有四个方法，挂在 `ctx.bazaar.providers`：

```js
await ctx.bazaar.providers.register(contract)   // → { ok:true, provider } | 失败信封
await ctx.bazaar.providers.unregister(providerId) // → { ok:true, providerId } | 失败信封
ctx.bazaar.providers.list()                      // → 声明面数组（注册顺序）
ctx.bazaar.providers.get(providerId)             // → { ok:true, provider } | PROVIDER_UNKNOWN
```

设计要点：

- **`list()` / `get()` 只给声明面投影**（`declarationOf()`），不含 `impl`。`impl` 里是上游闭包与凭据链，序列化时会变成不可 JSON 化的值。编排层需要 `impl` 时走内部口 `getRecord()`，那个口**不经 `ctx.bazaar` 暴露**。
- **重复注册被拒**（`BAZAAR_PROVIDER_DUPLICATE`），不覆盖既有记录。热更新若静默覆盖，正在被会话引用的 `impl` 会被悄悄换掉，而用户没做任何操作。要换实现必须先 `unregister`。
- **`unregister` 在同一临界区内清会话分区**：按 `providerId` 只清 `activeProviders` / `experts` / `skills` 中该库的那一份，其它库的条目逐字段原样保留。清除失败则**整笔作废**（表里保留该 provider），避免"表里没了、会话还指着它"的半状态。
- **注册与注销都串行化**（内部 enqueue 链）。它们同时动"provider 表"与"会话分区"两处状态，交错执行会留下上面说的那种窗口。单次失败不会毒化整条链。
- **注销后同名重注册放行**，按全新注册处理；该会话的 `activeProviders` 里已不含它（需用户重新勾选）。
- `onChange` 通知（`registered` / `unregistered`）用于让面板、路由、会话门控重算。监听器抛错不改变注册结果。

内置 provider（`id: 'workbuddy'`，见 [`lib/providers/workbuddy/index.js`](../lib/providers/workbuddy/index.js)）在 `apply()` 里自注册，注册失败只记 `warn` 日志、不阻断宿主启动——一个上游库注册不上，不该让整个插件加载失败。

---

## 4. 出网白名单与回环例外

每个 provider 只拿**自己那一份** `allowHosts` 与 `allowInsecureLoopback`，不存在全局名单：

| 情况 | 结果 |
| --- | --- |
| 目标 host 在该库 `allowHosts` 内，且为 https | 放行 |
| host 不在白名单内 | `BAZAAR_HOST_DENIED` |
| 非 https，且该库未开 `allowInsecureLoopback` | `BAZAAR_URL_INSECURE` |
| 非 https，但目标为本机回环**且**该库显式 `allowInsecureLoopback: true` | 放行（只对该库生效） |
| URL 带 userinfo | `BAZAAR_URL_USERINFO` |
| URL 解析失败 | `BAZAAR_URL_INVALID` |

`allowInsecureLoopback` 默认 `false`；置 `true` 只放行本机回环地址。A 库开的回环例外对 B 库无效——校验函数无全局状态、不读环境变量、不做记忆化。

---

## 5. 凭据

- **默认名由 `providerId` 推导**：`BAZAAR_<UPPER_SNAKE(id)>_TOKEN`。`id: 'my-lib-2'` → `BAZAAR_MY_LIB_2_TOKEN`；内置库 → `BAZAAR_WORKBUDDY_TOKEN`。
- **`credentialRef` 可覆盖**，但覆盖名必须先过两道判定：
  1. 形状必须是 `BAZAAR_<NAME>_TOKEN`（`/^BAZAAR_[A-Z0-9_]+_TOKEN$/`）；
  2. **反查归属**：把覆盖名反解成 `providerId`，若命中另一个已注册库，就是跨库取凭据，返回 `BAZAAR_PARAM_INVALID` 并在信封里给出 `ownerProviderId`。
- 自定义名（不等于任何库的推导名）允许存在。
- 形状不合**不静默回落到推导名**：静默回落会让"我明明配了 `credentialRef`"的故障查不出来。

为什么这么严：凭据名就是隔离边界本身。允许自由传入时，`alpha` 一句 `resolveCredentialName('BAZAAR_BETA_TOKEN')` 就能读到 `beta` 的令牌。所以只有两种合法来源——`providerId` 推导，或该库自己的 `credentialRef` 覆盖。

令牌只经宿主 `credentials` 服务解析，**配置文件里不出现明文密钥**；出现即 `BAZAAR_AUTH_INLINE`。

---

## 6. 错误码表

全部码名以 [`lib/provider/errors.js`](../lib/provider/errors.js) 的 `CODES` 为唯一清单（新增码必须先登记到那里，再回到本表）。前缀统一 `BAZAAR_`。

### 契约与注册表

| 码 | 触发条件 |
| --- | --- |
| `BAZAAR_PROVIDER_API_VERSION` | `apiVersion` 缺失或不等于 `1` |
| `BAZAAR_PROVIDER_INVALID_ID` | `id` 不匹配 `^[a-z][a-z0-9-]{0,31}$`（含路径穿越片段、大写、下划线、超长） |
| `BAZAAR_PROVIDER_IMPL_MISSING` | 已声明域缺 `impl.<域>` 或其中某个必需方法不是函数 |
| `BAZAAR_PROVIDER_DUPLICATE` | 同一 `id` 重复注册 |
| `BAZAAR_PROVIDER_UNKNOWN` | 查询/注销/派发一个未注册的 `id` |
| `BAZAAR_PROVIDER_REQUIRED` | 派发时既没显式传 `providerId`、活跃集也不是恰好一家 |
| `BAZAAR_PROVIDER_ID_MISMATCH` | `impl` 自报的 `id` 与声明不一致 |
| `BAZAAR_PROVIDER_THROWN` | 域方法抛了不带 `code` 的异常（边界折算） |
| `BAZAAR_CAPABILITY_UNDECLARED` | 调用该库未声明的域；信封含 `providerId` / `domain` / `declared` |
| `BAZAAR_PARAM_INVALID` | 入参、字段形状、路径拼装越界、`credentialRef` 越权等参数类问题 |

### 专家与市场

| 码 | 触发条件 |
| --- | --- |
| `BAZAAR_EXPERT_NOT_FOUND` | 指定 id 的专家不存在 |
| `BAZAAR_MARKET_AUTH_REQUIRED` | 市场要求鉴权但当前没有可用令牌 |
| `BAZAAR_MARKET_RATE_LIMITED` | 上游限流 |
| `BAZAAR_MARKET_UNAVAILABLE` | 上游不可达且无可回落的数据源 |
| `BAZAAR_PORTAL_AUTH_REQUIRED` | 在线门户要求登录态 |

### 技能与记忆

| 码 | 触发条件 |
| --- | --- |
| `BAZAAR_SKILL_NAME_CONFLICT` | 目标 slug 已被另一个库的技能占用 |
| `BAZAAR_SKILL_SLUG_INVALID` | 从市场元数据推导出的 slug 不合法 |
| `BAZAAR_SKILL_PACKAGE_TOO_LARGE` | 技能包超过体积上限 |
| `BAZAAR_MEMORY_UNAVAILABLE` | 记忆市场依赖的 `dsh-mnemon` 未安装 |

### 连接器

| 码 | 触发条件 |
| --- | --- |
| `BAZAAR_CONNECTOR_NOT_FOUND` | 指定 id 的连接器不存在 |
| `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED` | 该库不支持被请求的动作；信封含 `supported` |

### 认证与凭据

| 码 | 触发条件 |
| --- | --- |
| `BAZAAR_AUTH_MISSING` | 需要凭据但宿主凭据服务里没有条目 |
| `BAZAAR_AUTH_INLINE` | 配置里出现明文密钥 |
| `BAZAAR_AUTH_MODE` | `authMode` 取值非法或与当前能力不匹配 |
| `BAZAAR_AUTH_HEADER_MISSING` | `header` 模式下缺少 `headerName` |
| `BAZAAR_CREDENTIALS_MISSING` | 宿主未提供凭据服务 |
| `BAZAAR_LOGIN_EXPIRED` | 登录态过期，需要重新登录 |

### 出网

| 码 | 触发条件 |
| --- | --- |
| `BAZAAR_HOST_DENIED` | 目标 host 不在该库 `allowHosts` 内 |
| `BAZAAR_URL_INVALID` | URL 无法解析 |
| `BAZAAR_URL_INSECURE` | 非 https 且未获回环例外 |
| `BAZAAR_URL_USERINFO` | URL 带 userinfo |

---

## 7. 抄示例时最容易写错的三件事

活样例在 [`examples/minimal-provider/`](../examples/minimal-provider/)（读本地 JSON、不联网、不登录，不进 `lib/`）：

```bash
node examples/minimal-provider/index.mjs
```

1. **只声明你实现了的域。** 声明了 `skillMarket` 就必须实现 `listSkills` 与 `installSkill`，缺一个注册就失败。反过来，没声明的域不用写空方法——写了也不算进契约承诺。
2. **失败返信封，不 throw。** `return { ok: false, code, message }`；throw 只会被折成 `BAZAAR_PROVIDER_THROWN`，丢掉你自己给的定位信息。
3. **成功返领域结构，不套 `ok`。** `return { items, total, source }`；边界会补 `{ ok: true }`。嵌套一层 `{ ok: true, data: ... }` 会让调用方拿不到 `items`。

---

## 8. 相关规格

- [`openspec/changes/migrate-to-dsh-bazaar/specs/provider-registry/spec.md`](../openspec/changes/migrate-to-dsh-bazaar/specs/provider-registry/spec.md)——契约、注册表、隔离的 MUST 条款与场景。
- [`openspec/changes/migrate-to-dsh-bazaar/specs/account-auth/spec.md`](../openspec/changes/migrate-to-dsh-bazaar/specs/account-auth/spec.md)——凭据名推导与出网校验的 MUST 条款。
- [`DESIGN.md`](../DESIGN.md)——分层与决策记录。

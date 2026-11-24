## Purpose

定义账号与凭据的对外行为：按 provider 分目录存放账号与凭据，登录采用「扫码发起 → 轮询 → 落库」三段式且结果即时持久化，凭据只经宿主凭据服务解析且界面只呈现脱敏状态，出网地址校验（host 白名单、HTTPS 要求、loopback 例外）下沉到 provider 级并作用于所有出网路径，全部失败以 `BAZAAR_*` 错误码表达。

## ADDED Requirements

### Requirement: 账号记录按 provider 分目录存放

每个 provider 的账号记录 MUST 存放于 `<DSH_HOME>/bazaar/providers/<providerId>/accounts/`，一个账号一个文件。账号列表与状态查询 MUST NOT 返回任何 token 值，只返回账号标识、区域、到期时间等非敏感字段。

同一 provider 下多个账号 MUST 并存，不同 provider 的账号 MUST 互不可见。

#### Scenario: 多账号并存于同一 provider 目录

- **WHEN** `workbuddy` 下先后登录两个账号
- **THEN** `<DSH_HOME>/bazaar/providers/workbuddy/accounts/` 下存在两个账号文件
- **THEN** 账号列表返回两条记录，均不含 token 值

#### Scenario: 跨 provider 账号不可见

- **WHEN** `workbuddy` 已登录一个账号，查询 `demo` 的账号列表
- **THEN** `demo` 的账号列表为空（`demo` 未登录）
- **THEN** 返回体中不含 `workbuddy` 的任何账号标识

#### Scenario: 账号列表不泄露 token

- **WHEN** 查询某 provider 的账号列表与账号状态
- **THEN** 返回体所有字段均不含完整 token 或 refresh token
- **THEN** 凭据相关字段仅以「已配置 / 未配置」或脱敏占位呈现

#### Scenario: 账号查询在三条入口上结果一致

- **WHEN** 分别经设置页账号区、`bazaar_helper` 账号动作、HTTP 账号路由查询同一 provider 的账号
- **THEN** 三处返回的账号标识集合一致
- **THEN** 三处均不含 token 值

### Requirement: 登录采用三段式并即时持久化

登录 MUST 由「发起（取得登录标识与二维码/链接）→ 轮询（取得授权结果）→ 落库（写入账号记录）」三段组成。轮询返回成功时 MUST 立即持久化，MUST NOT 只在内存中标记成功。

登录标识 MUST 带 `bz_` 前缀。轮询 MUST 校验区域与发起时一致；区域不一致 MUST 拒绝，MUST NOT 落库。

登录会话 MUST 有有效期，过期后轮询 MUST 返回过期失败而不是继续等待。

#### Scenario: 登录成功后立即落库

- **WHEN** 用户发起登录并完成上游扫码，轮询返回成功
- **THEN** 账号记录立即写入 `<DSH_HOME>/bazaar/providers/<providerId>/accounts/<region>/<accountId>.json`
- **THEN** 插件重启后该账号仍在账号列表中

#### Scenario: 区域不一致被拦下

- **WHEN** 以 `cn` 区域发起登录，轮询时携带 `global` 区域
- **THEN** 轮询被拒绝，返回区域不一致错误
- **THEN** 不写入任何账号记录

#### Scenario: 过期登录返回过期失败

- **WHEN** 发起登录后超过有效期才轮询
- **THEN** 返回登录过期失败，不返回「进行中」
- **THEN** 该登录标识被清理，不可再轮询

#### Scenario: 登录在三条入口上状态流转一致

- **WHEN** 分别经设置页、`bazaar_helper` 账号动作、`/bazaar` 命令对同一 provider 发起登录
- **THEN** 三处的状态流转一致（发起 → 进行中 → 已登录 / 已取消 / 失败）
- **THEN** 三处成功后的落库位置一致

### Requirement: 凭据名按 provider 推导并只经宿主凭据服务解析

凭证名 MUST 由 `providerId` 推导：默认为 `BAZAAR_<ID>_TOKEN`（id 中的连字符转下划线并大写），可由 `providers.<id>.credentialRef` 覆盖。

凭据值 MUST 只经宿主凭据服务解析，MUST NOT 出现在配置文件中。配置中出现内联密钥 MUST 被拒绝并返回 `BAZAAR_AUTH_INLINE`。

以 A provider 的身份解析 B provider 的凭证 MUST 被拒绝。

#### Scenario: 默认凭证名由 id 推导

- **WHEN** 某 provider 的 `id` 为 `my-lib`，未声明 `credentialRef`
- **THEN** 其凭证名为 `BAZAAR_MY_LIB_TOKEN`
- **THEN** 该凭证名参与解析时不读取其他 provider 的凭证

#### Scenario: 内联密钥被拦下

- **WHEN** 配置中写入 `token: 'abc123...'` 形式的内联密钥
- **THEN** 解析被拒绝并返回 `BAZAAR_AUTH_INLINE`
- **THEN** 该值不出现在任何日志或返回体中

#### Scenario: 自定义 credentialRef 被放行

- **WHEN** 某 provider 声明 `credentialRef: 'MY_CUSTOM_TOKEN'`
- **THEN** 该 provider 的凭据解析使用 `MY_CUSTOM_TOKEN`
- **THEN** 其他 provider 的凭证解析不受影响

#### Scenario: 凭据解析在四个出网入口上一致

- **WHEN** 同一 provider 依次触发在线市场、公开快照、登录、连接器刷新四个出网入口
- **THEN** 四个入口解析出的凭证名一致
- **THEN** 四个入口均未读取其他 provider 的凭证

### Requirement: 出网地址校验下沉到 provider 级

出网地址校验 MUST 使用该 provider 自己声明的 `allowHosts` 与 `allowInsecureLoopback`，MUST NOT 使用全局或他 provider 的白名单。

host 不在该 provider 白名单内 MUST 返回 `BAZAAR_HOST_DENIED`。非 HTTPS 且未获 loopback 例外 MUST 返回 `BAZAAR_URL_INSECURE`。URL 非法 MUST 返回 `BAZAAR_URL_INVALID`；带 userinfo MUST 返回 `BAZAAR_URL_USERINFO`。

`allowInsecureLoopback` 默认 MUST 为 `false`；置为 `true` 时 MUST 只放行本机回环地址，且 MUST 只对该 provider 生效。

该校验 MUST 作用于在线市场、公开快照、登录、连接器刷新四个出网入口；各入口对应代码见下方场景。

#### Scenario: 四个出网入口都经过同一份校验

- **WHEN** 分别检查四个出网入口的实现位置：在线市场（`lib/market.js`）、公开快照（`lib/portal.js`）、登录（`lib/wb-login.js:194`/`:251`/`:303`/`:363`）、连接器刷新（`lib/connector.js:241`/`:283` 调 `refreshCredential`）
- **THEN** 四个入口在发请求之前都调用同一份 `assertAllowedUrl`，并传入该 provider 自己的配置。**源仓现状只覆盖市场与快照**：市场 3 处（`lib/market.js:81`/`:345`/`:353`）、快照 3 处（`lib/portal.js:329`/`:355`/`:372`）已调用；登录 4 处（`lib/wb-login.js:194`/`:251`/`:303`/`:363`）走自有 `baseForRegion`（`lib/wb-login.js:62-78`，只校验 `https:` 与已知 host 并抛普通 `Error`，不产生 `BAZAAR_*` 码），1.0.0 MUST 改造为经同一函数，且其失败也以 `BAZAAR_HOST_DENIED`/`BAZAAR_URL_INSECURE`/`BAZAAR_URL_INVALID`/`BAZAAR_URL_USERINFO` 表达
- **THEN** 登录与连接器刷新在源仓本就是同一处实现（`lib/connector.js:22` 直接 import `refreshCredential`），属「两个入口、一处代码」；改造后这两条的一致性由「同一函数 + 同一份 provider `urlConfig`」保证，市场与快照各自独立调用，同样按同一 provider 配置断言结果一致

#### Scenario: 越界 host 被拦下

- **WHEN** 某 provider 的 `allowHosts` 为 `['api.example.com']`，其请求指向 `evil.example.net`
- **THEN** 返回 `BAZAAR_HOST_DENIED`
- **THEN** 不发出该请求

#### Scenario: 非 HTTPS 被拦下

- **WHEN** 某 provider 未开启 `allowInsecureLoopback`，请求 `http://api.example.com/path`
- **THEN** 返回 `BAZAAR_URL_INSECURE`
- **THEN** 不发出该请求

#### Scenario: 回环例外只对本 provider 生效

- **WHEN** provider A 声明 `allowInsecureLoopback: true` 并请求 `http://127.0.0.1:8080/x`，provider B 未声明该字段并请求同一地址
- **THEN** A 的请求被放行
- **THEN** B 的请求返回 `BAZAAR_URL_INSECURE`

#### Scenario: 带 userinfo 的 URL 被拦下

- **WHEN** 请求 `https://user:pass@api.example.com/x`
- **THEN** 返回 `BAZAAR_URL_USERINFO`
- **THEN** 不发出该请求

#### Scenario: 四个出网入口判定一致

- **WHEN** 用同一越界 host 分别触发在线市场、公开快照、登录、连接器刷新四个出网入口
- **THEN** 四个入口均返回 `BAZAAR_HOST_DENIED`，且都在发出请求之前拦下（连接器刷新经 `refreshCredential` 与登录同一处代码，改造后同样经 `assertAllowedUrl`，不因走的是「连接器」入口而绕过）
- **THEN** 四个入口均未产生实际出网请求

### Requirement: 失败以 BAZAAR 前缀错误码表达且不泄露敏感值

所有认证与出网失败 MUST 以 `BAZAAR_` 前缀错误码表达，MUST 附带可读说明，MUST NOT 在错误信息、日志或返回体中包含 token、refresh token 或完整凭证值。

同一失败原因在不同入口 MUST 使用同一错误码。

#### Scenario: 错误码统一前缀

- **WHEN** 分别触发下列失败：凭据未配置、宿主凭据服务不可用、`header` 模式缺 `headerName`、不支持的 `authMode`、配置里出现明文密钥、host 越界、非 HTTPS、URL 带 userinfo、登录过期
- **THEN** 依次返回 `BAZAAR_AUTH_MISSING`、`BAZAAR_CREDENTIALS_MISSING`、`BAZAAR_AUTH_HEADER_MISSING`、`BAZAAR_AUTH_MODE`、`BAZAAR_AUTH_INLINE`、`BAZAAR_HOST_DENIED`、`BAZAAR_URL_INSECURE`、`BAZAAR_URL_USERINFO`、`BAZAAR_LOGIN_EXPIRED`
- **THEN** 每个码只对应上方列举的那一个触发条件，不同触发条件 MUST NOT 复用同一码
- **THEN** 错误信息可读且不含敏感值

#### Scenario: 日志与返回体不含敏感值

- **WHEN** 某次请求因上游返回 401 而失败，上游响应体回显了请求头中的 token
- **THEN** 插件返回体与日志中该 token 被替换为脱敏占位
- **THEN** 上游回显的 token 不出现在任何落盘文件中

#### Scenario: 同一原因跨入口同码

- **WHEN** 同一凭据缺失分别在设置页与模型工具上触发
- **THEN** 两处返回同一错误码
- **THEN** 两处的错误说明指向同一处置方式（去配置凭据）

#### Scenario: 账号总览的 summary 字段口径

- **WHEN** 某 provider 自有账号 2 条、其中 1 条已过期且不可刷新
- **THEN** `summary` 含 `count`（全部账号数，2）、`usableCount`（当前可用数，1）、`ownCount`（自有账号数，2）、`dir`（该 provider 账号目录真实路径，仅供面板展示）
- **THEN** `summary` MUST NOT 含 `vaultCount` 与 `source` 两个字段——它们来自已删除的 vault 兼容层（源仓 `lib/wb-accounts.js:87` 与 `:91`），1.0.0 没有需要并入的兼容层账号
- **THEN** 调用方读取这两个字段时返回 `undefined`，MUST NOT 伪造为 `0` 或空字符串

#### Scenario: 成功路径不产生错误码

- **WHEN** 凭证已配置且出网 host 合法
- **THEN** 请求成功，返回体中不含任何错误码字段

### Requirement: 账号区界面状态语义

账号区 MUST 用可见文字或徽标区分：未登录（空态，含登录入口）、登录中（禁用重复点击，含取消入口）、已登录（只读展示账号标识与到期时间）、凭据未配置（禁用登录并说明原因）、登录失败（含原因与重试入口）。

「退出登录 / 移除账号」MUST 视为危险操作，执行前 MUST 二次确认。

登录区域 MUST 是必选项：未登录态的账号区 MUST 提供「国内版 / 国际版」区域选择，以可见文字标注「（必选）」并同时挂 `required` 与 `aria-required`，且 MUST NOT 预选任何一个区域——区域决定凭据发往哪套上游账号体系，猜错等于把令牌发错主机。

点「登录」时若未选区域，界面 MUST 就地给出可定位到该下拉的提示（`aria-invalid` + `aria-describedby` 锚定「错在哪 / 怎么改」）并 MUST NOT 发出登录请求；服务端 MUST 对缺失或非法 `region` 的登录请求返回 `BAZAAR_PARAM_INVALID` 并指明字段，不受界面校验影响。

#### Scenario: 未选登录区域时界面拦下且不发请求

- **WHEN** 某 provider 未登录，用户未选择登录区域就点「登录」
- **THEN** 该下拉进入字段级出错态，带 `aria-invalid="true"` 与锚定说明「请先选择登录区域（国内版 / 国际版）」
- **THEN** 不发出登录请求（网络面板无该 `accounts/action` 调用），账号区仍为未登录态

#### Scenario: 客户端绕过界面提交缺失区域被拒绝

- **WHEN** 客户端绕过界面直接以 `action=login` 且不带 `region` 调用该 provider 的 `accounts/action`
- **THEN** 服务端返回 `BAZAAR_PARAM_INVALID` 并指明缺失字段为 `region`
- **THEN** 不产生登录标识，不写入账号记录

#### Scenario: 未登录为空态

- **WHEN** 某 provider 无任何账号
- **THEN** 账号区显示未登录文案与登录入口
- **THEN** 不显示错误态

#### Scenario: 登录中禁用重复点击

- **WHEN** 用户点击登录，登录进行中
- **THEN** 登录按钮进入禁用态并显示「登录中」，同时提供取消入口
- **THEN** 重复点击不产生第二个登录标识

#### Scenario: 凭据未配置时禁用并说明

- **WHEN** 某 provider 需要凭据但尚未配置
- **THEN** 登录入口处于禁用态并显示「凭据未配置」文字原因
- **THEN** 该原因不只以灰色表达

#### Scenario: 移除账号需二次确认

- **WHEN** 用户点击「移除账号」
- **THEN** 弹出确认，文案说明将删除该账号记录并需要重新登录
- **THEN** 未确认时不删除，确认后才移除记录

#### Scenario: 客户端绕过禁用态直接登录被拒绝

- **WHEN** 凭据未配置时客户端绕过界面直接发起登录
- **THEN** 服务端返回凭据缺失类错误码
- **THEN** 不产生登录标识，不写入账号记录

### Requirement: 从登录到出网鉴权的完整链路

从发起登录到出网请求携带正确凭据 MUST 构成一条可逐字段验证的链路：发起登录 → 轮询成功 → 账号落库 → 凭据可用 → 出网请求带鉴权头。任一环节失败 MUST NOT 让后续环节呈现成功。

#### Scenario: 登录经五跳到达鉴权出网

- **WHEN** 用户在 `workbuddy` 页签发起登录并完成上游扫码
- **THEN** 轮询返回成功，`<DSH_HOME>/bazaar/providers/workbuddy/accounts/<region>/<accountId>.json` 存在且含区域、到期时间，不含明文 token 字段以外的敏感回显
- **THEN** 账号区显示已登录与到期时间，`revision` 无关但账号列表可查到该账号
- **THEN** 该 provider 的凭证解析返回可用状态
- **THEN** 随后发起的市场请求带鉴权头，且该请求的 host 在该 provider 的 `allowHosts` 内

#### Scenario: 落库失败不呈现已登录

- **WHEN** 轮询返回成功但账号落库失败
- **THEN** 账号区显示落库失败错误与重试入口，不显示已登录
- **THEN** 凭证解析返回不可用，后续市场请求不携带鉴权头

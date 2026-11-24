## Purpose

定义专家市场的对外行为：在已注册且声明了 `expertMarket` 的 provider 之间，按 provider 分组并列呈现专家列表、支持搜索与分类筛选、呈现专家详情，并把用户的专家选择按 `providerId` 分区写入会话状态。同一会话内可同时点亮多个专家库；单个 provider 的数据源故障只影响自己的分区，不整体失败、不静默隐藏；跨库同名专家以 provider 限定前缀区分，选择动作必须携带 `providerId`。

## ADDED Requirements

### Requirement: 专家列表按 provider 分组并列返回

专家列表 MUST 以 `providerId` 为分组维度返回，每组 MUST 含该 provider 的 `id`、`displayName` 与该组的条目数组。请求 MUST 能表达「哪些 provider 需要返回」。

只有一个 provider 活跃时 MUST 只返回该组；多个 provider 活跃时 MUST 按活跃集顺序并列返回多组。未注册或未激活的 provider MUST NOT 出现在结果中。

#### Scenario: 单库活跃只返回该组

- **WHEN** 会话 `activeProviders: ['workbuddy']`，请求专家列表
- **THEN** 结果只含 `workbuddy` 一组，组内条目数与该 provider 的可用条目数一致
- **THEN** 结果中不含其他 provider 的空组

#### Scenario: 多库活跃并列返回

- **WHEN** 会话 `activeProviders: ['workbuddy','demo']`，请求专家列表
- **THEN** 结果含 `workbuddy` 与 `demo` 两组，顺序与活跃集一致
- **THEN** 每组条目的 `providerId` 字段分别等于所属组的 `id`

#### Scenario: 未激活 provider 不参与返回

- **WHEN** `demo` 已注册但不在会话活跃集内，请求专家列表
- **THEN** 结果中不含 `demo` 组
- **THEN** `demo` 的数据源未被请求（不产生该 provider 的出网调用）

#### Scenario: 分组结果在面板与工具路径上一致

- **WHEN** 同一会话分别经面板渲染路径与 `bazaar_helper` 的专家列表动作取数
- **THEN** 两次返回的 provider 组集合与每组条目 id 集合完全一致
- **THEN** 两次返回的组顺序均与 `activeProviders` 顺序一致

### Requirement: 专家列表支持搜索与分类筛选

专家列表 SHALL 支持关键词搜索与分类筛选，两个条件 MUST 可同时生效。筛选 MUST 在单个 provider 的分区内独立生效，MUST NOT 让一个 provider 的空筛选结果清空其他 provider 的分区。

参数非法（如 `pageSize` 非正整数、页码小于 1）时 MUST 拒绝请求并返回明确错误，MUST NOT 静默使用默认值。

#### Scenario: 关键词与分类同时生效

- **WHEN** 对 `workbuddy` 分区提交关键词「写作」与分类「内容」两个条件
- **THEN** 返回条目同时命中关键词与分类
- **THEN** 返回条目的 `displayName` 或描述中含该关键词

#### Scenario: 单库空结果不清空其他库

- **WHEN** `activeProviders: ['workbuddy','demo']`，在 `demo` 分区按关键词筛选得到 0 条
- **THEN** `demo` 分区显示「无匹配结果」空态
- **THEN** `workbuddy` 分区的条目仍完整显示，不受影响

#### Scenario: 非法分页参数被拦下

- **WHEN** 请求 `pageSize=0` 或 `page=-1`
- **THEN** 返回参数校验错误，错误信息指明非法字段
- **THEN** 不返回任何条目，也不以默认值代替

#### Scenario: 搜索与筛选在三条入口上判定一致

- **WHEN** 分别经面板搜索框、`bazaar_helper` 的专家列表动作、以及 HTTP 专家路由提交同一组「关键词 + 分类」条件
- **THEN** 三条路径返回的条目 id 集合一致
- **THEN** 三条路径对非法分页参数返回同一错误码

### Requirement: 专家详情按 provider 定位

专家详情 MUST 通过 `providerId` + 专家 `id` 双键定位。只给专家 `id` MUST 被拒绝并返回 `BAZAAR_PROVIDER_REQUIRED`。

详情 MUST 含该专家的展示名、来源标识、技能清单与该 provider 的 `displayName`。详情请求失败 MUST 返回明确错误，MUST NOT 返回空对象冒充成功：该 `providerId` 与 `id` 组合查不到专家时 MUST 返回 `BAZAAR_EXPERT_NOT_FOUND`，上游不可达时 MUST 按失败原因区分：在线市场需要账号令牌而未提供 → `BAZAAR_MARKET_AUTH_REQUIRED`；在线市场限流 → `BAZAAR_MARKET_RATE_LIMITED`；两个来源都不可用 → `BAZAAR_MARKET_UNAVAILABLE`；门户令牌失效 → `BAZAAR_PORTAL_AUTH_REQUIRED`。这些「拿不到」的码与 `BAZAAR_EXPERT_NOT_FOUND`（「查不到」）MUST NOT 混用。

#### Scenario: 缺 providerId 的详情请求被拦下

- **WHEN** 请求某专家详情的 `expertId` 为 `writer`，但未提供 `providerId`
- **THEN** 返回 `BAZAAR_PROVIDER_REQUIRED`
- **THEN** 不返回任何专家详情

#### Scenario: 双键定位成功

- **WHEN** 请求 `providerId: workbuddy` + `expertId: writer`
- **THEN** 返回该专家的详情，含 `providerId`、`displayName`、`source`、技能清单与该 provider 的 `displayName`
- **THEN** 详情中的技能清单条目数不超过该 provider 的技能上限

#### Scenario: 未注册 provider 的详情请求被拦下

- **WHEN** 请求 `providerId: ghost` 的专家详情，该 id 未注册
- **THEN** 返回 `BAZAAR_PROVIDER_UNKNOWN`
- **THEN** 不产生任何出网请求
#### Scenario: 专家 id 不存在被拦下

- **WHEN** 请求 `providerId: workbuddy` + `expertId: not-a-real-expert`
- **THEN** 返回 `BAZAAR_EXPERT_NOT_FOUND`
- **THEN** 不返回空对象，也不返回其它 provider 下的同名条目

#### Scenario: 同一专家经面板与命令定位结果一致

- **WHEN** 在面板点开 `workbuddy`/`writer`，随后用 `/bazaar workbuddy expert writer` 查询同一专家
- **THEN** 两处返回的专家详情字段值一致（展示名、来源、技能清单）

### Requirement: 选择专家必须携带 providerId 并按库分区落盘

选择专家 SHALL 要求请求携带 `providerId`，缺失时 MUST 返回 `BAZAAR_PROVIDER_REQUIRED`。

选择成功后 MUST 只写入该 `providerId` 对应的分区（`experts.<providerId>` 与 `skills.<providerId>.expertNames`），MUST NOT 改动其他 provider 的条目。同一 provider 重复选择同一条目 MUST 幂等（状态不变但 `revision` 可递增），切换同 provider 内不同条目 MUST 覆盖该分区。

选择失败（如人格注入失败）MUST 回滚到选择前的状态并返回错误；该 provider 分区回到原值，其他 provider 分区不受影响。

#### Scenario: 缺 providerId 的选择被拦下

- **WHEN** 提交 `POST /dsh-bazaar/select` 且请求体只有 `expertId`、没有 `providerId`
- **THEN** 返回 `BAZAAR_PROVIDER_REQUIRED`
- **THEN** 会话状态文件未被写入，`revision` 未变化

#### Scenario: 选择只写自己分区

- **WHEN** 会话原状态为 `experts: { workbuddy: {...} }`，用户选择 `demo` 的某专家
- **THEN** 写入后 `experts.demo` 为该专家引用，`experts.workbuddy` 保持原值不变
- **THEN** `skills.demo.expertNames` 为该专家的技能清单，`skills.workbuddy.expertNames` 保持不变

#### Scenario: 同库重复选择幂等

- **WHEN** 对 `workbuddy` 的同一专家连续选择两次
- **THEN** 两次均成功，`experts.workbuddy` 的内容与第一次选择后相同
- **THEN** 会话状态中不出现重复条目

#### Scenario: 选择失败回滚

- **WHEN** `demo` 的专家选择在人格注入阶段失败
- **THEN** 返回注入失败错误，`experts.demo` 与 `skills.demo` 回到选择前的值
- **THEN** `experts.workbuddy` 与其他 provider 分区不变

#### Scenario: 四种选择入口判定一致

- **WHEN** 分别经面板点选、`bazaar_helper` 专家动作、`/bazaar` 命令、直接提交选择路由去选同一个 `workbuddy` 专家
- **THEN** 四条路径产生的 `experts.workbuddy` 内容一致
- **THEN** 四条路径在缺 `providerId` 时均返回 `BAZAAR_PROVIDER_REQUIRED`

### Requirement: 未选择任何专家库时显示空态并给出入口

会话 `activeProviders` 为空时，面板 MUST 显示「尚未选择专家库」空态文案与选择入口（打开 provider 开关区域）。空态 MUST NOT 呈现为错误态，MUST NOT 自动点亮任何 provider。

#### Scenario: 空活跃集显示空态

- **WHEN** 打开某新会话的辅助面板，该会话 `activeProviders` 为空
- **THEN** 面板显示「尚未选择专家库」文案与「选择专家库」入口
- **THEN** 不显示任何 provider 分区，也不显示错误提示

#### Scenario: 从空态进入选择后恢复

- **WHEN** 在空态下点击入口并勾选 `workbuddy`
- **THEN** 面板切换为 `workbuddy` 分区并显示其专家列表
- **THEN** 空态文案消失，会话状态 `activeProviders` 含 `workbuddy`

#### Scenario: 清空活跃集回到空态

- **WHEN** 会话原有 `workbuddy` 活跃，用户取消其开关
- **THEN** 面板回到「尚未选择专家库」空态
- **THEN** `experts.workbuddy` 的历史选择在会话状态中保留（不因取消开关被删除），重新点亮后可恢复显示

#### Scenario: 空态与工具引导错误语义一致

- **WHEN** 空活跃集下面板显示空态，同时调用 `bazaar_helper` 专家动作且未传 `provider`
- **THEN** 面板文案与工具错误信息指向同一引导（选择专家库）
- **THEN** 工具不返回任何 provider 的数据

### Requirement: 单个 provider 故障隔离

某 provider 的专家数据源失败时，系统 MUST 在该 provider 的分区显示错误态与该分区内的重试入口，MUST NOT 使整个面板进入错误态，MUST NOT 隐藏该分区，MUST NOT 让其他 provider 分区受影响。

重试 MUST 只重新请求失败的那个 provider。

#### Scenario: 单库失败只红该分区

- **WHEN** `workbuddy` 与 `demo` 同时活跃，`demo` 的专家列表请求超时
- **THEN** `demo` 分区显示错误态文案与该分区内的重试按钮
- **THEN** `workbuddy` 分区正常显示条目，面板整体无错误提示

#### Scenario: 重试只重发失败库

- **WHEN** 在 `demo` 分区点击重试
- **THEN** 只对 `demo` 发起一次新的列表请求
- **THEN** `workbuddy` 分区不重新请求，其已有条目保持不变

#### Scenario: 全部分区失败仍可逐个重试

- **WHEN** `workbuddy` 与 `demo` 的列表请求同时失败
- **THEN** 两个分区各自显示错误态与各自的重试按钮
- **THEN** 重试其中一个成功后，该分区恢复正常，另一分区仍保持自身错误态

#### Scenario: 失败态不静默隐藏

- **WHEN** `demo` 连续三次列表请求失败
- **THEN** `demo` 分区始终可见，错误态文案含最后一次失败原因
- **THEN** 该分区不被移除、不被替换为空白、不被折叠

### Requirement: 跨库同名专家以 provider 限定前缀区分

当多个 provider 返回同名专家（`displayName` 相同）时，面板 MUST 在这些条目上显示 provider 限定前缀，形如 `<providerDisplayName> · <专家展示名>`。只有一个 provider 返回该名字时 MUST NOT 添加前缀。

限定前缀 MUST NOT 改变专家的真实 `id` 与 `providerId`，选择动作仍以双键提交。

#### Scenario: 同名专家带限定前缀

- **WHEN** `workbuddy` 与 `demo` 各自返回一个 `displayName` 为「写作助手」的专家
- **THEN** 两个条目分别显示为 `WorkBuddy · 写作助手` 与 `示例专家库 · 写作助手`
- **THEN** 两条目的 `id` 与 `providerId` 保持原值

#### Scenario: 唯一名字不加前缀

- **WHEN** `workbuddy` 返回「写作助手」，`demo` 未返回同名条目
- **THEN** 该条目只显示「写作助手」，不带 provider 前缀
- **THEN** 该条目的选择请求仍携带 `providerId: workbuddy`

#### Scenario: 前缀不参与定位

- **WHEN** 用户点击显示为 `示例专家库 · 写作助手` 的条目
- **THEN** 选择请求提交的 `providerId` 为 `demo`、`expertId` 为该专家真实 id
- **THEN** 会话状态写入 `experts.demo`，不写入含前缀字符串的伪 id

#### Scenario: 面板与详情页前缀一致

- **WHEN** 同名专家在面板显示前缀，随后打开其详情
- **THEN** 详情页显示的 provider 名称与面板前缀一致
- **THEN** 详情页的专家展示名不带前缀（前缀只在并列场景用于消歧）

### Requirement: 专家列表与选择的界面状态语义

面板 MUST 为以下状态提供可区分的呈现，且每处 MUST 有可见文字或徽标（不得只靠颜色）：条目加载中、条目为空、请求出错、开关未勾选（禁用，含原因「未选择该专家库」）、专家已选（只读标记：当前会话正在使用该专家）。

已选专家在重新选择前 MUST 保持可点击；正在应用的专家 MUST 标注「应用中」并暂时禁用重复点击。

provider 开关组 MUST 视为可选项：全不勾选 MUST 是合法空态（见「未选择任何专家库时显示空态并给出入口」），MUST NOT 标注为必填，也 MUST NOT 因未勾选而阻止搜索、分类筛选等其它操作。

#### Scenario: 加载中状态可见

- **WHEN** `workbuddy` 分区正在拉取列表
- **THEN** 该分区显示「加载中」文字或徽标
- **THEN** 该分区的条目区不显示空态文案

#### Scenario: 未勾选开关的禁用语义

- **WHEN** 某 provider 的开关未勾选
- **THEN** 该 provider 分区不渲染条目，并显示「未选择该专家库」的禁用说明
- **THEN** 该说明以文字呈现，不只用灰色表达

#### Scenario: 客户端绕过禁用态直接选择被拒绝

- **WHEN** `demo` 未在活跃集内，客户端绕过面板直接提交选择 `providerId: demo`
- **THEN** 服务端返回明确错误（未激活/未注册类错误码）
- **THEN** 会话状态中 `experts.demo` 未被写入

#### Scenario: 已选与应用中状态区分

- **WHEN** 用户对 `workbuddy` 选中专家后再次点击另一个专家
- **THEN** 原已选专家条目标注「当前使用」，新专家条目在应用期间标注「应用中」并禁用重复点击
- **THEN** 应用完成后新专家标注「当前使用」，旧条目标注解除

### Requirement: 选专家到模型可见的完整链路

从面板选择专家到该专家在模型侧生效 MUST 构成一条可逐字段验证的链路：面板选择 → 会话状态落盘 → 系统提示注入 → 模型可见的技能范围。任一环节失败 MUST NOT 让后续环节呈现成功。

#### Scenario: 选择经四跳在模型侧生效

- **WHEN** 会话活跃集为 `['workbuddy','demo']`，用户在 `demo` 分区选择专家 `writer`
- **THEN** `<DSH_HOME>/bazaar/sessions/<sha256(sessionId)>.json` 中 `activeProviders` 为 `['workbuddy','demo']`、`experts.demo` 含 `id: 'writer'` 与 `displayName`、`skills.demo` 含 `globalMode`/`globalNames`/`expertNames` 三个字段，且 `revision` 大于写入前
- **THEN** 该会话的系统提示中含 `demo` 专家的内容区块，区块内为该专家的提示文本
- **THEN** 该会话的系统提示中不含 `workbuddy` 的专家内容区块（该分区未选择专家）
- **THEN** 模型工具列举的技能范围含 `skills.demo.expertNames` 中的全部技能名

#### Scenario: 注入失败时链路不呈现成功

- **WHEN** 会话状态写入成功但人格注入失败
- **THEN** 面板显示注入失败错误与重试入口，条目不标注「当前使用」
- **THEN** 系统提示中不含该专家的内容区块，会话状态回滚到写入前的值

#### Scenario: 已有其他库选择时不被覆盖

- **WHEN** 会话已选 `workbuddy` 专家，再选择 `demo` 专家
- **THEN** 写入后两个分区同时存在
- **THEN** 系统提示中同时含两个专家的内容区块，各自按所属 provider 分组

## Purpose

定义连接器市场的对外行为，并划定 1.0.0 的能力边界：只做列表、筛选、详情、OAuth 授权、复制配置片段，不写宿主配置、不触发重载。连接器工具在会话内按 provider 是否活跃分组计算停用集合，并在会话级合并为一次限制；未被激活 provider 的连接器工具在该会话内不可被模型调用，已激活 provider 的工具全部可用。界面须显式呈现四类连接状态与禁用原因。

## ADDED Requirements

### Requirement: 连接器列表按 provider 分组并支持筛选

连接器列表 MUST 以 `providerId` 为分组维度返回，每条 MUST 含 `providerId`、连接器标识、`displayName`、`transport` 与当前连接状态。

筛选 MUST 支持按连接状态与关键词两种条件，两者 MUST 可同时生效；筛选 MUST 在单个 provider 分区内独立生效。

未声明 `connectorMarket` 的 provider MUST NOT 出现在连接器列表结果中，对该 provider 的连接器调用 MUST 返回 `BAZAAR_CAPABILITY_UNDECLARED`。

#### Scenario: 分组返回连接器列表

- **WHEN** 会话活跃集为 `['workbuddy','demo']` 且两者均声明 `connectorMarket`，请求连接器列表
- **THEN** 返回两个分区，每区条目含 `providerId`、连接器标识、`displayName`、`transport`、状态
- **THEN** 每条的 `providerId` 与所属分区一致

#### Scenario: 状态与关键词同时筛选

- **WHEN** 在 `workbuddy` 分区提交状态「已授权」与关键词「搜索」
- **THEN** 返回条目同时命中状态与关键词
- **THEN** 其他 provider 分区不受该筛选影响

#### Scenario: 未声明域被拦下

- **WHEN** `demo` 只声明 `expertMarket`，调用方请求其连接器列表
- **THEN** 返回 `BAZAAR_CAPABILITY_UNDECLARED`，错误信息含 `demo` 与 `connectorMarket`
- **THEN** 结果中不出现 `demo` 的空分区

#### Scenario: 三入口筛选结果一致

- **WHEN** 分别经面板筛选、`bazaar_helper` 连接器动作、HTTP 连接器路由提交同一组「状态 + 关键词」条件
- **THEN** 三处返回的连接器标识集合一致
- **THEN** 三处对未声明域的 provider 返回同一错误码

### Requirement: 连接器详情按 provider 定位

连接器详情 MUST 通过 `providerId` + 连接器标识双键定位。缺失 `providerId` MUST 返回 `BAZAAR_PROVIDER_REQUIRED`；`providerId` 未注册 MUST 返回 `BAZAAR_PROVIDER_UNKNOWN`。写路由（`connectors/session`、`connectors/action`）的请求体 MUST 携带与路径段完全一致的 `providerId`，不一致 MUST 返回 `BAZAAR_PROVIDER_ID_MISMATCH` 且两个 provider 都不写入。

详情 MUST 含传输方式、所需参数（不隐藏必填项）、当前授权状态与可用工具数量；MUST NOT 含任何明文密钥或 token 值。查不到连接器 `id` 时 MUST 返回 `BAZAAR_CONNECTOR_NOT_FOUND`；未支持的动作 MUST 返回 `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED` 并列出该 provider 支持的动作集合。

#### Scenario: 缺 providerId 的详情被拦下

- **WHEN** 请求某连接器详情但未提供 `providerId`
- **THEN** 返回 `BAZAAR_PROVIDER_REQUIRED`
- **THEN** 不返回任何连接器详情

#### Scenario: 路径与请求体 providerId 不一致被拦下

- **WHEN** 请求 `POST /dsh-bazaar/providers/workbuddy/connectors/session`，请求体中的 `providerId` 为 `demo`
- **THEN** 返回 `BAZAAR_PROVIDER_ID_MISMATCH`，错误信息同时指出路径值与请求体值
- **THEN** 两个 provider 的连接器会话状态都不发生任何写入（不以任一方为准继续执行）

#### Scenario: 路径与请求体 providerId 一致被放行

- **WHEN** 请求 `POST /dsh-bazaar/providers/workbuddy/connectors/session`，请求体中的 `providerId` 同为 `workbuddy`
- **THEN** 该请求按正常路径处理，写入 `workbuddy` 自己的连接器会话状态

#### Scenario: 详情不含明文密钥

- **WHEN** 查询某个需要 token 的连接器详情
- **THEN** 返回体中的凭据相关字段只呈现「已配置 / 未配置」或脱敏占位
- **THEN** 返回体任何字段都不含可用的完整 token 值

#### Scenario: 未注册 provider 的详情被拦下

- **WHEN** 请求 `providerId: ghost` 的连接器详情
- **THEN** 返回 `BAZAAR_PROVIDER_UNKNOWN`
- **THEN** 不产生任何出网请求

#### Scenario: 详情在面板与工具上字段一致

- **WHEN** 在面板打开某连接器详情，再用 `bazaar_helper` 查询同一连接器
- **THEN** 两处返回的传输方式、必填参数集合、授权状态一致
#### Scenario: 连接器 id 不存在被拦下

- **WHEN** 请求 `providerId: workbuddy` + 一个不存在的连接器 `id` 的详情
- **THEN** 返回 `BAZAAR_CONNECTOR_NOT_FOUND`
- **THEN** 不返回空对象，也不回退到该库的其它连接器

### Requirement: OAuth 授权可发起、可轮询、可取消

授权动作 MUST 支持 `authorize`、`poll`、`cancel` 三个动作。同一连接器的授权操作 MUST 单飞：已有进行中的操作时，新的授权请求 MUST NOT 启动第二条授权链路。

轮询成功 MUST 立即持久化授权结果（写在该 provider 自己的凭据目录），MUST NOT 只在内存中标记成功。取消 MUST 使该操作进入「已取消」终态，MUST NOT 留下「进行中」的僵尸操作。

#### Scenario: 授权成功后立即持久化

- **WHEN** 用户在 `workbuddy` 分区对一个连接器发起授权并完成上游同意，随后轮询返回成功
- **THEN** 授权结果被写入 `<DSH_HOME>/bazaar/providers/workbuddy/` 下的记录
- **THEN** 该连接器状态变为「已授权」，重启插件后仍为「已授权」

#### Scenario: 重复发起被单飞拦下

- **WHEN** 某连接器的授权操作正在进行中，用户再次点击授权
- **THEN** 不启动第二条链路，返回或复用同一条进行中的操作标识
- **THEN** 上游只收到一次授权初始化请求

#### Scenario: 取消进入终态

- **WHEN** 用户在授权进行中点击取消
- **THEN** 该操作状态变为「已取消」，不再出现在「进行中」列表
- **THEN** 后续轮询不再返回「进行中」

#### Scenario: 授权动作在面板与工具上语义一致

- **WHEN** 分别经面板授权按钮与 `bazaar_helper` 的连接器授权动作对同一连接器发起授权
- **THEN** 两条路径产生的操作状态流转一致（进行中 → 已授权 / 已取消 / 失败）
- **THEN** 两条路径的授权结果落在同一份持久化记录中

#### Scenario: 未支持的动作被拦下

- **WHEN** 对某 provider 的连接器请求 `connect`、`repair`、`unbind`、`enable` 或 `disable` 这类本版未提供、且该 provider 的 `connectorAction` 也未支持的动作
- **THEN** 返回 `BAZAAR_CONNECTOR_ACTION_UNSUPPORTED`，错误信息列出该 provider 支持的动作集合并说明每个动作的用途（`list` 列举 / `state` 读已存授权状态 / `authorize` 发起 / `poll` 推进进行中授权 / `cancel` 取消进行中 / `copy-config` 产出配置片段 / `remove` 清除已存授权记录）
- **THEN** 不写入任何授权或配置状态，也不静默降级成读动作返回成功

### Requirement: 复制配置片段只产出文本，不写宿主配置

连接器市场 MUST 提供 `copy-config` 动作，产出一段可粘贴的配置文本（含传输方式与连接参数）。该动作 MUST NOT 修改宿主配置文件、MUST NOT 触发重载、MUST NOT 写入任何 profile 补丁层。`remove` 只删本 provider 的授权记录，同样 MUST NOT 触碰宿主配置。

写入宿主配置并重载的能力不在本版范围内：对该类请求 MUST 以「留待后续版本」的明确错误拒绝，MUST NOT 静默降级为写半份配置。

#### Scenario: 复制片段只返回文本

- **WHEN** 用户对某连接器点击「复制配置片段」
- **THEN** 返回一段配置文本，含传输方式与连接参数
- **THEN** 宿主配置文件内容与修改时间均未变化

#### Scenario: 写配置请求被明确拒绝

- **WHEN** 调用方请求把某连接器写入宿主配置并重载
- **THEN** 返回明确错误，说明该能力留待后续版本
- **THEN** 不产生部分写入，宿主配置文件未被改动

#### Scenario: 只读查看被放行

- **WHEN** 用户查看连接器详情并复制片段
- **THEN** 两个动作均成功
- **THEN** 不产生任何文件写入（除剪贴板外无副作用）

#### Scenario: 复制片段在面板与工具上内容一致

- **WHEN** 分别经面板复制按钮与 `bazaar_helper` 的 `copy-config` 动作取同一连接器的片段
- **THEN** 两处文本内容一致
- **THEN** 两处均未改动宿主配置

### Requirement: 会话级工具门控按 providerId 分组 deny 并合并

连接器工具在会话内的可用性 MUST 由「该 provider 在本会话是否活跃」决定。停用集合 MUST 按 `providerId` 分组计算，并在会话级合并为一次工具限制动作。

未活跃 provider 的连接器工具在该会话内 MUST 不可被模型调用；已活跃 provider 的全部连接器工具 MUST 可用；无活跃 provider 时 MUST 不产生任何停用项。

门控计算 MUST 在会话创建、每步执行前、会话销毁、工具集合变更四个时点生效；门控失败 MUST NOT 中断该步执行。

#### Scenario: 未活跃 provider 的工具被停用

- **WHEN** 会话活跃集为 `['workbuddy']`，`demo` 已注册但未激活，模型尝试调用 `demo` 的连接器工具
- **THEN** 该工具不可用（被停用集合覆盖）
- **THEN** `workbuddy` 的连接器工具仍可正常调用

#### Scenario: 多库活跃时两组工具均可用

- **WHEN** 会话活跃集为 `['workbuddy','demo']`，两个 provider 各有连接器工具
- **THEN** 两组的连接器工具均可被模型调用
- **THEN** 停用集合为空

#### Scenario: 无活跃 provider 时不产生停用项

- **WHEN** 会话活跃集为空
- **THEN** 门控不产生任何停用项（不因「无活跃 provider」而停用全部工具）
- **THEN** 非连接器类工具不受影响

#### Scenario: 活跃集变更后门控即时生效

- **WHEN** 会话活跃集从 `['workbuddy']` 变为 `['workbuddy','demo']`
- **THEN** `demo` 的连接器工具在下一次模型调用前变为可用
- **THEN** 反向操作（取消 `demo`）后其工具在下一次调用前变为不可用

#### Scenario: 门控失败不中断该步

- **WHEN** 门控计算过程中抛出异常
- **THEN** 当前这一步继续执行，不因门控失败而失败
- **THEN** 记录该次门控失败原因，下次时点重新计算

### Requirement: 连接器界面状态语义

连接器区 MUST 用可见文字或徽标区分以下状态：未授权（含「需授权」文案）、授权中（禁用重复点击）、已授权（只读展示，不可编辑凭据）、授权失败（含原因与重试入口）、无可用工具（含原因）、未激活 provider 的工具（禁用，原因「该专家库未启用」）。

「清除授权」MUST 视为危险操作，执行前 MUST 二次确认，确认文案 MUST 说明影响范围。

该动作 MUST 有对应服务端动作：`connectorAction` 的 `remove` 移除已存授权记录。MUST NOT 只清界面态，MUST NOT 复用 `cancel`——`cancel` 只把进行中的授权推进到取消终态，对已存记录无作用。移除后该连接器的工具 MUST 变为不可用，且 MUST 不留下半份记录。

#### Scenario: 未授权与授权中可区分

- **WHEN** 某连接器处于未授权状态，用户点击授权后进入授权过程
- **THEN** 未授权时显示「需授权」与授权按钮
- **THEN** 授权过程中显示「授权中」且授权按钮禁用，重复点击不产生第二个请求

#### Scenario: 已授权状态为只读

- **WHEN** 某连接器已授权
- **THEN** 凭据相关字段以只读形式呈现，不提供编辑入口
- **THEN** 仅提供重新授权与清除授权两个动作

#### Scenario: 未激活 provider 的连接器禁用并说明原因

- **WHEN** `demo` 未在会话活跃集内
- **THEN** 其连接器条目的操作按钮处于禁用态，并显示「该专家库未启用」文字说明
- **THEN** 该说明不只以灰色表达

#### Scenario: 清除授权需二次确认

- **WHEN** 用户点击「清除授权」
- **THEN** 弹出确认，文案说明将移除该连接器的授权记录并使其工具不可用
- **THEN** 未确认时不执行清除，确认后才以 `remove` 移除记录
- **THEN** 移除后再次列举该连接器时状态为未授权，其工具在会话内不可用

#### Scenario: 清除授权不写宿主配置

- **WHEN** 调用方请求对某连接器执行 `remove`
- **THEN** 只删除该 provider 自己 `connectors.json` 中的授权记录
- **THEN** 宿主配置文件与修改时间均未变化

#### Scenario: 客户端绕过禁用态直接调用工具被拦下

- **WHEN** `demo` 未激活，客户端绕过界面直接调用其连接器工具
- **THEN** 该调用被门控拦下（工具不可用）
- **THEN** 不产生该连接器的实际出网调用

### Requirement: 从授权到工具可用的完整链路

从发起授权到连接器工具在会话内可被模型调用 MUST 构成一条可逐字段验证的链路：授权发起 → 上游同意 → 轮询成功并持久化 → 会话门控重算 → 工具可见。任一环节失败 MUST NOT 让工具呈现为可用。

#### Scenario: 授权经五跳到达工具可用

- **WHEN** 会话活跃集为 `['workbuddy']`，用户对 `workbuddy` 的某连接器发起授权并完成上游同意
- **THEN** 轮询返回成功，`<DSH_HOME>/bazaar/providers/workbuddy/` 下的记录含该连接器的授权状态与到期时间
- **THEN** 面板该连接器状态变为「已授权」，可用工具数量大于 0
- **THEN** 会话门控重算后停用集合不含该连接器的工具
- **THEN** 模型可调用该连接器的工具，`bazaar_helper` 的连接器状态动作返回该工具为可用

#### Scenario: 授权成功但门控未重算时不呈现可用

- **WHEN** 授权已持久化成功，但会话门控尚未重算
- **THEN** 面板显示该连接器为已授权
- **THEN** 该连接器工具在下一次门控重算前仍不可被模型调用（不呈现为可用）

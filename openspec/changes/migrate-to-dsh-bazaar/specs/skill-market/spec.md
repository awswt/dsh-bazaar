## Purpose

定义技能市场与记忆市场的对外行为：技能条目按 provider 分组返回并标注来源（技能市场 / 记忆市场），安装动作把技能包真实落到 `<projectRoot>/.dsh/skills/<slug>/` 并在元数据中记录 `providerId`，跨库同名安装被拒绝并指出已有来源，跨库之间不得互相改写已安装内容。记忆市场在宿主未安装对应记忆插件时给出显式不可用原因，不伪造记忆条目。

## ADDED Requirements

### Requirement: 技能市场按 provider 分组并标注来源

技能列表 MUST 以 `providerId` 为分组维度返回，每条条目 MUST 含 `providerId` 与 `source`（取值为 `skillMarket` 或 `memoryMarket`）。

同一个 provider 内 MUST 能同时返回两种来源的条目，且两种来源 MUST 各自可区分。同一个 provider 未声明 `memoryMarket` 时 MUST 只返回 `skillMarket` 条目，MUST NOT 用空数组冒充记忆市场已声明。

#### Scenario: 双来源并列返回

- **WHEN** `workbuddy` 同时声明 `skillMarket` 与 `memoryMarket`，请求其技能列表
- **THEN** 返回条目中含 `source: 'skillMarket'` 与 `source: 'memoryMarket'` 两类
- **THEN** 每条条目的 `providerId` 均为 `workbuddy`

#### Scenario: 未声明记忆市场不伪造

- **WHEN** `demo` 只声明 `skillMarket`，请求其技能列表
- **THEN** 返回条目全部 `source: 'skillMarket'`
- **THEN** 不返回 `source: 'memoryMarket'` 的空组，也不在为该 provider 渲染界面时出现记忆市场区块

#### Scenario: 调用未声明域被拦下

- **WHEN** 对只声明 `skillMarket` 的 `demo` 请求记忆市场条目
- **THEN** 返回 `BAZAAR_CAPABILITY_UNDECLARED`，错误信息含 `demo` 与 `memoryMarket`
- **THEN** 不返回任何记忆条目

#### Scenario: 三入口来源标注一致

- **WHEN** 分别经面板渲染、`bazaar_helper` 技能动作、HTTP 技能市场路由获取同一 provider 的技能列表
- **THEN** 三处返回的条目 id 集合与每条的 `source` 取值一致

### Requirement: 技能安装必须真实落位并记录归属

安装动作 MUST 把技能包解到 `<projectRoot>/.dsh/skills/<slug>/`，其中 `projectRoot` 为自工作区向上找到的最近含 `.git` 的祖先目录。安装成功后 MUST 在该技能的元数据中记录 `providerId`。

`slug` 的推导 MUST 与源仓 `lib/skill-install.js:27-34` 的 `skillSlug()` 逐步一致，MUST NOT 换成「把原始名清洗成 slug」的另一种算法——slug 同时是跨库冲突的判定键与落位路径的最后一段，算法一变，同一技能升级后会被当成两个。三步细则与错误码见下方场景。

落盘路径与元数据写入 MUST 在同一处完成，MUST NOT 出现「文件已落地但元数据未写」或反之的中间态。

安装成功后返回 MUST 含 `providerId`、`slug` 与 `installedPath`。

#### Scenario: 安装落到项目技能目录

- **WHEN** 在 `projectRoot` 为 `/repo` 的工作区安装 `workbuddy` 的技能 `doc-writer`
- **THEN** 文件落于 `/repo/.dsh/skills/doc-writer/SKILL.md`
- **THEN** 该技能元数据中 `providerId` 为 `workbuddy`，返回体 `installedPath` 指向该目录

#### Scenario: 非法名称被规整后落盘

- **WHEN** 按 `skillSlug()` 推导落盘名，规则 MUST 与源仓 `lib/skill-install.js:27-34` 逐步一致：① `const candidate = typeof skill?.name === 'string' ? skill.name.trim() : ''`——`name` 非字符串或 trim 后为空时**不报错**，直接进入 ②；② `candidate !== ''` 且匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` 时直接用它；③ 否则退回 `skill_id`（缺失时用 `id`），把 `[A-Za-z0-9._-]` 以外的字符替换为 `-`、去掉首尾连字符，再按 `slice(0, 64)` 截断；清洗结果为空串时抛 `skill has no usable name or id`，外层映射为 `BAZAAR_SKILL_SLUG_INVALID`
- **WHEN** 安装一个 `name` 为 `Doc Writer!`（不合白名单）、`skill_id` 为 `skill_2095070772061040640` 的技能
- **THEN** 因 `name` 不合格而退回 `skill_id`，落盘目录名为 `skill_2095070772061040640`（不是 `Doc-Writer`）
- **THEN** 返回体的 `slug` 为该值；该技能后续升级按同一 slug 覆盖同一目录，MUST NOT 产生第二份
#### Scenario: 规整后仍非法被拒绝

- **WHEN** 安装一个原始名称为 `!!!` 或 `   ` 的技能（规整后为空串）
- **THEN** 安装被拒绝，返回 `BAZAAR_SKILL_SLUG_INVALID`，错误信息同时给出原始名称与规整结果
- **THEN** `<projectRoot>/.dsh/skills/` 下不新增任何目录，元数据不写入

#### Scenario: 技能包体积超限被拒绝

- **WHEN** 安装的技能包声明体积或实际字节数超过该 provider 的 `maxPackageBytes`（默认 32 MiB），或解压后总量超过 `maxTotalBytes`（默认 96 MiB），或条目数超过 `maxEntries`（默认 400）
- **THEN** 安装被拒绝，返回 `BAZAAR_SKILL_PACKAGE_TOO_LARGE`，错误信息指出是体积、总量还是条目数超限以及实际上限值
- **THEN** 不产生部分解压残留：`<projectRoot>/.dsh/skills/<slug>/` 不出现半份目录

#### Scenario: 安装路径越界被拦下

- **WHEN** 安装请求携带的 `skillId` 被用于推导落盘路径时尝试注入 `../` 片段
- **THEN** 安装被拒绝，返回参数非法错误
- **THEN** `projectRoot` 之外不产生任何文件

#### Scenario: 三条安装入口落位一致

- **WHEN** 分别经面板安装按钮、`bazaar_helper` 技能安装动作、`/bazaar` 命令安装同一 `workbuddy` 技能
- **THEN** 三处落盘的目录路径与元数据 `providerId` 一致
- **THEN** 三处的返回体均含 `installedPath`

### Requirement: 跨库同名技能安装必须被拒绝并指出已有来源

当 `<projectRoot>/.dsh/skills/<slug>/` 已存在由**其他** provider 安装的同名技能时，安装 MUST 被拒绝并返回 `BAZAAR_SKILL_NAME_CONFLICT`，错误信息 MUST 指出已有技能的来源 `providerId`。

系统 MUST NOT 自动改名、自动加后缀或自动覆盖他人安装。同一 provider 重复安装同名技能 MUST 幂等覆盖（视为升级），MUST NOT 报冲突。

#### Scenario: 跨库同名被拦下

- **WHEN** `<projectRoot>/.dsh/skills/doc-writer/` 已由 `workbuddy` 安装，用户以 `demo` 安装同名技能
- **THEN** 返回 `BAZAAR_SKILL_NAME_CONFLICT`，错误信息含 `workbuddy`
- **THEN** `/repo/.dsh/skills/doc-writer/` 下的文件内容未被改动

#### Scenario: 同库重装幂等被放行

- **WHEN** `workbuddy` 已安装 `doc-writer`，用户再次以 `workbuddy` 安装同名技能
- **THEN** 安装成功，目录内容被覆盖为新版本
- **THEN** 元数据 `providerId` 仍为 `workbuddy`，不报冲突

#### Scenario: 不同库不同名互不影响

- **WHEN** `workbuddy` 安装 `doc-writer`，`demo` 安装 `code-review`
- **THEN** 两个目录并存，各自元数据记录自己的 `providerId`
- **THEN** 卸载或重装其中一个不影响另一个的文件

#### Scenario: 冲突判定在三条入口上一致

- **WHEN** 分别经面板、模型工具、命令以 `demo` 安装已被 `workbuddy` 占用的 `doc-writer`
- **THEN** 三条路径均返回 `BAZAAR_SKILL_NAME_CONFLICT` 且错误信息含 `workbuddy`
- **THEN** 三条路径均未改动既有文件

### Requirement: 跨库不得互改已安装内容

任一 provider MUST NOT 读写、覆盖、删除由其他 provider 安装的技能目录。技能范围（`globalMode`、`globalNames`、`expertNames`）MUST 按 `providerId` 分区存放，一个 provider 的范围变更 MUST NOT 影响其他 provider 的范围。

#### Scenario: 范围变更只影响自己分区

- **WHEN** 会话中 `skills.workbuddy.globalMode` 为 `all`，用户把 `skills.demo.globalMode` 改为 `selected` 并给出 `globalNames`
- **THEN** `skills.demo` 的 `globalMode` 与 `globalNames` 按提交值写入
- **THEN** `skills.workbuddy` 的 `globalMode` 仍为 `all`，`globalNames` 未变

#### Scenario: 卸载他人技能被拦下

- **WHEN** 以 `demo` 身份请求删除由 `workbuddy` 安装的 `doc-writer`
- **THEN** 请求被拒绝，错误信息指明该目录归属 `workbuddy`
- **THEN** 目录与文件保持不变

#### Scenario: 同名技能在两个库下并存被拒绝而非并存

- **WHEN** `workbuddy` 已安装 `doc-writer`，`demo` 试图安装同名技能
- **THEN** 按冲突规则拒绝（不产生第二份内容、不加后缀）
- **THEN** 系统中始终只有一份 `doc-writer`，其元数据 `providerId` 仍为 `workbuddy`

#### Scenario: 范围写入在两条入口上一致

- **WHEN** 分别经面板技能区与 `bazaar_helper` 的 `set-skills` 动作提交同一组 `providerId: demo` 的范围变更
- **THEN** 两处产生的 `skills.demo` 内容一致
- **THEN** 两处均未改动 `skills.workbuddy`

### Requirement: 记忆市场在宿主缺少记忆插件时显式不可用

记忆市场条目由宿主侧记忆插件提供。当该插件不存在时，系统 MUST 返回显式不可用原因（含插件名与「未安装」语义），MUST NOT 返回空列表冒充「无条目」，MUST NOT 伪造记忆条目。

插件存在时 MUST 按其当前 profile 的安装位置探测，MUST NOT 跨 profile 猜测。

#### Scenario: 插件缺失时给出不可用原因

- **WHEN** `workbuddy` 声明了 `memoryMarket`，但宿主未安装记忆插件，用户请求记忆市场条目
- **THEN** 返回不可用结果，`reason` 含插件名与「未安装」字样
- **THEN** 界面该区块显示不可用说明，不显示「暂无条目」空态
#### Scenario: 不可用以专属错误码表达

- **WHEN** 宿主未安装记忆插件，任一入口请求该 provider 的记忆市场条目
- **THEN** 返回码为 `BAZAAR_MEMORY_UNAVAILABLE`，`message` 含插件名 `dsh-mnemon` 与「未安装」字样
- **THEN** 该码与「空列表」是两种不同结果：调用方据码区分「不可用」与「无条目」

#### Scenario: 插件存在时按当前 profile 探测

- **WHEN** 宿主已安装记忆插件，且当前 profile 下存在其安装目录
- **THEN** 记忆市场返回该插件提供的条目
- **THEN** 探测路径不指向其他 profile 的安装目录

#### Scenario: 未声明记忆市场的 provider 不受影响

- **WHEN** `demo` 未声明 `memoryMarket`，宿主也未安装记忆插件
- **THEN** `demo` 的技能区块正常显示自身条目
- **THEN** 不因记忆插件缺失而对 `demo` 报任何错误

#### Scenario: 不可用原因在面板与工具上一致

- **WHEN** 插件缺失时分别经面板记忆区块与 `bazaar_helper` 技能动作查询记忆市场
- **THEN** 两处给出的不可用原因指向同一个插件名与同一语义
- **THEN** 两处均未返回条目数组

### Requirement: 技能区的界面状态语义

技能区 MUST 用可见文字或徽标区分以下状态：条目加载中、无条目（空态）、来源不可用（含原因）、安装中（禁用重复点击）、安装成功、安装失败（含失败原因与重试入口）、跨库同名冲突（含已有来源 `providerId`）。

安装按钮在「安装中」与「冲突未解决」两种状态下 MUST 处于禁用态，且 MUST 以文字说明禁用原因。

#### Scenario: 安装中禁用重复点击

- **WHEN** 用户点击某技能的安装按钮，安装正在进行
- **THEN** 该按钮进入禁用态并显示「安装中」
- **THEN** 重复点击不产生第二次安装请求

#### Scenario: 冲突态禁用并说明原因

- **WHEN** 某技能因跨库同名而被拒绝安装
- **THEN** 该条目显示冲突文案并指出已有来源 `providerId`
- **THEN** 安装按钮处于禁用态，禁用原因显示为文字（不得只变灰）

#### Scenario: 客户端绕过禁用态直接安装被拒绝

- **WHEN** 某技能条目处于冲突禁用态，客户端绕过界面直接提交 `force: true` 安装
- **THEN** 服务端仍返回 `BAZAAR_SKILL_NAME_CONFLICT`，不因 `force` 而覆盖他人安装
- **THEN** 既有目录内容未被改动

#### Scenario: 空态与不可用态可区分

- **WHEN** 某 provider 的技能市场返回 0 条，而其记忆市场因插件缺失不可用
- **THEN** 技能市场区域显示空态文案
- **THEN** 记忆市场区域显示不可用原因，两处文案不同且各自可辨认

### Requirement: 从安装到模型可见的完整链路

从面板安装到技能在模型侧生效 MUST 构成一条可逐字段验证的链路：安装请求 → 文件落位 → 元数据写入 → 会话技能范围更新 → 模型可见技能清单。任一环节失败 MUST NOT 让后续环节呈现成功。

#### Scenario: 安装经五跳到达模型可见清单

- **WHEN** 会话活跃集为 `['workbuddy','demo']`，用户在 `demo` 区块安装技能 `code-review` 并把它加入 `demo` 的范围
- **THEN** `/repo/.dsh/skills/code-review/SKILL.md` 存在，且该技能元数据 `providerId` 为 `demo`
- **THEN** 会话状态 `skills.demo.globalNames` 或 `skills.demo.expertNames`（取决于 `globalMode`）含 `code-review`，`revision` 大于写入前
- **THEN** 该会话的系统提示中技能范围区块反映 `demo` 的选择
- **THEN** 模型可见的技能清单含 `code-review`，且 `skills.workbuddy` 的任何字段未被改动

#### Scenario: 落位成功但范围写入失败

- **WHEN** 文件落位与元数据写入成功，但会话技能范围写入失败
- **THEN** 面板显示范围写入失败的错误与重试入口
- **THEN** 模型可见清单不含 `code-review`（文件存在不等于已生效）

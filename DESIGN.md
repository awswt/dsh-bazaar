---
version: alpha
name: "dsh-bazaar 集市面板视觉体系"
description: "面向 DSH 用户的多上游集市面板，沿用宿主设计令牌，传达克制、可信、分库可见的界面语言。"
colors:
  primary: "#0F1115"
  secondary: "#61666B"
  tertiary: "#EC1313"
  neutral: "#F9FAFB"
  surface: "#FFFFFF"
  on-surface: "#0F1115"
  error: "#570C0C"
  error-surface: "#FEF2F2"
  success: "#233C2C"
  success-surface: "#E6FAED"
  warning: "#27241F"
  warning-surface: "#FEF5E7"
typography:
  heading-md:
    fontFamily: "system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.35
  heading-sm:
    fontFamily: "system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: "system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  label-sm:
    fontFamily: "system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  badge-xs:
    fontFamily: "system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.6
  mono-sm:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, Courier New, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 5px
  sm: 8px
  md: 10px
  lg: 12px
  full: 999px
spacing:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 12px
  xxl: 16px
  xxxl: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 30px
    padding: 13px
  button-primary-hover:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: 30px
  button-primary-disabled:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 30px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 30px
    padding: 13px
  button-danger:
    backgroundColor: "{colors.error-surface}"
    textColor: "{colors.error}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    height: 30px
    padding: 13px
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 8px
  input-field-invalid:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 8px
  input-field-readonly:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 8px
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 6px
  tab-idle:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 6px
  tab-error:
    backgroundColor: "{colors.error-surface}"
    textColor: "{colors.error}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 6px
  badge-ok:
    backgroundColor: "{colors.success-surface}"
    textColor: "{colors.success}"
    typography: "{typography.badge-xs}"
    rounded: "{rounded.full}"
    padding: 4px
  badge-warn:
    backgroundColor: "{colors.warning-surface}"
    textColor: "{colors.warning}"
    typography: "{typography.badge-xs}"
    rounded: "{rounded.full}"
    padding: 4px
  badge-error:
    backgroundColor: "{colors.error-surface}"
    textColor: "{colors.error}"
    typography: "{typography.badge-xs}"
    rounded: "{rounded.full}"
    padding: 4px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 12px
  card-blocked:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 12px
  empty-state:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 12px
---

## Overview

面板嵌在 DSH 宿主界面里，与宿主共用同一套设计令牌：颜色、圆角、遮罩都以 `--dsw-alias-*` 与 `--dsw-static-neutral-bluish-*` 为准，插件不自造色板。用户在这里完成的是"选库—选专家—装技能—授权账号"这类高频、低风险但要求一眼看清归属的操作，因此信息密度优先于留白，层级靠字号与字重，不靠装饰。气质克制、可信：一屏只允许一个主操作，多库并列时靠分组与限定前缀区分归属，绝不靠颜色深浅暗示重要程度。

## Colors

条目名与 front matter 的 `colors` 键一一对应；每个取值都是宿主令牌的真实解析值（light 主题），dark 主题按宿主同名别名反转，插件侧不另设色值。

- **Primary (#0F1115)**：主文本与主操作底色。对应 light 下 `--dsw-alias-label-primary`（`--dsw-static-neutral-bluish-1000`），dark 下反转为 `neutral-bluish-50` (#F9FAFB)。一个界面只由它承载最重要的那个动作。
- **Secondary (#61666B)**：次要文本、边框、元信息、禁用态文字。对应 `--dsw-alias-label-secondary`（`neutral-bluish-700`），dark 下为 `neutral-bluish-300` (#CFD3D6)。
- **Tertiary (#EC1313)**：唯一强调色，取自 `--dsw-alias-state-error-primary`（light `static-red-600`，dark `red-400` #F25A5A）。它在本项目里不是"品牌强调"，而是**错误与待处理**的唯一承载体，出现即表示那里有事。
- **Neutral (#F9FAFB)**：页面与分组底色。对应 `--dsw-static-neutral-bluish-50`；卡片底色用 `--dsw-alias-bg-layer-1`（light `neutral-bluish-00`，dark `neutral-bluish-875` #232324），两层靠底色区分，不靠阴影。
- **Surface (#FFFFFF)**：卡片、表格、浮层底色。light 为 `--dsw-alias-bg-layer-1/2`，dark 为 `neutral-bluish-850` (#2C2C2E)。
- **On-surface (#0F1115)**：卡片上的正文色，与 Primary 同源。dark 下用 `neutral-bluish-50`。
- **Error (#570C0C on #FEF2F2) / Success (#233C2C on #E6FAED) / Warning (#27241F on #FEF5E7)**：三组状态色，分别对应宿主的 `static-red-*`、`static-green-*`、`static-amber-*` 深浅档。文字的取色不是宿主的 `state-*-primary`（那三档在浅底上只有 2.15–4.50:1，达不到 WCAG AA），而是同一色系的最深档（red-900 / green-900 / amber-900）配同色系最浅底（red-50 / green-100 / amber-100），实测对比度 10.98–14.30:1。`state-*-primary` 仍用于边框、圆点、进度条等**非文字**承载。**状态只作辅助**：任何状态必须同时有文字或图标说明，禁止只靠颜色区分（色觉差异下会完全失效）。

## Typography

字号全部来自源插件实测分布（10/11/12/13/14/16px），不引入新档位。

- **Heading-md (16px / 600)**：面板与分区的标题，承载层级，不用于正文。
- **Heading-sm (14px / 600)**：卡片标题、页签名，与正文形成一档差距即可，不再加大。
- **Body-md (13px / 400)**：正文、表单内容、专家与技能描述。
- **Body-sm (12px / 400)**：辅助说明、脚注、空态与错误文案。
- **Label-sm (12px / 500)**：字段标签、按钮文字、表头。次要关系由颜色（Secondary/Tertiary）与字号共同表达，不靠浅字重。
- **Badge-xs (11px / 600)**：状态徽标与计数，字号最小但字重足够，保证在 11px 下仍可读。
- **Mono-sm (12px)**：providerId、路径、错误码、脱敏凭据等需要逐字符核对的文本。

## Layout

- 设置页内容最大宽度 1120px，超出居中留白；会话面板随宿主宽度自适应，不横向拉伸列表。
- 间距只从 `spacing` 刻度取用（`xs` 4 / `sm` 6 / `md` 8 / `lg` 10 / `xl` 12 / `xxl` 16 / `xxxl` 24），不出现刻度外的值。落地规则：页面级区块之间 `xxxl`，区块内元素之间 `xxl`，分组之间 `xl`，字段行内元素之间 `md`，图标与文字之间 `xs`。源插件实测的 gap 6–10px、padding 10–12px 均已落在刻度上，不额外引入 7px / 9px / 14px 这类中间值。
- 多 provider 并列时，每个 provider 一个卡片分组（`card`），分组之间 `xl`，组内条目之间 `sm`。分组是归属的唯一视觉边界，不靠分割线堆叠层级。
- 设置页按 provider 分页签：页签行在标题下方、内容之上，一行可横向滚动，不折行成两排。
- 正文字号固定 `body-md`（13px）；表格正文可用 `body-sm`（12px），但同一表格内不混用。仅空态标题使用 `heading-sm`（14px）。

## Elevation & Depth

不使用投影表达层级（宿主的 `--dsw-mask-blur` 为 `none`，弹层也不加模糊）。层级由底色与 1px 边框承担：卡片用 `surface` + `--dsw-alias-border-l1`（light `#0000000A`，dark `#FFFFFF0F`），浮层用 `surface` + 同色边框 + `--dsw-alias-bg-mask-1`（light `#0000003D`，dark `#00000080`）遮罩与背景分离。悬挂阴影不用于强调。

## Shapes

圆角统一走 `rounded` 刻度：按钮、输入框 `sm`（8px，即宿主的 `--dsw-radius-sm`），卡片与分组 `lg`（12px），页签、徽标、头像 `full`，代码片段与行内标识 `xs`。同一视图内不混用锐角与圆角；表格单元格保持直角，避免与卡片圆角冲突。

## Components

按钮：主操作 `button-primary`（一屏只出现一个），次要操作 `button-secondary`（描边），删除类用 `button-danger`（红字描边，不走实心红）。悬停/按下/禁用已在令牌中分别定义，视觉差异不得只靠颜色深浅。

| 组件 | 状态 | 视觉承载 | 程序承载 |
|------|------|----------|----------|
| 凭据输入框 | 必填 | 标签右侧文字「必填」；另提供「查看填写说明」入口 | `required` + `aria-required="true"` |
| 凭据输入框 | 可选 | 与必填同一标签样式，不靠灰色或浅字重区分 | 不声明必填属性 |
| 凭据输入框 | 禁用 | 降低强调，旁注写明不可用原因（如「该 provider 未注册，先注册后再填写」） | `disabled` + `aria-disabled="true"` |
| 凭据输入框 | 只读 | 正常对比度、可聚焦、可选中复制、无禁用光标；另有「替换凭据」入口承担写操作 | `readonly` + `aria-readonly="true"` |
| 凭据输入框 | 出错 | 字段下方文案说明错在哪、怎么改（如「令牌已过期，请重新授权」）；红边仅作辅助 | `aria-invalid="true"` + `aria-describedby` 指向该文案 |
| provider 页签 | 当前 | 背景 `tab-active` + 文字 Primary + 底部 2px 指示条 | `aria-selected="true"`，页签容器 `role="tablist"` |
| provider 页签 | 非当前 | 背景 `tab-idle` + 文字 Secondary | `aria-selected="false"` |
| provider 页签 | 出错 | 文字 Error + 与徽标并列的「出错」文字，不整体报错、不影响其它页签 | 页签内 `role="status"` 播报该 provider 的错误摘要 |
| provider 多选开关 | 已激活 | 开关处于开位 + 文案「已启用」 | `role="switch"` + `aria-checked="true"` |
| provider 多选开关 | 未激活 | 开关处于关位 + 文案「未启用」 | `aria-checked="false"` |
| provider 多选开关 | 能力未声明 | 开关禁用 + 旁注「该库未声明记忆市场能力」 | `aria-disabled="true"` + `aria-describedby` 指向旁注 |
| 专家/技能列表 | 空数据 | 文案「这家库没有匹配的条目」+ 主操作入口（清除筛选 / 换库） | `role="status"` |
| 专家/技能列表 | 加载中 | 骨架行或「加载中」文案，与空态外观可区分 | `aria-busy="true"` |
| 专家/技能列表 | 出错 | 该 provider 分区内显示错误文案 + 「重试」；其它 provider 分区不受影响 | `role="alert"` + 可聚焦的重试按钮 |
| 技能条目 | 跨库同名冲突 | 徽标「已被 WorkBuddy 安装」+ 安装按钮禁用并旁注冲突来源 | `aria-disabled="true"` + `aria-describedby` 指向来源说明 |
| 移除凭据 / 退出登录 / 清除授权 | 点击前 | `button-danger` 描边，按钮文案写明对象（如「移除 WorkBuddy 凭据」） | 可键盘聚焦 |
| 移除凭据 / 退出登录 | 确认 | 二次确认说明影响范围与可撤销性（「移除后本机不再保存该凭据，需重新授权；数据缓存保留」） | 确认浮层可聚焦、`Esc` 可取消，确认按钮文案写具体动作 |

## Do's and Don'ts

- Do 用 `--dsw-alias-*` / `--dsw-static-neutral-bluish-*` 与本文档登记的字号、圆角、间距取值，界面里不出现未登记的颜色与间距
- Do 让每个状态都有文字或图标说明，颜色只作辅助
- Do 让必填、可选、禁用、只读在视觉上互相可区分，且与程序属性一致
- Do 多库并列时用分组卡片 + 显式 provider 前缀区分归属，故障只红自己那一块
- Don't 把必填字段做成灰色文字或空心方块，那会被读成「可选、未勾选」
- Don't 只用颜色区分状态（红=错、绿=成功），灰度或色觉差异下会完全失效
- Don't 用禁用冒充只读，或用只读冒充禁用
- Don't 让空数据与加载中共用同一外观
- Don't 让错误提示只变红而不说明错在哪、怎么改
- Don't 自造品牌强调色或投影来表达层级，宿主的令牌体系里没有这两样

---
name: 果小哨
description: 白底托盘、六级字号、主绿操作与黑金通行证——用布局传达信息
colors:
  background: "#FFFFFF"
  surface: "#F5F5F3"
  surface-top: "#FFFFFF"
  elevated: "#FFFFFF"
  pressed: "#E8E8E5"
  text: "#111412"
  text-secondary: "#545956"
  text-muted: "#626764"
  line: "rgba(17, 20, 18, 0.08)"
  primary: "#00C375"
  primary-ink: "#073C2C"
  accent-text: "#006B3F"
  warning: "#895806"
  warning-surface: "#FBF1DC"
  danger: "#A83E3E"
  danger-surface: "#FBECEC"
  pass: "#151816"
  pass-gold: "#E9CE9A"
  dark-background: "#0B0D0C"
  dark-surface: "#171A18"
  dark-surface-top: "#252927"
  dark-elevated: "#1F2320"
  dark-text: "#EEF2EF"
  dark-text-secondary: "#B7C0BB"
  dark-text-muted: "#9BA59F"
  dark-accent-text: "#5CE0A8"
typography:
  fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Helvetica, sans-serif'
  display: "28px / 600"
  title: "22px / 600"
  headline: "17px / 600"
  body: "15px / 400"
  sub: "13px / 400"
  caption: "12px / 400"
  weights: "400 | 600"
  lineHeights: "1.25 | 1.4 | 1.5"
rounded:
  tray: "16px"
  control: "12px"
  tile: "10px"
  pill: "999px"
spacing: "2 4 8 12 16 20 24 32 40 px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
  tray:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.tray}"
  pass:
    backgroundColor: "{colors.pass}"
    accent: "{colors.pass-gold}"
---

# 果小哨设计基准

> **令牌与规则以源码为准。** 颜色、字号、间距定义在 [`miniprogram/app.wxss`](miniprogram/app.wxss)；公共组件在 [`miniprogram/styles/common.wxss`](miniprogram/styles/common.wxss)；可执行约束在 [`tests/design-system.test.mjs`](tests/design-system.test.mjs)。改令牌必须同步改本文件与测试。本文件约束后续界面维护（含其他模型），不授权生产部署。

## Overview

**Creative North Star:「让布局本身来传达信息」**

果小哨是微信里的工作台：查门店取货、留意补货、记住到期。界面追求**高级、简洁、有哨标气质**——不是靠装饰，而是靠统一的字号阶梯、克制的绿色、干净的托盘，以及会员页那一张黑金通行证。

保留：主绿 `#00C375`、系统中文字体、四个原生 tab、精确 SKU、直接关注路径、影响购买/退款/授权/库存判断的事实。
拒绝：网页式通栏横线、卡片套卡片、页内自造字号、冗长规则段落、绿字大标题、字符充当图标。

本规范于 2026-11-21 按当前消费端源码重写，与 V3.7.2 界面重构一并生效。历史 shadcn 参照仅说明「层级与语义色」的思想来源，**不得**把 React / Tailwind / OKLCH / Noto Sans / Lucide 带进小程序。

## 硬规则（改界面前先读）

这些规则由 `tests/design-system.test.mjs` 机械执行。违反即失败，不要为了「好看一点」绕过。

1. **字号只有六级**：`--fs-display` 28 · `--fs-title` 22 · `--fs-headline` 17 · `--fs-body` 15 · `--fs-sub` 13 · `--fs-caption` 12。页面与组件的 `font-size` 只能写 `var(--fs-*)`，禁止 `clamp`、`rpx`、裸 `px`、`max()`。
2. **字重只有两种**：`400` 与 `600`。不要 `500` / `650` / `700`。
3. **行高只有三档**：`--lh-tight` 1.25 · `--lh-snug` 1.4 · `--lh-normal` 1.5。
4. **字体栈只在 `page` 声明一次**；别处不写 `font-family` / `font` 简写。等宽数字用 `font-variant-numeric: tabular-nums`（已在 `page`），货号不要换 Menlo。
5. **颜色只引用令牌**；字面色值只能出现在 `app.wxss` 的 token 定义里。深色只改 `app.wxss` 的 `@media (prefers-color-scheme: dark)`，页面不得再写一套 dark 覆盖。
6. **间距只走 `--sp-*`**：2 / 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40。允许 `calc(var(--sp-N) * -1)` 与 `+ env(safe-area-inset-bottom)`。
7. **圆角只走 `--radius-*`**：tray 16 · control 12 · tile 10 · pill。
8. **托盘不投影**；唯一允许的阴影是抽屉 `--shadow-sheet`。浅色托盘无描边，靠 `--surface` 与白底分层。
9. **不用 `rpx`、不用 `!important`、不用毛玻璃 blur、不用装饰性渐变**（渐变只能作为已命名令牌，如 `--pass-fill`）。
10. **按钮三级**：主 `.btn-primary`（绿底墨绿字）· 次 `.btn`（中性填充）· 文字 `.btn-text`。已退役：`btn-outline` / `btn-ghost` / `btn-neutral` / `ui-action--neutral`。
11. **图标用边框绘制或 PNG**：`ui-chevron` / `ui-check` / `ui-plus` / `ui-close`；模板里禁止 `› ✓ ＋ ✕` 等字符图标。
12. **展开入口不写「展开 / 收起 / 查看」文案**——方向标已经说明状态。
13. **触控高度**：主按钮 `--btn-height` 48px；通用点击区至少 `--tap` 44px。
14. **绿色分工**：`--green` 只做填充；可读绿字用 `--green-text`；绿底上的字用 `--green-ink`。禁止 `color: var(--green)`，禁止把标题/门店名整段染绿。

## Colors

白底页面 + 浅灰托盘承载内容。绿色是动作色，不是氛围色。

| 令牌 | 用途 |
| --- | --- |
| `--bg` | 页面与导航栏底 |
| `--surface` | 内容托盘（`.card`） |
| `--surface-top` | 托盘上的控件、选中套餐行 |
| `--elevated` | 抽屉 / 弹窗浮层 |
| `--pressed` | 按下态 |
| `--text` / `--text-2` / `--text-3` | 正文 / 次要 / 辅助 |
| `--green` / `--green-ink` / `--green-text` / `--green-soft` | 主按钮填充 / 按钮字 / 状态字 / 浅绿底 |
| `--warn*` / `--bad*` | 警示与错误，成对使用 |
| `--pass*` | **全站唯一深色物件**：会员通行证 |

**会员通行证**是品牌签名：深墨底、可选暖金字（年卡剩余天数）、金色对勾。金色 `--pass-gold` 不得出现在通行证以外。有效会员与未开通权益展台共用 `.member-pass` 材质；年卡仅用金色强调剩余天数，不为整页换金皮。

深色模式跟随系统。主绿填充 `--green` 与墨字 `--green-ink` 两模式相同；其余表面与文字在 dark 块中覆盖。`theme.json` 的导航/页面底必须等于对应模式的 `--bg`。

## Typography

一张图上的字号角色必须一眼能数清：

- **Display 28**：极少用（大日期等）
- **Title 22**：页标题、账户身份、余额主数
- **Headline 17**：卡标题、套餐名、主按钮字
- **Body 15**：默认正文、列表行
- **Sub 13**：次要说明、行内动作
- **Caption 12**：脚注、标签、下限可读字

标题与数字用 `600`，说明用 `400`。不要为「更高级」加第三种字重。

## Layout

四个原生 tab：查询 · 小哨 · 历史 · 我的。默认进查询；保留「不必先查询即可关注」。

页面结构：**当前状态 → 主操作 → 可展开详情**。
托盘（`.card`）是一组内容的唯一容器——**禁止托盘内再套灰色圆角小卡**。组内用 `1px solid var(--line)` 分隔。

- **查询**：取货凭条式阅读——配置、门店、观测时间、下一步。
- **小哨**：到期事项突出下次提醒；库存关注突出真实观测与可执行动作。
- **历史**：日期与「今天 / 昨天」同行；事件按观测时间轴阅读。
- **我的**：首屏是身份 + 通行证（或权益展台）+ 一个主 CTA；套餐列表仅在开通/续费时展开；规则与 FAQ 进帮助入口，不在购买按钮旁堆说明书。

窄屏（320）、浅/深色、1.3 倍字号、键盘与安全区要在离线预览与真机分别记录；本规范的 44px / 12px 是离线下限，不是微信认证。

## Elevation & Depth

分层靠明度，不靠描边叠阴影：

- 浅色：白底 → 浅灰托盘；托盘无边框、无投影。
- 深色：`--bg` → `--surface` → `--elevated` / `--surface-top`。
- 抽屉从底部升起，使用 `--shadow-sheet`；遮罩用 `--scrim`。

按下反馈：主按钮轻微 `scale(0.985)` + 降透明度；`prefers-reduced-motion: reduce` 时取消位移类动效。展开用 `.ui-reveal`（约 200ms）。有货哨点可用 `.ui-live-dot` 扩散三次后静止——**这是唯一的品牌动效签名**，不要给每个区块加入场动画。

## Components

### 按钮与行内动作

| 类 | 角色 |
| --- | --- |
| `.btn.btn-primary` | 唯一主操作 |
| `.btn` | 次操作（中性填充） |
| `.btn-text` | 低优先级文字操作 |
| `.ui-action` | 行内小动作；`--plain` 透明底 |
| `.ui-disclosure` | 列表展开行；右侧方向标 |

禁用与加载必须同时锁住外观与处理函数。原生 `view` 充当控件时补齐 `aria-role` / `aria-label` / `aria-disabled`。

### 表单与选配抽屉

保存才提交；取消保留原稿。保存中同步锁定 picker 与输入。失败保留可恢复草稿。占位用 `placeholder-class`，深浅色分别检查对比度。

### 关注卡与库存状态

先读配置身份与观测，再读动作。有货 / 无货 / 未知 / 陈旧 / 失败含义不得合并。观测时间是库存时间，不是页面刷新时间。查询、关注、监测、授权、受理、收信分步表达。

### 到期提醒

名称、到期日、计划提醒（北京时间）、状态分列。微信「已受理」≠ 已送达。服务未开时写「仅保存」，不包装成「免费试用」话术掩盖发送状态。

### 会员与购买

- 当前套餐以服务端 `planId` 为准，不按剩余天数猜档。
- 通行证卡面：有效期、剩余天数、已用名额；名额格可点进关注。
- 未开通：同一材质上三条权益 +「开通会员」。
- 套餐行：名 + 时长 + 一句名额 + 价（原价删除线、日均可在窄屏隐藏）；选中行抬起为 `--surface-top`。
- 购买按钮旁只保留退款与不自动续费两句；名额细则走「名额与续费常见问题」。
- 价格、时长、名额、退款以服务端与当前条款为准。

### 公告与更新记录

普通公告在公告页。首页只提示有效维护、告警、待恢复授权与真实故障。更新公告每页 3 个版本，有「上一页 / 下一页 / 收起」按钮样式入口（见 [product-copy.mdc](.cursor/rules/product-copy.mdc)）。

## Do's and Don'ts

### Do

- 先读 [PRODUCT.md](PRODUCT.md)、本文件与 [持续检查流程](docs/IMPECCABLE_WORKFLOW.md)。
- 只引用 `app.wxss` 令牌；改公共值后跑 `node --test tests/design-system.test.mjs`。
- 让布局解释关系；规则放进折叠或帮助页；保留购买/授权/退款/时效关键句。
- 状态同时用文案 + 形态（实心点 / 空心点 / 虚线环），不只靠颜色。
- 离线预览、微信编译、真机、云端、真实收信与发布**分别陈述**。

### Don't

- 不要在页面里发明第七种字号、第三种字重、或新的圆角体系。
- 不要用重复说明、装饰徽章、网页通栏线、毛玻璃堆高级感。
- 不要为简洁删掉影响判断的事实；也不要用少采样 / 缓存资格制造「更干净」的假状态。
- 不要把 Web 字体、框架或检测截图当成原生验收。
- 不要把本规范当成生产发放、上传或合并的授权。

## 维护检查清单

改任何 WXML/WXSS 后：

1. `node --test tests/design-system.test.mjs`
2. 受影响路径的离线预览（320 / 375 / 深色）
3. 核对：首屏是否仍一眼可读；规则是否仍可访问；绿是否仍只出现在动作与就绪态

证据目录与版本说明随发布包登记；未在真机验证的项必须写明「未验证」。

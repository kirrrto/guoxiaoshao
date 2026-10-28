# V3.4.3 实际设计审查与本地验收

日期：2026-10-28。当前工程：`C:\Users\Administrator\Downloads\flower book\guoxiaoshao-master\guoxiaoshao-master`。分支 `codex/v3.4.3-experience-usage`，基线 `8ecd44195e3e66c0c56d99a84fab70a71bb7b9fc`，版本仍为 3.4.3。

本记录接续[第一轮优化执行记录](OPTIMIZATION_3.4.3_PROGRESS.md)。第一轮只采用设计方法，未实际安装 Impeccable 或生成 shadcn preset；本轮已补齐真实使用、独立审查、源码修复与重新验证。原方案和工具建议均按当前小程序源码复核，不以模型或工具名代替证据。

后续发布收尾已将本版选定为正式发布源码，并调整版本记录文案、固定 CI 浏览器依赖。当前最终指纹与上线步骤以[发布交接](RELEASE_3.4.3_HANDOFF.md)为准；本页数字和指纹保留为设计审查阶段的历史证据。此前只在本地的精选截图与 Web 源码包已补入 [GitHub 可复用附件](../evidence/design/2026-10-28/README.md)。

## 最终 preset 与复现

- 官方可视化入口：[preset b2BnwlLhw](https://ui.shadcn.com/create?preset=b2BnwlLhw&template=vite)。已在 Chrome 实际选择、查看组件画廊、切换明暗、从 Get Code 导出命令和主题。
- 选择：Base UI；Vega；Neutral 底色；Emerald 主题和图表；Noto Sans 正文/标题；Lucide；Medium 圆角；Default / Solid 菜单；Subtle 菜单强调。未启用 pointer、monorepo 或 RTL。
- 界面生成命令：`npx shadcn@latest init --preset b2BnwlLhw --template vite`。实际验证固定 `shadcn@4.23.0`，在独立目录运行 init，并实际生成 Button、Card、Input、Badge；没有在小程序根目录执行初始化。
- [导出的配置](../evidence/design/2026-10-28/shadcn-preset.json)、[官方主题 CSS](../evidence/design/2026-10-28/shadcn-preset.css)、[CLI 版本/构建/哈希](../evidence/design/2026-10-28/shadcn-cli-verification.json)、[浏览器交互记录](../evidence/design/2026-10-28/shadcn-browser-verification.json)均保留。CLI 产物与浏览器导出的浅深色共 63 个主题变量完全一致；整个 CSS 因 imports 和基础层不同而不是同一文件。
- 独立 Web 参照已完成 Node 24 的 TypeScript、Vite 构建和 App ESLint；浏览器验证清空后报错、选择 24 GB、填写示例门店后保存成功、禁用示例和明暗切换。示例数据不连接业务服务。

官方配置截图为 `evidence/design/2026-10-28/shadcn-create-light.jpg`、`shadcn-create-dark.jpg`、`shadcn-create-command.jpg`；参照样页为 `shadcn-reference-light.jpg`、`shadcn-reference-dark.jpg`。截图与源码归档按仓库惯例保留在本地交付材料中，不把大图加入 Git。

## 实际使用 Impeccable

[官方源码](https://github.com/pbakaus/impeccable/tree/3e3a9179e01a60265000ce239c0a99803ec1e60d)固定于 commit `3e3a9179e01a60265000ce239c0a99803ec1e60d`。项目 skill 为 **4.8.0**，Windows engine 为 **0.1.18**，SHA256 `8f61e96b0c97001546a824d79b44f46b423b560f3eb1a0cc44a8695a1b395d9f`，63 个上游 skill 文件逐字节一致；许可证和来源见 [.agents/skills/impeccable/UPSTREAM.json](../.agents/skills/impeccable/UPSTREAM.json)。安装仅在项目内，没有全局 hooks 或全局配置改动，engine 二进制被忽略。

实际执行 `engine-probe`、一次 `context`、`critique-storage slug`、静态与 Edge 渲染 `detect`；audit、critique、operate、craft-floor、原生适配和 document 是实际读取并执行的方法，不伪称存在 `impeccable audit` CLI。`context` 能读取产品/设计资料，但不识别 WXML/WXSS，结果 `hasVisualImplementation:false` 不表示没有界面或审查通过；旧 PRODUCT 元数据 schema 提示保留，未据此重写产品事实。

原生 Assessment A 由独立代理在未读取 detector 输出的情况下完成，查真实页面/组件行为和截图；修复前 Nielsen 27/40、原生量表 14/20 仅是该范围初审记录。修复后未重打分，不把它当成真机性能或无障碍认证。另一代理负责 engine 证据与生成 HTML 的补充检查；HTML 检测不伪装成 WXML 原生扫描。

最终 engine 复验：320px 退役关注页原 15 个告警剩 6 个，9 个真实小字告警全部消失；375px 同款 iMac 页剩 2 个。保留的是预览说明条、HTML 模拟原生 tab 文本、必要库存状态分组；两个命令的实际退出码均为 **2（有告警）**，没有修改规则或屏蔽原始结果。范围内已复现且可本地修复的问题均已关闭，不能由此推断整个产品没有其他问题。

完整命令、哈希、原始告警和处置见 [实际使用记录](../evidence/design/2026-10-28/impeccable-actual-use.json)。没有注入可见诊断 overlay，也没有宣称存在。临时 detector 服务均已关闭。

修复关闭记录已实际执行 `critique-storage write` 和 `trend`，归档于 `.impeccable/critique/2026-10-28T08-50-06Z__miniprogram-components-target-picker-index-wxml.md`。趋势只有一条 27/40 初审记录，正文明确未在修复后重新评分，不能解释为提分曲线。

## 本轮发现与实际修复

1. **P1：保存期间的草稿丢失。** 复现为提交原 SKU 后仍可选择新颜色，旧请求成功却关闭新草稿。现请求开始前同步锁组件逻辑，再经属性禁用原生 picker/input 和选项，父页面拒绝迟到 change；重复保存、取消不穿透，失败解锁并保留草稿可重试。没有只靠延迟传到视图的 disabled 属性。
2. **P2：清空搜索的触控范围不足。** 原 320–430px 下宽约 29–39px，现为至少 44×44 CSS px。保留相邻输入和正常布局。
3. **P2：可访问语义平台混用。** 按微信官方 WeUI 实现将 WXML 的 Web `role` 调整为 `aria-role`，补搜索及两个设置开关的可访问名称；预览再映射回 HTML 标准语义，并保留 disabled。源码属性已修，读屏顺序和实际朗读另待真机。
4. **P2：窄屏功能文字偏小。** footer 免责声明与关注页实际使用的刷新状态、两个时间、授权余额、状态详情、退役状态、库存时间、旧结果说明设 12px 下限，保留原 rpx 比例。320px 目标 9 节点均为 12px，375px 为 12–12.5px；无 WXML 引用的旧 class 不计作修复成果。
5. **验证工具缺口。** renderer 原来未映射 placeholder-class，可能把浏览器默认灰色当作小程序颜色；现按原 WXSS 同作用域生成伪元素规则。颜色门禁增加实际显示的 placeholder，纳入颜色 alpha 和 opacity 合成，排除已有值输入；负例用黑色 0.4 有效透明度验证约 2.85:1 必须失败，不能误算成 21:1。

最终只读复核又真实复现一个颜色门禁 P2：input 或祖先的整体 opacity 会将文字与表面一起合成，原检查却可能报告 21:1。现对活动控件的这种不支持合成明确返回 `unsupported_group_opacity`、ratio=null、失败退出码；保留原反例和自身/祖先/普通按钮三组浏览器回归，不靠错误地再次叠乘已合成背景解决。最终业务样本中这种不支持的测量为 0。

新增搜索状态、保存锁/失败恢复测试和窄屏非零节点断言；保留旧精确 SKU、退役改选、同值选择、取消、门店与业务事实检查。改动没有新增云轮询或业务请求。

## 相对于原方案和 Web 预设的取舍

- 采用 Vega 的简洁层级、成对语义前景/背景、明确选中与禁用状态、就地错误恢复。保留果小哨既有绿色、系统中文字体、四个原生入口和准确 SKU 身份。
- 不把 Web 初始化命令用于微信项目，不引入 React、Tailwind、Web DOM 组件、OKLCH 或额外字体包。Web 的 Noto Sans、Lucide、Medium 仅记录在参照 preset 中，实际小程序继续使用现有资源与圆角。
- 填充色不自动等于文字色：本轮 Web 参照首段直接使用 primary，在深色下不清晰，已改用语义文字色；小程序继续使用经检测的 --action-fill/--action-text 与 --green-dark，不盲目换成 Web Emerald。
- 不机械消除库存分组、SKU 维度或必要免责声明以满足 detector 的风格偏好；价格、退款、续费、授权、时效与实际名额继续保留。
- 库存默认 legacy、真实支付资格含后来退款、冻名单续跑、图片缺原图及真实计量边界沿用第一轮独立复核结论；本轮没有把局部 7→5 SDK 动作当成真实账单收益。

后续入口：[DESIGN.md](../DESIGN.md) 给出视觉与组件规范；[持续检查流程](IMPECCABLE_WORKFLOW.md) 说明工具用法及证据边界；[助手规则](../AGENTS.md) 和 [ui-quality.mdc](../.cursor/rules/ui-quality.mdc) 使后续界面任务先读取这些约定。产品简洁文案规则继续优先适用。

## 最终本地验证

Node **24.22.1** 全量测试 **1803/1803 通过，0 失败、0 跳过**，日志 `output/gxs343-design/full-tests-final.log`。源码检查 593 文件、421 JS、49 JSON，errors 为空；monitor 闭包一致，现有商品图片和主包预算检查通过。该结果覆盖最终小程序与检查器源码。

最终统一浏览器门禁与每份报告的哈希见 [本地验收记录](../evidence/verification/3.4.3-design/local-verification.json)。所有页面均重新生成并核对 235 个源码文件，覆盖基础页面、V3.4.3 场景、iMac 与 MacBook 抽屉的浅深色、搜索及保存状态。记录明确区分布局、触控/重排、导航近似、对齐和颜色抽样，不能相加当成不同用户流程的数量。

最终为 450 张 HTML、浅深色 900 项布局、1728 项弹层几何/重排、1416 项原生导航近似、120 项选配对齐检查，全部通过；最终颜色工具重新检测 92 个页面样本、894 条可见控件/placeholder 记录，0 失败、0 不支持测量。首次搜索态断言错把隐藏的常用城市当作必需文案，4 项任务失败的原始日志保留；修正搜索预期后两套抽屉重建及检查全部通过，212 个 HTML 的字节哈希未变，仅 manifest 预期字段变化。

本项目修改范围的 `git diff --check` 通过。新增原样上游 skill 的 CRLF、既有尾空白/末尾空行仍会触发默认全仓空白检查；原始记录保留在 `output/gxs343-design/whitespace-upstream.log`，未篡改 63 个官方文件来消除这些格式提示。这不影响项目源码、运行或测试，也不写成默认全仓空白检查已通过。

最终微信源码指纹：`sha256:7ae69180501091bae90a29ec1c610f17c329724640d2860af3968b9fd03c4b16`。主包源码 1,209,639 B（不是微信上传包大小）。release check **51/52**，源码项通过，历史微信质检证据一项仍阻断，`publicationReady:false`。

## 真机和外部仍需验证

1. 当前源码在微信开发者工具真实编译及体验包：WXSS max()、组件样式隔离、原生 picker/input、首次 tab 切换、图片加载和包体。
2. iOS/Android 小屏与系统大字号：12px 下限的实际效果、44 CSS px 的真实点击体验、弹层滚动、键盘升降与安全区、横竖屏、返回/取消/失败重试。
3. VoiceOver/TalkBack：aria-role/name/disabled 的实际朗读、弹层焦点范围、恢复位置和保存状态反馈。
4. 真正弱网/后台切换下的保存锁、原生输入事件顺序、授权弹窗、支付/退款及订阅提醒收信；本地 mock 和 Chromium 都不能替代。
5. 四个历史微信 finding 保持 open，必须用当前版本、任务 ID、设备和源码指纹的新证据逐项关闭；102 份缺失原图及完整重建、真机清晰度仍待完成。
6. CloudBase 事务/索引、跨北京时间午夜 24 小时数据完整性、同负载时效和真实费用；生产赠礼冻结名单边界、受信任执行端和持久检查点；之后的部署、迁移、真实发放和发布均未执行。

Questions skipped: the maintainer explicitly authorized local fixes, tests and reusable design rules; visual direction and native constraints were already specified.

# 持续体验与用量检查

2026-10-28 在当前 3.4.3 上吸收 [PR #7](https://github.com/kirrrto/guoxiaoshao/pull/7) 的规范意图，保留后来加入的“避免不必要的次要标签和描述”。现已实际安装并使用项目范围的 [Impeccable 4.8.0 skill](../.agents/skills/impeccable/SKILL.md) 与 engine 0.1.18，来源固定为官方 commit `3e3a9179e01a60265000ce239c0a99803ec1e60d`；不再只是方法参考。未安装全局配置或 hooks。

来源、版本和许可见 [UPSTREAM.json](../.agents/skills/impeccable/UPSTREAM.json)。官方 Windows engine SHA-256 为 `8f61e96b0c97001546a824d79b44f46b423b560f3eb1a0cc44a8695a1b395d9f`，安装时按固定上游的 checksum 核验；二进制保存在被 Git 忽略的项目 skill 目录，不能把它当作应用发布资源。实际运行、退出码、修复前后发现和边界见 [本轮工具证据](../evidence/design/2026-10-28/impeccable-actual-use.json)。

## 开始

读当前分支、AGENTS、产品/设计/文案规则，确认已有改动。判断本次影响的页面、业务状态、采样时效、目标覆盖和数据库读写。方案是待验证假设，以当前源码和复现为依据；纯内部变更可以说明 UI 检查不适用。

要使用 Impeccable 时先读已安装的 SKILL.md 与当前任务对应参考，不凭命令名猜流程。Windows 项目入口为 `.agents/skills/impeccable/scripts/impeccable.cmd`；`engine-probe` 可核对运行版本，`context --target <明确目标>` 加载一次本次上下文，`detect --help` 查看实际检测接口。`audit`、`critique`、`harden`、`document` 等是 skill 工作流程，不能伪称为执行过同名 CLI 子命令。

## 实施

- critique / audit：检查主任务、信息层级、触控、可读性、状态与调用放大。
- clarify：明确当前事实与下一步，删除重复解释，保留价格、退款、授权与时效条件。
- harden：覆盖加载、空、慢、失败、未知、旧缓存、账号切换、并发和重复动作。
- adapt：检查窄屏、浅深色、大字、短窗口、键盘、安全区；Web 近似不能替代微信。
- extract / document：复用已有语义变量、组件与工具，记录新数据结构的兼容、默认模式及回退。
- polish：统一间距、对齐、按钮状态；不为美化新增轮询或大资源。

仅执行本次适用项。数据迁移要验证完整累计、权威版本、稳定分页、失败恢复和回滚。礼遇任务保留原支付退款账本，资格判断、原子发放、已到账凭证不能混为一谈。

## 小程序审查的实际方法

- 先按 `audit.native.md` / `critique.md` 检查 WXML、WXSS 和真实事件路径，保留系统中文字体、主绿、四个原生入口与直接关注路径。微信不是 Web DOM，也不是 SwiftUI/Compose；不能照搬 HTML 属性、字体单位、导航或组件依赖。
- 当前 engine 默认扫描后缀不含 WXML/WXSS；本轮 `context` 返回 `hasVisualImplementation=false`、`platform=null`，表示覆盖不足。原生源码不以 detector 空结果判为通过。原生 critique 的独立设计审查可采用 native A-only 方法，手工评分须注明源码/离线范围；不生成设备性能或无障碍认证分数。
- 生成 HTML 只作为附加验证。先重建 `tools/ui-preview/build.mjs` 并核对 `manifest.json` 的 sourceHashes，再对受影响页面执行 `detect --json --viewport <宽x高> --no-consent-hiding --no-overlay-hiding <本地URL>`。记录精确命令、实际退出码、原始 JSON 和检查范围；exit 0 表示没有主告警，1 表示目标扫描失败，2 表示有主告警。
- 区分真实业务问题、预览保真错误、有意的业务分组及预览专用内容。预览说明条和 HTML 原生 tab 近似的告警不等于小程序问题；SKU 身份、已选门店和库存状态也不能为了消除 `nested-cards` 告警而删除。真实状态文字、按钮和 placeholder 应实际测量，不能仅凭 advisory 分类忽略。
- 本轮已据此修复保存期间草稿丢失、清空搜索触控不足、原生可访问属性/名称及窄屏功能文字过小；预览另补 `placeholder-class`、`aria-role` 和 disabled 映射。修复后重建受影响预览、回归事件路径，不能用修复前截图或旧指纹关闭问题。
- shadcn/create 的可视化 preset 和实际生成的 Web 参照用于比较层级、留白、圆角、状态和语义色。是否采用以小程序真实内容和当前 `DESIGN.md` 为准；不因此把 React、Tailwind、Noto Sans 或 Lucide 作为小程序依赖。

## 收尾

运行相关测试和必要的全量门禁，记录本次证据。统计 SDK 调用、返回文档、计费单位和真实账单时分别陈述，按同负载和时间窗口比较，不能相加不同时窗降幅。

UI 修改要记录离线布局/颜色与原生未验项。测试缺依赖、零样本和浏览器失败不能记为通过。微信 finding 保留原证据门禁，不能用旧指纹关闭。

保留原始告警和逐项判断，不改规则来制造零告警。持续审查只覆盖本次变化及其依赖；已有证据充分时不反复全站重跑。读屏焦点、大字体、键盘/安全区、原生返回行为、真实图片与设备性能要单列微信开发者工具/真机验证，离线检测不关闭这些项目。

完整 critique 应先交付可见报告，再按 skill 用 `critique-storage write <目标> <报告文件>` 保存并查看 `critique-storage trend <目标> 5`。遵守会话内已明确的授权和产品约束；上游问题模板不覆盖维护者指示，也不要求再次批准已授权的本地工作。临时服务仅绑定 loopback，记录停止方法，检查结束后关闭；原始报告和必要截图作为证据保留。

交接包含采用/调整/未实施的方案项、修改范围、实测结果、未验证项、迁移与回滚方式。生产迁移、真实赠礼、云部署、上传、推送和合并依据会话内有效授权执行，本流程不单独授权这些动作。

# Impeccable 适配与每次更新检查

## 采用决定与范围

维护者于 2026-10-28 要求评估 [pbakaus/impeccable](https://github.com/pbakaus/impeccable) 并在果小哨以后的每次更新中考虑相关优化。决定采用其设计审查方法，结合本项目原生微信小程序技术栈、既有产品规则和真实验证流程执行。

这是一项持续开发约定。初始接入仅增加项目上下文、设计基准、助手入口与 PR 清单；没有安装上游 skill/CLI、启用 hooks、增加小程序运行依赖或修改现有 CI。规范随分支存在，进入默认分支后供后续任务共同读取。PR 清单本身不是合并保护或自动检测门禁。

## 已核实的上游边界

评估日：2026-10-28（北京时间）。

- 上游参考 skill/CLI 为 4.8.0，engine 为 0.1.18；本轮审阅源码固定在 `d34c87e1a00989ae8dbdd7f6b30b70f23319e860`，skill 4.8.0 标签对应 `414603bf14c7a344edb466bb1f85690c77ce8b7d`。
- 上游既有 AI 设计指导，也有确定性扫描与编辑 hooks。AI 审查仍需判断实际产品语义；扫描无发现不代表没有体验问题。
- 默认文件扫描和 hook 扩展列表不包含 `.wxml` / `.wxss`。配置扩展可以交给通用文本或 HTML 引擎，但不能据此称为微信原生支持。
- 浏览器 DOM、URL/CDP 或 HTML 近似预览检测不能验证小程序组件隔离、微信授权、原生导航、完整 WXML 语义或手机运行效果。
- 上游产品界面模式允许系统字体和熟悉的操作控件。果小哨保留中文字体、品牌、四入口导航和已有产品事实，不照搬营销落地页风格。
- hooks、AI 审查、CI、微信验收是不同层次；仅有配置文件不等于本地 hooks 已信任或启用。

## 每次更新的执行步骤

### 1. 开始前判断影响

读当前分支的 [AGENTS.md](../AGENTS.md)、[PRODUCT.md](../PRODUCT.md)、[DESIGN.md](../DESIGN.md) 和 [文案规则](../.cursor/rules/product-copy.mdc)。识别改动页面、共享组件、用户状态及现有未提交内容。

| 变更类型 | 最低检查 |
| --- | --- |
| 页面 / 组件 / 样式 / 主题 / 用户文案 | 对本次改动及受影响共享组件执行下表中适用检查 |
| API / 库存 / 数据源 / 会员 / 支付 / 提醒 | 先判断用户流程、状态、观测时间、错误和下一步是否变化，再对受影响界面检查 |
| 内部工具 / 纯测试 / 纯文档 | 记录体验影响判断；无用户可见变化可注明“不适用”及理由 |
| 全局样式 / 字体 / 导航 / 共用组件 | 补查所有实际受影响页面，不只看入口截图 |

### 2. 在需求范围内审查并修正

以下命令名用于对应 Impeccable 方法；当前没有安装其命令时，按同等检查维度执行并如实说明，不声称已运行工具。

| 方法 | 果小哨检查重点 |
| --- | --- |
| critique / audit | 主任务、信息层级、操作可发现性、颜色语义、触控、阅读与性能风险 |
| clarify | 按钮、状态、失败原因及下一步清晰；精简重复说明但保留权益、授权、时效等事实 |
| harden | 加载、空、慢、失败、未知、旧数据、拒绝授权、权益变化、长文本与重复操作 |
| adapt | 窄屏 / 宽屏、系统字号、深色、键盘、安全区及原生控件 |
| extract / document | 复用现有组件和 token；检查未定义变量、主题覆盖与样式隔离；更新真实设计约定 |
| polish | 对齐、间距、字号、按钮状态和反馈；保持各页面一致 |
| optimize（有相关改动时） | 资源、渲染、重复请求及交互耗时；区分实际测量和推测 |

并非每次都必须执行全部方法，也不因审查发现可改进项而自动扩大本轮范围。重要问题应修正或登记；不适用项说明原因。无需为每次更新改颜色、加动效或重新设计页面。

### 3. 按实际风险验证

沿用 [持续集成](CONTINUOUS_INTEGRATION.md)、当前测试与发布规则。根据改动复用相关离线用例、源代码检查和布局场景；代码改动按项目既有门禁执行，不用 Impeccable 替代现有验证。

界面重点覆盖本次受影响状态的 320 / 375 / 430px 近似预览、浅深色及放大字体；涉及宽屏、短窗口、键盘、导航或安全区时增加对应场景。这些是项目检查场景，不宣称在任何设备上都完整覆盖。

WXML/WXSS、原生控件与运行交互变化需核对微信开发者工具；涉及支付、授权、真实收信等仍需对应场景的实际验收。离线数据须标为样例，未执行的手机、云端或生产验证列为待验证，不写“全部通过”。

既有发布限制继续有效，不能为了 CI 变绿而关闭发布检查、伪造质检证据或沿用旧提交结论。

### 4. 交付时固定记录

在 PR 或本次更新说明中包含：

- 用户体验影响：涉及哪些页面、组件、状态；无影响时写理由。
- 已检查与已优化：对应方法、实际变化及依据。
- 证据：本次运行命令/截图/文件/设备或测试环境；每项标明已执行、未执行或不适用。
- 遗留问题：严重程度、影响、下一步；将源码发现与真机已复现问题分开。
- 业务与发布影响：会员、支付、提醒语义、数据真实性是否受影响，发布仍需哪些验收。

使用 [PR 模板](../.github/pull_request_template.md) 可减少遗漏。后续每次更新均应做影响判断，不要求没有界面变化的更新重复美化。

## 首轮审查中记录的候选问题

以下来自基线 `a56dbe663e3f18463de6f8de96ec3e2f42d32f92` 的源码只读核对，不是已修复或真机缺陷报告。

- `miniprogram/pages/query/index.wxss` 有 3 处 `var(--surface)`。
- `miniprogram/pages/follow/index.wxss`、`miniprogram/pages/mine/index.wxss`、`miniprogram/pages/notice-board/index.wxss`、`miniprogram/styles/reminder-center.wxss` 各有 1 处 `var(--text-1)`。
- 本次核对全部 15 份消费者小程序 WXSS 未找到这两个变量的定义；已有表面变量是 `--card` / `--surface-soft`，文字变量是 `--text` 等。

后续修复应先核对当前源码、组件隔离与预期视觉语义，再选择复用已有变量或增加清晰定义，验证浅深色及受影响页面。不能仅按名称机械替换，也不能把源码问题直接写成线上显示已故障。

## 后续工具安装与升级

如以后需要完整 skill、CLI 或 hooks，作为独立工具变更处理：检查所用编辑器与系统、固定已审阅的来源、保留许可证与 notice、验证实际扫描覆盖和误报，并记录本地是否真正启用。Codex hook 的信任由对应环境完成，不能通过文档假定已获信任。

“以后每次更新考虑优化”不等于每次自动升级 Impeccable。仅固定 `npx impeccable@4.8.0` 的 CLI 版本也不保证其下载的 skill bundle 固定；实际安装内容应单独核验与记录。上游工具留在开发环境，不能混入消费者小程序或云函数运行包。

本次文档是针对果小哨编写的检查约定，没有复制上游实现或 skill 文件。若以后复制上游内容，按其 Apache-2.0 和适用第三方 NOTICE 保留相应声明。

## 本轮核对来源

- 果小哨：[基线提交](https://github.com/kirrrto/guoxiaoshao/commit/a56dbe663e3f18463de6f8de96ec3e2f42d32f92)、[app.wxss](../miniprogram/app.wxss)、[app.json](../miniprogram/app.json)、[现有 CI](../.github/workflows/verify.yml)。
- Impeccable：[README](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/README.md)、[产品界面指导](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/skill/reference/operate.md)。
- 覆盖范围：[文件扫描](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/crates/detect/src/file_system.rs)、[hook 扩展](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/crates/hook/src/hook_lib.rs)。
- 来源与分发：[skill 4.8.0](https://github.com/pbakaus/impeccable/releases/tag/skill-v4.8.0)、[bundle 获取实现](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/crates/skills/src/bundle.rs)、[LICENSE](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/LICENSE)、[NOTICE](https://github.com/pbakaus/impeccable/blob/d34c87e1a00989ae8dbdd7f6b30b70f23319e860/NOTICE.md)。

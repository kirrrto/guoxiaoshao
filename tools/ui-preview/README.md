# 果小哨离线 UI 预览

运行 `node tools/ui-preview/build.mjs --out <输出目录>`，打开生成的 `index.html`。

- 从项目当前的实际 WXML、WXSS 与页面 JS 派生消费者 4 页 × 6 种状态 × 3 种宽度，共 72 个独立 HTML。管理页已移入独立运营项目，默认预览不再包含它。
- 状态为 `free`、`member`、`expired`、`empty`、`error`、`longcontent`；宽度为 320、375、430 像素。
- 数据明确是模拟的，不调用云函数、不扣次数、不支付、不发送消息。默认不加载远程产品图片；加 `--remote-images` 可读取目录中精确 SKU 的官方图片 URL。
- HTML 可离线打开。浏览器不是微信原生渲染器；原生组件、选择器弹层、平台字体及安全区域需以开发者工具和真机验证。
- 独立快照提供 `window.previewAudit()`，供浏览器脚本检查横向溢出。横向品类滚动区域允许超宽内容。
- 构建器不改动业务源码；默认输出系统临时目录，也可通过 `--out` 指定项目外的目录。
- 页面模块在预览沙箱中使用固定时钟 `2026-09-15T07:00:00.000Z`，保证会员到期和库存新鲜度快照可复现。固定时钟不写入小程序业务文件，也不影响正式账号或真实采集的时间。

历史版本 1.0.1 四组预览合计 **150 个场景**：当时默认基础 90、提醒记录 24、库存新鲜度 15、会员兑换 21。管理项目拆分后，对应消费者四组为 **132 个场景**，运营预览另有 18 个。各专项开关分别运行并使用不同输出目录；它们不在默认一次构建中同时生成。数量说明场景覆盖，不代表云端业务或手机微信验收结论。

1.0.1 发布清理版已从微信上传目录 `miniprogram/` 移除功能验收页及模拟运行时。离线测试和本工具的快照仍可使用样例数据；它们不构成小程序用户可打开的测试入口。会员兑换的原 `redemption-simulation` 场景改为 `redemption-empty`，总数保持 150 个。

## 仅预览提醒记录：24 个场景

独立运营工具另用 `node tools/ui-preview/build.mjs --admin-only --out "<运营预览输出目录>"`，再执行相同的 `check-layout.mjs`。它读取 `tools/admin-miniprogram/miniprogram/` 中的真实页面与样式，生成 18 个离线场景，不加载消费者目录或消费者页面。`--admin-only` 不能与消费者专项开关混用。

在仓库根目录执行以下命令；将 `<提醒预览输出目录>` 替换为工程外的实际路径，路径含空格时保留引号：

```powershell
node tools/ui-preview/build.mjs --reminders-only --out "<提醒预览输出目录>"
node tools/ui-preview/check-layout.mjs "<提醒预览输出目录>"
```

`--reminders-only` 只生成「我的」页面，以当前实际 WXML/WXSS 和页面格式化逻辑覆盖以下 8 种状态，每种均生成 320、375、430 像素宽度，共 24 个独立 HTML：

- `reminders`：多种发送状态的记录，以及加载更多入口。
- `reminder-empty`：没有提醒记录。
- `reminder-loading`：提醒记录加载中。
- `reminder-deleting`：单条删除进行中。
- `reminder-clearing`：清空进行中。
- `reminder-error`：清理结果未确认，保留记录并提供重试。
- `reminder-more-error`：更早记录加载失败，保留已有列表。
- `longcontent`：超长商品、门店文字及多种发送状态。

有记录的场景包含平台受理、验收模拟、发送失败、结果不确定、未发送、待发送和发送中状态，并带有平台拒绝及网络异常的展示样例。这里的 `accepted` 仅用于展示平台受理标签，不代表任何真实消息已经送达。

检查脚本根据该输出目录的 `manifest.json` 检查全部 24 个场景，生成 `layout-metrics.json`；当前代表截图规则会生成 320 像素的长文本提醒页面截图。打开 `index.html` 可逐项查看其他状态。快照不执行删除确认、清空事务或微信原生交互；相关行为应按 [会员功能验收](../../docs/MEMBERSHIP_ACCEPTANCE.md) 复测。

## 仅预览库存新鲜度：15 个场景

```powershell
node tools/ui-preview/build.mjs --stock-only --out "<库存预览输出目录>"
node tools/ui-preview/check-layout.mjs "<库存预览输出目录>"
```

以实际关注页覆盖 5 种状态 × 320、375、430 像素，共 15 个 HTML：

- `stock-fresh`：新观测，本轮记录尚不足 1 秒时显示时长待后续观测确认。
- `stock-old`：旧观测主标签为「待更新」，过去结果单独标记，不当成当前库存。
- `stock-unknown`：最近检查未得到有效库存，显示「状态待确认」。
- `stock-missing`：尚无观测，显示「等待首次观测」。
- `stock-restricted`：会员权益受限，遵守新品实时库存权限。

这组快照检查标签、说明和长文字排版，不进行采样。模拟关注列表读取同样不应生成样本，相关行为由业务回归验证。

## 仅预览会员兑换：21 个场景

```powershell
node tools/ui-preview/build.mjs --redemption-only --out "<兑换预览输出目录>"
node tools/ui-preview/check-layout.mjs "<兑换预览输出目录>"
```

以实际「我的」页覆盖 7 种状态 × 320、375、430 像素，共 21 个 HTML：`redemption-input`（输入）、`redemption-loading`（处理中）、`redemption-error`（无效码）、`redemption-success`（成功）、`redemption-used`（已领取）、`redemption-limited`（错误锁定）、`redemption-empty`（空兑换码输入）。

每个场景同时展示会员兑换及「付费购买（暂未开放）」入口。快照使用模拟响应，不包含正确兑换码、不调用真实兑换或支付，也不证明任何账号已经获得会员。输入键盘、原生提示和真实响应更新需在微信环境按 [真实兑换验收](../../docs/MEMBERSHIP_ACCEPTANCE.md) 检查。

## 监测、消息服务与个人提醒体检：30 个场景

```powershell
node tools/ui-preview/build.mjs --monitoring-only --part-number "MJYE4CH/A" --out "<监测状态预览目录>"
node tools/ui-preview/check-layout.mjs "<监测状态预览目录>"
```

此专项使用当前关注页的实际 JS、WXML 和 WXSS，在离线沙箱内生成 10 种状态 × 320、375、430 像素，共 30 个页面：

- 后台运行、订阅模板缺失。
- 后台运行、发送服务就绪且有 1 条授权。
- 后台运行、发送服务就绪但无授权。
- 后台状态过期。
- 后台检测关闭。
- 会员到期，关注已暂停。
- 尚未添加关注。
- 所有关注均已暂停。
- 个人消息提醒开关关闭。
- 当前处于免打扰时段。

默认完全离线，无远程图片请求；不会查询云端、调用微信授权、发送消息或改变账号状态。页面中的库存、会员日期、服务状态和授权次数均为样例，不构成真实服务运行或消息送达证据。

检查脚本保存每个状态的 375 像素全页截图；模板缺失状态同时保存 `follow-monitor-template-missing-375-first-screen.png`，尺寸为 375 × 850。所有预览顶部保留“离线模拟”标识。

## 自动测量与截图

新增历史浏览奖励专项：`--history-task-only`，覆盖历史页及我的页的会员领取、免费首次浏览、读取失败、余额上限、当天已完成、长条件和加载中，共 42 个快照。命令及场景定义见 [历史浏览任务专项预览](HISTORY_TASK_QA.md)。

运行 `node tools/ui-preview/check-layout.mjs <输出目录>`，通过独立无界面的 Chromium 检查该目录清单内的场景（默认 72 个；提醒专项 24 个；新鲜度专项 15 个；兑换专项 21 个），并生成 `layout-metrics.json` 和代表截图 `screenshots/`。不打开或操作用户的桌面窗口。

- 检查横向溢出、被裁切的文本、缺失的关键商品/门店/价格文案与图片加载状态。
- 表达式求值失败会写入 `evaluation-errors.json` 并让构建失败，不会默默把文案清空。
- 检查脚本优先使用项目的 Playwright，未安装时使用 Codex 已提供的工作区依赖；不自动安装软件。
- 需要产品颜色图片证据时：构建添加 `--remote-images --part-number <目录中的准确SKU>`，检查添加 `--images-only`。这会读取官方图片网址，但仍不会调用业务云函数或执行支付、提醒操作。
- 截图和测量只能证明这些模拟状态下的浏览器布局。原生小程序组件、权限和真实接口仍需在微信环境验收。

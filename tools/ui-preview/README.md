# 果小哨离线 UI 预览

运行 `node tools/ui-preview/build.mjs --out <输出目录>`，打开生成的 `index.html`。

## 会员原生按钮级联专项

```powershell
node tools/ui-preview/build.mjs --membership-native-only --out tmp/ui-membership-native
node tools/ui-preview/check-layout.mjs tmp/ui-membership-native
node tools/ui-preview/check-layout.mjs tmp/ui-membership-native --dark
node tools/ui-preview/check-floating-tabs.mjs tmp/ui-membership-native
node tools/ui-preview/check-membership-regression.mjs tmp/ui-membership-native
node tools/ui-preview/check-layout.mjs tmp/ui-membership-native --membership-fonts-only
```

独立专项覆盖 12 种免费、会员、已到期、续费、升级、待支付及展开说明状态，宽度为 320、360、375、390、393、414、430、480、768、1024，共 120 个快照。只在该模式的「我的」区域前置 `button:not([size=mini])` 的 `width:184px; margin-left:auto; margin-right:auto` 级联约束，重现套餐被固定宽度挤成居中窄列的缺陷；没有加入 `min-content` 等额外原生假设。普通预览和原有付款专项保持原来的宽度与样式。

这仍是 Chromium 的定向压力测试，**不是微信原生渲染或真机验收证据**。生成页的提示、清单和报告均标记压力模式及实际注入 CSS；真实开发者工具和设备截图仍需另行核验。

检查保留原有全部断言，增加套餐是否铺满容器、主信息可用宽度、内部溢出/重叠、账户与会员状态、七个独立图标加载及入口对齐、免费账户的「体验微信提醒」位置与消耗/授权/测试说明，并限制平板下的异常大字。免费及会员首页在每个宽度另存首屏、账户、会员卡、底部七入口截图。待支付时恢复订单保持优先，体验入口按页面条件隐藏。浮动导航专项另测 1×/1.3×字体、0/34px 模拟安全区，共 480 组。

源码校验包含小程序 JS/JSON/WXML/WXSS 和本地图像资产；检查前后任一文件变化都必须重新构建，避免使用旧图标或旧页面截图。

`check-membership-regression` 在两个正常状态通过后，只在临时浏览器 DOM 中制造六种错误：184px居中套餐、内部窄列、缺失入口图标、提醒体验移错卡片、隐藏消耗说明和主按钮巨字，要求检查器全部拒绝。它不修改源码和生成的 HTML，结果另存 `membership-checker-selftest.json`。

`check-layout --membership-fonts-only` 对 320/375 宽度的免费购买、会员升级、会员到期六案增加 1.3×字号与行高，仍使用全部布局和套餐内部断言；记录在 `membership-font-metrics.json` 和 `screenshots-membership-fonts/`，不覆盖常规快照。可追加 `--dark` 验证深色。这只模拟浏览器字号压力，不能替代微信字体设置实测。

## 微信提醒体验页专项

```powershell
node tools/ui-preview/build.mjs --notification-test-only --out tmp/ui-notification-test
node tools/ui-preview/check-layout.mjs tmp/ui-notification-test
node tools/ui-preview/check-layout.mjs tmp/ui-notification-test --dark
node tools/ui-preview/check-layout.mjs tmp/ui-notification-test --notification-fonts-only
node tools/ui-preview/check-layout.mjs tmp/ui-notification-test --notification-fonts-only --dark
node tools/ui-preview/check-notification-regression.mjs tmp/ui-notification-test
```

专项保留原有 ready、no-quota、accepted、uncertain、failed、received、not-received 七状态，新增 authorized、authorized-no-quota、sending、pending-other、error、loading、rules、needs-authorization、uncertain-received 九状态。每种覆盖 320、360、375、390、393、414、430、480、768、1024，共 160 个快照。授权完成与另一待确认请求通过页面实际 `loadStatus/applyResult` 还原；展开规则、排查和反馈使用页面实际处理方法。初始加载保留页面默认加载状态。沙箱禁止通知授权及发送调用，也不会连接云函数或微信。

仅在此专项前置 `.test-page` 内 `button:not([size=mini])` 的 184px 宽度和自动左右边距，模拟默认按钮选择器对页面样式的级联压力；它不是微信实机证据。检查全部操作至少 44px 高、铺满所在行，反馈按钮按两列均分；同时检查原请求恢复、未确认结果禁止新发、无额度按钮禁用、字体大小、平板卡宽和原有文本/溢出/图像断言。展开规则场景保留扣次、失败退回、结果未知暂不退、非库存及正式提醒条件的文本断言。

`--notification-fonts-only` 对 320/375 的准备发送、已受理、已授权、其他待确认、未收到排查、规则展开六状态施加 1.3×字号与行高，共 12 案。报告和截图分别保存在 `notification-font-metrics*.json` 与 `screenshots-notification-fonts*`，不覆盖正常字号报告。

检查器自检在正常准备与反馈场景通过后，向临时 DOM 注入固定宽度操作、固定宽度反馈、缺失恢复按钮、零额度可发送、未确认状态可新发及异常大字六种错误，要求全部被拒绝，结果保存在 `notification-checker-selftest.json`。

## 2.0.0 业务与屏宽专项

```powershell
node tools/ui-preview/build.mjs --v2-only --out tmp/ui-preview-v2
node tools/ui-preview/check-layout.mjs tmp/ui-preview-v2
node tools/ui-preview/check-layout.mjs tmp/ui-preview-v2 --dark
node tools/ui-preview/check-floating-tabs.mjs tmp/ui-preview-v2
```

`--v2-only` 使用本地模拟的 `bootstrap.features` 打开新界面开关，`growthEvents` 保持关闭，不发送漏斗事件。普通场景时钟为北京时间 2026-10-11 15:00；未来日期场景为 2026-12-01 00:00，每个快照在清单中记录 `previewDate`。共有 18 种状态，按相关页面组合生成 198 个快照：原有账户／库存／服务状态，以及月卡和年卡的当前／未来日期优惠价、攻略准备步骤／日历／FAQ、首次开屏日历。宽度为 320、375、390、430、768、1024 像素；浅/深色各检查 198 个。其余旧专项保持原来的固定时钟和场景。

优惠夹具遵守服务端产品契约：月卡当前 14.99 元、标准 30 元；年卡当前 129 元、标准 360 元。当前优惠已取消固定截止日，`promotion.endsAt` 为 `null`，标签为「优惠价」。保留名为 `v2-promotion-expired-*` 的历史场景作为未来日期回归，检查跨过已移除的截止日仍为 14.99／129 元，禁止出现「限时优惠」「优惠至」和未来自动恢复价。通过真实套餐选择方法检查应付价；旧待确认订单仍保留原订单金额，不能被新套餐价格覆盖。

`index.html` 按实际生成清单联动页面、场景和宽度，不提供不存在的组合；布局检查在浏览器中遍历全部可选组合，核对目标文件存在且清单中的页面全部可达。

这些场景执行实际页面的加载、选择、查询格式化和上下文恢复方法，再读取当前 WXML/WXSS；不会调用真实云函数、支付、原生授权或库存采集。结果动作用独立断言验证未知/过期/服务异常不呈现无货转化话术，受限新品保留权限入口，已付费未配置需主动继续。

布局检查输出 `layout-metrics.json`、`layout-metrics-dark.json`、代表整页/首屏/结果动作/套餐区截图。`check-floating-tabs` 对各 tab 页检查 1×/1.3×字体和 0/34px 模拟安全区，并分别验证非 tab 页没有浮动导航、阻断弹窗期间导航隐藏；实际数量见 `floating-tab-metrics.json`。全页长截图的悬浮导航固定在第一个视口位置；判断实际遮挡时须同时看首屏与滚动后的区域截图。

构建清单保存小程序 JS/JSON/WXML/WXSS 的 SHA-256。布局检查开始和结束均对照本地源码；期间若修改业务源码，会要求重新构建，避免旧截图被当成最终结果。浏览器仍是 WXML/WXSS 的近似渲染，不能验证微信原生组件注入顺序、真实支付/授权弹窗、JS 基础库、真机性能或设备安全区。

`--nudge-only` 生成提醒补充弹窗的三种模拟内容，配合 `check-layout.mjs <目录>` 和 `--dark` 检查。这里只呈现弹窗；是否触发、24 小时节流、待同步恢复与用户手势由 `tests/reminder-nudge.test.mjs` 验证，不调用真实微信授权。

- 从项目当前的实际 WXML、WXSS 与页面 JS 派生消费者 4 页 × 7 种状态 × 3 种宽度，共 84 个独立 HTML。管理页已移入独立运营项目，默认预览不再包含它。
- 状态为 `free`、`member`、`expired`、`empty`、`error`、`loading`、`longcontent`；宽度为 320、375、430 像素。
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

## 监测、消息服务与个人提醒体检：51 个场景

```powershell
node tools/ui-preview/build.mjs --monitoring-only --part-number "MJYE4CH/A" --out "<监测状态预览目录>"
node tools/ui-preview/check-layout.mjs "<监测状态预览目录>"
```

此专项使用当前关注页的实际 JS、WXML 和 WXSS，在离线沙箱内生成 17 种状态 × 320、375、430 像素，共 51 个页面：

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
- 免费账号的会员专属说明及消息落地页。
- 到货和断货双模板均有次数、断货次数空、到货次数空、断货次数低和补授权待同步。

默认完全离线，无远程图片请求；不会查询云端、调用微信授权、发送消息或改变账号状态。页面中的库存、会员日期、服务状态和授权次数均为样例，不构成真实服务运行或消息送达证据。

检查脚本保存每个状态的 375 像素全页截图；模板缺失状态同时保存 `follow-monitor-template-missing-375-first-screen.png`，尺寸为 375 × 850。所有预览顶部保留“离线模拟”标识。

## 自动测量与截图

`--onboarding-only` 覆盖首页手动签到、签到中、签到失败、当日已签到、已载入分享、分享等待切换、分享目录待确认和分享目录失败，共 8 种状态 × 3 种宽度，即 24 个快照。可与浅色、`--dark` 分别检查。该专项只渲染模拟状态，不执行签到、查询或分享。

新增历史浏览奖励专项：`--history-task-only`，覆盖历史页及我的页的会员领取、免费首次浏览、读取失败、余额上限、当天已完成、长条件和加载中，共 42 个快照。命令及场景定义见 [历史浏览任务专项预览](HISTORY_TASK_QA.md)。

运行 `node tools/ui-preview/check-layout.mjs <输出目录>`，通过独立无界面的 Chromium 检查该目录清单内的场景（默认 84 个；提醒专项 24 个；新鲜度专项 15 个；兑换专项 21 个），并生成 `layout-metrics.json` 和代表截图 `screenshots/`。不打开或操作用户的桌面窗口。

- 检查横向溢出、被裁切的文本、缺失的关键商品/门店/价格文案与图片加载状态。
- 表达式求值失败会写入 `evaluation-errors.json` 并让构建失败，不会默默把文案清空。
- 检查脚本优先使用项目的 Playwright，未安装时使用 Codex 已提供的工作区依赖；不自动安装软件。
- 已缓存的 Chromium 与 Playwright 默认版本不同时，可通过环境变量 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定现有浏览器可执行文件；未设置时保留默认查找和 Windows 浏览器回退。
- 需要产品颜色图片证据时：构建添加 `--remote-images --part-number <目录中的准确SKU>`，检查添加 `--images-only`。这会读取官方图片网址，但仍不会调用业务云函数或执行支付、提醒操作。
- 截图和测量只能证明这些模拟状态下的浏览器布局。原生小程序组件、权限和真实接口仍需在微信环境验收。

## 配置面板与深色模式

备选颜色与门店专项使用 `--alternatives-only`，覆盖默认、勾选、月／年会员四颜色四门店、免费查询、已有记录、准备配置、空记录、错误、过期和缓存共 10 种状态，分别检查 320、375、430 像素。检查包含两列的位置、按钮填满列内容、门店整行宽度、查询按钮右对齐且不超过半行、文案不重叠及控件数量。

```powershell
node tools/ui-preview/build.mjs --alternatives-only --out output/alternatives
node tools/ui-preview/check-layout.mjs output/alternatives
node tools/ui-preview/check-layout.mjs output/alternatives --dark
node tools/ui-preview/build.mjs --alternatives-only --round-rpx --out output/alternatives-rounded
node tools/ui-preview/check-layout.mjs output/alternatives-rounded
node tools/ui-preview/check-layout.mjs output/alternatives-rounded --dark
```

`--round-rpx` 将 rpx 的转换结果四舍五入到整数 CSS 像素，用于发现半宽 `calc()` 与独立间距相加时造成的换行。这是额外的舍入压力场景，**不是微信引擎实现，也不证明某台手机使用这种舍入规则**；报告保留 `rpxRoundingProfile`。默认仍按小数像素构建，两个模式均需检查，最终以微信真机显示为准。

`--release-notes-only` 使用页面实际展开事件展示“我的 → 更新公告”，覆盖免费、会员和长内容三种状态 × 三种宽度，共 9 个快照。可配合 `check-layout.mjs` 的浅色与 `--dark` 检查全部版本条目和换行。

`--sheets-only` 生成查询、小哨、历史三个入口的配置面板，覆盖编辑、模拟键盘、长内容和保存中四种状态 × 三种宽度，共 36 个快照。使用实际 `config-sheet`、`target-picker` 的 WXML/WXSS 和选项数据；支持默认与具名 slot 的布局近似。原生返回拦截、输入法、slot 实例查找及触摸行为仍需真机检查。

```powershell
node tools/ui-preview/build.mjs --sheets-only --out output/ux-r1/sheets
node tools/ui-preview/check-layout.mjs output/ux-r1/sheets
node tools/ui-preview/check-layout.mjs output/ux-r1/sheets --dark
node tools/ui-preview/check-theme-colors.mjs output/ux-r1/pages output/ux-r1
node tools/ui-preview/check-theme-colors.mjs output/ux-r1/pages output/ux-r1 --dark
```

布局检查的 `--dark` 使用浏览器深色配色偏好，另存 `layout-metrics-dark.json` 与 `screenshots-dark/`。对比度脚本在 375 像素的会员/免费页面抽样可见控件，不是完整无障碍认证；须查看报告中的失败数量。

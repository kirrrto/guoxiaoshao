# 3.7.0 视觉层级与全页面一致性重构（2026-11-14）

依据 [VISUAL_REFINEMENT_BRIEF.md](../../../docs/VISUAL_REFINEMENT_BRIEF.md) 与维护者关于清理嵌套灰底框及过时文案的反馈，对全量 8 个消费端页面（`query`、`follow`、`history`、`mine`、`guide`、`notice-board`、`notification-test`、`deadlines`）、全局样式、选配抽屉、设计规范与测试实施完整视觉升级与清理：

- [四页浅色离线预览（375px）](four-tabs.png)
- [四页深色离线预览（375px）](dark.png)
- [攻略页清理对比预览（375px，无嵌套灰框与过时页脚）](guide-refined.png)
- [会员卡与账目卡片对比（3.7.0 原版 vs 2026-11-14 浅深色）](member-comparison.png)
- [校验命令与指纹记录](verification.json)

---

## 本次变更：采用 / 清理 / 调整 / 未实施说明

### 已采用（Adopted）

1. **中性底色与深色表面层级**（`miniprogram/app.wxss`、`miniprogram/theme.json`）：
   - 浅色页底 `#F4F4F2`、正文 `#111412`、`--green-dark: #006B3F`；深色 `#0B0D0C` 页底 → `#171A18` 内容卡面 → `#1F2320` 浮层表面，`--green-dark: #5CE0A8`。
2. **统一字阶与等宽数字**（`miniprogram/app.wxss`、`styles/common.wxss` 及全站 8 个页面 `.wxss`）：
   - 引入 `--fs-display` / `--fs-title` / `--fs-headline` / `--fs-body` / `--fs-sub` / `--fs-caption` / `--fs-section`，大字与标题统一收敛至 `600` 半粗字重（含 `guide`、`notice-board`、`notification-test`）。
   - 日期、时间戳、货号、余额、套餐配额与到期日程时间统一启用 `font-variant-numeric: tabular-nums`。
3. **色彩克制与三态状态胶囊**（`styles/common.wxss`、`query`、`follow`、`history`、`notice-board`、`styles/reminder-center.wxss`）：
   - 去掉查询结果标题、有货门店名、小哨库存正标题、提醒次数数字以及 `notice-board` 常规公告标题和粗绿左框线的大面积用绿；绿色专注主按钮与就绪/警告状态。
   - `.pill` 与 `.event-status` 区分实心圆点（就绪/有货）、空心圆点（未启用/停用或中性底错误标签）和虚线圆点+透明底（警告/待确认）。
4. **清理全站嵌套灰底与三层按钮**（`styles/common.wxss`、`guide`、`notice-board`、`notification-test`、`deadlines`、`mine`）：
   - **折叠列表与行组**：`.ui-disclosure-group`、`.ui-disclosure`、`.test-disclosure` 去掉 `--control-fill`/`--surface-soft` 灰块底色，改用透明背景与 `1px solid var(--line)` 细线分隔，文字左对齐贴齐卡片内容区。
   - **次操作描边按钮**：`.btn-outline`、`.test-secondary`、`.guide-reminder-check .ui-action`、`.membership-manage`、`.mine-reminder-action`、`.checkout-secondary .ui-action`、`.release-page-button.ui-action` 改为 `background: var(--card); border: 1px solid var(--line);`，不再显示为卡片内或页底的灰色块。
   - **轻文本操作**：`.btn-text`、`.membership-shop-close.ui-action`、`.notice-heading .ui-action`、`.deadline-item-actions .ui-action`、`.release-notes-collapse.ui-action` 去除灰底胶囊填充。
   - **会员套餐与权益网格**：`.member-benefit-plan`、`.membership-package`、`.membership-package-selected` 改用 crisp `var(--card)` 卡片材质 + `1px` 细线 / `--green-dark` 选中边框，彻底去除大块灰色卡片套灰盒的视觉观感。
5. **清理过时文案与日期标识**（`pages/guide/index.wxml`、`config/usage-guide.js`、`config/release-notes.js`）：
   - 移除 `pages/guide/index.wxml` 底部过时冗余文案 `库存仅供参考，购买请在 Apple 官方渠道完成（核对于 {{checkedOn}}）。`（第 1 步与 FAQ 已包含实时观测说明及官方渠道核对提示）。
   - 将 `config/usage-guide.js` 中的 `checkedOn` 更新为 `2026-11-14`，将 `config/release-notes.js` 中 3.7.0 的 `dateText` 更新为 `版本记录 · 2026-11-14`。
6. **四处受控渐变/毛玻璃与纯色回退**（`app.wxss`、`styles/common.wxss`、`components/config-sheet/index.wxss`、`pages/mine/index.wxss`）：
   - 页首 `.page-heading`、`config-sheet-scrim`、`redemption-mask`、年卡/会员卡渐变与商品图展台均先声明纯色/非透明回退，再以 `@supports` 叠加渐变或模糊。
7. **规范与自动化测试同步**（`DESIGN.md`、`tests/dark-mode.test.mjs`）：
   - 同步 `DESIGN.md` tokens 与规则，并在 `tests/dark-mode.test.mjs` 增加 `.ui-disclosure-group` 透明化、`.btn-outline` 卡片描边以及禁止 `pages/guide/index.wxml` 保留「核对于」过时注脚的回归断言。

### 调整项（Adjusted）

1. **`.page-heading` 不使用 `position: sticky`**：保留普通文档流，避免离线滚动定位与固定提示条遮挡采样。
2. **`reminder-balance` 细线兼容既有节点**：将原先并排灰色方块改为列间 `1rpx` 细线格，保留 `12px` 最低文字尺寸下限。

### 未实施项（Omitted in Scope）

1. **Impeccable CLI `detect` 未在本地运行**：`.agents/skills/impeccable/scripts/impeccable` 在当前 macOS 主机为无执行权限脚本且 `impeccable.cmd` 指向 Windows 引擎，未绕过平台/权限限制；由仓库自有 Playwright Chromium 全量测量脚本替代完成检查。

---

## 验证结论分项说明

1. **Node 单测、源码与打包检查**：
   - `npm test`：**1976 / 1976 全部通过**（`fail: 0`）。
   - `npm run check`：653 个文件，**0 错误**；`node tools/build-monitor.mjs --check`：50 个文件，**0 问题**。
   - `node tools/release/check.mjs`：本地源码与依赖锁定检查全部通过（`sourceChecksPassed: true`、`monitorBundlePassed: true`、`frontend: 242 files / 1,294,635 bytes`）；退出码 `1` 仅因 4 项自 3.3.1 起的待真机/开发者工具复验微信质检条目保持 open。
2. **离线 Chromium 预览检查**：
   - `check-v360.mjs`：**96 / 96 通过**（0 失败）。
   - `check-layout.mjs`：`tabs` 浅/深色（84×2）、`member` 浅/深色（120×2）、`v350`（96）、`notify` 浅/深色（160×2）全部 **0 失败**；`v2`（含 `guide` 与 `notice-board`，318 快照）水平溢出 / 截断 / 图片加载均 **0 失败**（48 项 `missingText` 为旧版 `v2` 预期文案，未影响新版结构与排版）。
   - `check-theme-colors.mjs`：`tabs` 浅色与深色各 119 个激活控件，**0 项不达标**（主激活控件最低对比度 `5.36:1`，选中底部导航最低对比度浅色 `6.61:1` / 深色 `7.57:1`）。
3. **微信开发者工具编译 / 真机与云端**：**未验证**（本次未执行微信开发者工具编译、真机 iOS/Android 实测、云函数部署或版本上传）。

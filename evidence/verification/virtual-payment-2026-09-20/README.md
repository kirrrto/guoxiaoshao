# 会员虚拟支付前端验收记录

日期：2026-09-20。商品：`vip666`，一次购买 7 天，700 分。此目录为离线模拟与自动化测试证据，没有进行真实付款、真实微信收银台交互或云端订单写入。

## 已验证范围

- `tests/member-payment-frontend.test.mjs`：20 项通过。覆盖原样传递服务端签名、微信回调成功但服务端未确认时不授予会员、防双击、取消、同账号订单恢复、账号隔离、未知支付结果、有限轮询、页面隐藏/卸载、旧 iOS/微信能力判断、退款状态、会员确认后记录刷新失败等。
- 付款前端、会员兑换、账户体验、个人提醒管理四组回归：57 项通过。
- 本轮另运行付款前端与 `virtual-payment-service.test.mjs` 合计 36 项通过；后端用假的微信 HTTP 响应，不能替代真实支付验证。
- 27 个支付页面快照：9 种状态 × 320 / 375 / 430 像素。状态为可购买、续费、暂停开放、旧 iOS、支付待确认、取消、网络错误、确认开通、部分退款。
- 21 个兑换回归快照：7 种状态 × 3 种宽度。
- 两组 `layout-metrics.json` 均记录：表达式错误、缺失文案、横向溢出、文字裁切、图片加载失败均为 0。

付款预览使用真实页面 JS/WXML/WXSS，`wx.login`、`wx.requestVirtualPayment` 和接口响应均是本地桩。预览固定时钟为 2026-09-15，因此会员日期是样例，不能用于判断真实账户权益。

## 取消与恢复的验证边界

取消后只显示“已取消本次支付，请查询订单状态”，保留当前账号的订单编号。页面不会自动再次拉起收银台，也不会自动创建另一笔订单。

是否能继续同一笔订单必须由服务端查单结果决定：

- 明确未签发支付参数、未产生平台交易的本地订单，可在服务端核对后通过用户再次点击继续同一笔订单。
- 平台状态 0 / 1、`paymentPending` 或 `payment_pending` 代表待确认，只能继续查单，不能重新打开收银台。
- **已签发参数但用户尚未打开收银台、或者已经取消时，官方查询接口的“订单不存在”错误码尚未取得可依赖的明确合同。** 此时查询异常会保留待确认，不把错误文案猜成未付款，不更换订单号重试收费。

自动化测试证明上述状态控制和数据隔离成立。尚未验证真机取消之后平台何时建立或关闭订单，也未证明所有取消场景均能立即重新购买；这些属于后续配置完成后的真实联调范围。

## 排版证据

- `index.html`：离线付款状态预览入口。
- `manifest.json`、`evaluation-errors.json`、`layout-metrics.json`：27 场景的结构与布局结果。
- `screenshots/`：27 张会员卡局部截图。
- `screenshot-manifest.json`：截图清单与渲染说明。
- `redemption/`：21 个兑换场景及对应布局测量。

生成 HTML、完整布局测量与截图保留在本地，不重复入库；Git 保留 `layout-summary.json` 的统计和完整报告哈希，以及场景、截图清单。可按下方命令重新生成预览和完整测量。

布局测量使用 900 像素高的浏览器视口。会员卡局部截图使用较高视口，以免固定底部导航覆盖局部裁剪画面。已人工查看 320 像素待确认、375 像素可购买与 430 像素部分退款代表图；按钮、订单号、会员日期和退款文案均可读。

浏览器只是 WXML/WXSS 的离线近似，不是微信原生渲染器。真实微信收银台、系统键盘、原生安全区域、IAP 地区限制与真实付款/退款回调仍待真机联调。

## 复现命令

在仓库根目录运行：

```powershell
node --test tests/member-payment-frontend.test.mjs tests/member-redemption-frontend.test.mjs tests/account-ux.test.mjs tests/notification-management-frontend.test.mjs
node tools/ui-preview/build.mjs --payment-only --out evidence/verification/virtual-payment-2026-09-20
node tools/ui-preview/check-layout.mjs evidence/verification/virtual-payment-2026-09-20
node tools/ui-preview/build.mjs --redemption-only --out evidence/verification/virtual-payment-2026-09-20/redemption
node tools/ui-preview/check-layout.mjs evidence/verification/virtual-payment-2026-09-20/redemption
```

# 支付合规整改 · 本地交付报告

日期：2026-10-13  
分支：`fix/virtual-payment-compliance-ui`  
范围：仅本地代码与独立分支提交。未部署云函数、未上传微信、未改生产配置、未发起真实扣款/退款。

## 1. 修复目标

降低「支付不可用仍展示虚拟商品交易入口」的合规风险，不重写支付系统，不改历史订单/签名协议。

## 2. 修改文件

| 文件 | 变更 |
| --- | --- |
| `miniprogram/utils/member-payment.js` | 拆分设备收银能力与商品购买就绪；`purchase`/`continue` 双模式；平台暂停禁止收银台；导出 `purchaseGate`/`planPurchasable` |
| `miniprogram/utils/member-products.js` | 增加 `purchasableProducts`、`choosePurchasablePlan`（待确认订单不自动换套餐） |
| `miniprogram/pages/mine/index.js` | 按套餐过滤展示；无可用套餐隐藏购买区；续费/升级/下单遵守可用性 |
| `miniprogram/pages/mine/index.wxml` | 支付不可用隐藏套餐价格、划线价、「立即开通/续费/升级」；保留会员权益/记录/兑换/客服 |
| `tests/payment-compliance-ui.test.mjs` | 新增 10 项合规回归 |
| `tests/member-payment-frontend.test.mjs` | 文案断言兼容中性提示 |
| `evidence/verification/payment-compliance-ui-states.json` | 可用/不可用/部分不可用三态离线快照 |

## 3. 需求对照

### 需求1：支付不可用隐藏交易入口
- 无任何可购套餐时 `showPurchaseShop=false`，不渲染价格、划线价、促销标签、购买按钮。
- 中性提示：`会员购买暂不可用，现有会员权益不受影响。`
- 保留：已有会员、权益说明、购买记录、兑换码、联系客服、待确认订单恢复面板。

### 需求2：分套餐购买状态
- `purchaseGate` 只保留 `available` 套餐。
- 部分可用：仅展示可购套餐；全部不可用：隐藏购买区。
- 待确认订单：不自动切换套餐/金额；无待确认订单时才安全落到可购套餐。
- 续费/升级入口检查 `available`，不可绕过。

### 需求3：加强支付受限检查
- 删除 `buy()` 中 `pendingId ? { enabled:true, paymentReady:true }` 强行放行。
- `continue` 模式：平台/全局暂停（`payment_not_enabled`/`payment_server_not_ready` 等）**禁止**调起收银台；套餐级停用不改写已存在订单冻结条款。
- 历史订单 `check()`/退款/回调不依赖购买就绪。
- 不把 `canIUse` 当商户收款权限；仍要求服务端商品就绪。
- **未**新增安卓专用服务端开关（见第 6 节方案，待确认）。

### 需求4：价格一致性（只核对，未改协议）
| 套餐 | productId | 当前实付/签名 goodsPrice | 划线价 UI | 历史价 |
| --- | --- | ---: | ---: | ---: |
| 周卡 7 天 | vip666 | 700 | 无 | 700 |
| 月卡 30 天 | vip777 | 1499 | 3000 | 1990 (v2) |
| 年卡 365 天 | vip888 | 12900 | 36000 | 20000 (v2) |

- 新单：`goodsPrice=priceFen`（实付），`activitySellingPrice=null`；与 `VIRTUAL_PAYMENT_SETUP.md` 一致。
- 划线价仅 UI，不进签名。
- v1/v2/v3/v4 快照校验逻辑未改动。
- 用户已提供后台价格一致证据；本报告不假定线上部署状态。

### 需求5：功能保护
- `wx.requestVirtualPayment`、签名下单、查单、发货、退款、对账、兑换、提醒、关注均未删改。
- 历史订单快照兼容逻辑未动。

## 4. 回归测试

- `node --test "tests/**/*.test.mjs"`：**1335 tests, 1333 pass, 0 fail, 2 skipped**（跳过项为需在 `cloudfunctions/gxs_api` 执行 `npm ci` 的 SDK 契约测）。
- `node tools/check-source.mjs`：`errors: []`，474 files。
- 新增 `payment-compliance-ui.test.mjs` 10 项覆盖：分档可用性、API 存在≠可收款、平台暂停禁收银台、套餐停用、待确认不换套餐、全不可用隐藏入口、部分可用、可用可进支付控制器、devtools/缺 API、iOS 单独停用。
- **以上均为本地模拟/契约测试，不是微信真机收银或真实付款验证。**

## 5. 可复现预览

`evidence/verification/payment-compliance-ui-states.json`：

| 状态 | showPurchaseShop | 展示套餐 | 提示 |
| --- | --- | --- | --- |
| payment-available | true | 周/月/年（含划线价） | — |
| payment-unavailable | false | 无 | 会员购买暂不可用，现有会员权益不受影响。 |
| partial-month-disabled | true | 仅周/年 | — |

## 6. 安卓专用购买暂停开关（设计方案，待确认，默认不实现）

| 项 | 建议 |
| --- | --- |
| 配置键 | `virtualPayment.androidPurchaseSuspended`（服务端 runtime，默认 `false`） |
| 作用 | 仅禁止 Android 新购/继续支付调起收银台；iOS、订单查询、回调、退款不受影响 |
| 下发 | `memberProducts[].androidPurchaseSuspended` 或 bootstrap `payment.androidPurchaseSuspended` |
| 客户端 | `paymentAvailability` 在 android 平台命中即 blocked，文案「会员购买暂不可用，现有会员权益不受影响。」 |
| 影响范围 | 不改历史订单、不改签名、不关 iOS |
| 默认值 | `false`（不关闭任何用户支付） |

**未经你确认前不实现、不写入生产配置。**

## 7. 正式支付风险

- 支付不可用时隐藏标价入口可能减少转化，但符合 5.13 合规优先。
- `continue` 模式在平台暂停时不重开收银台；若用户有未付订单，只能查询/放弃，待恢复后再购。
- 未改服务端价格/签名；若商户后台道具价与 700/1499/12900 不一致，收银仍会失败（属配置问题，非本次改动）。
- 不涉及云函数/运行配置变更，**无需**为本修复重新部署云函数。

## 8. 是否需要变更云函数或运行配置

**本次不需要。**  
可选后续（待确认）：第 6 节安卓暂停开关需增加服务端配置字段与下发。

## 9. 上线前建议（不在本次执行）

1. 真机 Android/iOS 各一笔小额：支付 → 发货推送 → 会员开通 → 账单金额一致。
2. 核对 MP 虚拟支付道具单价 = 700/1499/12900。
3. 确认申诉材料与线上页面一致（无站外收款引导）。

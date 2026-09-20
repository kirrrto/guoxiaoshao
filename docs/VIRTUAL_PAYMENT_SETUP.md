# 果小哨 · 7 天会员虚拟支付

更新：2026-09-20。用户已恢复支付接入需求，并确认下列商品信息。本文为配置与验收指引；部署、密钥、真单结果以版本证据为准。

## 已确认的商品

- 消费者小程序 AppID：`wxe96ad9e77b602f1b`。
- OfferID：`1450655203`，签名时使用字符串。
- 已提供商品／道具 ID：`vip666`。
- 商品名称：果小哨会员 · 7 天。
- 单次价格：人民币 7 元，协议金额为 `700` 分。
- 权益时长：7 天；现有有效会员从原到期时间顺延。
- 用户确认已开通 iOS IAP。客户端还需满足微信版本与系统要求。
- 道具直购模式：`short_series_goods`；正式环境 `env=0`，币种 `CNY`，数量 `1`。
- 这是单次购买，不是自动续费协议。兑换活动独立保留原来的 30 天权益。

微信后台的「代币配置」不是本商品配置入口。请在「道具配置」确认 `vip666` 已发布且单价 700 分。商品 ID 来自用户文字确认，代码无法仅凭这个字符串证明后台发布状态。

## 云端密钥配置

环境：`flowermean-6gjaxfqhf6c13e88`，云函数：`gxs_api`。在函数配置的环境变量中填写，保留已有变量：

1. `GXS_CONSUMER_APPID`：`wxe96ad9e77b602f1b`（已于 2026-09-20 写入 `gxs_api`）。
2. `GXS_CONSUMER_APPSECRET`：果小哨当前有效的 AppSecret。此前 `gxs_monitor` 已使用同一个消费者 AppSecret；无需重置。
3. `GXS_VIRTUAL_PAYMENT_APPKEY`：虚拟支付后台「正式环境／现网」AppKey。
4. `GXS_PAYMENT_CALLBACK_TOKEN`：与微信「消息推送配置」一致的 Token，3–32 位英文字母或数字。
5. `GXS_PAYMENT_CALLBACK_AES_KEY`：与消息推送配置一致的 43 位 EncodingAESKey。使用微信页面随机生成的值。
6. `GXS_ENABLE_PAYMENT_RECONCILE`：`true`，用于开启已部署的受信定时查单任务；购买开关与补偿处理分开。

AppSecret、AppKey、Token、EncodingAESKey 只填写在平台与云端配置中，不贴到聊天、不写入源码或 runtime 数据库。这里使用虚拟支付，不需要普通商户支付证书或 APIv3 密钥。资源方小程序 `wxc6dfebb77650f3a9` 的 AppSecret 不能替代果小哨凭据。

## 微信消息推送配置

部署回调路由后，在果小哨公众平台「开发管理 → 消息推送」填写：

- URL：`https://flowermean-6gjaxfqhf6c13e88-1397722981.ap-shanghai.app.tcloudbase.com/payment/callback`。
- Token：与云函数 `GXS_PAYMENT_CALLBACK_TOKEN` 相同。
- EncodingAESKey：与 `GXS_PAYMENT_CALLBACK_AES_KEY` 相同。
- 消息加密方式：**安全模式**。
- 数据格式：**XML**。

该路由已于 2026-09-20 建立并核验，完整路径透传到 `gxs_api`；未签名 GET／POST 返回 403，非法路径返回 403，PUT 返回 405。微信保存 URL 时的 GET 校验只验 Token 签名并回显 `echostr`。**2026-09-20 14:39 微信页面提交已通过**：网关请求 34ms 内返回 HTTP 200 与数字 `echostr`。安全模式 POST 仍需 43 位 EncodingAESKey 才能解密发货／退款通知。服务端使用安全模式解密、验签并验证消费者 AppID；只在处理持久化成功后返回平台允许的纯文本 `success`。普通业务 action 和管理接口不会通过这条匿名 HTTP 路由开放。

此处「消息推送」用于微信将付款／退款事件通知服务器；此前已配置的「订阅消息模板」用于给用户发送到货提醒，两者配置各有用途。

## 支付确认与异常恢复

前端仅在用户点击购买后登录并请求签名。价格、会员天数、商品及买家身份由服务端固定；客户端支付成功回调只触发查询，不直接开通会员。

微信回调和主动查单共同确认平台订单、正式环境、金额及付款状态，再以事务发放权益。同一订单和平台交易号重复通知不重复发放。查询不确定时保留订单，不自动创建新订单或再次扣款；平台已经建单但未付款时继续等待查单，不复用旧平台单号重新拉起收银台。

取消付款后，若支付参数已签发但平台尚不能返回可信订单状态，页面可能继续保持待确认。尚未取得可靠的官方“订单不存在”错误码合同，不能保证取消后立即重新购买；真实取消与恢复流程须在手机上单独验收。

定时触发器 `gxs-payment-reconcile-five-minutes` 每 5 分钟处理有限数量的订单，使用执行租约防止重叠；前端返回页面时也可以主动查询已知订单。查询与回调可在暂停购买后继续处理在途订单。`GXS_ENABLE_PAYMENT_RECONCILE=true` 已开启；14:35 真实触发返回 `completed` 且扫描 0 笔（尚无待对账订单）。热实例上的匿名云 API 调用不能继承上一轮定时标记。

会员权益按来源订单记录。累计退款只撤销对应订单尚未使用的时长；不会扣掉后来购买或兑换的权益。部分退款先于发放时，在确认原支付后发剩余净权益。缺乏订单归属的历史会员时长保留为既有权益，不反推所属订单。

## 开放购买与真机验收

1. 确认商品 `vip666` 正式发布，金额 700 分；iOS 已设置小程序简称并开通 IAP。
2. 完成密钥、回调 URL 和安全模式配置，确认微信保存验证通过。
3. 部署本版三个云函数，核验订单索引、定时器及前端版本。
4. 管理员将 `memberProduct.enabled` 开启，并展示购买须知：该产品为一次性虚拟服务，一经售出不予退款。配置就绪只说明字段完备，不等于已经完成真单验证。
5. 用户在手机上主动完成一笔 7 元购买，确认平台账单、云端订单、7 天会员到期时间相互一致；助手不代替用户确认扣款。
6. 退出重进、重复查询、重放回调都不能额外增加权益。取消付款不增加会员；已有会员按余期顺延。
7. 分别检查 Android 与 iOS 的实际支付体验。iOS 需微信 8.0.68 及以上；客户端兼容性判断不代替真机支付。
8. 核对退款与回调处理，再开放给正常用户。退款的实际申请和批准由对应支付平台规则决定。

## 官方依据

- [个人虚拟支付接入](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html)：商品配置、直购模式、金额与环境、iOS 要求、支付与补偿流程。
- [查询订单](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order)：平台订单状态及金额字段。
- [补偿发货确认](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_notify_provide_goods)。
- [消息推送安全模式](https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html)。

个人接入页当前列明：Android 等渠道技术服务费 1%，iOS 12%；通常结算周期分别为 T+3 与约 45–60 天，全终端月支付限额为 10 万元。这些是读取当日的公开平台说明，实际适用情况以账号签约协议与支付后台为准。

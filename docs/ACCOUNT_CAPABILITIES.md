# 账号能力与外部配置状态

更新：2026-09-20。本文件区分已经读到的状态、源码实现和仍未完成的外部步骤。

## 当前进展：虚拟支付已开放

用户已恢复支付接入，确认 OfferID `1450655203`、商品 `vip666`、7 元／7 天以及已开通 iOS IAP。云端商品资料已改为 7 天、700 分。1.1.6 实现服务端签名、查单、加密回调、定时补偿与按订单退款；`gxs_api` 已写入公开的消费者 AppID，定时查单身份校验已按本次调用的平台上下文加固。微信消息推送 URL 已于 2026-09-20 14:39 通过 GET 校验。购买开关已打开；购买须知为一次性虚拟服务、一经售出不予退款。2026-09-23 维护者确认真机付款实测通过，可正常购买开通会员；退款链路暂无真机验收记录。见 [配置指引](VIRTUAL_PAYMENT_SETUP.md)。

订阅提醒在 1.1.5 已完成云端模板与消费者令牌鉴权验证；实际用户须主动授权并在真实事件发生后验收送达，见 [订阅配置](SUBSCRIBE_SETUP.md)。共享身份加固和每分钟监测已经部署，自动监测仍仅覆盖有效会员的关注目标。

以下 2026-09-15 的章节保留为历史记录，其「尚未部署／暂缓」描述不代表以上当前进展。

## 支付：按用户要求暂缓（2026-09-15 历史记录）

用户确认主体备案、认证尚未完善，已明确暂停支付开通与配置。当前版本：

- `member.createOrder` 固定返回 `payment_not_enabled`，不创建未付款占位订单。
- `member.status` 与初始化接口显示购买未开放；前端没有可达的收银台或查询支付状态入口。
- 管理员不能通过 `memberProduct.enabled=true` 单独打开支付；后台返回 `payment_deferred`。
- 管理员授予会员继续可用于受控测试，订单创建与会员延期都支持事务幂等。
- 支付服务草稿保存在工程外，不打包到本版本。真实支付签名、回调与对账需下一轮完整实现并验收，不以仓储预留接口代表已接通支付。

待主体完善后，再按[微信官方个人虚拟支付说明](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html)核对账号资格、商品、凭据和平台要求。届时重新核实规则，不以旧费率或结算说明代替后台实际状态。不要把 AppSecret、支付密钥或认证资料发到聊天中。

## 共享环境与身份

- 现有旧版云函数已经能在微信开发者工具加载账号和目录，本轮实际见到查询页与账户页。
- 新版源码只从 `cloud.getWXContext()` 读取身份，跨账号使用 `FROM_APPID/FROM_OPENID` 成对识别；不信任客户端提供的 AppID/OpenID。
- [微信官方共享环境说明](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/resource-sharing/)中 cloudbase_auth 示例明确使用这两个字段；已保存公开文档摘取文本到 `evidence/official/wechat-resource-sharing.txt`。
- 缺少 OPENID 不再直接获得管理员身份；只有明确受信来源或管理员用户键可访问管理接口。
- 本轮尚未部署这些身份加固，需要更新云函数后再次验证共享初始化和管理员入口。

## 数据库权限

本轮只读检查了 12 个 `gxs_` 集合，全部返回 `ADMINONLY`。证据见 `evidence/verification/cloud-permissions.json`，含集合、查询时间与请求编号。

客户端需要通过云函数执行业务。后续部署需补齐源码导出的组合索引；不要为了排障将集合改成所有人可写。

## 订阅提醒

源码已实现消费者小程序专用消息发送器、模板字段映射、持久通知任务、发送前会员/关注/免打扰检查、额度预留和重复发送防护。

仍待外部完成：

1. 在果小哨对应账号选择实际可申请的补货提醒模板，取得模板 ID 和字段编号。
2. 将模板写入 `notifications.templateIds.restock`，按真实模板配置 `templateFields`。
3. 在常驻服务的密钥配置中注入消费者 AppID/AppSecret；资源方小程序凭据不能替代消费者凭据。
4. 用户主动订阅后，再做一次真实发送和手机收信验证。

当前 `notifications.enabled=false`；本轮没有发送真实微信消息。一次性授权需要分别记录并消耗，购买会员不会自动获得无限提醒。微信平台是否受理与用户是否实际看到消息需分开核对。参考[微信订阅消息说明](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html)。

## 常驻监测

- 代码、进程入口、健康检查、Docker 文件和部署参数模板已完成。
- 进程开关、采集开关和消息开关分别控制。默认不会自动连接云环境或启动上游请求。
- 本轮没有创建云托管实例或启用新的持续计费资源。
- 配置、启动、预算与真实验收步骤见 [COLLECTOR_OPERATIONS.md](COLLECTOR_OPERATIONS.md)。

## 上线前其他事项

隐私指引、备案认证、发布审核、产品图片在正式微信环境中的访问，以及真实库存延迟和成本都需要在发布前确认。本地原生编译与离线浏览器检查不能替代手机微信验收。

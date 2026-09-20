# 数据模型与接口约定

版本 1.1.6，更新于 2026-09-20。本文描述当前源码契约，不由文档版本推断部署、真单或微信审核成功。会员兑换与虚拟支付购买共用会员权益；7 元／7 天商品为 `vip666`，购买默认关闭，开放与验收见 [虚拟支付配置](VIRTUAL_PAYMENT_SETUP.md)。

## 1. 数据与身份边界

### 1.1.4 历史数据补充（2026-09-16）

新增 `gxs_observation_days`（仅服务端可访问），主键 `storeNumber|partNumber|dayKey`，索引 `part_day_store`。记录 sampleCount、knownCount、unknownCount、manualCount、autoCount、firstObservedAt、lastObservedAt、firstKnownAt、lastKnownAt。新观测与 latest/events/day 摘要同事务提交；旧 latest/health 不回填，首末时间不表示连续覆盖。

`history.list` 增加 `dataAvailability`、`billing.reason` 和 `observationCoverage`。日摘要在其独立 `checkedAt` 时刻读取后冻结用于分页，不伪装成事件 `snapshotAt` 的严格快照。没有事件时按完整总数原子退还已扣次数；未知采样、有效但无事件、无日摘要分别显示，均不将空事件等同于全天无货。零余额仍有查询前门槛。下文较早的计费说明若有差异，以本补充和当前源码为准。

全部业务集合位于共享环境，前缀为 `gxs_`。客户端禁止直接读写，经过 `gxs_api` 服务端鉴权后访问。时间使用 UTC ISO 8601 字符串，业务日 `dayKey` 使用北京时间 YYYY-MM-DD。

身份仅从 `cloud.getWXContext()` 获取。跨账号调用使用完整的 FROM_APPID + FROM_OPENID，本账号调用使用 APPID + OPENID，用户主键为 appid:openid。请求中自报的 openid、会员状态或余额没有授权作用。

没有 OPENID 不自动成为管理员。平台操作来源必须经过 `lib/identity.js` 的来源链白名单校验；有用户身份时必须命中 adminUserKeys。HTTP 仅开放 `/payment/callback` 的微信安全模式回调，不将 HTTP 请求交给普通 action 路由。共享鉴权函数不接受 event.fromAppid 替代 SDK 的 FROM_APPID。

## 2. 集合与关键字段

- `gxs_users`：用户主键 appid:openid。保存会员到期时间、次数余额、免打扰与提醒设置、订阅授权账本、统计。
- `gxs_quota_ledger`：确定性操作 ID。保存 userKey/type/delta/balanceAfter/dayKey/refId/createdAt；与用户余额同事务提交。
- `gxs_queries`：实时查询主键 userKey|queryId，历史查询主键 userKey|history|historyQueryId。绑定 SKU、门店、日期及操作类型，保存状态、执行租约、扣次信息和响应。首次扣次与 pending 记录同事务写入，结果及失败退次同事务完成。
- `gxs_follows`：主键 userKey|followId。保存 partNumber/storeNumbers/status/statusReason；保存状态为 active、paused、removed。展示时可返回派生 expired 与原始 savedStatus，到期不会伪装成正在监测。
- `gxs_latest`：主键 storeNumber|partNumber。保存 status/statusSince/observedAt/knownAt/unknownSince/quote/sampleCount 等。latest 和对应状态事件同事务提交；旧观测不能覆盖新观测。
- `gxs_events`：确定性状态迁移 ID，保存目标、事件类型、北京时间业务日、发现时间、前后状态和原始取货说明。notificationPlannedAt 用于持久提醒消费者去重规划。
- `gxs_target_health`：目标与时间桶键。保存采样成功间隔、请求错误等健康数据。
- `gxs_orders`：兑换与管理员发放保留原主键。虚拟支付订单主键及平台单号为 `G + SHA256(userKey|orderId)前31位`，保存服务器固定的商品、买家、700 分及 7 天快照。兑换订单继续使用 `redeem_launch_30d_v1`、`type=membership_redemption`、`source=redemption_code`、`days=30`、`amountFen=0`。用户会员发放与订单 `fulfilled` 同事务完成；新增 `membership.entitlements` 按订单记录剩余时长，累计退款只撤销所属订单未用权益。
- `gxs_notifications`：主键 userKey|eventId。保存 pending、sending、accepted、failed、uncertain 或 skipped 状态，发送租约、模板、原因及授权预占信息。
- `gxs_config`：runtime、catalog、collector_lease、collector_status，以及预算计数、订阅操作去重、提醒冷却等文档。兑换错误计数保存在 `member_redemption_attempts_<用户哈希>`，包括 userKey、failures、lockedUntil、updatedAt；正确码及输入明文不入库。不能对整个集合无条件启用 TTL 删除。
- `gxs_catalog_stores`：门店主键 R###，保存名称、城市、省份、地址。
- `gxs_catalog_products`：商品主键 partNumber，保存品类、系列、型号、标题、属性、价格、供应接口支持状态和精确产品图片来源。图片映射不能替代供应接口验证。

索引唯一来源为 `cloudfunctions/gxs_api/lib/collections.js` 的 INDEX_PLAN。运行 `node tools/db/export-plan.mjs` 导出 `config/database-deployment-plan.json`。数据库操作与 SDK 契约验证详见 [后端与数据库说明](BACKEND_RELIABILITY_AND_DATABASE.md)。

## 3. 次数与查询幂等

相同 ID 和相同参数重放不会重复扣次、退款或发放。相同 ID 改变参数返回冲突，客户端应为新操作创建新 ID。签到按用户与北京时间日去重，任务再加入 taskId；查询扣次/退款以用户、queryId、操作类型确定账本 ID。免费次数每日奖励上限和余额上限在同一用户事务内检查，并发点击不能越限。

查询执行租约为 25 秒；存活执行者失去租约后不能覆盖接管者的结果。异常中断可沿用原 ID 恢复。用户重新 bootstrap 时会清算租约过期超过 2 分钟的 pending 记录，每次最多 20 条，退回已扣次数并标记 query_expired。

## 4. 库存事件语义

- first_seen_available：第一次观测就可取货，不声称发生过补货。
- restock_confirmed：在连续已知观测覆盖下，由不可取货转为可取货。
- recovered_available：出现 unknown 或观测断档后再次可取货，不能证明中间是否补货。
- became_unavailable：从可取货变为不可取货，记录可观测的持续时间。
- status_changed：其他已知状态间变化。

接口失败产生的 unknown 不覆盖最后已知业务状态，但展示时会明确标记未知/过期，不将旧库存当作当前保证。真实库存以 Apple 当时的取货页面为准。

关注页、查询关注摘要和历史最近观测共用 `utils/format.js` 的 `stockObservation`：超过 2 分钟的旧观测显示「待更新」，旧值单独标记为「上次有效结果」；缺少时间为「等待首次观测」，服务端 `isStale/unknownSince` 或未知状态显示「状态待确认」。该展示有效期与后端判断事件连续性的窗口用途不同。列表读取不会更新 observedAt 或制造新样本；本地模拟同样遵守此规则。

## 5. 调用形式

```js
// 请求
{ action: 'query.pickup', payload: { queryId, partNumber, storeNumbers } }
// 成功返回，业务拒绝仍可能由 data.ok=false 表示
{ ok: true, data: { /* action 返回值 */ }, serverTime, requestId }
// 参数、鉴权或服务异常
{ ok: false, error: { code, message, details }, serverTime, requestId }
```

幂等 ID 使用 8–64 位字母、数字、下划线或连字符。前端 utils/api.js 的 newId 负责生成；网络结果不确定时保留原 ID 重试。

主要业务原因包括 insufficient_credits、query_in_progress、query_expired、query_failed、new_product_restricted、new_product_history_restricted、upstream_unavailable、payment_not_enabled。客户端不能把外层 ok=true 一概当作业务成功。

## 6. 动作

### 用户、目录和次数

- `system.ping`：返回版本及身份摘要，不授予权限。
- `user.bootstrap`：创建或刷新用户，清算弃置查询，返回会员、次数、任务、关注限额、通知模板、设置、采集状态和目录版本。
- `user.updateSettings`：更新 notifyEnabled 与 dnd: { enabled, startMinute, endMinute }。
- `catalog.get`：支持 ifVersion；版本未变返回 unchanged，否则返回商品和门店，包括图片与图片版本。
- `quota.signin`、`quota.completeTask`：签到和已满足条件的体验任务发奖；按北京时间日去重。
- `quota.ledger`：最近次数账本。

### 实时与历史

- `query.pickup`：{ queryId, partNumber, storeNumbers }，最多 3 家店；非会员按配置扣次，会员不限次数。全部上游未知则退款，部分成功保留有效结果。返回查询时的商品与门店，不受后来选择变化影响。
- `query.recent`：最近手动查询记录。
- `history.list`：{ historyQueryId, partNumber, storeNumbers?, dayKey?, cursor?, limit? }。最多 10 家店，默认每页 100 条、最大 200 条。后续页沿用同一查询 ID 和筛选条件，不重复扣次。

历史返回 pagination.nextCursor/hasMore/total/snapshotAt，以发现时间和事件 ID 双字段稳定排序。summary 按全日数据计算，lastHourRestocks 相对首轮 snapshotAt 统计，不只计算当前页。当前库存另有 latestSnapshotAt/isStale/lastKnownStatus；受新品限制的非会员查旧历史时 latestRestricted=true，不泄露当前库存。

### 关注、会员和提醒

- `follow.list/upsert/pause/resume/remove`：有效会员最多关注 3 个具体 SKU，每个 SKU 最多 3 家店。不同容量/颜色分别占用名额。upsert 传 followId、partNumber、storeNumbers；到期不能恢复监测。
- `member.status`：真实会员状态、商品、支付关闭原因及最近会员记录；记录增加 type、source、campaignId，区分兑换与其他会员发放来源。
- `member.redeemCode`：`{ code, requestId? }`，返回 `{ redeemed: true, alreadyRedeemed, membership }`，membership 与 bootstrap 使用同一结构。活动码 `hbw666` 忽略大小写及首尾空白；每个可信账号仅领取一次 30 天，有效会员顺延。重复兑换及到期后重试返回 alreadyRedeemed=true，不增加天数；幂等依据账号与活动，不依赖客户端 requestId。正式版和体验版均调用真实后端，开发模拟必须先退出。
- `member.createOrder`：`{ orderId, loginCode }`，以可信账号创建幂等订单，商品与金额来自服务端配置，返回 `{ ok, order, payment }`；未就绪返回 `payment_not_enabled`。`payment` 为服务器签名的微信收银参数，已进入平台的订单不会盲目再次拉起收银台。
- `member.checkOrder`：`{ orderId }`，仅查询本人订单，返回 `{ order, membership }`。服务端核验微信订单后事务发放权益，支付结果不确定为 `payment_check_pending`；不存在或非本人订单统一 `unknown_order`。前端付款回调不能替代该核验。
- `notify.recordSubscription`：{ requestId, results: { templateId: 'accept'|'reject'|'ban' } }。只接受已配置模板，原 requestId 重试不重复增加本地授权额度；微信平台最终决定能否发送。
- `notify.list`：`{ limit?, cursor? }`，默认 20 条、最多 100 条；返回 `{ notifications, nextCursor, hasMore, clearBefore }`。按创建时间与 ID 稳定分页，后续页保持首轮快照。accepted 只表示平台受理，uncertain 不自动重发。
- `notify.delete`：`{ id }`，仅本人可删除；返回 `{ deleted: true }`，重试幂等。通过 `userHiddenAt` 从个人列表移除，内部发送记录继续保留。
- `notify.clear`：`{ before: clearBefore }`，返回 `{ cleared: true, before }`。清空服务端令牌对应快照内本人全部提醒，包含尚未加载的页面；快照后新入库提醒保留。`clearBefore` 与 `cursor` 为签名不透明字符串，前端原样传递，不生成或修改内容。

删除与清空不取消关注、不撤回微信消息、不删除共享库存事件，也不改变在途发送、授权额度、冷却与去重。新通知保存时事务分配 `viewSequence`；`gxs_config` 自动维护本用户的序号、清空水位和签名密钥，不需手动配置。API 与常驻消费者须同步使用本版代码，旧数据兼容按快照时间读取/清空。详细事务和索引见 [后端与数据库说明](BACKEND_RELIABILITY_AND_DATABASE.md)。

兑换错误：`invalid_redemption_code` 返回 `details.remainingAttempts`；连续 5 次错误后为 `redemption_rate_limited`，返回 retryAt/retryAfterSeconds 并锁定 15 分钟；活动关闭为 `redemption_disabled`，异常兑换记录为 `redemption_conflict`。错误计数先事务提交再生成 API 错误，避免异常回滚使限流失效。成功验证会重置连续错误计数；当前锁定期间正确码也要等待锁定结束。活动详情见 [会员兑换配置](MEMBER_REDEMPTION.md)。

### 管理

- `admin.getConfig/updateConfig`：读取配置；更新时在服务端事务内重新读取 runtime、合并本次 patch、校验并写入。并发局部修改不会覆盖其他更新或把已关闭的兑换重新打开。支付开关可在完成外部配置后启用，商品必须匹配 7 天、700 分；密钥缺失时仍不能生成收银参数。`virtualPayment` 仅接受 OfferID、商品 ID 和 iOS 开关，不保存密钥。
- `admin.seedCatalog`：将函数包内目录写入云端，属于实际数据操作，不在本轮本地验收中执行。
- `admin.grantMembership/grantCredits`：传目标 userKey、days 或 amount、grantId、可选 note；幂等且校验冲突参数。
- `admin.stats/lookupUser`：运行统计、用户与关注查询。

## 7. 默认配置与运行条件

lib/config.js 是默认值与校验的唯一来源。主要默认值：签到 +1，历史体验任务 +1，每日最多奖励 2 次，余额最多 10 次，实时和历史每次各消耗 1 次；付费会员为 7 元／7 天，购买默认关闭，兑换活动仍为 30 天。`memberRedemption.enabled` 默认为 true，可经管理员关闭；兑换事务再次读取开关，不接受客户端自报活动、天数或会员有效期。新品窗口为空，需录入真实开售资料后才启用对应限制。

自动采集默认关闭，目标间隔 8 秒、并发 2、每请求最多 20 SKU、每分钟最多 60 次、每天最多 10,000 次。订阅通知默认关闭；须配置消费者小程序的真实模板和服务端凭证。监测和消息的部署、预算及状态语义详见 [采集运行手册](COLLECTOR_OPERATIONS.md)。

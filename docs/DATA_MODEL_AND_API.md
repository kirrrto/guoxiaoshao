# 数据模型与接口约定

当前源码契约，更新于 2026-10-01。不由文档日期推断部署、真单或微信审核成功；本次查询容量修复尚未读取实际云端 runtime 或部署。会员兑换与虚拟支付购买共用会员权益；7 元／7 天商品为 `vip666`，购买默认关闭，开放与验收见 [虚拟支付配置](VIRTUAL_PAYMENT_SETUP.md)。

## 1. 数据与身份边界

### 1.1.4 历史数据补充（2026-09-16）

新增 `gxs_observation_days`（仅服务端可访问），主键 `storeNumber|partNumber|dayKey`，索引 `part_day_store`。记录 sampleCount、knownCount、unknownCount、manualCount、autoCount、firstObservedAt、lastObservedAt、firstKnownAt、lastKnownAt。新观测与 latest/events/day 摘要同事务提交；旧 latest/health 不回填，首末时间不表示连续覆盖。

`history.list` 增加 `dataAvailability`、`billing.reason` 和 `observationCoverage`。日摘要在其独立 `checkedAt` 时刻读取后冻结用于分页，不伪装成事件 `snapshotAt` 的严格快照。没有事件时按完整总数原子退还已扣次数；未知采样、有效但无事件、无日摘要分别显示，均不将空事件等同于全天无货。零余额仍有查询前门槛。下文较早的计费说明若有差异，以本补充和当前源码为准。

全部业务集合位于共享环境，前缀为 `gxs_`。客户端禁止直接读写，经过 `gxs_api` 服务端鉴权后访问。时间使用 UTC ISO 8601 字符串，业务日 `dayKey` 使用北京时间 YYYY-MM-DD。

身份仅从 `cloud.getWXContext()` 获取。跨账号调用使用完整的 FROM_APPID + FROM_OPENID，本账号调用使用 APPID + OPENID，用户主键为 appid:openid。请求中自报的 openid、会员状态或余额没有授权作用。

没有 OPENID 不自动成为管理员。平台操作来源必须经过 `lib/identity.js` 的来源链白名单校验；有用户身份时必须命中 adminUserKeys。HTTP 仅开放 `/payment/callback` 的微信安全模式回调，不将 HTTP 请求交给普通 action 路由。共享鉴权函数不接受 event.fromAppid 替代 SDK 的 FROM_APPID。

## 2. 集合与关键字段

- `gxs_users`：用户主键 appid:openid。保存会员到期时间、次数余额、免打扰与提醒设置、订阅授权账本、统计。`firstReminderSentAt` 记录账号第一条到货提醒发出（或结果未知）的时间，有它就不再有新用户免费提醒；`freeReminderTaskId` 是免费提醒发送期间的锁，发送结束即清空。
- `gxs_quota_ledger`：确定性操作 ID。保存 userKey/type/delta/balanceAfter/dayKey/refId/createdAt；与用户余额同事务提交。
- `gxs_queries`：实时查询主键 userKey|queryId，历史查询主键 userKey|history|historyQueryId。绑定 SKU、门店、日期及操作类型，保存状态、执行租约、扣次信息和响应。首次扣次与 pending 记录同事务写入，结果及失败退次同事务完成。
- `gxs_follows`：主键 userKey|followId。保存 partNumber/storeNumbers/status/statusReason；保存状态为 active、paused、removed。展示时可返回派生 expired 与原始 savedStatus，到期不会伪装成正在监测。
- `gxs_latest`：主键 storeNumber|partNumber。保存 status/statusSince/observedAt/knownAt/unknownSince/quote/sampleCount 等。latest 和对应状态事件同事务提交；旧观测不能覆盖新观测。
- `gxs_events`：确定性状态迁移 ID，保存目标、事件类型、北京时间业务日、发现时间、前后状态和原始取货说明。notificationPlannedAt 用于持久提醒消费者去重规划。
- `gxs_target_health`：旧版按目标与分钟桶写入的健康数据，没有任何接口读取；当前代码已不再写入，各目标健康数据保存在 `collector_status` 的调度检查点中。云端已有文档可在控制台删除。
- `gxs_orders`：兑换与管理员发放保留原主键。虚拟支付订单主键及平台单号为 `G + SHA256(userKey|orderId)前31位`，保存服务器固定的商品、买家、700 分及 7 天快照。兑换订单继续使用 `redeem_launch_30d_v1`、`type=membership_redemption`、`source=redemption_code`、`days=30`、`amountFen=0`。用户会员发放与订单 `fulfilled` 同事务完成；新增 `membership.entitlements` 按订单记录剩余时长，累计退款只撤销所属订单未用权益。
- `gxs_notifications`：主键 userKey|eventId。保存 pending、sending、accepted、failed、uncertain 或 skipped 状态，发送租约、模板、原因及授权预占信息。用户在提醒落地卡片回答后写入 `feedback: { outcome: bought|missed|skipped, at }`。
- `gxs_observation_days`：主键 storeNumber|partNumber|dayKey，每个目标每天一条观测摘要：样本数、已知/未知/手动/自动计数、首末观测时间，以及 `eventCounts`（当天各类事件数）、`firstAvailableAt`（当天首次可取货）、`availableWindows`（可取货窗口的次数、总时长、最长、最短，毫秒）。与 latest、事件同事务更新。
- `gxs_config`：runtime、catalog、collector_lease、collector_status，以及容量状态、请求计数、订阅操作去重、提醒冷却等文档。`upstream_capacity` 保存连续容量的 version、tokens、capacities、rates、lastDemandAt、updatedAtMs；跨日和冷启动不重置，不按日清理。`collector_budget_<北京时间日期>` 保存 dayCount、minuteKey、minuteCount、autoCount、manualCount；continuous 模式每日计数只用于核对消耗。`query_target_<门店与 SKU 的哈希>` 保存跨实例手动刷新租约与短时失败等待状态。兑换错误计数保存在 `member_redemption_attempts_<用户哈希>`，包括 userKey、failures、lockedUntil、updatedAt；正确码及输入明文不入库。不能对整个集合无条件启用 TTL 删除。
- `gxs_catalog_stores`：门店主键 R###，保存名称、城市、省份、地址。
- `gxs_catalog_products`：商品主键 partNumber，保存品类、系列、型号、标题、属性、价格、供应接口支持状态和精确产品图片来源。图片映射不能替代供应接口验证。

索引唯一来源为 `cloudfunctions/gxs_api/lib/collections.js` 的 INDEX_PLAN。运行 `node tools/db/export-plan.mjs` 导出 `config/database-deployment-plan.json`。2026-09-23 起计划不再包含 5 个前缀冗余索引：`gxs_quota_ledger.user_day`、`gxs_queries.user_created`、`gxs_events.part_day_detected`、`gxs_notifications.user_created`、`gxs_notifications.status_created`，它们的字段和方向与同集合更长索引的开头完全相同，查询可由更长索引承担；云端这 5 个已于 2026-09-23 在控制台删除。

**数据保留 10 天**：定时监测每天北京时间 04:00 后的第一次运行执行一次清理（`lib/engine/retention.js`），保留最近 10 个北京时间日（含当天）。`gxs_events` 按 dayKey 删除更早数据；`gxs_queries`（pending 除外，它可能仍需退还次数）、`gxs_notifications`（pending、sending 除外）、`gxs_target_health`，以及 `gxs_config` 中的订阅授权去重、查询限流和每日预算计数按时间删除。用户、次数账本、订单、关注、当前观测、每日观测摘要（`gxs_observation_days`，长期保留用于统计到货规律）、支付回执、兑换计数与运行配置不清理。每次结果写入 `gxs_config/retention_status`，部分失败次日重试。历史查询只接受最近 10 天，更早日期返回 `history_day_expired` 且不扣次。数据库操作与 SDK 契约验证详见 [后端与数据库说明](BACKEND_RELIABILITY_AND_DATABASE.md)。

## 3. 次数与查询幂等

相同 ID 和相同参数重放不会重复扣次、退款或发放。相同 ID 改变参数返回冲突，客户端应为新操作创建新 ID。签到按用户与北京时间日去重，任务再加入 taskId；查询扣次/退款以用户、queryId、操作类型确定账本 ID。免费次数每日奖励上限和余额上限在同一用户事务内检查，并发点击不能越限。

查询执行租约为 25 秒；存活执行者失去租约后不能覆盖接管者的结果。异常中断可沿用原 ID 恢复。用户重新 bootstrap 时会清算租约过期超过 2 分钟的 pending 记录，每次最多 20 条，退回已扣次数并标记 query_expired。

不同用户/查询 ID 的相同门店与 SKU 还可共享近期有效样本。`query.sharedFreshnessSeconds` 默认 10 秒，允许 0–30 秒；0 关闭复用。通过已有权限和次数门槛后，先读有效样本，缺失时通过目标租约合并手动刷新。样本必须为已知状态、没有 unknownSince、时间不在未来且严格小于有效期；自动采集产生的样本也可复用。复用不写回观测，不增加 sampleCount，不触发新事件或复查确认，保留原 observedAt。没有取得新的有效结果时退回已扣次数；有复用结果但没有新的有效结果时以 `billingReason: 'shared_result_no_charge'` 区分全部失败。

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

主要业务原因包括 insufficient_credits、query_in_progress、query_expired、query_failed、new_product_restricted、new_product_history_restricted、upstream_unavailable、upstream_budget_limited、query_refresh_pending、payment_not_enabled。客户端不能把外层 ok=true 一概当作业务成功。

## 6. 动作

### 用户、目录和次数

- `system.ping`：返回版本及身份摘要，不授予权限。
- `user.bootstrap`：创建或刷新用户，清算弃置查询，返回会员、次数、任务、关注限额、通知模板、设置、采集状态和目录版本。`freeReminder=true` 表示账号还有新用户免费提醒；此时 `limits.maxFollows` 为 1，会员为 3。
- `user.updateSettings`：更新 notifyEnabled 与 dnd: { enabled, startMinute, endMinute }。
- `catalog.get`：支持 ifVersion；版本未变返回 unchanged，否则返回商品和门店，包括图片与图片版本。
- `quota.signin`、`quota.completeTask`：签到和已满足条件的体验任务发奖；按北京时间日去重。
- `quota.ledger`：最近次数账本。

### 实时与历史

- `query.pickup`：{ queryId, partNumber, storeNumbers }，默认最多 3 家店；非会员取得新的有效结果时按配置扣次，会员不扣次数。全部失败、全部复用，或仅复用成功而其余门店失败时退回预扣次数。返回查询时的商品与门店，不受后来选择变化影响。
- `query.recent`：最近手动查询记录。
- `history.list`：{ historyQueryId, partNumber, storeNumbers?, dayKey?, cursor?, limit? }。最多 10 家店，默认每页 100 条、最大 200 条。后续页沿用同一查询 ID 和筛选条件，不重复扣次。

实时查询响应补充字段：

| 字段 | 契约 |
|---|---|
| `sharedResult` | 至少一个结果复用了有效样本。 |
| `allShared` | 所有返回结果都复用有效样本；包含失败门店时不能仅因成功门店都复用就设为 true。 |
| `results[].reused` | 该门店结果来自已有样本，`observedAt` 为真实原始采集时间；`queriedAt` 仅是本次查询时间。 |
| `billingReason` | `shared_result_no_charge` 表示展示了已有有效样本，但本次没有取得新的有效结果，不收取查询次数。 |
| `charged` / `refunded` / `balance` | 由服务端账本确定；免费用户复用时可能先扣后返，净扣次为 0。客户端不自行计算退款。 |
| `reason` / `budgetScope` | 容量暂缺映射为 `upstream_budget_limited` / `continuous`；分钟上限为 `minute`；显式旧模式日上限为 `daily`。其他实例仍在刷新为 `query_refresh_pending`。 |
| `retryAfterMs` | 预计可重试的等待毫秒数，不保证等待结束后一定取得结果。只有 `daily` 可提示北京时间次日 00:00，continuous 不提示等至午夜。 |

有效复用结果仍是带采集时间的快照；未知或过期不能伪装成实时结果。客户端手动重试，不自动循环发起可能扣次的查询。

历史返回 pagination.nextCursor/hasMore/total/snapshotAt，以发现时间和事件 ID 双字段稳定排序。summary 按全日数据计算，lastHourRestocks 相对首轮 snapshotAt 统计，不只计算当前页。当前库存另有 latestSnapshotAt/isStale/lastKnownStatus；受新品限制的非会员查旧历史时 latestRestricted=true，不泄露当前库存。

### 关注、会员和提醒

- `follow.list/upsert/pause/resume/remove`：有效会员最多关注 3 个具体 SKU，每个 SKU 最多 3 家店；有免费提醒的新用户最多 1 个。不同容量/颜色分别占用名额。upsert 传 followId、partNumber、storeNumbers；会员到期或免费提醒用完后不能新增或恢复监测（`member_required`）。list 同时返回 `freeReminder` 与对应的 `limits`。

新用户免费提醒：从未收到过到货提醒（没有 `firstReminderSentAt`）的非会员账号可以关注、记录授权并被监测，直到第一条提醒发出。第一条提醒无论是否会员发出都会写入 `firstReminderSentAt`，所以会员到期后不会重新获得免费提醒。发送端在预占授权次数时把免费提醒锁定到一个任务，并发事件得到 `free_reminder_in_use`；微信明确拒绝则解锁，可用于下一次补货；已受理或结果未知记为已用，之后的任务为 `free_reminder_used`。发送服务崩溃遗留的锁在下一次预占时按原任务结果处理。
- `member.status`：真实会员状态、商品、支付关闭原因及最近会员记录；记录增加 type、source、campaignId，区分兑换与其他会员发放来源。
- `member.redeemCode`：`{ code, requestId? }`，返回 `{ redeemed: true, alreadyRedeemed, membership }`，membership 与 bootstrap 使用同一结构。活动码忽略大小写及首尾空白（明文不写入文档）；每个可信账号仅领取一次 30 天，有效会员顺延。全活动名额由 `memberRedemption.maxClaims` 控制（默认 20，含上线前已兑换账号），计数保存在 `gxs_config/member_redemption_claims_launch_30d_v1` 并与兑换同事务递增；名额用完返回 `redemption_sold_out`。重复兑换及到期后重试返回 alreadyRedeemed=true，不增加天数；幂等依据账号与活动，不依赖客户端 requestId。正式版和体验版均调用真实后端，开发模拟必须先退出。
- `member.createOrder`：`{ orderId, loginCode }`，以可信账号创建幂等订单，商品与金额来自服务端配置，返回 `{ ok, order, payment }`；未就绪返回 `payment_not_enabled`。`payment` 为服务器签名的微信收银参数，已进入平台的订单不会盲目再次拉起收银台。
- `member.abandonOrder`：`{ orderId }`，仅本人订单。先向微信核对一次：已付款正常开通；仍为未付款的 `created` 订单写入 `abandonedAt`，返回 `order.abandoned=true`、`paymentPending=false`。已放弃的订单继续参与查单和支付回调，之后付款仍会开通。
- `member.checkOrder`：`{ orderId }`，仅查询本人订单，返回 `{ order, membership }`。服务端核验微信订单后事务发放权益，支付结果不确定为 `payment_check_pending`；不存在或非本人订单统一 `unknown_order`。前端付款回调不能替代该核验。
- `notify.recordSubscription`：{ requestId, results: { templateId: 'accept'|'reject'|'ban' } }。有效会员或仍有免费提醒的账号可记录，否则返回 `membership_required`；只接受已配置模板。每个 accept 记 1 次提醒并累加，原 requestId 重试不重复增加；微信平台最终决定能否发送。
- `notify.list`：`{ limit?, cursor? }`，默认 20 条、最多 100 条；返回 `{ notifications, nextCursor, hasMore, clearBefore }`。按创建时间与 ID 稳定分页，后续页保持首轮快照。accepted 只表示平台受理，uncertain 不自动重发。
- `notify.detail`：`{ eventId }`，到货提醒落地页使用。消息卡片跳转 `pages/follow/index?eid=<encodeURIComponent(eventId)>`；服务端用 `当前 userKey|eventId` 读取，只能读到自己的提醒。返回 `{ notification, latest, follow }`：提醒的商品、门店、发现时间、发送状态与已有反馈；目标当前观测（字段同关注列表门店，受限新品对非会员 `restricted=true`）；对应关注的 ID 与状态。超过保留期或已删除为 `notification_not_found`。
- `notify.feedback`：`{ eventId, outcome: 'bought'|'missed'|'skipped' }`，记录「买到了吗」，可改答。`bought` 且关注仍开启时暂停该关注，返回 `{ outcome, paused }`。
- `notify.delete`：`{ id }`，仅本人可删除；返回 `{ deleted: true }`，重试幂等。通过 `userHiddenAt` 从个人列表移除，内部发送记录继续保留。
- `notify.clear`：`{ before: clearBefore }`，返回 `{ cleared: true, before }`。清空服务端令牌对应快照内本人全部提醒，包含尚未加载的页面；快照后新入库提醒保留。`clearBefore` 与 `cursor` 为签名不透明字符串，前端原样传递，不生成或修改内容。

删除与清空不取消关注、不撤回微信消息、不删除共享库存事件，也不改变在途发送、授权额度、冷却与去重。新通知保存时事务分配 `viewSequence`；`gxs_config` 自动维护本用户的序号、清空水位和签名密钥，不需手动配置。API 与常驻消费者须同步使用本版代码，旧数据兼容按快照时间读取/清空。详细事务和索引见 [后端与数据库说明](BACKEND_RELIABILITY_AND_DATABASE.md)。

兑换错误：`invalid_redemption_code` 返回 `details.remainingAttempts`；连续 5 次错误后为 `redemption_rate_limited`，返回 retryAt/retryAfterSeconds 并锁定 15 分钟；活动关闭为 `redemption_disabled`，异常兑换记录为 `redemption_conflict`。错误计数先事务提交再生成 API 错误，避免异常回滚使限流失效。成功验证会重置连续错误计数；当前锁定期间正确码也要等待锁定结束。活动详情见 [会员兑换配置](MEMBER_REDEMPTION.md)。

### 管理

- `admin.getConfig/updateConfig`：读取配置；更新时在服务端事务内重新读取 runtime、合并本次 patch、校验并写入。并发局部修改不会覆盖其他更新或把已关闭的兑换重新打开。支付开关可在完成外部配置后启用，商品必须匹配 7 天、700 分；密钥缺失时仍不能生成收银参数。`virtualPayment` 仅接受 OfferID、商品 ID 和 iOS 开关，不保存密钥。
- `admin.seedCatalog`：将函数包内目录写入云端，属于实际数据操作，不在本轮本地验收中执行。
- `admin.grantMembership/grantCredits`：传目标 userKey、days 或 amount、grantId、可选 note；幂等且校验冲突参数。
- `admin.stats/lookupUser`：运行统计、用户与关注查询。
- `admin.capacity`：`{}`。经现有 `gxs_api` 管理员鉴权只读查询容量配置、最近监测状态、当天预占计数和查询复用抽样；不预占/补充容量、不探测上游、不创建用户，不返回用户身份或目标列表。`mode/maxRequestsPerMinute/sustainedDailyTarget` 来自配置，`hardDailyLimit` 只在 daily 模式返回。`uniqueGroups/plannedIntervalSeconds` 来自最近 collector_status，必须结合 `collectorStatusUpdatedAt/collectorStatusStale` 判断是否仍可用。`normalCadenceSeconds` 为配置常规间隔与运行模式下限的较大值，`configuredNormalRequestsPerDay` 为该间隔下的估计采集需求，`autoRequestsPerDay` 为自动来源份额；`aboveAutoCapacity=true` 表示配置期望的常规采集需求超过自动份额，需要接受调度降速或验证后扩容，不表示已发生超额 HTTP。
- `admin.insights`：`{ days? }`（1–10，默认 7）。统计最近事件与提醒（各最多 2000 条，超过时 `truncated=true`）：`availability` 为 became_unavailable 事件的可取货时长（count、p50Ms、p90Ms、maxMs、分段 buckets）；`alerts` 为提醒任务总数、按状态与未发送原因计数、`noCreditShare`（因没有授权次数未发送的占比）、`sendDelay`（已受理提醒从发现到发出的延迟）；`feedback` 为「买到了吗」回答数与买到占比。

管理员容量读数通过 `{ action: 'admin.capacity', payload: {} }` 调用，补充字段如下；实际读数解释和发布核对见 [查询容量](QUERY_CAPACITY.md)。

| 字段 | 读取边界 |
|---|---|
| `todayReservations` | date、available、total、auto、manual、unclassified、sourceSplitComplete。计数为预占次数，不是精确已完成 HTTP 数；available=false 表示当天计数文档缺失，不能等同于已确认零请求。旧记录可能没有来源字段。 |
| `tokenSnapshot` | recordedAt、tokens、burstCapacity、refillPerSecond（均按 shared/auto/manual）。值为最后持久化时的快照，接口不按当前时间推算剩余容量或进行 refill；没有状态时为 null。 |
| `recentQueryReuse` | 从北京时间当天起创建的最新最多 2000 条查询文档抽样，仅已完成的 live 查询参与目标计数。包含 sampledRecords、sampleLimit、truncated、completedLiveQueries、freshTargets、reusedTargets、unclassifiedTargets、unknownTargets、reuseShareOfClassifiedTargets、attributionComplete。恰好达到上限也标记 truncated。 |

复用比例只在明确归类的 fresh/reused 目标中计算，不是全部查询或 HTTP 的命中率；旧记录缺少 reused 标记时归为 unclassified，不能当作新采集。unknown 单独统计。监测状态已过期、来源归类不完整或抽样被截断时，不能把估算推广为完整线上容量结论；提高速率前应验证上游、云函数、数据库与真实覆盖间隔。

## 7. 默认配置与运行条件

lib/config.js 是默认值与校验的唯一来源。主要默认值：签到 +1，历史体验任务 +1，每日最多奖励 2 次，余额最多 10 次，实时和历史每次各消耗 1 次；付费会员为 7 元／7 天，购买默认关闭，兑换活动仍为 30 天。`memberRedemption.enabled` 默认为 true，可经管理员关闭；兑换事务再次读取开关，不接受客户端自报活动、天数或会员有效期。新品窗口为空，需录入真实开售资料后才启用对应限制。

自动采集默认关闭，配置目标间隔 8 秒、并发 2、每请求最多 20 SKU。`collector.budgetMode` 默认 `continuous`：每分钟硬上限 60，`maxRequestsPerDay=10000` 表示全天持续补充速率目标，并允许不超过分钟容量的有界突发；实际常规间隔会根据独立请求组数拉长。自动与手动来源持续速率占比 80% / 20%，支持有界空闲借用。显式 `daily` 才保留北京时间自然日硬上限及次日恢复。配置、迁移、观测指标与测试边界见 [查询容量](QUERY_CAPACITY.md)。订阅通知默认关闭；须配置消费者小程序的真实模板和服务端凭证。监测和消息部署见 [采集运行手册](COLLECTOR_OPERATIONS.md)。

# 2.0.0 增长采集、付款事实与实验候选

本文件记录本地实现和离线验收边界。没有查询生产数据库、修改线上开关、部署集合、支付、退款或发送真实通知；没有真实转化提升结论。

## 默认关闭与安全回退

`user.bootstrap` 新增 `features` 和 `experiment`。`features` 下列开关全部默认 `false`：

| 开关 | 作用 |
| --- | --- |
| contextualCheckout | 目标上下文开通入口 |
| resultNextAction | 查询结果下一步 |
| activationJourney | 付款后启用提示 |
| targetEvidence | 有权限的目标证据展示 |
| growthEvents | 可丢弃的前端事件采集 |
| experimentAssignments | 账户稳定分组 |
| launchGuide | 有公开来源的新品准备卡 |

运营工具配置编辑器可编辑 `features`、`growthExperiment`，复用现有管理员鉴权、配置版本冲突保护与脱敏变更审计。发布候选代码不打开这些生产开关。关闭 UI 开关不会取消已保存关注、删除待支付订单、调整价格或发放/回收权益。关闭 `growthEvents` 或 `experimentAssignments` 可单独生效，当前实验特征同步回到对照行为。

`growthExperiment` 只容纳一个对象：`{id, assignmentVersion, mode, feature, allocationPercent}`。`mode` 为 `off / aa / ab`；实验特征仅允许四个主链路 UI 开关，价格、名额、查询计费和权益账本不在实验配置范围内。默认 `mode: off`、`allocationPercent: 0`。

账户以可信微信上下文的 `appid:openid` 做确定性哈希分桶；同 `id` 和 `assignmentVersion` 的账号始终保留原分组。实验流量内对照/变体各约一半；增加比例只扩大纳入桶，既有账户不换组。A/A 两组都呈现对照行为。改变实验含义、目标特征或假设时须递增版本或使用新 ID，不能把不同实验的队列合并。首次有效目标保存当时的实验 ID、版本、模式与组别；后续回退不能重写该意向。前端输入的实验组完全不被采用。

默认代码没有宣称 A/A 完成，没有实现统计显著性、序贯检验、自动胜出或自动扩量。开启实验前仍需有采集覆盖评估、真实基线、设备分层、最小业务增量及预设样本量/终点。已有真实付费者在报表按订单历史从首付队列排除，不把续费混为首付。

## 事件契约与负载边界

入口 `growth.ingest`：`{events: [...]}`，只接受已 bootstrap 的可信账户。`userKey`、openid、匿名关联、实验组、金额和支付结果证明均不能由 payload 授权。分析账户键是域隔离的 SHA-256 去标识键，不保存原始 openid。

- 每批 1–10 条且整个 payload 不超过 16 KiB。
- 每个账户每分钟最多 12 批校验，最多 60 个新事件；限流记录按账户分散，无全站单热点。
- 事件 ID 与账户键构成确定性文档 ID。重放不新增事件；事件与首次目标意向在同一事务中保存。
- `eventName` 只允许 `session_started`、`target_committed`、`offer_viewed`、`offer_cta_clicked`、`checkout_blocked`、`cashier_invoked`、`cashier_result`、`activation_viewed`、`purchase_feedback`。
- 只有事件 ID、会话 ID、版本、构建 SHA、固定平台、允许的入口/套餐/诊断码/结果、服务端实验组、目标目录键会写入。自由文本、原始异常、支付签名、登录 code、定位与联系方式被忽略。
- `occurredAt` 仅接受距接收时间 24 小时内的合法日期，保存 `receivedAt` 供服务器时间核对。首次意向用服务端确认时间，避免客户端倒填首付队列。
- `target_committed` 要求目录中 `supported: true`、非 `comingSoon` 的 SKU，以及 1–4 家真实目录门店；不做库存查询，不改变新品限制或计次。
- 客户端不能上报 `payment_verified` / `entitlement_granted` / `refund_verified` 等财务事实。`cashier_result: success` 只是诊断，报表绝不把它当付款。

客户端 `utils/conversion-events.js` 暴露 `configure(bootstrap)`、`track(eventName, fields)`、`flush()`。`track` 同步返回是否入队，业务代码不要等待采集；`configure` 仅在可信 bootstrap 后生效。目标支持 `fields.target = {partNumber, storeNumbers}`，也接受这两个字段直接放在 `fields`。

队列仅存在内存中，最多 40 条，优先丢非关键曝光；每次发 10 条，短延迟批量发送，失败最多再试一次。失败不弹窗、不阻断业务，不占同步存储。切换账户或关闭开关清空待发队列，旧请求完成后不会把旧事件重放到新账户。进程关闭、网络中断或限流可能丢事件，因此不是完整访问日志，也不覆盖匿名用户。

`purchase_feedback` 仅允许七项固定回答：暂时不需要、已经买到、价格/时长、不了解权益、不信任效果、支付问题、其他。不保存“其他”的自由文本，反馈次数不代表总体比例。

## 付款与报表口径

独立运营工具增加“真实付费与首付队列（近 30 天）”，按需调用 `admin.growth`；普通账号返回 `forbidden`，正常 bootstrap 不扫订单。

`admin.growth` 支持 `days: 7..90`（默认 30），按北京时间起始日与请求截止时间展示。三类集合使用 `_id` keyset 分批读取，每集合最多 2001 条探测是否超过 2000 上限；剩余函数预算不足 3 秒时提前结束并报告不完整。扫描为非原子快照，进行中的订单核实或退款可能在下一次读取体现。

### 财务事实

付款订单必须具有 `wechat_virtual_payment` provider、正整数分金额、与服务端 `payment.providerData` 相符的 provider/金额、交易编号、商户单号和合法 `paidAt`。这与现有核实服务写入的结构一致。赠送、兑换、测试另列；证据不足的旧“已完成/已支付”记录列 `unknown`，不补造实付。`userHiddenAt` 不影响运营金额。

同 provider/交易编号只计一次；遇到重复交易列出异常，净额及 D7 比率停止计算等待核对。部分/全额退款必须有 `query_order` 的匹配交易证据、合法累计退款分值与确认时间；退款证据不全时净额为未知。手续费没有来源，始终为未知。

收入归属是“本期已核实付款订单的毛额，减这些订单截至读取时的累计已核实退款”，**不是本期实际退款现金流**。已有模型没有每笔增量退款日期流水，不能从最后退款时间重建每日现金流。`paidAt` 为服务端首次核实时间，可能晚于用户付款；不能宣称它是平台精确扣款时间。

按套餐列订单、首付/复购候选和金额。首付由全历史扫描内的首笔可信付款确定；历史扫描截断、未知订单或重复交易时显著标记分类不完整，不能宣称得到完整新增付费人数。

### 合格意向 D7

每个账户仅保留首次经服务器验证的有效 SKU/门店意向；是否需要先付费、客户端支付能力及实验后的受阻情况都不作为入组过滤条件。按该首次意向时间选择队列：

1. 首次真实付款在意向之前的账户，单列已有付费者。
2. 历史含付款证据不明的账户，单列待核对；不猜是否首付。
3. 满 `7 × 24` 小时的意向才进入成熟分母；未满另列。
4. 首次可信付款落在意向起 `7 × 24` 小时以内（含边界）的账户进入首付分子，付费和权益发放不混同。
5. 任何集合扫描不完整、该队列存在未知历史、交易重复时 `cohort.rate = null`。成熟人数为 0 时也不显示 0% 假象。

这是已采集有效目标的账户队列，不能覆盖采集开关启用前的首次意向。弱网导致目标事件晚到、事件丢失/关闭采集也会影响覆盖；报表明确保留 `historicalEventsComplete: false`。没有把访问、订单、关注三张普通统计表相除冒充漏斗。

### 已交付与未交付的观测

已交付：账户/会话分开；曝光账户中的受阻账户交集、平台/套餐/固定诊断码事件数；可信现金事实和异常分类；成熟 D7 队列及实验组；自愿回答计数；采集与扫描完整性说明。

未交付：匿名 UV、全量分页导出/离线聚合流水线、精确每日退款现金流、可信历史 24 小时付费激活率、自动实验置信区间/样本充分性结论。超过 2000 条后本端点提供明确不完整的核对样本，不能继续当作全站经营报表；正式大规模运营需先补全离线聚合与历史对账流程。当前快照的关注/授权就绪状态不能证明付款后 24 小时内就绪，因此 `activation.rate = null`，原有提醒效果报表继续提供观测但不替代它。

## 数据库与上线前检查

新增 `gxs_growth_events`、`gxs_growth_accounts`，已登记到 `collections.js` 和 `config/database-deployment-plan.json`。直接客户端读写规则都为 `false`；增长事件增加接收时间、账户/接收时间索引。部署计划仍 `deployed: false`。

默认保留最近 **30 个北京时间自然日**的原始增长事件，随后由现有每日 `runRetentionIfDue` 清理；无有效意向的账户限流记录空闲 30 天后删除。首次意向的目标、平台、实验详情保留 **90 个自然日**，之后置空并标记已压缩。去标识账户键和首次意向时间作为最小去重锚点保留，防止老账号因清理重新成为“首次”队列；这不是无限保留原始行为日志。财务订单、付款凭据、退款和权益账本不进入增长清理范围。

新增清理结果写入 `gxs_config/retention_status.growth`，包括事件截止、意向详情截止、删除/压缩数量与错误；集合尚未部署时按空集合处理。需经授权创建集合/索引并确保现有 monitor 定时维护持续运行。停用定时触发、数据库故障或预算不足会延迟物理清理，启用采集前必须验证清理状态和错误监控，不能只开采集而忽略维护。部署后有限留存规则才实际执行；本轮仅离线测试，并未删除生产数据。隐私说明应披露最小去重锚点用途，账户删除流程需单独处理该锚点。

报表读取最长 90 天时，流量/曝光部分只能覆盖尚在 30 天保留期内的事件；D7 仍取持久首次意向和订单事实，不能用已过期曝光补零或重建匿名访问。

离线专项：`node --test tests/growth.test.mjs tests/config-revision.test.mjs tests/config-regression.test.mjs tests/admin-security.test.mjs tests/account-bootstrap.test.mjs tests/virtual-payment-service.test.mjs`，本轮实际通过 80 项（其中增长专项 8 项）。涵盖开关与 A/A 回退、身份伪造、敏感字段丢弃、目录验证、重放、限流、成熟窗口、历史未知、隐藏及退款订单、截断和客户端失败隔离。全仓验证、monitor 派生包生成与候选发布证据由总验收记录统一登记。

后续独立复核：`node --test tests/growth.test.mjs tests/retention.test.mjs tests/virtual-payment-service.test.mjs tests/launch-readiness.test.mjs` 实际通过 59 项。新增直接走正式支付服务和模拟平台响应的断言，确认真实核实订单、部分退款、全额退款、隐藏订单和旧周卡均被正确分类；验证 30 天事件删除、90 天意向详情压缩后原始首意向时间与财务凭据不变。

## 新品上线本地检查

`node tools/catalog/check-launch-readiness.mjs --as-of=2026-10-11` 只读取本地目录与 `miniprogram/config/product-launches.js`，检查官方域名、明确北京时间、日期有效性、源/云函数目录同步以及真实目录投影；输出 `evidence/verification/2.0.0/launch-readiness.json`。不会联网核实网页、修改目录、访问生产或按日期自动开放查询。

本轮结果：Duo 共 8 个 SKU 全部 `comingSoon: true`、运行时投影 `supported: false`，取货采样为空，明确未开放查询/监测。原始 family 的 `supported: true` 是目录候选元信息；实际服务支持还必须通过 `pickupVerification.verified` 和每 SKU 非 `comingSoon` 的现有检查。工具不会把所有未开放产品当测试失败，也不会把工具通过解释为新品服务已就绪。

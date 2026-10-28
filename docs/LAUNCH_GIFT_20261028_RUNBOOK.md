# 2026-10-28 新品会员礼遇：本地任务与生产准备

本文件对应 V3.4.3 的 WP03 / A19–A26。本次交付的是本地实现、离线演练工具和执行清单；没有运行生产赠礼、改动线上账号、部署函数或发送通知。

## 已确定的资格与实现判断

历史上真实支付成功的会员订单符合资格；之后全额、部分退款或权益尚未履约都不取消资格。仅试用、免费赠送、故障补偿、免费兑换不符合。当前是否登录、有无关注、会员是否过期不决定后台名单。

资格检查独立于 `purchasedPlan`，后者的普通履约/退款限制未放宽。规则核对账号归属、正式环境的不可变支付条款、正金额、交易编号、订单身份、服务端 providerData 及 `payment_<交易编号哈希>` 回执。缺失或矛盾列为 `review`，不会按无付费处理。原支付、退款及收入记录不会被礼遇修改。

原方案有三点需要具体限制：

- 北京时间 10 月 28 日结束，即 `2026-10-28T16:00:00.000Z` 的排他截止是**建议**，不是已确认的生产名单边界。默认 dry-run 标记 `cutoffIsSuggestion: true`；实际执行需沿用已确认名单，或明确登记最终边界。CLI 的 `--cutoff` 仅确认该次本地演练参数，不授权线上操作。
- 交易回执的 `createdAt` 会被现有支付对账刷新，不能当成原始付款时刻。名单时间使用订单保留的 `paidAt` 和 `createdAt`；回执负责确认交易归属。晚于截止、缺失付款时点的记录列待核对。
- 年卡片段后已有月卡排队时，把年卡赠礼直接追加到队尾，会额外把中间月卡期限当成年卡名额期。新实现把礼遇放在当前档位最后一个片段之后，只把总时长及对应名额截止顺延 1 天，保留原片段与退款归属。

## 代码与运行边界

- `rules/launch-gift.js`：付款事实、旧赠礼凭证和触达候选校验。
- `repo/launch-gift.js`：逐账号串行读写事务；用户、真实付款证据和旧活动记录在事务内重读，权益、零金额赠礼凭证、`launch20261028GiftedAt` 同事务提交。
- `services/launch-gift-task.js`：稳定分页扫描、冻结 manifest、有限账号批次、检查点与脱敏对账。
- `tools/member/launch-gift.mjs`：**只读本地导出的 CLI**。默认 dry-run；`--apply-local` 仅写输出目录的模拟状态，不包含生产 apply、SDK 初始化、网络请求或定时轮询。
- `tools/lib/launch-gift-offline-repo.mjs`：独立离线适配器，无数据库凭据。

API 和 monitor 的原访问入口共用上述原子规则，但只在活动当天尝试当前账本指向的至多 32 个付款候选，不在每次 bootstrap 扫完整历史。已消耗完、被后续赠送覆盖的历史付款由后台冻结名单覆盖；跨日仅后台任务可处理既定名单。

活动 ID 始终是 `grant_launch_20261028`；记录 ID 始终是 `用户ID|活动ID`。已有完整成功凭证跳过；只有旧 giftedAt、未履约订单、相互矛盾标记、旧误发一律列待核对。不会换活动 ID 重发、自动扣回、删除旧记录或通知用户。

## 扫描与冻结

仓储提供 `getLaunchGiftOrderWatermark()` 和 `scanLaunchGiftOrders({afterId,throughId,limit})`。首次固定最大订单 `_id`，之后按 `_id` 升序使用 `(afterId, throughId]`，每页最多 100 条，不使用 skip，不筛掉退款、隐藏记录或缺少日期的旧数据。每页完成后保存边界、游标及按账号汇总结果；单账号多个真实付款只保留确定性选择的最后一笔有效依据。

名单冻结包含环境、snapshotAt、截止、源指纹、扫描水位、账号候选及哈希；扫描完成与发放完成分开。完成扫描后续跑不再读订单页；完成账号批次后续跑不再读取或写入成功账号。

**固定 ID 水位不等于数据库事务快照。** 正常新订单有服务端新建时间，服务按 snapshotAt 排除确证的新插入；付款/退款不会撤销历史已付事实。但并发人工导入、回填旧 createdAt、改写历史交易证据可能插到游标之前，不能靠 keyset 保证全量。生产准备应使用一致的冻结导出或停用历史导入，核验完整性，并记录此条件；必要时重建 manifest，不在原批次悄悄扩大名单。

候选只来自订单集合，报告的 `totalAccounts` 是候选去重账号数，不是全平台注册账号数。没有任何订单的免费账号不需要逐个扫描。

## 可复核的本地命令

先准备私有的冻结导出，结构为：

```json
{
  "metadata": {
    "environmentId": "offline-example",
    "snapshotAt": "2026-10-29T00:00:00.000Z",
    "ordersComplete": true
  },
  "collections": {
    "gxs_users": [],
    "gxs_orders": [],
    "gxs_config": []
  }
}
```

`ordersComplete` 是提供者的完整性声明，工具不把它当成独立生产证据。需包含对应用户和付款回执；缺项会进入账号异常/待核对。原始导出、manifest 和 checkpoint 包含账号标识，放在 `output/` 或仓库外，不提交到 Git。

```powershell
node tools/member/launch-gift.mjs --help
node tools/member/launch-gift.mjs --input <冻结导出.json> --out output/gift-dry --page-size 100 --max-pages 2 --max-accounts 20
node tools/member/launch-gift.mjs --input <同一冻结导出.json> --out output/gift-dry --page-size 100 --max-pages 2 --max-accounts 20 --resume
```

默认输出为 dry-run。候选、预计档位、到期变化、成功凭证、明确不符合、待核对和账号异常分别进入 `report.json`；该报告脱敏。输入文件哈希、环境、截止或执行模式改变时拒绝续跑。

用独立目录演练落账，并明确本地演练采用的建议边界：

```powershell
node tools/member/launch-gift.mjs --input <冻结导出.json> --out output/gift-apply-local --apply-local --cutoff 2026-10-28T16:00:00.000Z --max-accounts 20
node tools/member/launch-gift.mjs --input <同一冻结导出.json> --out output/gift-apply-local --apply-local --cutoff 2026-10-28T16:00:00.000Z --max-accounts 20 --resume
```

仅 `output/gift-apply-local/local-state.json` 产生模拟权益变化，原输入不变；每份报告明确 `productionGrants: 0`。`--now` 用于固定离线夹具时钟；未来生产调用必须传实际服务端时间，不得回填为活动日。过期账号从实际执行时间获得完整 1 天。

## 检查点与对账

`runLaunchGiftBatch` 默认 dry-run，每次至多 100 个账号，默认 20；并发为 1。生产若接入受信任操作端，需把 `onCheckpoint` 接到持久化存储并绑定实际环境，不能依赖进程内变量。公共路由和定时 monitor 没有新增该写入口。

执行前先持久化该账号 `pending_apply`，再执行原子落账，最后保存结果。响应丢失时检查点保留可重试状态；重试依据活动凭证返回成功，不再加时。评估前失败为 `unresolvedBeforeAssessment`；重试证明待发后纳入待发对账，不把该次成功漏掉。

`reconciliation` 明确针对已评估为待发的账号：`initialPending = successful + retryable + manual`。另外列出 `unprocessedAccounts`、资格不明、账号异常、预先已发和明确不符合。`processingComplete` 只表示已处理全部候选；有失败、待核对、账号异常或尚待发放时，`allEligibleGranted` 不为真。零符合候选也不会显示“全部发放完成”。

已成功发放不随代码回退撤销。停止后续批次、保留检查点和成功凭证；修复失败后用同一 manifest 续跑。改变名单边界必须另建可审阅名单，仍共用原活动 ID 去重。

## 一次性成本与验证

扫描每 100 条订单至多一次集合页读取，另有一次水位读取；每笔历史订单的 `inspectLaunchGiftPayment` 在一个只读事务中核对订单、用户和付款回执，最多 3 次文档 get，加事务起止。批次评估/发放再次事务重读当前事实；代价是一次性任务成本，不隐藏为稳态采集优化收益。检查点写入成本取决于生产持久化实现。本地 CLI 使用本地文件，不产生数据库调用或计费。

赠礼可能恢复会员关注；恢复后目标数量和持续采集负载与一次性扫描/发放分别计量。实现不延长采样周期、不新增每分钟扫描、不发送真实通知。

### A26 补充：过期会员恢复关注的离线负载实验

`tests/launch-celebration-gift.test.mjs` 的 `gift restores only eligible active targets` 用例使用真实 `collector.refreshTargets` 和合成内存数据，另通过生产仓储与锁定 SDK 的离线 transport 计量一次性赠礼。四个已过期付费账号分别保存两个正常 active 关注、一个手动 paused 关注和一个退役 SKU 关注；另有一个从未付费账号。两个正常关注重叠在相同 SKU×两门店，不把账号数误当独立采集目标数。

结果：四个付费账号各获一次本地模拟赠礼；所有原关注文档与支付订单原样保留，手动暂停不恢复、退役目标不进入采集、免费账号仍无资格。正常 active 关注重新有资格，去重目标从 0 变为 2，请求组从 0 变为 2；配置的常规间隔仍为 60,000ms。本实验只刷新计划，没有执行 scheduler.tick，没有请求真实或模拟库存，也没有发送消息。

一次性实际离线 SDK 动作分开记录：冻结扫描四笔支付共 22 个动作（4个事务起始、14读、0写、4提交）；随后四账号评估与赠礼共 56 个动作（8个事务起始、32读、8写、8提交）。完整检查点重跑是 0 动作。这里不含真实环境的检查点持久化、部署或监控费用。

恢复后的稳态负载是另一项模型：若两目标各在健康常规轮次接受一个无变化样本，legacy 样本持久化链是 2×7=14 个动作；只有另行授权并迁移这些目标后，embedded 链才是 2×5=10 个动作。赠礼默认不迁移库存。预算/健康、样本外租约与状态写、事件与通知、前端读取、迁移/归档均另计，不能把 78 个一次性动作与稳态差值合并后声称账单降幅。

证据：`output/gxs343-review/gift/restoration-load.json`（计数、范围及测试源码 SHA-256）和 `restoration-load.log`。执行 `node --test --test-name-pattern "gift restores only eligible active targets" tests/launch-celebration-gift.test.mjs` 可重复此实验；Node 24.22.1 专项通过，所在赠礼测试文件当前 19 项通过、0失败、0跳过。生产请求、真实发放、真实通知均为 0。

本地验证命令：

```powershell
node --test tests/launch-celebration-gift.test.mjs tests/launch-gift-sdk-contract.test.mjs tests/mac-catalog-and-gift-v343.test.mjs
```

2026-10-28 本地 Node 24.22.1 验证：25 项通过，0 失败、0 跳过。覆盖 A19–A26、全/部分退款、免费来源排除、后台无访问覆盖、原活动并发去重、交易回滚、成功响应丢失后续跑、稳定有界扫描、北京午夜及真实晚到时间、不同 ISO 时区的付款排序、旧误发/缺证据、缺账号旧订单、混合套餐、并发购买退款、CLI 输入不变/离线续跑，以及锁定 `wx-server-sdk@4.0.2` 的 keyset 查询编码。SDK 传输被离线替代，不证明真实服务端事务或生产费用。

## 生产前具体清单与停止条件

1. 核对当前 API/monitor/runner 部署指纹、原活动账本及已有批次，确认新兼容代码已覆盖所有触达入口。
2. 固定目标环境、已确认名单边界、完整导出/冻结条件与源指纹；10 月 28 日结束仍只是可选建议，不能替维护者确认生产名单。
3. 在隔离环境验证真实 CloudBase 串行事务、冲突/未知提交结果、稳定扫描索引和持久检查点。离线 SDK 编码测试不能替代此项。
4. 审阅脱敏分类人数及待发预计档位/时长，单列缺凭证、账号异常、跨日首次付款、旧误发和旧标记冲突，不自动修复账本。
5. 在已授权的实际生产范围内接入受信任执行端，以有限账号批次运行；每批保存对账。边界改变、支付证据矛盾、重复赠礼、套餐期限异常、事务错误升高、检查点无法持久化立即停止后续批次。
6. 只在实际对账无待处理/失败后更新活动“已发放”文案；个人到账由已提交的赠礼记录证明。当前没有生产发放结果。

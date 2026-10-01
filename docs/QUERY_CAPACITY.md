# 查询容量与持续服务

更新：2026-10-01。本文描述当前修复代码及上线核对。初始候选没有读取真实 runtime 或部署；后续已核实当日 10000 次耗尽、部署 API / monitor 并完成真实会员零扣次查询。前端修补包已上传，尚未正式发布。证据与边界见 [会员查询故障复核](HOTFIX_MEMBER_QUERY_2026-10-01.md)。

修复现已对齐 `codex/ux-r1-ui` 的 v1.5.0 源码基线（`866c43d`），保留新版界面及旧提醒目标保护；不以仍标为 1.4.2 的 master 替代该版本。v1.5.0 的既有发布记录见 [发布说明](RELEASE_1.5.0.md)，其中 2026-09-30 的 API 版本核验不代表本次容量修复已上线。

## 人数、目标与请求数

会员不扣查询次数，与实际采集容量是两层规则。容量由独立请求工作量决定，不能把监测记录中的 9 组理解为最多 9 个用户。

- 自动监测先合并不同用户的相同门店与 SKU，同一门店默认每 20 个 SKU 分为一组；每组实际 HTTP 请求计 1 次。
- 手动查询每个门店与 SKU 可共享近期有效样本。默认 `query.sharedFreshnessSeconds=10`，允许 0–30 秒，0 关闭。已有样本可以来自自动采集；跨实例目标租约合并同时发生的手动刷新。
- 共享的是原始观测，不是新的采集。保留 `observedAt`，不重复写入样本、状态事件或通知确认。没有有效新样本时不能声称实时刷新成功。
- `sharedResult=true` 表示含复用结果；`allShared=true` 表示所有结果都复用。全部复用，或复用成功但其他门店失败且没有新的有效结果，都返还免费用户预扣次数；后一类用 `billingReason: 'shared_result_no_charge'` 说明。至少取得一个新的有效结果时按原整次规则收费。会员始终不扣使用次数。
- 账号频率、并发、权限和新品限制仍生效；复用不会绕过准入检查。`query_refresh_pending` 表示目标仍被其他实例刷新，客户端显示预计短时重试，不无限自动重试。

## 默认连续容量

| 配置或状态 | 默认及含义 |
|---|---|
| `collector.budgetMode` | `continuous`。按时间持续补充容量；可显式选择旧模式 `daily`。 |
| `collector.maxRequestsPerDay` | `10000`。continuous 下为持续补充目标，速率为 10000/86400 次/秒；不是自然日硬封顶。 |
| `collector.maxRequestsPerMinute` | `60`。自然分钟硬上限，同时约束共享突发桶容量。 |
| 来源分配 | 自动 80%、手动 20% 的补充速率；默认突发桶分别 48 / 12。共享桶约束两者合计。 |
| 空闲借用 | 另一来源至少 60 秒无需求时可借用其空闲容量，至少保留 1 次；不能突破共享桶或分钟上限。 |
| `gxs_config/upstream_capacity` | 持久保存 tokens、capacities、rates、lastDemandAt、updatedAtMs 和 version；午夜及冷启动不清零。 |
| `collector_budget_<北京时间日期>` | 保留 dayCount、minuteCount、autoCount、manualCount 等核对计数。continuous 下 dayCount 不触发日停服。 |

实际请求在事务内预占容量；预占后进程失败不会返还采集容量，因此计数可能保守高于实际完成的 HTTP 数。容量暂缺的内部原因为 `capacity_wait`，对查询端映射为 `upstream_budget_limited`、`budgetScope: 'continuous'`，返回根据补充速率估计的 retryAfterMs。持续高负载、共享争用或上游限流仍可能延长等待，不能保证等待结束必定成功。

旧日模式迁移时不重置当天消耗来制造大批请求：如果当天已耗尽，初始连续容量为 0，随后按速率恢复；当天已有部分消耗则初始最多 1 次共享容量。调整配置也不会按新速率追溯补充过去的时间。保留持久状态，避免通过冷启动或午夜重新获得整桶突发。

定时监测会解除旧日模式因日预算耗尽而保存的午夜等待，按连续容量重新准入；保留真实失败退避和上游 429/503 暂停。新模式下的容量等待会对所有自动目标共同生效并跨冷启动保存，避免目标增多后反复进行无效准入事务。

手动查询的 `query_target_*` 也会保存等待状态。切换到 continuous 后，只解除旧 `daily_budget` / `auto_budget_reserved` 的目标等待，再走当前共享容量准入；不清零日计数、容量或断路器，活动租约和其他失败等待仍生效。2026-10-01 的补充回归发现上一候选遗漏了这一层，详情见 [会员查询故障复核](HOTFIX_MEMBER_QUERY_2026-10-01.md)。

`daily` 保留自然日总上限；自动来源在总消耗达到日上限的 80% 后为手动预留其余容量，日上限全部耗尽后需等北京时间次日 00:00。它可用于明确接受停服的严格请求封顶需求，不是本次持续服务修复的推荐模式。

## 容量增加后的更新间隔

连续模式自动常规间隔下限约为：

`独立请求组数 × 86400 ÷ (maxRequestsPerDay × 0.8)` 秒。

实际取配置间隔、运行模式下限和以上间隔中的较大值，定时模式再按分钟触发对齐。默认 9 组计算值为 97.2 秒，常规扫描约每 2 分钟一次；加速复查同样消耗容量，失败、延迟或限流仍可使覆盖变慢。

更多用户若重复查询同目标，能大量复用；不同门店与 SKU 增加后，独立组数仍会增长。例如 1000 个独立请求组在默认自动持续份额下，仅常规均摊就约需 3 小时。这不等于 1000 个用户，也不能据此承诺 1000 个独立目标实时更新。进一步扩容需要测量组数、期望覆盖间隔、上游可用容量、数据库争用与成本，再调整经过验证的参数或数据源能力。

## 管理员只读检查

已部署匹配 API 后，通过现有 `gxs_api` 的管理员调用路径读取：

```js
{ action: 'admin.capacity', payload: {} }
```

接口沿用管理员鉴权，只读取状态；不创建用户、不发起上游请求、不预占或补充容量，不返回用户身份或目标列表。

| 返回信息 | 如何解读 |
|---|---|
| `mode`、`maxRequestsPerMinute`、`sustainedDailyTarget` | 当前配置。只有 daily 返回 `hardDailyLimit`；continuous 的持续目标不解释为硬日限。 |
| `uniqueGroups`、`plannedIntervalSeconds` | 来自最近监测状态；同时查看 `collectorStatusUpdatedAt`、`collectorStatusStale`。旧状态不能证明当前实际覆盖。 |
| `normalCadenceSeconds`、`configuredNormalRequestsPerDay`、`autoRequestsPerDay`、`aboveAutoCapacity` | 按配置常规间隔和运行模式下限估算需求，与自动份额比较。aboveAutoCapacity=true 表示期望常规频率超过自动持续容量，调度需要降速；不表示实际请求已经超限。实际范围需结合组数与新鲜健康记录。 |
| `todayReservations` | date、available、total、auto、manual、unclassified、sourceSplitComplete。是事务预占计数，不是精确 HTTP 完成量；available=false 是当天文档缺失，不是已证实零请求。旧日计数缺少来源时进入 unclassified。 |
| `tokenSnapshot` | recordedAt 时持久化的 shared/auto/manual tokens、burstCapacity、refillPerSecond；不是当前时刻投影值。只读接口不 refill，无状态时为 null。 |
| `recentQueryReuse` | 北京时间当天创建的最新最多 2000 条查询文档抽样，只统计已完成 live 查询中的结果目标。sampledRecords 与 completedLiveQueries 含义不同；truncated=true 表示达到抽样上限，可能不完整。 |

复用抽样区分 freshTargets、reusedTargets、unknownTargets 和 unclassifiedTargets。旧结果没有 reused 字段时归为 unclassified，不推定为真实新请求；reuseShareOfClassifiedTargets 只以明确归类的 fresh/reused 目标为分母，并非全部查询或 HTTP 命中率。还应核对 attributionComplete；来源计数完整性由 sourceSplitComplete 单独表示。

增大 maxRequestsPerDay 或分钟速率前，必须根据实际上游响应、云函数并发、数据库事务争用、覆盖间隔及账单验证承载能力。管理员估算可以指出容量不足，不能证明提高配置后就能稳定承载。

## 验证与发布

仓库的 `tests/shared-query-capacity.test.mjs` 包含 100 个不同会员、不同 handler 实例同时查询一个目标的契约测试：内存数据库与模拟上游下只发起 1 次 HTTP、只形成 1 个样本，不把 100 次读取变成复查确认。这不是云端负载测试，也没有验证真实云数据库的并发争用或上游延迟。连续容量、跨日、冷启动及来源保护由 `tests/continuous-capacity.test.mjs` 等测试覆盖；上线仍需实际测量。

1. 读取并备份线上 `gxs_config/runtime`、当日计数、`upstream_capacity`（若存在）、`collector_status` 和当前部署版本。确认旧代码/配置是否仍使用日硬上限。匹配 API 部署后可调用 admin.capacity 辅助核对；该接口不能代替原配置备份。
2. 选择 `collector.budgetMode: 'continuous'`，核对持续补充目标、分钟上限、并发及 sharedFreshnessSeconds。局部合并配置，不覆盖会员、支付、通知等其他设置，不清零持久容量状态。
3. 发布匹配的 `gxs_api`、重新构建并检查的 `gxs_monitor` 和小程序前端。常驻采集若启用也必须使用相同共享源码，避免新旧保护逻辑同时运行。
4. 用受控目标核对复用前后 observedAt、实际 HTTP 数、净扣次、未知状态与原始样本数；验证刷新等待、容量暂缺、异常、恢复及跨午夜行为。
5. 持续观察独立请求组数、真实采样间隔、dayCount/autoCount/manualCount、capacity_wait、query_refresh_pending、上游 429/503、错误率、超时 pending 查询和成本。根据实际覆盖间隔决定扩容，不以 enabled 开关或离线测试宣称线上已恢复。

相关契约见 [数据模型](DATA_MODEL_AND_API.md)、[共享保护](UPSTREAM_PROTECTION.md)、[定时部署](SCHEDULED_MONITOR.md) 与 [采集运行手册](COLLECTOR_OPERATIONS.md)。

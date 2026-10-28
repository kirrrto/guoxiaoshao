# V3.4.3 库存日摘要兼容迁移

本文件记录 2026-10-28 的本地实现与演练。默认仍为 legacy；没有迁移生产数据、部署兼容函数、创建线上索引、调用真实库存上游或发送通知。`publicationReady` 与生产容量验收状态不因这些本地测试改变。

## 设计与独立复核结论

采用执行包 U02 的“一个完整内嵌日摘要、跨日归档”方向。它能在保持逐样本持久化的同时减少稳态写入，但有三个必须补足的边界：

1. 历史查询不用会随跨日缩小的“内嵌日期集合”做 offset 分页。当前实现以 SKU 的全部 latest 目标为稳定集合，按 `_id` keyset 分页，包含停监/退役目标；先冻结这些内嵌快照，再读取该日期的归档。
2. 不能用 `latest.sampleCount` 校验或推算日累计。可信服务器时间修复未来 latest 时，原库存状态机可能重置此累计。迁移只验证完整日摘要自身字段、身份与末次接受时间；修复 latest 后仍保留有效日累计。摘要本身损坏时保留原数据并报错，不猜测历史。
3. 缺失/矛盾的旧摘要不能被下一条 legacy 样本“洗成完整基线”。兼容 writer 会留下当日 `baselineIssue`，继续记录真实新样本，但该日目标仍禁止迁移并报告待核对。下一个真实采样日建立独立新摘要，才解除旧日问题对新日的限制。

已有一分钟常规采样、变化后确认、unknown 中断、未来时间防护、发送前读取、事件 ID 与通知规划标记均沿用。没有新增缓存发送资格、预算迁移、Redis 或常驻实例。

## 数据与权威选择

`gxs_latest` 的目标 ID 与业务库存字段保持不变，新增：

```js
observationStorage: {
  schemaVersion: 1,
  mode: 'legacy' | 'embedded',
  revision: 42,             // 每目标单调递增；回滚不归零
  day: { /* 一个完整原 schemaVersion:1 日摘要 */ } | null,
  baselineIssue: { dayKey, reason } // 仅发现旧基线问题时存在
}
```

`day` 内包含原始日累计的全部字段：真实接受样本、known/unknown、auto/manual、首末 observed/known、eventCounts、firstAvailableAt、availableWindows。内部 `storageRevision` 和 `storageMode` 随完整快照归档；对外 coverage 返回时去除这两个内部字段，维持旧协议。没有增长的日数组或逐条原始样本。

没有 marker 的目标就是 legacy。没有全局逐样本开关读取；显式迁移任务的目标清单只决定哪些目标可以尝试切换，事务内 latest 才是权威。没有历史的新目标不创建虚假零计数：任务返回 `waiting_for_first_sample`，首条真实样本按默认 legacy 入库后可重新审核迁移。

同日 embedded 样本只写 latest（若有业务事件仍在同事务写 events）。跨日首次接受样本在同一事务完整替换旧日归档、创建新日摘要并保存新样本。最终日没有次日样本仍由 latest 直接可查；显式 `archive` 可将完整副本持久化到归档，仍由 embedded 模式继续写入。重复 archive 在同修订、同内容时无写入。

reader 先读 latest，再读 archives。相同目标/日期只选择完整权威版本，绝不相加；embedded 快照与归档比较 `storageRevision`，跨日或 rollback 在两次读取之间发生时允许采用更新的归档。legacy 模式忽略残留内嵌副本。它是冻结的分步读取，不冒充数据库全局时间点快照。

新增索引由 `node tools/db/export-plan.mjs` 生成到 `config/database-deployment-plan.json`：`gxs_latest.part_id`（partNumber, _id）、`gxs_observation_days.part_day_id`（partNumber, dayKey, _id）。已有索引不删除。日摘要和 latest 均不参与十天历史清理。

所有业务样本入口最终使用 `repo.recordObservation`，共享实现位于 `repo/observation-storage.js`，由 `atomic-ops.js` 挂载；API、monitor 与 runner 共用这一方法。`saveLatest` 原始完整替换对已迁移目标拒绝执行，避免绕过原子累计。monitor 生成副本应在集成时统一重建，不能单独修改副本。

## 迁移、检查点与回滚

`tools/db/observation-storage.mjs --help` 是准确命令入口。默认 dry-run；目标文件必须是审核过的固定目标 ID 数组，不能拿当日活跃关注代替全体目标。排序去重后逐目标串行执行事务，包含 25ms 默认间隔。最大一次清单 10,000 目标；更大范围按明确清单分批。

迁移基线取 latest 最后接受样本的北京时间日期，不取执行日期。事务内读取对应完整旧摘要，核验身份、计数、首末时间、事件累计与可用窗口，校验迁移执行权后原子写入 mode/day/revision。缺失或矛盾目标保持 legacy，报告 `blocked` 原因。迁移与回滚不删除集合、改写事件 ID、清空规划水位或变动额度。

检查点绑定 environment、action、dryRun、排序目标清单 SHA-256，保存最后完成目标及逐目标结果。恢复时校验结果恰好覆盖目标前缀；提交成功但检查点失败会重复审核该目标，已迁移/已回滚状态不会重复累计。失败目标不推进检查点。执行锁按单个目标取得并在完成后释放；进程崩溃留下的锁最长 30 秒后可接手。

回滚必须先运行兼容版本的 `rollback`：同一事务将最新完整 day 写回旧日日文档，再将 mode 切回 legacy、移除内嵌权威。事务冲突重新读取当前模式和累计，不使用旧进程快照。后续 legacy 样本继续递增修订，下一次迁移重读最新 legacy 摘要，旧内嵌值不能覆盖回滚后新增样本。

离线演练：

```text
node tools/db/observation-storage.mjs --snapshot snapshot.json --targets targets.json --out dry-run.json
node tools/db/observation-storage.mjs --snapshot snapshot.json --targets targets.json --env offline --apply --out apply.json --state-out migrated.json
node tools/db/observation-storage.mjs --snapshot migrated.json --targets targets.json --env offline --apply --action rollback --out rollback.json --state-out rolled-back.json
```

snapshot 是“集合名 → 完整文档数组”的 JSON；targets 是 `R577|MXXX1CH/A` 等精确 ID 数组。离线 apply 只修改内存并写入单独输出文件，禁止覆盖输入快照。报告、状态输出、检查点不得互相覆盖或覆盖输入；`--resume` 与续写的检查点为同一路径是唯一允许的输入输出重合。

离线检查点另绑定状态快照的 SHA-256。恢复使用上次持久化的 `--state-out` 快照和对应 `--resume` 检查点，误用最初快照会拒绝。若状态文件成功落盘但检查点落盘失败导致 hash 不匹配，先核对该状态文件，再以它启动新的幂等批次、不带 `--resume`，重扫完整固定清单；已迁移目标不重复累计。不能将“报告说已迁移”代替状态证据。

具备具体生产授权后才考虑远端命令：

```text
node tools/db/observation-storage.mjs --env ENV_ID --region REGION --targets targets.json --out remote-dry-run.json
node tools/db/observation-storage.mjs --env ENV_ID --region REGION --targets targets.json --apply --readiness reviewed.json --out apply.json
```

远端 apply 必须明确环境、范围、`--apply` 与 readiness 文件；后者须绑定同一 envId，并包含 compatibleApi、compatibleMonitor、compatibleRunner、oldWritersDrained、serverTransactions、indexes、backup 的非空证据引用。未启用 runner 也要记录“未运行”的可核对证据。脚本只检查材料完整性，不代替人工/环境实证或授权，不负责部署。

停止条件：出现未知版本、基线矛盾、服务端 TransactionBusy、持续事务冲突、计数/事件身份差异、样本或通知延迟恶化时停止扩大范围。保留已提交状态与报告，在兼容版本下审阅并 flush 回滚。只有所有范围均确认 legacy、历史/未规划事件/在途任务一致且旧 writer 已排空后，才考虑回退旧二进制；单关开关不等价于数据回滚。

## 离线验收与用量边界

`tests/observation-storage-migration.test.mjs` 覆盖 C04–C11、C13–C15。已有 observation coverage、future safety、history statistics、collector cost、retention 与 transaction conflict 回归一起验证。

- C04：固定 `wx-server-sdk 4.0.2`、真实生产 adapter、离线 transport 计数；普通无变化自动样本旧结构 7 个动作（3读、2写、事务起止），embedded 5 个（2读、1写、事务起止）。每个事务的 get/set 串行执行，未引入共享事务并发写。
- C05/C06：同一录制输入的完整 latest 业务字段、事件 ID/内容、unknown 与确认链、两天全部日统计相等；重复、乱序不累计；latest/event/archive 写失败整笔回滚。
- C07/C08：北京时间跨日、跨日读取、最终停监日、长期保留和幂等 archive；不会依赖有次日样本才能读到末日。
- C09：手工/自动并行、旧采集执行者失权、未来 latest 修复保留嵌入累计；SDK transport 注入迁移与 rollback 提交冲突，重试保留并发已提交的新样本。
- C10/C13：固定清单中断续跑、已提交但检查点不确定、空目标、旧摘要缺失/矛盾、缺失后继续采样仍待核对。
- C11/C15：flush 回滚、旧副本非权威、回滚新增3样本、再迁移不丢不重，revision 持续递增。
- C14：130 个目标的第一批100个在分页中跨日，剩余30个不漏；没有 skip/offset 或仅活跃目标筛选。
- C12：真实 CloudBase 服务端事务、线上索引、24小时跨北京时间午夜的同负载时效/计量、P50/P95/P99 与真实通知等待仍待验证。没有真实账单或月费节省结论。

新增成本也必须计入：指定≤100目标的 coverage 比旧版多一次 latest ID读取；全门店多一轮 latest keyset扫描。latest 文档和传输体积变大，迁移锁、基线读取、归档、回滚和诊断也有额外操作。7→5只是稳态样本事务局部减少约28.6%，净收益模型是 `2×稳态样本数－额外读取/归档/迁移成本`，不能写成全系统或账单百分比。

本次命令行固定夹具演练保存在 `output/gxs343-review/inventory/`：dry-run 为 ready=1、blocked=1、waiting_for_first_sample=1；apply 为 migrated=1、blocked=1、waiting=1；rollback 为 rolled_back=1、blocked=1、waiting=1。三份报告的 productionWrites 均为 false，仅有本地合成数据。

最终专项及相关回归在 Node 24.22.1 下 54/54 通过，0失败、0跳过，日志为该目录 `tests.log`；计数、CLI结果和本次相关源码 SHA-256 汇总在 `verification.json`。这不替代主工作包后续的全量测试、monitor同步检查或线上验收。

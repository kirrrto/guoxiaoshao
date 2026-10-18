# 3 秒固定采集周期 · 设计与交付说明

记录日期：2026-10-18。基线：`master` @ `8dfb888`（v3.3.0）。  
**本轮仅本地开发与模拟验证**：未推送、未部署云函数、未改线上配置、未对苹果接口压测。

## 1. 目标与结果

有效会员关注的库存（有货或缺货）使用统一的 **3 秒目标采集周期**，不再因请求组数增加被 `groups×86400÷自动日容量` 拉成数分钟。3 秒指真实上游请求的目标周期；容量不足、上游保护或资源限制时明确降级，不伪造观测时间。

小程序关闭后由 **常驻采集**（`tools/collector/runner.js` + `createCollector`）或定时 `gxs_monitor` 继续监测；分钟级触发不会被标成“持续 3 秒”。

## 2. 修改文件清单

### 服务端共享源（权威）

| 文件 | 变更 |
|---|---|
| `cloudfunctions/gxs_api/lib/config.js` | 新增 `collector.cadenceMode`、`collector.autoSharePercent`；容量上限放宽并校验 |
| `cloudfunctions/gxs_api/lib/engine/scheduler.js` | 固定周期：稳定相位槽位、绝对 `nextDueAt`、漏轮跳过、调度延迟指标 |
| `cloudfunctions/gxs_api/lib/engine/collector.js` | `fixed` 模式不再按组数拉长周期；状态输出 `cadenceMode`/`targetPeriodMs` |
| `cloudfunctions/gxs_api/lib/engine/capacity-budget.js` | `autoShare` 可配置，仍受共享总上限约束 |
| `cloudfunctions/gxs_api/lib/engine/guarded-pickup.js` | 将 `autoShare` 传入预算预留 |
| `cloudfunctions/gxs_api/lib/repo/upstream-guard.js` | 预算/日限按 `autoShare` 核算 |
| `cloudfunctions/gxs_api/lib/services/admin.js` | 容量展示使用配置的自动份额 |

### 生成目录（`node tools/build-monitor.mjs`）

`cloudfunctions/gxs_monitor/lib/**` 与 `lib-manifest.json` 与上表同步（43 文件闭包，`--check` 通过）。

### 测试

| 文件 | 说明 |
|---|---|
| `tests/fixed-cadence.test.mjs` | 新增 9 项：组数扩展、相位、漏轮跳过、同店瓶颈、配置边界、容量份额、权益与指标 |

## 3. 配置字段与迁移

在运行配置 `collector` 中局部合并（**不要整份覆盖**）：

```json
{
  "collector": {
    "cadenceMode": "fixed",
    "intervalSeconds": 3,
    "maxConcurrency": 2,
    "maxRequestsPerMinute": 2000,
    "maxRequestsPerDay": 2880000,
    "autoSharePercent": 80,
    "budgetMode": "continuous"
  }
}
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `cadenceMode` | `adaptive` | `adaptive`：沿用组数拉长；`fixed`：`intervalSeconds` 为每组绝对目标周期 |
| `intervalSeconds` | `8` | 目标周期（秒）；固定模式示例为 `3` |
| `autoSharePercent` | `80` | 共享预算中自动监测份额（1–95），主动询货使用其余部分 |
| `maxRequestsPerMinute` | `60`（上限 6000） | 共享分钟突发/上限 |
| `maxRequestsPerDay` | `10000`（上限 10M） | 共享日补充速率目标（continuous） |

**迁移**

1. 备份线上 `gxs_config` 中 `collector` 与 `upstream_capacity` / `collector_status`。  
2. 部署同步后的 `gxs_api` 与 `gxs_monitor`（含触发器）。  
3. 按上表**局部**写入 `cadenceMode`/`intervalSeconds`/预算；校验拒绝越界，不会静默截断。  
4. 用 `collector_status.cadenceMode === "fixed"` 与 `targetPeriodMs === 3000` 确认生效。  
5. 回退：将 `cadenceMode` 改回 `adaptive`（或恢复备份的 `collector` 字段），无需改库历史；冷却/租约状态保留。

## 4. 调度设计（fixed）

- 每组稳定相位 `phase = fnv1a(group.key) % intervalMs`，槽位 `phase + n×intervalMs`。  
- `nextDueAt` 按绝对槽位推进；超时/停机后 **跳过已错过槽位**，不集中补发。  
- 同组 `inFlight` 互斥；同店串行与店级间隔保留；受店级限制时目标带 `storeDelayed` / `storeDelayReason: store_serial_or_spacing`。  
- 并发上限、429/503 冷却、Retry-After、容量 `capacity_wait` 均保留。  
- 指标分列：`plannedAt`（计划槽）、`scheduleDelayMs`（计划→实际请求开始）、`health.lastRequestAt`、`health.lastSuccessAt`。

采集资格：`canUseReminders` = 有效会员（含赠送）。**提醒次数为 0 或微信权限关闭不影响采集目标**；通知规划单独扣次。

## 5. 宅量估算（理论，非苹果额度）

| 组数 N | 后台请求/分钟 | 请求/天 | 建议 `maxRequestsPerMinute` | 建议 `maxRequestsPerDay` |
|---:|---:|---:|---:|---:|
| 1 | 20 | 28,800 | ≥20 | ≥28,800 |
| 20 | 400 | 576,000 | ≥400 | ≥600,000 |
| 50 | 1,000 | 1,440,000 | ≥1,000 | ≥1,500,000 |
| 100 | 2,000 | 2,880,000 | ≥2,000 | ≥3,000,000 |

另有复查/重试/批量/在线询货。`autoSharePercent=80` 时自动监测占日速率 80%，主动询货 20%；**共享总上限仍约束合计**，不能靠拆双预算绕开。

常驻 runner 需可持续执行、崩溃重启、仅租约持有者派发。费用取决于运行形态（Cloud Run 常驻 / 容器 / 其他），**未经确认不采购资源**。

## 6. 模拟验收（条件与结果）

条件：内存仓库、模拟上游、虚拟时钟；**未请求苹果接口**。

```text
node --test tests/fixed-cadence.test.mjs
→ 9/9 pass
```

| # | 场景 | 结果 |
|---|---|---|
| 1 | 20/50/100 组 3s 周期，无分钟级拉长 | 通过（平均周期 ≤3.6s，无超 7s 空档） |
| 2 | 稳定相位分散 | 通过 |
| 3 | 停机 30s 后不补发堆积 | 通过（每 tick ≤ 组数） |
| 4 | 同店串行显示瓶颈原因 | 通过 |
| 5 | 固定周期不被预算改写 | 通过 |
| 6 | 配置边界拒绝越界 | 通过 |
| 7 | autoShare 分车道 + 共享总上限 | 通过 |
| 8 | 0 提醒次数仍采集；免费用户无后台任务 | 通过 |
| 9 | planned/started/success 指标分离 | 通过 |

全量：`npm test` **1569/1569**；`npm run check` 529 文件 0 错；`node tools/release/check.mjs` **48/48**；`build-monitor --check` 通过。

模拟不能替代线上。仍需：关掉小程序后仍采集、页面数据与微信真机到达、真实延迟 P95/P99。

## 7. 剩余瓶颈

1. **上游与许可**：非授权开放 API，大规模 3s 轮询需确认条款与容量。  
2. **同店多组**：店级串行使同店超过 `intervalMs/平均耗时` 组时无法全员 3s，需增加门店或接受 `storeDelayed`。  
3. **运行成本**：100 组约 288 万次/天，需实测云资源与数据库压力后再定生产参数。  
4. **分钟级定时触发**无法提供 3s；必须常驻 runner，定时仅作降级且 UI 须显示降级。  
5. **通知与采集**已链路分离；微信受理 ≠ 用户收到，需真机确认。

## 8. 建议真实验证计划（待批准）

| 项 | 内容 |
|---|---|
| 范围 | 测试账号 1～3 个会员、N≤5 组 |
| 时长 | 30 分钟常驻 |
| 请求量 | 约 N×20×30 ≈ 3,000 次上限 |
| 观测 | `collector_status.targetPeriodMs`、每组 `scheduleDelayMs` P95/P99、漏轮比例、`storeDelayed` |
| 停止条件 | 429/503、延迟 P95>3.5s 持续 5 分钟、成本超预估 |

## 9. 部署与回滚

**部署顺序**：备份配置 → `node tools/build-monitor.mjs` → 部署 `gxs_api` + `gxs_monitor`（+触发器）→ 局部写 `cadenceMode`/预算 → 核对 `collector_status` → 再考虑小程序。

**回滚**：`cadenceMode` 改回 `adaptive` 或恢复 `collector` 备份；必要时下线常驻进程、保留定时监控并显示降级。共享冷却与租约状态**不**清空。

## 10. 未做事项

- 未推送 GitHub、未部署、未改线上配置、未真实上游压测。  
- 未改会员价格/套餐数量/支付/公告/安卓授权。  
- 生产 `interval=3` 与预算参数需按实际组数与资源测算后批准。

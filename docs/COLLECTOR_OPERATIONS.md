# 果小哨常驻采集与订阅通知运行手册

更新：2026-09-15。本文描述已实现的可部署代码。尚未创建或启用云托管实例、注入真实密钥、向微信发送消息；本地验证使用模拟 Apple / 微信接口和内存数据库。真实云端权限、索引、模板及真机收信应在上线验收时逐项确认。

## 1. 组件与文件

- `tools/collector/runner.js`：Node.js 22 常驻进程、HTTP 健康检查、SIGTERM / SIGINT 优雅关闭。
- `tools/collector/Dockerfile`：从仓库根目录构建，直接复制 `cloudfunctions/gxs_api/lib`。业务逻辑只有一份源文件。
- `tools/collector/Dockerfile.dockerignore`：构建上下文仅包含业务 lib、runner 和依赖清单；不会上传本地 node_modules、原始采集证据或环境密钥文件。
- `tools/collector/deployment.example.yaml`：单副本部署模板；CloudBase Run 的等价设置见下文。
- `cloudfunctions/gxs_api/lib/engine`：调度、事件状态机、租约、通知发送和消费者小程序专用微信适配器。
- `tests/engine-reliability.test.mjs`：关键异常、并发与进程生命周期回归测试。

## 2. 必须区分的三个开关

1. 环境变量 `GXS_ENABLE_COLLECTOR_PROCESS=true` 才连接数据库并启动工作循环。默认 false，可安全启动本地健康服务检查容器。
2. 云数据库 `gxs_config/runtime.collector.enabled=true` 才向 Apple 发起自动采集。运行中的配置刷新默认每 10 秒一次；间隔和并发会真正更新。
3. `notifications.enabled=true`，配置 restock 模板，并有匹配消费者小程序的凭证后才发送订阅消息。模板缺失、凭证缺失、消费者 AppID 不一致都不会模拟成功。

关闭采集开关仅停止新的 Apple 请求。已经持久化、尚未发送的短时有效事件仍可被通知消费者处理；需要停止消息时关闭 notifications 开关或整个进程开关。

## 3. 构建和无云请求本地检查

在仓库根目录运行：

```powershell
npm test
npm ci --prefix tools/collector --ignore-scripts
node tools/collector/runner.js --check-config
node tools/collector/runner.js
```

最后一个命令默认仅启动 `http://127.0.0.1:8080/healthz`。没有设置进程开关时不会读写真实数据库，也不会请求 Apple / 微信。

```powershell
docker build -f tools/collector/Dockerfile -t guoxiaoshao-collector:0.2.0 .
docker run --rm -p 8080:8080 guoxiaoshao-collector:0.2.0
```

镜像命令是供正式部署前执行的构建步骤；本次本机验收未构建或上传镜像。依赖固定为 `wx-server-sdk@4.0.2` 并提交了 lock 文件；云函数与常驻进程使用相同数据库 API 包装。

## 4. CloudBase Run 部署参数

先确认共享环境的云托管开通主体、资源账单归属、预算和最小权限。部署时使用项目现有共享环境，不凭空创建第二份生产数据库。

- 容器端口：8080；无业务外部写入接口，只有 GET 健康检查。
- 实例数：最小 1、最大 1；使用不会缩容到零的常驻模式。滚动更新产生短暂重叠时，数据库租约保证只有持有者分发采集和领取发送任务。
- 启停：终止宽限至少 35 秒，进程优雅关闭预算 30 秒；停止新请求后等待在途工作，写入 stopped 状态后释放租约。
- 初始资源建议：请求 100m CPU / 128 MiB，限制 500m CPU / 384 MiB；此为模板起点，需根据实际目标量和观测内存调整。
- 健康检查：`/healthz`，15 秒间隔。工作循环 60 秒无法完成租约续期时返回 503。
- 就绪检查：`/readyz`。进程未启用、采集开关关闭、没有租约或心跳过期时返回 503；健康存活不等于正在监测。
- 数据库使用云托管工作负载身份。自建容器另需通过 secret 注入 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`，临时凭证还需 `TENCENTCLOUD_SESSIONTOKEN`；不要把任何密钥写入源码或镜像。

环境变量：

```text
PORT=8080
GXS_ENABLE_COLLECTOR_PROCESS=false
GXS_CLOUDBASE_ENV=flowermean-6gjaxfqhf6c13e88
GXS_CLOUDBASE_REGION=ap-shanghai
GXS_CONSUMER_APPID=<消费者小程序 AppID>
GXS_CONSUMER_APPSECRET=<仅通过云托管密钥注入>
```

需要发送通知的是消费者小程序 `wxe96ad9e77b602f1b`。资源环境所属小程序 `wxc6dfebb77650f3a9` 的 access_token 不能用于消费者用户的 openid。发送器显式获取消费者的 stable access_token，且发送前校验用户 appid；没有调用共享环境隐式的 `cloud.openapi.subscribeMessage.send`。

## 5. 模板和订阅授权

在消费者小程序后台选择符合业务用途的订阅模板，将真实模板 ID 配入 `notifications.templateIds.restock`。模板字段需和实际模板一致：默认 product=`thing1`、store=`thing2`、time=`time3`、status=`thing4`；可以通过 `notifications.templateFields` 映射实际字段编号。商品和门店文字会去 HTML 并截断至 20 字符。

前端每次用户点击并完成 `wx.requestSubscribeMessage`，生成一个 requestId。请求记录格式为 `{requestId, results:{模板ID:'accept'|'reject'|'ban'}}`，网络重试必须沿用原 requestId。服务端校验当前模板白名单，并在事务内幂等累计额度，防止同一次授权重试多加。

客户端上报的 accept 是本地授权账本线索，不能替代微信平台的最终授权检查。平台明确拒绝时记录 failed；本地账本的额度并不保证该条消息一定被微信接受。

## 6. 漏发、重复发送与恢复规则

- 手动查询和自动采集共享原子观察状态机。所有可提醒事件进入持久事件集合，常驻消费者从数据库读取未规划事件。
- 每个“用户 × 事件”生成确定性任务 ID。全部任务保存后才标记事件已规划；中途数据库失败，下一轮重新规划并靠 ID 去重。
- 发送任务通过事务从 pending 领取为 sending。发送前重读会员、关注状态、通知开关、免打扰、模板、事件时效和消费者身份。
- 1.1.8 起，提醒要等下一次复查确认：新状态被再次看到才规划任务，复查时已变回则丢弃；只被看到 1 次的「有货」不会引出断货提醒，「有货 → 断货一次 → 又有货」不算新补货。等待确认的事件会让门店立即进入复查。
- 可提醒事件包括补货类事件和断货（`became_unavailable`，需配置 `templateIds.soldout`，只发会员）。规划只读取最近 10 分钟未规划的事件，旧积压不会挡住新提醒。
- 一次发送额度通过事务预留；冷却按用户 × 门店 × 商品计算，补货和断货分开计。代码默认 30 分钟，线上 1.1.8 配置为 0（每次都提醒）。
- 默认超过 120 秒的事件不再发送，记录 `event_expired`。可以用 `maxEventAgeSeconds` 调整，但库存提醒延迟过长会失去意义。
- 平台返回 errcode=0 才标记 accepted，含义是平台受理；不等于已经证明用户看到消息。
- 平台明确拒绝标记 failed，并幂等归还本地预留额度。超时、无法解析的平台响应或发送阶段异常标记 uncertain，不归还、不自动重试，以免重复发送。
- sending 的领取租约过期后标记 uncertain，避免进程重启重复发送可能已经送达的消息。这个保守策略可能留下漏发；应根据平台记录人工核实，不能把 uncertain 一键改回 pending。
- 关闭或缺少发送凭证时显示 disabled，pending 任务保持可审计；恢复凭证后仍受事件时效限制。

## 7. 请求量、预算与扩容

**变化时加速（1.1.8）**：`collector.burstIntervalSeconds`（默认 2）与 `collector.burstQuietSeconds`（默认 20）。某门店出现状态变化后改为每 2 秒请求，持续到连续 20 秒无变化；加速只会让检测变快，不会慢于平时间隔；同一门店两次请求至少间隔 2 秒。定时模式下单次运行在有门店加速时持续到平台剩余时间减 5 秒（最多 55 秒），加速状态随调度检查点带到下一分钟。设为 0 可关闭。全局每分钟、每日预算照常生效。

采集按“门店 × 分片后的 SKU 集合”合并目标，默认每个请求最多 20 个商品。调度默认目标间隔 8 秒、并发 2；实际覆盖间隔可能因目标数、请求延迟、全局预算或上游限流更长。界面应展示真实健康统计与上次观测时间。

配置项：`intervalSeconds`、`maxConcurrency`、`maxPartsPerRequest`、`maxRequestsPerMinute`、`maxRequestsPerDay`。默认硬上限为 60 次/分钟、10,000 次/北京时间日。计数在数据库事务内持久化，重启不会归零；达上限会显示 budget_limited，并等待下一分钟或北京时间午夜。

请求量粗估：目标组数 × 86,400 ÷ 间隔秒数，最终还受预算上限限制。例如 3 组、每 30 秒一次约为 8,640 次/日。3 组、每 8 秒一次约为 32,400 次/日，会先触及默认 10,000 次日预算。这个上限是请求量限制，不是人民币账单封顶；每个请求还涉及租约、预算事务、各商品状态、事件和健康记录的数据库读写，以及常驻 CPU / 内存费用。正式启用前应测量单日账单后决定上限，不能据此承诺“每天只花多少钱”。

上游 429 / 503 会打开全局熔断，尊重 Retry-After。冷却结束只放一个探测请求；熔断前已在途的其他成功响应不能提前解除限流。不要通过增大实例数或关掉预算绕过上游限制。

## 8. 数据库与上线验收

需要已有业务集合。索引至少覆盖：events 的 notificationPlannedAt + detectedAt + _id；notifications 的 status + createdAt + _id，以及 status + leaseUntil；现有查询和关注索引继续保留。不同数据库控制台可能要求补充组合索引，应按实际错误创建并保存索引清单。

预算文档带 expiresAt 清理标记；配置集合还包含订阅 requestId 幂等凭据、冷却记录与业务配置。不可对整个配置集合执行无条件 TTL 清理，也不可过早删除授权幂等凭据。应按文档 kind / ID 前缀和保留策略做受控清理；本次代码没有自动删除历史数据。

正式验收顺序：

1. 使用测试环境或受控目标核实数据库事务、索引、租约竞争和权限。只启动一个实例，观察真实请求数与预算计数一致。
2. 验证配置 8 秒时真实请求不会每秒发出；暂停采集后不再创建新请求；终止实例后状态会过期。
3. 由测试会员主动授权一次，观察 unavailable→available 事件及任务；分别核实手动先发现、自动发现、数据库临时失败后的恢复。
4. 只有在明确同意发送测试消息后，打开通知开关做一次真实订阅发送，对照任务 accepted 与真机消息。模板不匹配或权限失败应记录明确原因。
5. 保留一段真实健康数据与成本账单，再扩大商品和门店覆盖；不要将离线测试结果写成已完成生产验证。

参考：腾讯官方 [CloudBase Run 概述](https://docs.cloudbase.net/run/quick-start/introduce)、[Node SDK 初始化源码文档](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/initialization.md)。微信消息接口的真实账号可用性、模板和权限仍需要按上述流程在消费者小程序后台核验。

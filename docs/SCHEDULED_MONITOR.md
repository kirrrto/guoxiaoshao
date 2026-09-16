# 补货定时监测部署

更新：2026-09-16。`gxs_monitor` 是独立的定时云函数，复用 `gxs_api/lib` 的库存观测、事件、关注、会员、预算和发送逻辑。本文的命令是部署步骤；代码完成及离线测试通过不代表云端已部署或已收到微信消息，线上结果另看本次验收记录。

## 运行方式

每分钟触发一次，每次目标最多扫描一轮。单次工作分发截止时间为 35 秒，给正在进行的网络和数据库请求留出云函数收尾时间。部署的函数超时设为 60 秒，内存 256 MB，运行时 Node.js 20.19 或云环境支持的更新 Node.js 版本，入口 `index.main`。

关注仍需是 `active` 且属于有效会员。多个用户同门店同商品合并请求；每分钟 / 每日请求预算继续生效。目标太多、上游异常或预算达到上限时，实际间隔会大于一分钟，页面显示上次实际观测时间。

采集与发送使用同一数据库租约。不要同时启用常驻进程和定时函数；重叠时只有租约持有者运行。库存状态与待处理事件始终保存在数据库；冷启动不会丢失补货事件。调度进度及 HTTP 429 / 503 的 Retry-After 同样持久化，避免重启越过上游限流。心跳有效期为 150 秒，覆盖正常的一分钟调度空档；失去后续触发后会显示过期。

## 生成部署目录

修改共享后端代码后，在仓库根目录执行：

```powershell
npm ci
node tools/build-monitor.mjs
node tools/build-monitor.mjs --check
node --test tests/monitor-bundle.test.mjs tests/scheduled-monitor.test.mjs tests/collector.test.mjs tests/engine-reliability.test.mjs
node tools/release/check.mjs
```

`cloudfunctions/gxs_monitor/lib` 是自动生成的部署目录，应只改 `gxs_api/lib` 后重新生成。生成器从 `gxs_monitor/index.js` 出发，使用 Acorn 解析实际的字面量 `require()`，只复制递归依赖到的模块。自动观测与手动查询共用 `engine/observations.js`，监测包不再引入 API 路由或 `services/*`。仓储中的共享事务仍按模块复用，不能将“没有 API 路由”理解成已经按每个函数裁剪所有代码。

生成的 `lib-manifest.json` 按路径排序，记录入口和共享文件的 SHA256、字节数及外部依赖，不含构建时间，因此相同输入可复现。文本按 UTF-8 严格解码并统一 LF 换行后计算字节数、哈希、复制及检查，Windows CRLF 工作树和 Linux CI 得到相同清单。`--check` 和发布预检查共用规则：缺失文件、内容变化、额外文件或清单过期都会失败。新增模块依赖无需手工维护复制名单；删除依赖后，构建会清理仅位于 `gxs_monitor/lib` 内的过期普通文件，不会清理函数根目录、源目录或其他位置。

构建对路径越界、符号链接、目录 junction、动态或别名 `require`、`require.resolve`、动态 `import()` 和未声明的运行时依赖直接报错。共享本地模块限 `.js` / `.json` 与默认 `index`，不支持含 `package.json` 的本地目录包；需要新形式时先扩展解析和测试。Acorn 是根项目的开发依赖，由根目录 `npm ci` 安装，不放进云函数依赖或上传包。

上传整个 `gxs_monitor` 目录（包括生成的清单），云端安装 `wx-server-sdk@4.0.2`。发布检查还需要三个云函数本地已各自完成 `npm ci`。`config.json` 已包含触发器名 `gxs-monitor-minute` 及每分钟的配置。

## 先验证触发身份，再启用采集

1. 部署 `gxs_monitor`，先保持环境变量 `GXS_ENABLE_SCHEDULED_MONITOR=false`。此时符合条件的触发也不会读写业务数据库或请求 Apple / 微信。
2. 创建 / 上传 `config.json` 中的定时触发器，观察实际云端日志返回：应是 `state: process_disabled`，并带 `source: wx_trigger`，或 SCF 原生触发的 `triggerSource: timer`、`runEnvironment: SCF`。来源仅取自 SDK 可信上下文及平台内置环境变量，不会信任事件负载伪造的来源。环境级函数规则还应禁止客户端调用 `gxs_monitor`。
3. 如果平台返回 `timer_only`，查看只含来源标记和是否存在用户身份的诊断。不要直接删掉检查，也不要仅依据 `event.Type === 'Timer'` 放行。用户端、HTTP、开发者工具手动调用及未知来源均被拒绝；真正的 timer 触发必须提供平台可信来源。
4. 确认身份后，设置环境变量 `GXS_ENABLE_SCHEDULED_MONITOR=true`，并合并更新 `gxs_config/runtime.collector`：`enabled: true`、`intervalSeconds: 60`、`statusStaleAfterSeconds: 150`。保留既有管理员、会员、次数等其他配置，以及预算、并发和限流参数，不用整份默认配置覆盖现有 runtime。
5. 在两个相邻分钟核实 `gxs_config/collector_status` 的 `mode: scheduled`、`updatedAt`、`stats.lastBatchAt` 确实变化，且目标最新观测的 `source` 为自动采集。不能只凭配置 enabled 宣称已经在监测。

## 订阅消息独立接入

采集不需要微信 AppSecret。缺少模板和发送凭证时，可先启用库存采集，保持 `notifications.enabled=false`。

真实消息发送还需要消费者小程序的订阅模板、用户主动授权、消费者凭证，以及通知开关。消费者为 `wxe96ad9e77b602f1b`，不能使用资源环境所属小程序的凭证代替。通过云函数环境密钥配置 `GXS_CONSUMER_APPID` 和 `GXS_CONSUMER_APPSECRET`，不得把 AppSecret 填入小程序端、源码包或聊天。

模板映射 `product` 和 `store` 对应 `thingN`，`time` 对应 `timeN`，`status` 可对应 `thingN` 或 `phraseN`。四个字段必须互不重复，且应与后台实际选取的模板语义一致。商品和门店长度最多 20 字，当前状态用语不超过 5 个中文字符。

`user.bootstrap` 兼容保留 `notifications.enabled`，新增 `templateConfigured`、`deliveryReady`、`reason`。`enabled` 仅代表配置开关；`deliveryReady` 才会综合新鲜采集心跳与实际发送器配置判断。它仍不代表用户已授权或已收到消息，授权额度和会员、免打扰状态继续单独检查。

## 官方参考

- [CloudBase 定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)：触发器配置与上传方式。
- [CloudBase 云函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)：函数运行时、环境变量、超时及触发器配置。
- [SCF 内置环境变量](https://cloud.tencent.com/document/product/583/30228)：定时触发时的 `TRIGGER_SRC=timer` 和运行时 `TENCENTCLOUD_RUNENV=SCF`。
- `wx-server-sdk@4.0.2` 本地安装源码 `getWXContext`：从运行环境读取微信上下文及 `TCB_SOURCE`，不读取业务事件的自报身份。

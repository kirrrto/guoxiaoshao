# 果小哨 · v1.4.1

个人取货信息查询、关注和提醒记录工具。四个页面用于查询、小哨提醒、历史记录和账户管理。当前修复版为 **v1.4.1**，正式上一版本为 **v1.4.0**；早期提交里的 1.1.x 编号保留为历史记录。

## 当前发布状态

- **本次变更与验收状态**：[v1.4.1 发布说明](docs/RELEASE_1.4.1.md)。源码检查、云函数部署、微信前端发布和手机实际验收分别记录。
- **既有购买事实**：维护者于 2026-09-23 确认手机微信付款后可正常开通会员。此事实不等于本次版本已经完成双端支付、退款或新提醒模板的手机验收。
- **监测恢复**：2026-09-28 修复平台剩余时间工具异常导致的定时监测启动失败，真实定时调用恢复。见 [稳定性修复记录](docs/HOTFIX_2026-09-28.md)。
- **数据范围**：历史来自本程序实际采集，未采集或监测中断期间的历史无法补造；监测覆盖有效关注目标，不代表全国全型号持续覆盖。

## v1.4.1 解决的问题

- 查询、历史查询、保存和转关注在点击时读取当前配置，避免快速切换后提交旧型号或门店。
- 保存结果与刷新结果分开处理；已确认保存不因后续读取超时被显示为保存失败。
- 旧账户请求不再覆盖新提醒次数；自动补次数与手动授权共享执行锁，网络不确定时保留原请求编号重试。
- 提醒卡片关闭、切换或退出后，旧反馈响应不会改写其他提醒。
- 连续确认会被未知观测中断；目标刷新和旧事件重读不再错误打断或延长加速复查。
- 采集和消息请求按剩余运行时间限制超时；尚未发出的消息安全退额重排队，可能已发出的消息保留“不确定”状态，避免重复发送。
- 云环境初始化失败可恢复；畸形支付回调参数在入口拒绝；发布检查新增文档和根锁文件版本一致性验证。

## 使用规则

- 免费查询默认签到和浏览历史任务各奖励 1 次，每日最多 2 次，余额最多 10 次。实时和历史查询各消耗 1 次；全部上游请求失败时退回本次次数。
- **会员 7 元／7 天单次购买**，商品 `vip666`，已有会员顺延，不自动续费。金额、有效期、订单核实和权益由服务端决定。源码默认关闭购买，实际是否开放由云端配置及支付服务状态决定。
- 会员最多关注 **3 个配置，每个配置 3 家门店**。不同容量或颜色分别占名额；暂停保留名额，删除释放。到期保留配置，停止会员自动提醒。
- 从未收到过到货提醒的非会员可使用 1 个关注配置、1 条到货提醒体验；断货提醒为会员功能。
- 到货与断货分别使用模板授权次数。微信每次授权按模板增加 1 次，发送每条消耗对应的 1 次；会员不等于无限提醒。
- 平时按分钟检测，变化后约每 2 秒复查，连续确认后才提醒；20 秒无新变化退出加速。并发、上游预算和平台时限可能拉长实际间隔。
- 历史原始记录保留最近 10 天；账户、订单、次数账本和每日摘要按各自规则保存。读取页面不会产生新库存观测。
- 会员兑换保留独立入口，每账号限领一次；活动总名额默认 20，已有兑换计入，活动码由运营另行提供。

## 本地开发与检查

微信开发者工具导入仓库根目录，消费者代码为 `miniprogram/`。运营工具单独导入 [tools/admin-miniprogram](tools/admin-miniprogram/README.md)，服务端仍校验管理员身份。

```powershell
npm ci
npm ci --prefix cloudfunctions/gxs_api
npm ci --prefix cloudfunctions/gxs_monitor
npm ci --prefix cloudfunctions/cloudbase_auth
node tools/build-monitor.mjs
node tools/build-monitor.mjs --check
npm test
npm run check
node tools/release/check.mjs
```

`gxs_monitor` 从 `gxs_api` 的实际依赖闭包生成，不手工维护复制文件。离线预览使用实际 WXML/WXSS 和测试数据，不证明手机交互或消息送达。

GitHub 仓库：[kirrrto/guoxiaoshao](https://github.com/kirrrto/guoxiaoshao)。Actions 执行测试、源码和发布检查，不自动部署云函数或发布微信前端。

## 结构与运行边界

- `miniprogram/`：四个消费者页面、选择器、会话缓存和品牌资源。
- `cloudfunctions/gxs_api/`：身份、查询、关注、会员、支付、运营配置及共享监测实现。
- `cloudfunctions/gxs_monitor/`：定时监测入口与生成的运行依赖。
- `cloudfunctions/cloudbase_auth/`：共享环境的消费者身份授权。
- `tools/admin-miniprogram/`：独立运营项目；`tools/collector/` 为可选常驻采集工具。
- `tests/`、`evidence/verification/`：离线回归和脱敏验收记录。原始函数备份、截图和临时输出保存在忽略目录。

业务身份只采用可信微信上下文，普通业务 HTTP 请求不能伪造用户；支付 HTTP 回调使用专门路径、认证和查单。共享环境为 `flowermean-6gjaxfqhf6c13e88`，消费者 AppID 为 `wxe96ad9e77b602f1b`，资源方 AppID 为 `wxc6dfebb77650f3a9`。密钥只存云端环境变量，不写入代码、文档或日志。

本项目尚未确认上游数据源授权，不能声称已获授权。请求预算、429 熔断和未知状态降级见 [上游保护及发布边界](docs/UPSTREAM_PROTECTION.md)。

## 文档

- [v1.4.1 发布说明](docs/RELEASE_1.4.1.md) · [v1.4.0 历史说明](docs/RELEASE_1.4.0.md)
- [版本与回退](docs/VERSION_CONTROL.md) · [CI 说明](docs/CONTINUOUS_INTEGRATION.md)
- [支付配置与验收](docs/VIRTUAL_PAYMENT_SETUP.md) · [订阅配置与验收](docs/SUBSCRIBE_SETUP.md)
- [定时监测部署](docs/SCHEDULED_MONITOR.md) · [采集运行手册](docs/COLLECTOR_OPERATIONS.md)
- [数据模型与接口](docs/DATA_MODEL_AND_API.md) · [管理员权限与审计](docs/ADMIN_SECURITY.md)
- [会员兑换](docs/MEMBER_REDEMPTION.md) · [品牌资源](docs/BRAND_MINT.md)

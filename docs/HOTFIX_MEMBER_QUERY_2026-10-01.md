# 会员查询故障复核 · 2026-10-01

状态：补齐 PR #3 的代码与回归；尚未核实当前线上 runtime，尚未执行本次云函数部署或微信发布。源码版本沿用 PR 的 1.5.0，不能只用版本号判断修复是否上线。

## 投诉与已核实事实

截图同时显示「会员 · 不限次数」和查询额度已用完、等待 17657 秒。截图中 19:05 左右的时间加等待时间约为北京时间次日 00:00，与旧共享日请求上限行为吻合；截图不能证明支付未激活，也不能代替线上日志。

核对 [PR #3](https://github.com/kirrrto/guoxiaoshao/pull/3) 的原头提交 `e105f8232580ad9e4a64010149a488ad35cf3fac`：open、draft、未合并，无 review 或讨论记录；关联 GitHub Actions 成功。PR 正文明确声明未读取线上 runtime/当天计数，未部署云函数或发布小程序。因此此前完成的是修复候选和离线验证，没有线上恢复证据。

## 此次发现并修复

1. **旧目标等待阻止新模式恢复。** `sharedQueryPickup → claimQueryTarget` 无条件沿用 `query_target_*.deferUntil`。即使管理员切换为 continuous，之前的 daily_budget 仍把这个门店/SKU 拦到午夜。现在将当前模式传入领取事务，仅 continuous 忽略旧 daily_budget / auto_budget_reserved，仍经过活动租约、连续容量、分钟上限和断路器准入。
2. **会员生效后仍显示旧非会员限制。** 账户刷新已识别会员，页面却残留「次数不足」或「免费用户暂不能实时查询」。现在仅清除 insufficient_credits / new_product_restricted 的文案及原因，上游暂停、容量不足、频率/并发限制与失败提示保留。
3. **会员前端测试实际未创建会员视图。** 旧 daily 文案测试设置了页面不读取的字段。现在通过 bootstrap 返回有效会员，并显式断言 `boot.member === true`。

## 复现与验证

新增测试先在旧实现失败，再应用修复。完整查询入口回归设定北京时间 2026-10-01 19:05:43、有效会员、当天预占 10000 次，重现 `member: true`、零扣次和 `retryAfterMs: 17657000`。通过真实 `admin.updateConfig` 入口切换 continuous 后，首次按零容量重新准入，模拟时间推进最多 43.201 秒后查询成功；当天计数保留并增至 10001。这里的等待取决于默认配置与无额外竞争的模拟场景，不是生产恢复时限承诺。

回归另覆盖活动租约、显式 daily、分钟等待、连续容量等待、普通失败等待、429 断路器，以及 `invalidateBootstrap → onShow` 的会员状态刷新。

- `node --test --test-reporter=spec tests/*.test.mjs`：782 通过、0 失败、0 跳过。
- `node tools/check-source.mjs`：340 文件，0 错误。
- `node tools/build-monitor.mjs` 和 `--check`：32 个依赖文件一致，215253 bytes。
- `node tools/release/check.mjs`：34/34 本地检查通过。

审查遗漏原因：已有容量迁移测试直接调用 guardedPickup，没有经过手动查询目标的持久等待状态；前端会员文案测试又未真正进入会员分支。测试通过、云函数心跳和同版本号均不足以证明付费用户可完成查询。

## 线上闭环仍需完成

本机微信开发者工具 CLI 返回服务端口关闭，当前无法通过已登录开发者工具读取云端部署。需开启「设置 → 安全设置 → 服务端口」后继续核实，而不是推定线上已更新。

1. 读取并备份当前 API/monitor 包、runtime、当日 collector_budget、upstream_capacity、collector_status；如存在 query_target 日等待保留其状态供核对。
2. 部署同一修复提交的 API 和生成的 monitor；启用中的常驻 collector 同步源码。读取 runtime 的实际 budgetMode，使用局部 patch 改为 continuous，保留其他参数和全部账本，不重置计数。
3. 核对当前已付费会员的查询结果、净扣次和采集时间；确认旧目标日等待能进入新容量准入，monitor 产生新的有效观测。受控核对故障与恢复，不在生产制造日额度耗尽或伪造库存。
4. 上传并发布同一提交的前端，真机确认会员开通后返回查询页状态正确。服务端兼容旧客户端，恢复查询无需等待前端审核。记录云包内容/修复提交、上传和发布时间，以及实际验收结果；线上成功前不标记事故恢复。

配置及发布顺序详见 [查询容量](QUERY_CAPACITY.md) 和 [定时监测部署](SCHEDULED_MONITOR.md)。

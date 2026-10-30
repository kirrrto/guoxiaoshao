# V3.5.0 本地验证与交接

日期：2026-10-30（北京时间）。工作区为 `C:\Users\Administrator\Downloads\flower book\guoxiaoshao-master\guoxiaoshao-master`，基线 `7cc3827`。本轮交付范围为经代码审查的 GitHub 源码候选；本记录不代表云端、微信上传或正式发布状态，实际提交与同步状态以 Git 记录为准。

## 范围与选择

维护者确认 V3.5.0 先实现到期提醒的手动免费试验方向，其他来源监控、跨品牌与 OCR 后续验证。按最新确认，默认首页继续为库存查询，「我的小哨」放在第二个原生入口；保留 Apple 查询、关注、会员与实际观测链路。免费日期事项与付费库存关注分别表达，不扩大现有购买权益。

复用既有主绿、系统中文字体、WXML/WXSS、语义变量和四个原生入口。使用 Impeccable 的既有界面扩展与独立审查流程，没有更换设计身份。原生 WXML/WXSS 无完整 detector 覆盖；机械检测只针对源码派生的 HTML，结论受此范围限制。

Apple 新品目录、ProLED 15 项标准零售 SKU、Mac Studio 45 项精确配置及完整可选配置边界，见 [发布说明](RELEASE_3.5.0.md#apple-新品与可观测边界)、[零售配置证据](../evidence/catalog/2026-10-30/mac-selected-configurations.json)、[Mac Studio 定制配置证据](../evidence/catalog/2026-10-30/mac-studio-cto-research.json) 与 [逐项配置采集](../evidence/catalog/2026-10-30/mac-studio-configurations.json)。45 项包含 3 个标准零售 SKU 与 42 个定制配置；预售目录不因日期到来自动开放监测。

Mac Studio 补充核验使用 1 次公开前端脚本 GET、5 次公开兼容选项 GET，全部返回 HTTP 200；随后 40 次受限配置 GET 解析完整配置。四种芯片的实际兼容选项覆盖 36/48/64/96/128/256/512GB 七档内存和最高 16TB 存储；完整矩阵见发布说明，另确认 Ultra 36/80、512GB、16TB 的精确官方选项 ID。导入器只接受逐项请求与响应维度一致、选项未阻断且容器身份完整的 45 项，缺项、重复或自动改写依赖都会停止。定制款不支持 Apple Store 店内取货，仅作参考展示；首次定制取货 GET 返回 HTTP 541（Apple 404 页面），接手复核以 `pl=true` 再验证一次仍为 541，标准零售请求在同一环境也返回 541，不能作为有货或无货结论。所有请求均不涉及购物、购买、账号 cookie 或 token。

## 发版代码审查（2026-10-30，GitHub 源码候选）

维护者确认先同步源码候选，并在 GitHub Actions 保留原有检查、补充 v3.5.0 离线界面回归。不得以本地通过关闭微信质检门禁，不创建正式 Release，不部署云函数或上传微信。以下为本轮最新结果，优先于后文历史候选。

审查发现并修复六项问题：到期授权离线重试丢失原凭证；原生授权无回调持续锁定；同修订迟到拒绝覆盖有效授权；令牌获取跨过到期边界后仍发起通知；目录再生成丢失 ProLED 预售限制且 pending 抽样错误授予能力；旧版 CI 场景仍要求已撤销的活动公告。前后端修复与目录修复均经过独立交叉复核。原生授权超时为 30 秒，使用操作标识隔离迟到回调；此为模拟计时器验证，不保证后台墙钟时限。拒绝新的授权请求不撤销已有同修订有效授权；编辑仍清除旧授权。绝对到期时间约束令牌获取及消息发起，明确未发送才记为 missed，已经发出的不确定结果不自动重试。

依赖审计另发现 `follow-redirects` 与 `qs` 漏洞，三个云函数和可选 collector 分别升级至 `1.16.2` 与 `6.17.1`。collector 遗留的 `lodash.set` 依赖通过与云函数相同的 `@cloudbase/database: 1.5.1` 覆盖移除，没有降级 SDK 或使用强制审计修复。四个生产依赖树最终审计均为 0；collector 锁定安装、语法检查和 SDK 导入通过，发布源码检查已纳入相应锁文件约束。

最终整仓回归为 **1896 项通过、0 失败、0 跳过**，较接手候选新增 21 项回归；完整 TAP 记录见 [release-review-tests.log](../evidence/verification/3.5.0/release-review-tests.log)。运行环境为 Windows / Node.js 26.5.1，不能替代云端运行时验证。`npm run check` 检查 637 个文件、453 个 JS、53 个 JSON，无错误；项目未配置独立 lint/typecheck 命令。monitor 重新生成后 `--check` 核验 50 文件、375292 字节一致，实际 monitor sender 的截止时间离线复现也确认不会请求令牌或消息接口。

最终 v3.5.0 预览包含 96 个快照，浅深色及 1.3 倍字号四组共 **384 次布局**检查全部通过；原生 tab 的浏览器近似浅深各 213 案通过；颜色浅深各 303 项、活动控件各 298 项，无低于阈值或无法测量项。实际页面方法覆盖保存、未知结果恢复和冲突等状态，并查看窄屏编辑及深色恢复代表图。原 v3.4.3 CI 专项也重新生成，浅深各 156 张布局、各 372 案导航、120 案选择器对齐、浅深各 236 项颜色检查通过。本地完整预览产物分别位于忽略目录 `output/review-v350` 与 `output/playwright/catalog-v343`；不将 Chromium 近似当作微信原生验收。

[最终发布检查](../evidence/verification/3.5.0/release-review-check.json) 的 `sourceChecksPassed: true`，源码指纹为 `sha256:e19a5f0b9432279e1666c3e75f8dc489e42356df73dad36527d0808c0cceb89d`。`publicationReady: false`，发布命令仍按设计退出 1：未用 channel-video、首次 tab 切换、图片体积及旧图片格式四项缺少当前版微信复验证据。GitHub 工作流保留这一失败条件，不能称 CI 全绿；源码同步与正式发布分别判断。

目录修复只改变后续维护流程，不改当前 397 项目录、预售及 CTO 的当前能力，也不清理历史目录状态。已有 HomePod mini 2 的 pending/verified 例外来自旧版，本轮未更改，不能把新采样规则称为全量历史数据修复。修复没有增加线上库存采样或降低 unknown 覆盖；本次没有云端业务写入、真实授权、通知发送或收信验证。通知默认关闭，回退仍按发布说明先关发送、保留事项和幂等回执。`.workbuddy/` 本地记录及被忽略的原始素材、预览不纳入源码提交。历史文本证据保留原始 CRLF 与失败断言输出中的空白行；暂存区默认 `git diff --check` 因这些原始日志报空白告警，没有为制造全绿而改写证据。源码与文档单独检查无空白问题。

## 接手复核（2026-10-30 下午）

当前工作区在上一候选之后完成 Mac Studio 定制款参考隔离、过期公告清理、到期模板五字段映射、前端回归、图片映射和文档一致性。实际结果保存于 [复核证据](../evidence/verification/3.5.0/takeover-revalidation.json)。

- 修正了旧断言仍把 Mac Studio 当作 3 个零售 SKU、允许内部 CTO 编号混入零售货号语义、以及分页/关联数据源仍只接受 `CH/A` 的问题。42 个定制配置只作为官网配置参考，`querySupported/supported/monitorSupported` 均为否，不再进入查询或关注候选；3 个标准零售 SKU 的查询保持原样。
- 删除 10 月 28 日会员礼遇的过期内置公告；当前公告改为 Mac 目录与定制款说明，并在客户端离线兜底中同步，避免旧缓存继续展示活动。
- 重新运行全量测试 **1875 项通过、0 失败**（约 204 秒），包含定制款参考隔离、过期公告清理、五字段模板、迁移键与旧结果关注回归。`node tools/check-source.mjs` 无错误（635 个文件、451 个 JS、53 个 JSON），monitor 构建 50 个文件通过。
- V3.5.0 离线预览重建 96 个快照，浅色、深色、1.3 倍字号和短窗口四组布局均无溢出、裁切、文案或图片失败；原生 tab 近似浅深各 213 案通过；颜色浅深各 303 项、活动项 298 项，无低于阈值或无法测量项。当前 245 个小程序源文件的集合指纹为 `1b3b1c8367fac0edd19e9ca26d466740168e61c7c172128367340d8c30cf50da`。代表图：[定制款配置参考](../evidence/verification/3.5.0/ui-takeover/query-mac-studio-reference-375.png) 与 [标准零售摘要](../evidence/verification/3.5.0/ui-takeover/query-mac-studio-retail-375.png)，确认定制款说明位于范围列表顶部、内部 CTO 标识不作为货号展示。以上仍是 Chromium 近似，不是微信编译或真机验收。
- 发布门禁 `sourceChecksPassed: true`，但 `publicationReady: false`；仍由 3.3.1 遗留的四项微信质检复验阻塞：未使用的 `channel-video`、自定义 tabBar 首次切换、商品图片过大和旧图片格式。不能把本地全量通过写成可发布。
- 到期提醒运行时仍为 `enabled: false`。后台「日历事件提醒」模板 ID 与五个关键词已通过截图核对，源码已配置 `thing3/time2/time6/thing7/thing5` 并补齐事件类型映射；[离线映射计划](../evidence/verification/3.5.0/deadline-template-plan.json) 生成 `deliveryEnabled: false` 与合成消息预览。模板类型仍需确认，存量云端配置、同版函数、凭据和真实授权/收信仍未验证。

历史段落以下方“前序候选”保留原貌；其 244 源哈希和旧 UI 结论不适用于当前源码，不能用来关闭本轮检查。

## 本地自动检查（前序候选）

- 用户纠正后的最终完整回归 [corrections-final-tests.log](../evidence/verification/3.5.0/corrections-final-tests.log) 为 **1858 项通过、0 失败**，耗时约 136 秒，包含本轮所有最终业务源码及新增回归。早先 1842 项候选及后续定向日志保留作历史；本轮中间全量曾发现 isolated picker 属性样式和缩略图目录哈希关联三项失败，已修复并重新全量通过，没有放宽门禁。
- [最终源码检查](../evidence/verification/3.5.0/corrections-final-source-check.log) 无错误，检查 623 个文件、440 个 JS、53 个 JSON，覆盖消费者 8 页和独立运营 1 页。
- [monitor 构建](../evidence/verification/3.5.0/monitor-build.json) 与随后 `--check` 确认生成副本与 49 个规范运行依赖一致。
- [最终发布门禁](../evidence/verification/3.5.0/corrections-final-release-check.json)：`sourceChecksPassed: true`，`publicationReady: false`。源码与图片预算、版本、云函数包锁、目录副本及导航一致性通过；正式发布门禁仍由四项历史微信质检复验记录阻塞。目录增加 CTO family 元数据后，逐一重核 355 个 SKU 的原图映射和 118 组缩略图的原始与产物哈希，再更新清单关联；图片字节未变，见 [重核证据](../evidence/verification/3.5.0/thumbnail-catalog-revalidation.json)。
- `git diff --check` 无空白错误。以上不代表微信编译包体、真实运行性能或云账单验证。

新增行为回归覆盖北京时间及无效日期、20 条并发保存限制、跨账号隔离、原操作重试、修订冲突恢复、原生授权失败、保存中账号切换、独立模板授权、发送前设置重读、并发领取、不确定发送不重试、删除释放名额、免打扰和超期。

## 前一候选离线界面检查（历史）

证据集中在 [UI 目录](../evidence/verification/3.5.0/ui/)，源指纹保存在 `manifest.json` 与各份 metrics 中。72 个源码派生场景覆盖首页及到期页、320/375/430px、加载/空/正常/失败/保存/冲突/过点未授权，以及 Apple 读取失败时仍可使用到期入口。

- 常规字号浅色、深色与 1.3 倍字号/600px 短窗口浅色、深色共 288 个场景检查，横向溢出、裁切、必要文案缺失、图片失败和到期控件检查均为零。
- 新增常用控件实际触区至少 44px，受影响功能文字至少 12px。检查范围是 Chromium 近似，不是微信触控或无障碍认证。
- 浅深色各 184 项颜色测量，179 项活动控件/占位文字，均无低于阈值或不支持结果；主按钮最低约 5.357:1。此结论不替代全屏正文或原生读屏验证。
- 原生 tab 的 HTML 几何近似共 324 案通过。四个真实微信原生 tab 的首次跳转、注入、焦点及设备安全区仍待微信复验。
- 对最终生成 HTML 做一次 Impeccable 机械检测，实际 exit 2，保留 8 条警告：2 条预览说明条、4 条 HTML 原生 tab 标签近似，以及库存状态分组与原生 picker 外壳两条形状告警。不修改规则消除告警，也不宣称 detector 全绿；逐项判读见 [UI 验证摘要](../evidence/verification/3.5.0/ui/verification.json)。

代表图：[首页浅色](../evidence/verification/3.5.0/ui/home-375-light.png)、[首页深色](../evidence/verification/3.5.0/ui/home-375-dark.png)、[到期编辑浅色](../evidence/verification/3.5.0/ui/deadline-editor-320-light.png)、[到期编辑深色](../evidence/verification/3.5.0/ui/deadline-editor-320-dark.png)。

独立审查最初发现三项 P2：修改冲突后继续提交旧修订、过点未授权事项指向不可用动作、正常保存出现异常恢复横幅。已逐项修复并经独立行为重放和浅深六图复验全部标为 resolved。保留草稿后须用户主动替换最新内容；原生请求失败后恢复原操作的能力仍保留。首页分享固定品牌图和通用文案，避免自动截取私人到期事项。

最终独立复核再次逐项核对 manifest、四份布局及两份 tab 报告的 244 个源码哈希，全部与当前小程序一致；四张交付图片与最终截图的 SHA-256 一致。结论为「本地 UI 候选可交付」，不扩大为微信原生或生产验收。源码集合指纹为 `c80ff359668dcc64a75e2ad9ddf1b2e1e45a1419a7c5d8a26289192a9076d02b`（SHA-256 of JSON.stringify(manifest.sourceHashes)）。

设计文档仅同步已确认的入口顺序和到期状态/恢复规则；主绿与 token 未替换。预先存在的 `DESIGN.md` 页边距 24rpx 与公共样式后置 32rpx 漂移已记录，本轮未为此改全局样式。

## 云端、发布与回退边界

### 查询首页恢复补充

维护者查看候选后确认库存查询应保持首页。已同步 `app.json` 的普通启动页和原生 tab 顺序、导航工具的默认路由以及发布检查；「我的小哨」位于第二个入口。普通启动没有跳往小哨的强制导航，失效页面恢复仍进入查询，通知和分享的明确目标路径继续保留。相关导航、冷启动、分享与公告回归 69 项通过、0 失败，`git diff --check` 通过，摘要见 [query-home-restore.json](../evidence/verification/3.5.0/query-home-restore.json)。没有新增 API 或轮询，查询首页启动不读取到期列表。

以上离线 UI 段落记录的是此前候选的检查；恢复首页及随后服务状态/配置覆盖修正改变了源指纹，必须以最终重新生成的预览和检查补充为准，不能复用旧哈希声明当前界面已通过。微信原生首屏、首次切换和真机仍未复验。

### 用户纠正后的最终界面复核

本轮最终证据位于 [ui-corrections](../evidence/verification/3.5.0/ui-corrections/verification.json)。预览生成于 2026-10-30 12:52:34，244 个当前小程序源码哈希一致，集合指纹为 `c1a1ccc2adb36fdb8a6d731ada3d894c2c713c36a5b4d0d714bf649fc13114af`。实际页面方法生成查询首屏、到期服务未开放/仅保存/失败恢复，以及 query/follow 的 Mac Studio 定制范围收起/展开；展开前后精确 SKU 和门店保持一致。

- 20 个场景、96 个快照在 320/375/430px 下覆盖浅深色与 1.3 倍字/600px 短窗口，共 384 次布局检查，无溢出、裁切、文案、失败图片或新增控件几何问题。
- 原生 tab 的 HTML 近似浅深色各 213 案，共 426 案通过。颜色浅深色各 303 项、其中活动项各 298 项，未发现低于阈值或不支持测量；主按钮最低约 5.357:1。
- Impeccable 对本轮四个 URL 实际检测 exit 2，保留 13 条警告：4 条离线说明条、8 条原生 tab 的 HTML 标签近似、1 条既有库存状态分组。原始报告、逐项解释与退出码均保留，没有删规则制造全绿；临时 loopback 已停止。
- 独立审查另外复现了两项 P2：服务端账号先变化但 bootstrap 未更新时残留旧私人内容；原生复制同步异常后按钮持续锁定。已修复、补行为回归并独立重放确认 resolved。旧账号待确认记录仍按账号保留，但错误身份下不能展示或重试；复制失败允许显式重试，旧回调不能干扰新操作。

独立复核逐张查看本轮 12 张代表图，并核对 PNG 哈希、manifest、四份布局、两份导航和浅深颜色报告与当前源一致；结论为“本轮新差异可作为本地 UI 候选交付”。没有将离线候选等同于微信或生产发布通过。

代表图：[查询首页](../evidence/verification/3.5.0/ui-corrections/query-first-375-light.png)、[服务不可用](../evidence/verification/3.5.0/ui-corrections/follow-unavailable-375-light.png)、[仅保存事项](../evidence/verification/3.5.0/ui-corrections/follow-records-only-375-light.png)、[Mac Studio 定制范围](../evidence/verification/3.5.0/ui-corrections/mac-studio-follow-expanded-320-dark.png)。全部为合成数据与 Chromium 近似，不证明真实微信编译、原生控件、云端目录刷新或实际收信。

### 到期事项缺表修复

用户截图中的错误已通过当前云端日志定位：2026-10-30 12:41 的 `deadline.list` 多次返回 `-502005 database collection not exists: gxs_deadlines`；管理端只读检查也确认集合不存在。函数详情显示 API 在 12:40:02 已有更新，这不代表其他函数或本地最新源一致，不能沿用早前“没有部署”的假设判断当前环境。

12:47–12:48 已补建 `gxs_deadlines`、设置 ADMINONLY 权限和 `user_status_remind_id` / `schedule_due_id` / `schedule_lease_id` 三条非唯一复合索引。结构与权限读取均成功；12:48:15 的自然用户请求返回 `ok: true`、空事项列表、`capability.enabled: false`、`template_missing`。只保存最小诊断证据，不复制用户身份或私人事项，见 [deadline-cloud-repair.json](../evidence/verification/3.5.0/deadline-cloud-repair.json)。本次没有代建测试事项或触发业务通知。

本地界面同步区分“读取中”“暂不可用”“仅保存事项”“免费试用”：加载或失败时不开放新增入口，成功读取但未开启通知时明确仅记录日期；页面已有草稿在刷新失败时保留，重新读取成功后才允许提交。缺失集合有明确服务错误码，不作为空列表成功返回。首页恢复独立于该修复。

到期通知仍关闭。后续需确认同版 API/monitor、核对独立微信模板与字段、分别核对两个函数的消费者凭据，并在真实微信账号完成保存/修改/删除、授权、到期触发、查收与错误恢复。凭据存在及 AppID 匹配只表示 readiness 条件，不证明令牌有效或实际收信。

历史微信质检中的未用 channel-video 声明、自定义导航首切、图片体积和旧图片格式四项，仍缺当前版本的微信复验凭证。本地修复和预览不关闭这些门禁。

本轮代理未部署函数、未上传微信、未提审或正式发布；仅补齐上述到期集合、私有权限与索引，没有修改通知配置、会员账本或真实采集目标，没有执行真实付款、赠礼或消息发送。云端已有的 API 更新不等于本地后续修正已部署。取货证据包括 PROLED 两个零售配置的只读抽样，以及 Mac Studio 一次返回 HTTP 541 的定制取货请求；后者保持未验证，不能解释为缺货或永久不支持。

用量影响、无旧数据迁移、通知禁用开关与保留幂等回执的回退顺序见 [发布说明](RELEASE_3.5.0.md#可靠性与用量)。新功能不通过降低 Apple 采样频率或遗漏 unknown 节约用量，当前没有真实降费结论。

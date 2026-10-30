# V3.5.0 到期提醒：微信模板与通知接通

本页按 2026-10-30 当前源码编写。到期记录与微信通知分开：能保存日期不代表已取得微信授权，也不代表通知已发送。维护者已提供「日历事件提醒」模板详情，源码已按后台字段配置 `事项=thing3`、`事件时间=time2`、`时间=time6`、`事件类型=thing7`、`备注=thing5`，但 `enabled` 仍为 `false`。只有同版 API/monitor、消费者凭据、真实用户授权、平台受理和手机收信分别验证后，才可开启发送。

## 在微信后台选择模板

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)，选择**果小哨消费者小程序**。当前代码中的消费者 AppID 为 `wxe96ad9e77b602f1b`；共享云环境所属的资源方小程序不能替代它。
2. 进入**功能 → 订阅消息**，在公共模板库添加符合当前账号类目及真实业务的模板。添加后到**我的模板**查看详情。微信官方说明公共模板由账号所属类目决定，返回的 `type: 2` 是一次性订阅、`type: 3` 是长期订阅。[官方：获取类目下的公共模板](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_getpubnewtemplatetitles.html)
3. 本版使用**用户通过弹窗授权的一次性订阅**。可搜索「到期提醒」「到期通知」「事项提醒」「日程提醒」等关键词，再检查候选模板的适用业务及可选字段。这些是筛选关键词，**不是已确认存在于果小哨类目中的固定模板名或编号**。不要把新版 Beta 的 code 下发或长期订阅当作已接入能力。[官方：订阅消息分类](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html)
4. 优先选能如实表达“用户自己登记一件事，到指定日期前提醒”的模板。不要为了凑模板填写不存在的订单号、付款金额、预约结果，也不要复用 Apple 到货模板。若仅找到“本平台会员即将到期”等特定业务模板，不能默认用于第三方会员、优惠券和保修到期。
5. 选择关键词、保存模板后，复制**我的模板中的完整模板 ID**及**全部字段代码**。公共库的数字标题编号 `tid` 不能作为发送用 `template_id`。字段以真实详情为准，代码中的数字不要求按本页示例排列。

微信官方允许在没有合适模板时申请新模板，审核通过后使用。若需要申请，可把**建议标题**写为“事项到期提醒”，用途写为“用户主动创建并订阅的个人事项到期提醒，按用户确认的日期与提前量发送一次通知”；建议关键词为事项名称、到期日期、提醒时间、温馨提示。该建议不代表当前类目已有该模板，也不保证审核通过。[官方：订阅消息开发指南](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)

## 本版支持的字段映射

| 后台关键词的语义 | 代码映射槽 | 支持的真实字段代码 | 本版发送内容 |
| --- | --- | --- | --- |
| 事项名称、服务名称等能够真实描述登记事项的名称 | `title`，必需 | `thingN` | 用户登记名称；通知卡片最多 20 个字符，完整名称留在小程序。当前模板为 `thing3` |
| 到期日期、到期时间 | `date`，必需 | `dateN` 或 `timeN` | `dateN` 发送 `2030-01-02`；`timeN` 发送 `2030-01-02 23:59`。当前模板为 `time2` |
| 提醒时间 | `time`，可选 | `timeN` | 用户设置的计划提醒时刻，例如 `2030-01-01 09:00`，北京时间。当前模板为 `time6` |
| 事件类型 | `category`，可选 | `thingN` | 会员续费、优惠券、保修到期、活动截止或其他。当前模板为 `thing7` |
| 备注、温馨提示 | `remark`，可选 | `thingN` | 固定文字“你设置的到期提醒”。当前模板为 `thing5` |

`N` 表示后台实际编号，不是字面字符 N。微信官方规定 `thing` 最多 20 个字符，`time` 必须包含时分、可以带日期，`date` 可以只有日期；因此不能把纯 `YYYY-MM-DD` 直接当作 `timeN` 的值。该类型区别已在源码和回归测试中处理。[官方：发送订阅消息及参数限制](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage.html)

**日期范围说明：**第一版让用户选“到期日期”，没有输入精确截止时分。服务端把该日期的结束边界定为北京时间 23:59:59；映射到 `timeN` 时展示到分钟的 23:59。这是本工具的日期约定，不是从优惠券、商家或保修合同核实得到的精确截止时间。能选择纯日期关键词时优先采用 `dateN`；确切截止早于日末的事项，应先完善精确时间能力后再使用相应承诺。

模板选了哪些字段，就必须全部提供。不要多选暂时没有真实数据的字段。`time`、`category`、`remark` 没有选入模板时，配置应明确写为空字符串；存储的模板映射会原样使用，不会再混入新模板的默认字段。当前准备工具会拒绝遗漏字段、额外字段、重复字段及不支持的数据类型。

维护者可以按下面格式提供资料；**不需要发送 AppSecret、access_token 或个人 OpenID**：

```text
小程序：果小哨
模板标题：后台实际标题
模板类型：一次性订阅
模板 ID：添加到“我的模板”后取得的完整 ID
关键词及完整字段代码：
- 事项：thing3
- 事件时间：time2
- 时间：time6
- 事件类型：thing7
- 备注：thing5
后台模板说明/适用类目：照实际填写
```

当前模板「日历事件提醒」的五个关键词必须全部映射，不能只发送其中一部分，也不能多加后台没有的字段。截图未展示模板类型；源码按一次性订阅（`type: 2`）接入，若后台实际是长期订阅，必须先调整授权与发送策略，不能直接开启。

## 本地生成可审查配置

工具 [prepare-deadline.mjs](../tools/notifications/prepare-deadline.mjs) 只读取本地模板资料，校验并生成配置和合成消息预览。它不读取密钥、不请求微信、不修改 CloudBase、不发送通知；输出始终为 `enabled: false`。

将后台实际内容转录为单个 JSON 对象，或使用个人模板查询接口得到的对应模板对象。`content` 必须保留全部 `{{字段名.DATA}}`。下面是待替换的结构示例：

```json
{
  "priTmplId": "ciI4JTu358s2e_TEPLgB-9g26_CrHGcVga9fdSKG68Y",
  "title": "日历事件提醒",
  "type": 2,
  "content": "事件时间:{{time2.DATA}}\n事项:{{thing3.DATA}}\n时间:{{time6.DATA}}\n事件类型:{{thing7.DATA}}\n备注:{{thing5.DATA}}"
}
```

按真实编号运行：

```powershell
node tools/notifications/prepare-deadline.mjs --template-file "C:\path\deadline-template.json" --title thing3 --date time2 --time time6 --category thing7 --remark thing5 --state trial --out "evidence/verification/3.5.0/deadline-template-prepared.json"
```

输出包含 `proposedEvent`（供审查的 `admin.updateConfig` 请求）、合成消息 `preview` 和仍需验证的项目。模板资料中的标题、类目和归属仍需对照微信后台；本地校验不冒充微信审核或账号归属验证。输出文件若已存在，工具拒绝覆盖，便于保留前次审查证据。

当前源码已经把模板 ID、五个字段映射和 `miniprogramState: formal` 写入默认配置，但 `enabled` 仍为 `false`。存量云端配置如果显式保存了空模板 ID，合并时仍以云端值为准；不能把“源码已有映射”当作“线上已经开启”。部署同版 API/monitor 后，需要由有权限的运维人员审查并写入配置，再做真实授权与收信验收。

`deadlineReminders.miniprogramState` 独立控制到期通知的落地版本：`trial` 为体验版、`developer` 为开发版、`formal` 为正式版。库存通知继续使用 `notifications.miniprogramState`。体验验证时只调整日期通知，避免把已有库存通知也切到未发布页面。

## 配置、验证与开启顺序

1. 核对真实模板归属于消费者小程序，类型为一次性，关键词语义符合实际用途；保存仍关闭发送的审查配置。
2. 确认 `gxs_deadlines` 集合、仅服务端可访问权限及三个复合索引。数据库计划见 [database-deployment-plan.json](../config/database-deployment-plan.json)，当前实际部署证据分别记录在版本发布说明中。
3. 在最终源码执行 `node tools/build-monitor.mjs`，将同版 `gxs_api` 和 `gxs_monitor` 作为待部署产物核对；API 提供保存/授权，monitor 执行日期调度。只更新一个函数不能作为完整接通证据。
4. 核对两个函数中消费者 `GXS_CONSUMER_APPID` / `GXS_CONSUMER_APPSECRET` 配置，AppID 与消费者一致；不把资源方凭据当作消费者凭据。当前 API readiness 只验证存在及匹配，不证明 token 已有效、消息已发出。
5. 核对 `gxs-monitor-minute` 的真实分钟触发器和最新定时日志。日期调度独立于 Apple 的采集 lease 和会员资格，但仍需要这个可信定时入口实际运行。只在本地执行 worker 测试不能替代云端触发器验证。
6. 在单独的日期模板和正确落地版本准备好后开启 `deadlineReminders.enabled`，用维护者自己的微信账号创建一条未来几分钟的测试事项，手动点击页面授权按钮。每一次性授权只用于一次提醒，授权必须由用户操作触发。[官方：requestSubscribeMessage](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)
7. 分别记录：保存成功、原生弹窗 `accept`、服务端授权同步成功、定时任务处理、微信 `errcode: 0`、手机收到消息及点击后打开正确版本和页面。`accepted` 只代表微信受理，实际收信另记；不要把“有资格授权”或“数据库有记录”当作送达。

首版每分钟最多处理 5 条到期发送和 5 条过期发送 claim，按到期索引取小页，不扫描所有用户、不减少 Apple 采样。积压会使计划时间与实际发送时间不同；用户关闭通知或处于免打扰时会延后检查，超过到期日不发送。界面应表达计划时间，不能承诺精确秒级送达。

出现 `40037` 检查真实模板 ID；`47003` 检查全部字段及类型；`43101` 检查这条提醒的授权和是否已经消费。网络结果不确定或 worker 中断不会盲目补发；要重新试验请创建/改为新的未来时间并重新授权。完整错误含义以当前官方发送接口文档为准。

关闭 `deadlineReminders.enabled` 即停止新的日期发送；保存记录和幂等凭证保留。先观察在途任务结算，再回退函数或客户端，不重置 `uncertain` 记录制造重复通知。

## 本次核查边界

2026-10-30 已通过直接 HTTPS 成功读取微信官方 Markdown 页面，核对发送字段类型、一次性授权、类目模板以及关键词查询说明；旧 `/OpenApiDoc/` 发送文档路径返回 404，当前官方入口为 `/miniprogram/dev/server/API/…`。浏览搜索工具对部分官方页无法打开，未用第三方转载替代验证。

模板 ID、标题与五个关键词已按 2026-10-30 后台截图核对；模板类型仍需确认。离线准备工具已生成 [字段映射与合成预览](../evidence/verification/3.5.0/deadline-template-plan.json)，其中 `deliveryEnabled: false`。当前源码已保存映射但发送保持关闭，云函数未部署、云端配置未写入、用户未授权、真实收信未验证。本页及本地测试不表示线上通知已经开启。

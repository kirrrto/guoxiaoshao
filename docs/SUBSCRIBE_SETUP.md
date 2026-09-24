# 果小哨：接通微信补货提醒

更新：2026-09-23。适用于消费者小程序 `wxe96ad9e77b602f1b`。

## 2026-09-23 起改用「商品到货提醒」模板

管理员已在后台添加一次性订阅模板「商品到货提醒」：

```text
模板 ID：qcfmYZuvfallzFUAVrEaRlmop3kvhoM4Bl4ewpAqjag
模板编号：61831（公共模板库编号，不能当模板 ID 用）
类目：信息查询
商品名称：thing1
时间：time2
到货数量：number5（数字类型）
门店名称：thing7
```

2026-09-23 核对详情后确认：「到货数量」是数字类型 `number5`，无法如实填写（见下文），所以**这个模板不使用**。管理员已在公共模板库再次选用 61831，只勾选三个关键词，这是实际使用的模板：

```text
模板 ID：qcfmYZuvfallzFUAVrEaRsWw4vtnwpucYMaao65OzCw
关键词：商品名称 thing1、时间 time2、门店名称 thing7（同一公共模板的关键词编号固定）
场景说明：关注的配置在门店可取货时提醒
```

四个关键词对应配置里的四个槽位：商品名称 → `product`，门店名称 → `store`，时间 → `time`，到货数量 → `quantity`。这个模板没有状态类关键词，`status` 要设为 `null`，否则会继续带上旧模板的字段。

**到货数量如实填写**：苹果取货接口只说明门店今天能否取货，从不公布件数。字段为文字类型（`thing`）时填「有现货，具体数量以门店为准」，短语类型（`phrase`）时填「有现货」。数字类（`number`、`character_string`、`amount` 等）无法如实填写，配置会被拒绝；遇到这种情况请另外添加一个不含到货数量的到货类模板。

切换用的 patch：

```json
{
  "notifications": {
    "templateIds": {"restock": "qcfmYZuvfallzFUAVrEaRsWw4vtnwpucYMaao65OzCw"},
    "templateTitle": "商品到货提醒",
    "contentMode": "stock_status",
    "templateFields": {"product": "thing1", "time": "time2", "store": "thing7", "status": null, "quantity": null}
  }
}
```

如果以后选用的到货模板带有文字类型的「到货数量」（`thing`/`phrase`），可以把 `quantity` 填上它的编号，消息会显示「有现货，具体数量以门店为准」。

切换后的影响：

- 授权次数按模板分别记账。旧模板「订单状态提醒」累计的次数不能用于新模板，所有用户的剩余次数从 0 开始，需要在小哨页重新点「允许」；页面会自动提示。
- 仍在排队、使用旧模板的提醒任务会被跳过（`template_changed`），不会用旧模板再发出。
- 用户授权弹窗和消息卡片的标题变为「商品到货提醒」。

## 此前使用的模板（2026-09-20 至 2026-09-23）

管理员已提供后台截图，并于 2026-09-20 以文字确认完整 ID：

```text
模板 ID：6vsQ7AjaRjwfyNWIJIETQQIKKnjzkgVZhClfrHB47q0
模板库编号：524（不能作为模板 ID 使用）
微信卡片固定标题：订单状态提醒
商品名称：thing17
预约项目：thing33
更新时间：time20
商家名称：thing14
```

本次使用 `notifications.contentMode=watch_item`：商品名称填写完整短配置（例如 `18 ProMax 512G 冰川蓝色`），商家名称填写实际门店，更新时间填写真实检测的北京时间，预约项目填写真实的关注事项 `商品到货关注`。不把库存状态塞入预约字段，也不编造订单、预约成功或交易状态。过长且无法完整保留的商品配置用精确 SKU 代替，点击卡片进入关注页查看完整信息。

微信授权弹窗及消息卡片的标题仍是“订单状态提醒”，代码不能改成“补货提醒”。字段格式适配不代表微信已确认此模板适用于本业务；其业务场景是否被允许以及手机实际收信仍需验证。后续取得更匹配的到货模板时，可替换 ID 和映射，旧模板的授权不转移至新模板。

## 先弄清三个状态

- **关注已开启**：这条商品和门店配置参与监测；“暂停关注”只停用这一条配置。
- **后台库存监测**：云端任务定时查询库存，关闭手机小程序后仍能工作。页面约每分钟刷新一次，只是读取结果，不会代替云端采集。
- **微信订阅提醒**：还需要正确的订阅模板、消费者账号发送凭据、服务开关，以及该用户的有效订阅授权。

会员有效不代表微信已经授权消息。若订阅模板未配置，库存监测仍可以独立工作，但不会向微信发送提醒。不要用测试模板 ID、假库存事件或界面“已开启”字样代替真实发送验收。

## 第一步：在微信后台选用模板

1. 用浏览器打开 [微信公众平台](https://mp.weixin.qq.com/)，由管理员登录**果小哨**小程序账号。
2. 打开“功能 → 订阅消息”。按后台实际显示，进入公共模板库/选用模板。
3. 在账号当前服务类目允许的模板中，搜索“补货”“到货”“商品”等，选择与本产品提醒用途匹配的模板。是否能选用以及模板具体名称，以该账号后台为准。
4. 消息内容需要对应：商品名称、门店名称、发现时间，另可有一个状态或到货数量字段。记录每个字段的实际编号，例如商品是 `thing1`、门店是 `thing2`、时间是 `time3`；编号仅为举例，不能照抄。到货数量只能选文字类型，原因见上文。
5. 选用后，在“我的模板”复制**完整模板 ID**，并记录模板标题和各字段编号。可以把这些非密钥信息交给维护者配置。

如果账号看不到匹配模板，先核对账号服务类目及能力状态；不要为凑模板而选用与业务不符的通知。若实际模板字段结构与本项目支持的字段不同，需要先调整字段映射与格式校验。

## 第二步：配置消费者账号凭据

在云开发环境 `flowermean-6gjaxfqhf6c13e88` 中打开云函数 `gxs_monitor` 的环境变量配置：

- `GXS_CONSUMER_APPID`：填 `wxe96ad9e77b602f1b`。
- `GXS_CONSUMER_APPSECRET`：由账号管理员直接填入果小哨对应的 AppSecret。不要发到聊天里，不要写入前端源码、文档或 Git。

共享环境归属账号 `wxc6dfebb77650f3a9` 的 AppSecret 不能代替果小哨的 AppSecret。监测函数使用消费者账号凭据获取微信接口令牌，再给消费者账号下的 OpenID 发送消息。

管理员若需要查看或管理 AppSecret，请在微信公众平台后台自行完成相应验证；不要为了本次配置盲目重置已被其他服务使用的密钥。环境变量保存后需要让函数新实例使用新配置。

## 第三步：配置模板和发送开关

配置写入数据库 `gxs_config` 集合中 `_id=runtime` 的文档。**使用点号路径逐字段更新**，保留管理员、会员兑换和采集配置：

```text
notifications.templateIds.restock = 实际模板 ID
notifications.templateFields.product = 商品字段编号
notifications.templateFields.store = 门店字段编号
notifications.templateFields.time = 时间字段编号
notifications.templateFields.status = 状态字段编号
notifications.contentMode = stock_status
notifications.templateTitle = 后台的实际模板标题
notifications.consumerAppId = wxe96ad9e77b602f1b
notifications.page = pages/follow/index
notifications.miniprogramState = formal
notifications.enabled = true
```

开发版测试使用 `developer`，体验版测试使用 `trial`，正式发布使用 `formal`。该配置影响消息卡片点击后进入哪个版本，应与测试账号当前使用版本一致。

`page` 只填页面路径即可。1.1.7 起发送时自动追加 `?eid=<事件ID>`（已有参数时用 `&`），点开消息后小哨页顶部显示这条提醒的发现时间、当前库存和「买到了吗」。

模板未完成时保持 `notifications.enabled=false`。不要把整个 runtime 文档替换为上面的片段，也不要把发送凭据写进数据库。

此前的「订单状态提醒」模板使用的配置为（已被上文的「商品到货提醒」取代）：

```json
{
  "notifications": {
    "enabled": true,
    "templateIds": {"restock": "6vsQ7AjaRjwfyNWIJIETQQIKKnjzkgVZhClfrHB47q0"},
    "templateTitle": "订单状态提醒",
    "contentMode": "watch_item",
    "templateFields": {"product": "thing17", "store": "thing14", "time": "time20", "status": "thing33"},
    "consumerAppId": "wxe96ad9e77b602f1b",
    "page": "pages/follow/index",
    "miniprogramState": "formal"
  }
}
```

这是 `admin.updateConfig` 的 **patch** 内容，不是完整 runtime 文档。`status` 是兼容现有配置的槽位名称；在 `watch_item` 模式下它承载关注事项，不表示模板中存在库存状态字段。

字段规则（`lib/config.js`）：`product`、`store` 必须是 `thing`，`time` 是 `time` 或 `date`；`status`（`thing`/`phrase`）和 `quantity`（`thing`/`phrase`）可选，设为 `null` 即不发送；各字段编号不能重复，不接受其他槽位名。

开启发送开关后，后台会先进行有超时限制的微信令牌鉴权检查，该检查不会发送通知或扣授权次数。缺少凭据、凭据不正确、网络失败、令牌失效均显示未就绪；凭据非空不再等于鉴权通过。鉴权通过仍不能证明模板内容已被微信受理或手机已经收到消息。

## 第四步：用户主动授权

1. 使用有效会员账号，或从未收到过提醒的新账号（可免费关注 1 个配置、收 1 条提醒），进入“关注”，添加准确的型号、容量、颜色和门店，并保持关注开启。
2. 打开“我的”中的提醒开关，检查免打扰时段。
3. 回到“关注”，点击“授权提醒”，在微信原生弹窗中允许接收该模板消息。
4. 检查页面是否显示已授权/可用提醒次数，以及监测服务、微信发送服务是否就绪。

模板已配置即可主动申请授权，暂时缺少发送凭据不阻拦授权；页面会分别显示授权记录与发送服务状态。微信拒绝（43101）后，系统作废本次发送开始前的失效本地额度并引导重新授权，同时保留发送期间新增的授权。其他明确发送失败返还本次预扣次数，结果不确定时不会自动重发。

当前采用一次性订阅：每次用户点「允许」记 1 次提醒，次数可以累加，每次补货提醒消耗 1 次。到货提醒为会员功能；从未收到过提醒的新用户另有 1 条免费提醒，只需授权 1 次。免费提醒用完的非会员不能记录次数（`membership_required`）。小哨页显示剩余次数和「增加提醒次数」按钮，剩 2 次及以下时提示补充。会员在弹窗里勾选「总是保持以上选择」后，点「查询」「重新查询」「刷新」「保存关注」「签到」时会顺带申请一次，微信不弹窗并再给 1 次（`utils/reminder-credits.js`）。勾选保持选择不代表无限发送，每次仍需一次用户点击。长期订阅只开放给特定公共服务类目，本项目不把一次性模板伪装成长效无限提醒。

## 第五步：验证真的检测、真的发送

应分别核对以下事实：

1. **自动采集**：`gxs_config/collector_status` 的心跳持续更新；对应商品/门店的观测时间在关闭小程序后仍前进，来源为自动采集。
2. **发现事件**：真实库存由不可取货变为可取货时，生成确认补货事件；初次发现有货及观测中断后恢复有不同事件名称。
3. **消息任务**：记录是否已被微信平台受理。`accepted` 只代表平台返回成功，不证明用户手机已经看到了消息。
4. **手机收信**：在微信服务通知中实际收到消息，商品、门店和时间对应真实观测；点击进入果小哨关注页。
5. **重复防护**：同一补货事件不会因为刷新页面、任务重试或重启函数而重复发送；库存抖动还受同商品同门店冷却时间约束。

没有发生真实补货时，不应为演示给真实用户制造“已补货”通知。离线测试可以验证状态机与异常处理，不能替代真机收信验证。

## 无法收到提醒时看哪里

- **模板未配置**：先完成第一、三步。
- **发送凭据未配置/账号不匹配**：检查第二步的消费者 AppID 和密钥；不要使用资源方账号的密钥。
- **后台监测未运行/心跳过期**：检查 `gxs_monitor` 云函数、定时触发器和最新运行日志。
- **库存检查受限/失败**：查看上游错误与下一次重试时间；旧库存不能当作当前库存。
- **没有有效授权次数**：用户再次点击授权；本地授权记录并不能保证微信一定接受发送。
- **免打扰/用户关闭提醒/会员到期/关注暂停**：按实际原因调整相应设置。
- **免费体验提醒已用完（`free_reminder_used`）/ 免费提醒已用于另一条补货（`free_reminder_in_use`）**：新用户的 1 条免费提醒已经发出或正在发送，开通会员后继续提醒。
- **微信拒绝**：按记录的错误码修正，例如模板 ID 无效、未订阅或字段不匹配；结果不确定的消息不会盲目重发。

## 官方资料

- [订阅消息概述](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html)
- [用户点击订阅接口 wx.requestSubscribeMessage](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)
- [发送订阅消息及字段限制](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage.html)

订阅消息概述、发送接口及字段限制于 2026-09-20 重新读取。后台入口和账号可用模板需以实际后台为准。

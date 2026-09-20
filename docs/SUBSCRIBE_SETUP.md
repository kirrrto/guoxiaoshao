# 果小哨：接通微信补货提醒

更新：2026-09-20。适用于消费者小程序 `wxe96ad9e77b602f1b`。

## 本次接入的实际模板

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
- **后台库存监测**：云端任务定时查询库存，关闭手机小程序后仍能工作。页面每 15 秒刷新只是读取结果，不会代替云端采集。
- **微信订阅提醒**：还需要正确的订阅模板、消费者账号发送凭据、服务开关，以及该用户的有效订阅授权。

会员有效不代表微信已经授权消息。若订阅模板未配置，库存监测仍可以独立工作，但不会向微信发送提醒。不要用测试模板 ID、假库存事件或界面“已开启”字样代替真实发送验收。

## 第一步：在微信后台选用模板

1. 用浏览器打开 [微信公众平台](https://mp.weixin.qq.com/)，由管理员登录**果小哨**小程序账号。
2. 打开“功能 → 订阅消息”。按后台实际显示，进入公共模板库/选用模板。
3. 在账号当前服务类目允许的模板中，搜索“补货”“到货”“商品”等，选择与本产品提醒用途匹配的模板。是否能选用以及模板具体名称，以该账号后台为准。
4. 当前消息内容需要对应：商品名称、门店名称、发现时间、库存状态。记录每个字段的实际编号，例如商品是 `thing1`、门店是 `thing2`、时间是 `time3`、状态是 `thing4`；编号仅为举例，不能照抄。
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

模板未完成时保持 `notifications.enabled=false`。不要把整个 runtime 文档替换为上面的片段，也不要把发送凭据写进数据库。

本次模板使用的配置为：

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

开启发送开关后，后台会先进行有超时限制的微信令牌鉴权检查，该检查不会发送通知或扣授权次数。缺少凭据、凭据不正确、网络失败、令牌失效均显示未就绪；凭据非空不再等于鉴权通过。鉴权通过仍不能证明模板内容已被微信受理或手机已经收到消息。

## 第四步：用户主动授权

1. 使用有效会员账号进入“关注”，添加准确的型号、容量、颜色和门店，并保持关注开启。
2. 打开“我的”中的提醒开关，检查免打扰时段。
3. 回到“关注”，点击“授权提醒”，在微信原生弹窗中允许接收该模板消息。
4. 检查页面是否显示已授权/可用提醒次数，以及监测服务、微信发送服务是否就绪。

模板已配置即可主动申请授权，暂时缺少发送凭据不阻拦授权；页面会分别显示授权记录与发送服务状态。微信拒绝（43101）后，系统作废本次发送开始前的失效本地额度并引导重新授权，同时保留发送期间新增的授权。其他明确发送失败返还本次预扣次数，结果不确定时不会自动重发。

当前采用用户点击弹窗的一次性订阅方式。用户勾选保持选择不代表无限发送；后续仍需通过有效的用户操作获得订阅次数。微信官方还有其他订阅类型，是否适用取决于账号类目和模板，本项目不把一次性模板伪装成长效无限提醒。

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
- **微信拒绝**：按记录的错误码修正，例如模板 ID 无效、未订阅或字段不匹配；结果不确定的消息不会盲目重发。

## 官方资料

- [订阅消息概述](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html)
- [用户点击订阅接口 wx.requestSubscribeMessage](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)
- [发送订阅消息及字段限制](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage.html)

订阅消息概述、发送接口及字段限制于 2026-09-20 重新读取。后台入口和账号可用模板需以实际后台为准。

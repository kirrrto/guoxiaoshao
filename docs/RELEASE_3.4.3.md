# 果小哨 v3.4.3 发布说明

2026-10-28 发布候选。本版同步苹果中国官网最新上架的新款 14 英寸 MacBook Pro（M6）与新款 iMac（M6），补齐全部 6 大 Mac 系列共 88 个官方标准零售配置的内存、硬盘容量与具体配置说明，下线已停用的老款取货接口（11 个配置），庆祝苹果 Mac 新品发布向全体会员及曾付费用户赠送 1 天会员时长并同步双端公告，同时按“避免不必要的次要标签和描述，让布局本身来传达信息”原则精炼各页界面。

## 用户更新小结

同步新款 MacBook Pro（M6）与 iMac（M6），全系 Mac 支持直接选择内存与硬盘容量并展示完整芯片/内存/闪存配置，老款关注自动提示改选。庆祝新品发布，10 月 28 日向会员及曾付费用户赠送 1 天会员时长。移除各页冗余副标题，让页面布局直接传达信息。

## 变更范围与证据

### 1. 新款 MacBook Pro（M6）与 iMac（M6）及全系 Mac 内存/容量目录、取货核验与缩略图

- **上游采样与全系 Mac 标准配置目录生成**：抓取苹果中国官网 6 大 Mac 购买页及全部 88 个标准零售配置的官方详情页（`evidence/raw/2026-10-28/*.html`），同步新款 M6 14 英寸 `macbook-pro`（7 个 M6 标准配置 + 17 个 M5 Pro／M5 Max 配置，共 24 个 SKU）、新款 M6 `imac`（17 个标准配置）、`macbook-air`（30 个标准配置）、`mac-mini`（6 个标准配置）、`mac-studio`（3 个标准配置）与 `macbook-neo`（8 个标准配置），目录总 SKU 数更新为 340。为全系 Mac 补齐 `attributes.memory`（8GB～96GB）、`attributes.capacity`（256GB～2TB）及完整具体配置标题，并在选配器（`miniprogram/components/target-picker`）中支持按内存、硬盘容量与具体配置（芯片/核心数/内存+容量/屏幕玻璃）精准筛选。设置新款 `releaseDate: "2026-10-27"`，Mac 分类排序更新为 `['macbook-pro', 'imac', 'mac-mini', 'mac-studio', 'macbook-neo', 'macbook-air']`。
- **取货接口实测**：对新款 M6 Mac SKU 在广州天环广场（`R577`）完成官方取货接口采样并落盘 `evidence/pickup-samples/2026-10-28/*.json`，确认 `pickupDisplay` 与商品标题返回正常。
- **商品图片与本地卡片缩略图**：下载并校验新款 `mac-macbook-pro-summary-select-202610-*` 与 `imac-summary-select-202610-*` 官方图片（`evidence/catalog/2026-10-28/images.verification.json`），生成 `< 12 KB` 的本地卡片缩略图并同步至 `miniprogram/images/products/*-card.jpg`、`miniprogram/config/product-thumbnails.js` 与 `miniprogram/config/catalog-seed.js`。

### 2. 老款 Mac 下线保护、新品发布付费用户 +1 天会员赠礼与公告

- **老款 SKU 停用保护**：在 `cloudfunctions/gxs_api/lib/rules/follow-access.js` 登记 3 个已下线 M5 14 英寸 MacBook Pro（`MDE14CH/A`、`MEQJ4CH/A`、`MDE54CH/A`）与 8 个已下线 M4 iMac（`MWUG3CH/A`、`MWUC3CH/A`、`MWV43CH/A`、`MWUE3CH/A`、`MWUF3CH/A`、`MWUY3CH/A`、`MWV13CH/A`、`MWUU3CH/A`）。后台采集自动跳过已停用老款；查询与新增/恢复关注老款返回 `product_retired` 明确提示；存量老款关注展示为暂停状态并引导改选新款。
- **庆祝新品发布 · 付费用户 +1 天会员赠礼**：在北京时间 `2026-10-28` 当日，在 `ensureUser` 与后台 `loadFollowPolicy` 链路通过事务 `ensureLaunchCelebrationGift` 为全体当前有效会员及曾付费会员自动发放 1 天（`86,400,000 ms`）会员时长，保留原套餐等级（`member_7d`、`member_30d`、`member_365d`）并顺延增强配置额度到期时间，写入幂等标识 `launch20261028GiftedAt` 与账单 `grant_launch_20261028`（在「我的 → 会员记录」展示为 `1 天会员 · 新品礼遇`）；免费用户及仅领取过体验补偿的用户不重复触发付费赠礼。
- **庆祝新品与目录更新双公告**：在服务端 `user.bootstrap` 与前端 `miniprogram/utils/query-notice.js` 同步内置公告 `mac-launch-celebration-2026-10-28`（查询页顶部横幅与公告中心首卡）与 `mac-catalog-2026-10-28`（公告中心列表项），有效期 `2026-10-28` 至 `2026-11-06`。

### 3. 界面设计原则落地：移除冗余次要标签与副标题

- **项目约定**：在 `AGENTS.md` 写入 `Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.`。
- **全页精炼**：移除查询页、小哨页、历史页、我的页、使用说明、公告中心与选配抽屉中重复解释标题或按钮的次要副标题、提示横幅与冗余说明，同时完整保留价格、退款/续费规则、微信授权规则与官方渠道免责声明等必要事实。

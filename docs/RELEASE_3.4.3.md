# 果小哨 v3.4.3 发布说明

2026-10-28 正式版定稿，维护者选定本源码作为 v3.4.3 发布；当前待部署与微信正式上线。保留原有新款 MacBook Pro（M6）/iMac（M6）、6 大 Mac 系列 88 个标准配置、全部 340 个 SKU 和 11 个老款停用保护。在 `8ecd441` 基线上独立复核优化方案，补齐精确选配、退役操作、公告优先级、局部读取、库存兼容迁移和历史实付赠礼任务。库存默认仍为 legacy；本轮没有生产迁移、真实赠礼、上游采集、部署、上传或正式发布。原目录采样证据为此前记录，不是本轮重新采集。上线前必须完成的索引、兼容部署、真机复验与礼遇路径边界见[发布交接](RELEASE_3.4.3_HANDOFF.md)。

## 用户更新小结

同步新款 Mac，精确配置选择更稳，老款关注可直接改选。提醒记录按需加载，浅深色显示更清晰。10 月 28 日会员礼遇面向符合条件的曾付费用户，到账以会员记录为准。

## 变更范围与证据

### 1. 新款 MacBook Pro（M6）与 iMac（M6）及全系 Mac 内存/容量目录、取货核验与缩略图

- **上游采样与全系 Mac 标准配置目录生成**：抓取苹果中国官网 6 大 Mac 购买页及全部 88 个标准零售配置的官方详情页（`evidence/raw/2026-10-28/*.html`），同步新款 M6 14 英寸 `macbook-pro`（7 个 M6 标准配置 + 17 个 M5 Pro／M5 Max 配置，共 24 个 SKU）、新款 M6 `imac`（17 个标准配置）、`macbook-air`（30 个标准配置）、`mac-mini`（6 个标准配置）、`mac-studio`（3 个标准配置）与 `macbook-neo`（8 个标准配置），目录总 SKU 数更新为 340。为全系 Mac 补齐 `attributes.memory`（8GB～96GB）、`attributes.capacity`（256GB～2TB）及完整具体配置标题，并在选配器（`miniprogram/components/target-picker`）中支持按内存、硬盘容量与具体配置（芯片/核心数/内存+容量/屏幕玻璃）精准筛选。设置新款 `releaseDate: "2026-10-27"`，Mac 分类排序更新为 `['macbook-pro', 'imac', 'mac-mini', 'mac-studio', 'macbook-neo', 'macbook-air']`。
- **取货接口实测**：对新款 M6 Mac SKU 在广州天环广场（`R577`）完成官方取货接口采样并落盘 `evidence/pickup-samples/2026-10-28/*.json`，确认 `pickupDisplay` 与商品标题返回正常。
- **商品图片与本地卡片缩略图**：下载并校验新款 `mac-macbook-pro-summary-select-202610-*` 与 `imac-summary-select-202610-*` 官方图片（`evidence/catalog/2026-10-28/images.verification.json`），生成 `< 12 KB` 的本地卡片缩略图并同步至 `miniprogram/images/products/*-card.jpg`、`miniprogram/config/product-thumbnails.js` 与 `miniprogram/config/catalog-seed.js`。

### 2. 老款 Mac 下线保护、新品发布付费用户 +1 天会员赠礼与公告

- **老款 SKU 停用保护**：在 `cloudfunctions/gxs_api/lib/rules/follow-access.js` 登记 3 个已下线 M5 14 英寸 MacBook Pro（`MDE14CH/A`、`MEQJ4CH/A`、`MDE54CH/A`）与 8 个已下线 M4 iMac（`MWUG3CH/A`、`MWUC3CH/A`、`MWV43CH/A`、`MWUE3CH/A`、`MWUF3CH/A`、`MWUY3CH/A`、`MWV13CH/A`、`MWUU3CH/A`）。后台采集自动跳过已停用老款；查询与新增/恢复关注老款返回 `product_retired` 明确提示；存量老款关注展示为暂停状态并引导改选新款。
- **新品付费用户 +1 天礼遇**：按真实会员订单、服务端支付回执与金额/归属校验资格，后来全额或部分退款仍符合；纯赠送/体验/兑换排除，缺证据单列待核对。访问入口与后台任务共用原子方法，复用 `launch20261028GiftedAt` 和 `grant_launch_20261028`，已发或矛盾记录不得再次顺延。后台冻结名单、默认 dry-run、续跑和对账不依赖当天访问或有效关注；已到期账号按实际执行时间获得一天，保留混合套餐边界。截止10月28日结束仍是建议，生产名单边界需审阅。已到账以履约凭证为准，本轮未执行真实发放。
- **庆祝新品与目录更新双公告**：在服务端 `user.bootstrap` 与前端 `miniprogram/utils/query-notice.js` 同步内置公告 `mac-launch-celebration-2026-10-28`（查询页顶部横幅与公告中心首卡）与 `mac-catalog-2026-10-28`（公告中心列表项），有效期 `2026-10-28` 至 `2026-11-06`。

### 3. 界面设计原则落地：移除冗余次要标签与副标题

- **项目约定**：在 `AGENTS.md` 写入 `Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.`。
- **全页精炼**：移除查询页、小哨页、历史页、我的页、使用说明、公告中心与选配抽屉中重复解释标题或按钮的次要副标题、提示横幅与冗余说明，同时完整保留价格、退款/续费规则、微信授权规则与官方渠道免责声明等必要事实。

## 本轮优化与验证入口

- 后续实际使用 Impeccable 和 shadcn/create，修复异步保存草稿、窄屏触控/字号和可访问语义，补齐输入提示颜色检测；最终 preset、设计规范与最新验证见[实际设计审查与本地验收](DESIGN_REVIEW_3.4.3_20261028.md)。第一轮记录中的旧前端指纹不再代表当前候选。

- 精确 SKU 同值保持、合法偏好选择与回退提示；退役配置移除无效恢复，改选保留门店与编辑对象；名额文案按配置计数。
- 活动公告让位于授权恢复和故障；局部商品批读、通知 limit+1、折叠提醒首屏刷新保持游标与账号隔离。
- 新库存结构逐样本保存单个内嵌日摘要，跨日归档；目标级权威模式、单调修订号、默认关闭、迁移/回滚与中断重跑。离线稳态7→5为局部动作计数，不是账单降幅。
- 图片尺寸与预算集中管理；现有产物可校验，但缺少102份原图，完整重建和高像素设备清晰度待验。
- 主题变量、Mac标签与44px触控修正；新日期/退款/退役预览和颜色失败门禁；长期规范见根目录 PRODUCT、DESIGN。

最终测试、离线布局、方案调整、源码指纹与外部待验统一记录在 [优化执行记录](OPTIMIZATION_3.4.3_PROGRESS.md)，库存和赠礼的具体工具与回退见其中工作包链接。不得以本地通过关闭当前四项微信质检open或宣称生产已完成。

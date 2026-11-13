# 果小哨 v3.4.2 发布说明

2026-10-27 发布版本（维护者于 2026-10-27 确认已发布）。本版将 iPad mini 目录更新为苹果中国官网最新上架的新款 iPad mini（A20 Pro，20 个配置，午夜色／星光色，起售价 ¥5,499），下线已停用的第 7 代老款取货接口（24 个配置），防止旧目录缓存回退，同步首页与公告中心说明，并对各页面文案、视觉层级与选配交互进行精炼优化。

## 用户更新小结

目录更新为新款 iPad mini（A20 Pro），下线已停用的老款接口并同步公告。已关注老款配置自动提示改选新款，避免无效监测。精炼各页说明文案与卡片层级，阅读和选配更高效。

## 变更范围与证据

### 1. 新款 iPad mini（A20 Pro）目录、取货核验与缩略图

- **上游采样与目录生成**：抓取苹果中国官网 `https://www.apple.com.cn/shop/buy-ipad/ipad-mini`，更新 20 个新款 `ipad-mini` SKU（`MJ6F4CH/A` 至 `MJ7C4CH/A`，涵盖 128GB／256GB／512GB、午夜色／星光色、无线局域网／无线局域网 + 蜂窝网络、标准玻璃／纳米纹理玻璃，起售价 ¥5,499，售价区间 ¥5,499–¥10,099），标准玻璃排在同规格纳米纹理玻璃之前。设置 `releaseDate: "2026-10-26"`，iPad 分类排序更新为 `['ipad-mini', 'ipad-air', 'ipad-pro', 'ipad']`。目录总 SKU 数由 297 更新为 293。
- **防旧目录缓存回退**：前端 `miniprogram/utils/store.js` 与云端 `catalog.get` 增加目录版本时间戳校验，本地缓存（`gxs_catalog_v1`）或云端未同步旧目录不会覆盖小程序包内更新的新款目录种子。
- **取货接口实测**：对全部 20 个新款 SKU 在广州天环广场（`R577`）完成官方取货接口采样并落盘 `evidence/pickup-samples/2026-10-27/ipad-mini*.{json,body.json}`，确认 `pickupDisplay` 与商品标题返回正常。
- **商品图片与本地卡片缩略图**：下载并校验 4 张新款 `ipad-mini-finish-select-*-202610` 官方图片（`evidence/catalog/2026-10-27/images.verification.json`），生成 `< 12 KB` 的本地卡片缩略图并同步至 `miniprogram/images/products/*-card.png`、`miniprogram/config/product-thumbnails.js` 与 `miniprogram/config/catalog-seed.js`。

### 2. 老款下线保护与目录更新公告

- **老款 SKU 停用保护**：在 `cloudfunctions/gxs_api/lib/rules/follow-access.js` 登记 24 个已下线第 7 代 iPad mini 型号（`MXN63CH/A` 至 `MXPT3CH/A`）。后台采集（`collector.js`）自动跳过已停用老款，避免无效请求；查询与新增/恢复关注老款返回 `product_retired` 明确提示；已保存老款关注在列表与小哨页展示为暂停状态（「老款已下架，请改选新款」），引导用户点击「调整」改选新款配置。
- **目录入库清理**：`admin.seedCatalog` 支持 `prune: true` 清理数据库内已不在当前目录包的旧商品文档。
- **目录更新公告**：在服务端 `user.bootstrap` 与前端 `miniprogram/utils/query-notice.js` 同步内置公告 `ipad-mini-catalog-2026-10-27`（有效期 `2026-10-27` 至 `2026-11-06`），在查询页横幅与「公告与服务」页展示说明。

### 3. 界面排版、交互与文案精炼

- **精炼冗余文案，保留关键判断事实**：压缩查询页、小哨页、历史页、我的页、使用说明与公告中心的重复引导语和冗长前缀，保留计次规则、新品限制、时间新鲜度、授权消耗与会员权益等影响判断的核心事实。
- **视觉层级与触控反馈**：优化查询页快捷入口、结果指标卡、小哨服务状态栏、历史概览芯片、公告中心状态网格及选配容量芯片按压态反馈，提升首屏信息密度与扫读效率。

## 本地验证结果

- `node tools/build-monitor.mjs --check`：监测云函数同步副本一致性检查通过。
- `node tools/catalog/check-launch-readiness.mjs`：293 个商品、48 家门店、新款 iPad mini 取货样本与图片校验通过（见 `evidence/verification/3.4.2/launch-readiness.json`）。
- `npm test`：全量单元测试（含新增 `tests/ipad-mini-catalog-v342.test.mjs`）通过。
- `npm run check`：源码静态检查与包体积/依赖约束通过。
- `node tools/ui-preview/build.mjs`：四页七场景三宽度共 84 张预览快照构建通过，`expressionErrors: 0`。
- 本地 release check 的源码检查通过，仅“历史微信质检须有当前版本通过证据”一项按既有规则保持未关闭（`publicationReady=false`），待上传对应版本并通过微信云端质检后更新。

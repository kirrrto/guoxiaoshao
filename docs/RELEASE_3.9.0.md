# 果小哨 v3.9.0 发布说明

本版聚焦四站点扩展、去除冗余交互负担与状态变化动效统一：新增美国全境 **269 家官方直营店（覆盖 44 个州及哥伦比亚特区，免税州置顶）** 与 **357 个当地零售货号（347 个 `LL/A`、10 个 `AM/A`）**，提供 `州 / 地区 → Apple 直营店` 两级联动选择、全 7 个美国时区计算与 20 字内不截词中英通知校验；同步移除日本、台湾和香港站点中无取货接口的占位产品（大陆 Mac Studio 官方定制参考保留），实现单店城市自动勾选与抽屉 1:1 下滑手势关闭及回弹保护。本版已完成云函数 `gxs_api` / `gxs_monitor` 线上更新与全文件回读核验、微信开发者工具原生编译与 `miniprogram-ci` 11 项代码质量扫描、模拟器全链路交互验收及消费端体验版上传；正式提审发布前仍需完成体验版真机手势及订阅消息收信验收、绑定本指纹微信后台质检回执，并按阶段开启美国站点运营开关。

本次消费端源码指纹为 `sha256:09f8f90260845ac0ef9728cbd8131111fb01665d158bc098fbdd016e84b4f25d`，供微信质检复测关联本包。

## 当前能做什么

1. **美国站点（US）全境闭环支持**
   - 目录与门店：新增 [美国全境门店生成与校验脚本](../tools/catalog/markets/build-us-stores.mjs)（`--check`），结合 [regional catalog builder](../tools/catalog/build-market-catalog.mjs) 与 [美国站点抓取脚本](../tools/catalog/markets/fetch-us.mjs) 汇入 **269 家美国 Apple 直营店**（覆盖 44 州及哥伦比亚特区，俄勒冈 3 店、特拉华 1 店、新罕布什尔 3 店、阿拉斯加 1 店等免税州置顶，含全部州名、主要城市与旗舰店双语/中文译名）及 **357 个当地零售货号**（24 个系列，涵盖 iPhone、iPad、Mac、AirPods、HomePod 5 大品类；日/台/港同步维持 348 个已核实零售货号，门店分别为 11 / 2 / 6 家）。
   - 两级联动与消息合规：在「其他站点」切换美国站时自动展现 `州 / 地区 → Apple 直营店` 两级联动（日/台/港维持直接选店）；[notifier.js](../cloudfunctions/gxs_api/lib/engine/notifier.js) 修复了长门店名在中文模板下直接硬截断导致超 20 字符的问题，中英文通知均按门店简称顺序平滑回落，并通过全部 288 家门店（含全部 269 家美国门店）`<= 20` 字唯一性校验。
   - 取货接口与全 7 时区：美国站采用根路径 `/shop/retail/pickup-message`（不带 `/us/` 前缀）；前后端 [markets.js](../cloudfunctions/gxs_api/lib/markets.js)、[observation-day.js](../cloudfunctions/gxs_api/lib/engine/observation-day.js) 与 [presentation.js](../miniprogram/pages/markets/presentation.js) 共享纯 UTC 算法覆盖美国全部 7 个直营店 IANA 时区：`America/Anchorage`（`UTC-9/-8`）、`America/Los_Angeles`（`UTC-8/-7`）、`America/Denver`（`UTC-7/-6`）、`America/Chicago`（`UTC-6/-5`）、`America/New_York`（`UTC-5/-4`）以及全年不变夏令时的 `America/Phoenix`（`UTC-7`）与 `Pacific/Honolulu`（`UTC-10`），各门店库存日摘要与事件跨日严格按所属门店本地午夜切分。
   - 实时取货抽测证据：在 [fetch-us.mjs](../tools/catalog/markets/fetch-us.mjs) 新增 `--check` 与 `--sample-pickup`，并已保存 5 品类跨时区实测证据 [us-regions.json](../evidence/pickup-samples/2026-11-24/us-regions.json)（覆盖俄勒冈 `R077 Pioneer Place`、特拉华 `R102 Christiana Mall` 与夏威夷 `R073 Ala Moana`）。
2. **清理无取货接口商品 & 体验减负（Principle 1）**
   - 移除 `catalog/markets/{jp,tw,hk}.json` 中各自 48 个无官方自提接口的配置（Apple Watch 表壳 39 个、Vision Pro 验配 3 个、Mac 自选占位 6 个），同步更新 [regional extractor](../tools/catalog/markets/extract-regional.mjs) 与 `tw.mjs`；大陆目录中的官网定制 Mac 参考说明按既有产品边界保持不变。
   - 其他站点在仅有 1 个型号时隐藏重复的型号选择行；仅有中文实时通知而无英文模板时，隐藏尚不可用的英文提醒语言切换器（已保存英文偏好的关注保留切回能力）；英文顶栏标签缩写为 `US` 并通过无障碍标签保留 `United States`。
   - 大陆选配器 [target-picker](../miniprogram/components/target-picker/index.js) 在切换至仅含 1 家门店的城市且未满门店上限时自动勾选该唯一门店，再次点击可取消选中。
3. **状态变化动效体系（Principle 2）**
   - 在 [app.wxss](../miniprogram/app.wxss)、[styles/common.wxss](../miniprogram/styles/common.wxss) 与 [DESIGN.md](../DESIGN.md) 统一新增 `--ease-out`、`--dur-sheet` 节奏令牌及 `.ui-scrim-enter`、`.ui-sheet-enter`、`.ui-dialog-enter` 进入动画。
   - [config-sheet](../miniprogram/components/config-sheet/index.js) 顶部增加便携抓手条，支持非固定抽屉向下跟手拖动：入场动画期间起拖立即打断并 1:1 随指（>180px 阻尼衰减），松手低于 `84px` 通过纯 `transform` 过渡平滑回弹而不重播入场动画，达到 `84px` 时触觉反馈并复用 `dirty` 草稿放弃确认；`busy` 或 `docked` 状态自动锁定。
   - 为各筛选芯片、复选/单选对勾、展开/折叠区块补充一致微过渡，并在 `@media (prefers-reduced-motion: reduce)` 下全面停止动画与按压缩放。

## 正式发布还缺什么

1. **体验版真机与后台质检回执**：本版消费端已通过 CLI 上传至微信后台，提审前需在微信后台关联本指纹（`sha256:09f8f90260845ac0ef9728cbd8131111fb01665d158bc098fbdd016e84b4f25d`）关闭或更新 4 项历史质检复测记录，并在 iOS / Android 真机实测 320px 窄屏、深色模式、`prefers-reduced-motion`、抽屉下拉手势及键盘弹起回落。
2. **美国站分阶段开放与真实收信验收**：线上 `US` 公众查询、自动监测与微信通知开关当前均保持关闭（`false`，有效月卡/年卡及测试管理员可手动免扣次查询）；正式开放自动监测或英文推送前，需在运营端核对 `notifications.templateIds.restockEn` 并在真机验收实际订阅消息送达。

## 验收与对照记录

- **已验证（本地 / 离线环境）**：
  - `npm run check`（仓库全量语法、配置与资源完整性校验通过，0 错误）。
  - `node tools/catalog/markets/build-us-stores.mjs --check`、`node tools/catalog/markets/fetch-us.mjs --check`、`node tools/catalog/build-market-catalog.mjs --check`、`node tools/i18n/build.mjs --check`、`node tools/build-monitor.mjs --check`（美国 269 店/44 州及特区/7 时区索引、357 货号、压缩词表及 59 份 `gxs_monitor` 同步文件均一致）。
  - `node --test tests/design-system.test.mjs`（9/9 通过：字号/字重/间距/色彩令牌、组件类名隔离、单一内联样式约束、`prefers-reduced-motion` 全覆盖）。
  - `npm test` 全量 2,214 项自动化测试通过（覆盖 4 站点目录、US 269 门店全 7 时区夏令时与逐店观测日边界、`<=20` 字通知模板、两级州/门店联动、无接口商品过滤、`config-sheet` 入场打断/回弹/草稿锁、`target-picker` 单店城市自动勾选及原有全部契约）。
  - Playwright 离线 Chromium 布局校验：`--markets-only`（含 `us-pickup` 两级州/店行，共 90 份快照全部 0 失败）；`--sheets-only` 浅色 432 例与深色 432 例全部 0 失败（含 `sheet-rise`/`scrim-appear` 动画完成态与 `reducedMotion` 静止校验）。
  - 实时联通抽测：构建美国目录期间 `apple.com` 官方零售货号目录 24 个系列及 `storelist` 全数 HTTP 200；运行 `node tools/catalog/markets/fetch-us.mjs --sample-pickup` 对 `R077`（俄勒冈免税州）、`R102`（特拉华免税州）、`R073`（夏威夷州）5 大品类全数返回 HTTP 200（15 条实时观测记录见 [us-regions.json](../evidence/pickup-samples/2026-11-24/us-regions.json)）。
- **已验证（微信开发者工具、云端部署与上传）**：
  - **微信编译与本地质量扫描**：自带 `wcc` / `wcsc` 全量通过消费端与运营端模板样式编译；`miniprogram-ci@2.1.31` 的 `checkCodeQuality` 11 项全部 `success: true`（`CONTAINS_OTHER_PKG_JS`、`CONTAINS_OTHER_PKG_COMPONENTS`、`CONTAINS_UNUSED_COMPONENTS` 均为 0）；CLI 正式上传 `wxe96ad9e77b602f1b` v3.9.0 成功，上传包总计 `1,323,905` 字节（主包 `1,185,372` 字节，5 个分包合计 `138,533` 字节）。
  - **微信开发者工具模拟器实测**：在 `2.02.2611242`（基础库 `3.17.3`）隔离环境走通四个原生底栏、大陆单店城市（`R765`）自动勾选、抽屉下滑 `<84px` 回弹与 `>=84px` 关闭、美国站 45 个州/特区选项（44 州及哥伦比亚特区）中置顶免税州→门店联动、中英界面切换及全部 5 个分包页面跳转，运行异常为 `0`。
  - **CloudBase 云端部署与回读**：已更新 `flowermean-6gjaxfqhf6c13e88` 环境 `gxs_api` 与 `gxs_monitor`（保留共享鉴权 `cloudbase_auth` 现网版本），回读比对 `gxs_api` 93 个文件与 `gxs_monitor` 62 个文件差异均为 `0`，定时触发器 `gxs-payment-reconcile-five-minutes` 与 `gxs-monitor-minute` 保持正常；线上 `system.ping` 返回 `version: "3.9.0"`，`market.catalog` 确认 `US` 269 店已就绪且公众查询/监测/通知开关均为 `false`。
- **未验证（须正式提审与全量放开前完成）**：
  - 微信公众平台后台绑定同指纹的在线质检报告（关闭或更新自 3.3.1 延续的 4 项历史记录）。
  - iOS / Android 物理真机体验版触控帧率、大字号与真实键盘交互验收。
  - 开启美国站自动监测及通知开关后的跨日持续采样观测与真机微信订阅消息投递。

## 用量与时效说明

- 纯表现层动效仅使用 `transform` / `opacity` 合成属性且默认禁用无限循环（仅保留有效有货时的 `.ui-live-dot` 呼吸），无额外数据库读写或上游请求。
- 单店城市自动勾选仅复用前端已加载门店列表，不触发查询；未选满上限才自动勾选，不制造额外额度消耗。
- 美国站自动监测按对应配置上限共用现有配额预算与频率守卫，未更改未知状态或过期口径。

## 回退方式

3.9.1 复核发现，3.8.8 会拒绝含有 `US: false` 的持久化配置，且无法管理已经保存的美国关注。回退前须按 [3.9.1 兼容回退说明](RELEASE_3.9.1.md) 核对配置、关注与历史清理。

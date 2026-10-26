# 产品图片来源与更新

## 当前覆盖

2026-10-26 本地复核：当前目录共 **297 个零售 SKU、118 个精确官方原图 URL**，均有对应的已验证包内展示图。已有原图核验报告生成于 2026-10-14，记录 118 个有效 HTTP 图片、完整解码与 SHA-256 校验通过，原图总字节数为 46,126,818；本次没有重新请求全部官网原图，不能把历史 HTTP 结果当作当前网络可用性证明。

当前包内包含 **119 个缩图，共 595,221 B**：118 张商品卡片图及 1 张保留的海报资源，其中透明 PNG 47 个、不透明 JPEG 72 个。卡片最大边 216px，单图 1,359–9,114 B；海报为 609×720、28,226 B。它们由已验证的原图缩放、编码得到，没有生成替代商品图。此次 `node tools/assets/build-product-thumbnails.mjs --check` 已通过；素材存在不表示对应海报入口仍在展示。

图片与规格的关系来自官方数据：

- 253 个 SKU：购买页 `products[].imageKey` 精确关联同页 `imageDictionary`。不同容量可以共享图片，颜色和机型仍由各 SKU 的 `imageKey` 决定。
- 37 个 Mac SKU：按官方配置维度调用 28 个去重后的商品图集请求，取得所选颜色、屏幕尺寸和外观配置的 `summary` 图片。部分不同芯片配置共享同一个官方外观图集。
- 7 个 SKU：Mac mini、Mac Studio 和 Apple Vision Pro 的单一产品系列摘要图。这些标准 SKU 没有影响图片外观的颜色、屏幕尺寸等选项；来源明确记录为 `apple-family-summary`。

当前目录的图片版本为 `2026-10-14T13:16:53.334Z`。本地 `catalog/products.json` 与本地云函数随包目录的产品文件完全相同，SHA-256 为 `7ee4d65c4e3e9d87f99be5d19bba2fd4de12221d4f92c1b9f51cec46dc39b968`；此项比较不单独证明线上目录已同步。

2026-09-15 的历史核验覆盖 292 个 SKU、113 个原图 URL，并额外人工抽查了勃艮第酒红色 iPhone 18 Pro Max、天蓝色 13 英寸 MacBook Air、粉色两端口 iMac、蓝色 AirPods Max。这些人工抽查是当时的来源证据，不是此次体验包或当前全部商品的真机验收。

## 文件与证据

- `catalog/products.json`：主产品目录，保留此前 SKU 和供应接口验证资料，新增 `imageUrl`、`imageAlt`、尺寸、来源 URL、`imageKey`、用于匹配的配置维度。
- `cloudfunctions/gxs_api/catalog/products.json`：由 `npm run catalog:sync` 同步的云函数随包目录。
- `evidence/catalog/2026-10-14/images.manifest.json`：当前 24 份官方购买页来源及 28 个图集请求的映射记录。原始页面混合使用 2026-09-15 与 2026-10-14 快照，必须按每条 `rawFile` 读取，不按 manifest 日期猜测原始文件目录。
- `evidence/catalog/2026-10-14/images.verification.json`：118 个原图的精确 URL、关联 SKU、HTTP 响应、文件大小、哈希与实际解码格式和尺寸。
- manifest 中的原始页面及图集文件：保存官方响应与来源证据。
- `evidence/raw/2026-10-14/image-files/`：当前核验报告指向的未改动原图及下载记录；原始素材目录受 `evidence/raw/` 的 Git 忽略规则覆盖，不增加小程序源码包体积。
- `evidence/assets/product-thumbnails.manifest.json`：原图哈希与每个缩图的尺寸、格式、字节、透明度、SHA-256、关联 SKU；同时绑定目录与展示映射文件的哈希。
- `miniprogram/config/product-thumbnails.js`、`miniprogram/images/products/`：精确原始 URL／SKU 到包内缩图的映射及实际展示资源。

解码报告的 `assetDirectory` 与每条 `assetFile` 组合即为本机原图路径。原始素材和报告可用于复核，报告中的 SKU 列表可以反向定位图片。

## 映射规则

1. 先按零件号匹配购买页中的原始 SKU，使用该行的 `imageKey`；不按相似产品名称、颜色近似值或家族中的第一张图片匹配。
2. Mac 页面的 `window.buyFlowGallery.productGalleryData.summary.warmStateImageSetRules` 指定图集所需的配置维度。请求形式与官方页面脚本一致：每项使用单独的 `dm.<dimension>=<value>` 参数。
3. iMac 标准零售行的容器名称包含 `_STAND_`，官方配置枚举将 `desktop` 标为“支架”。仅在这两项证据同时存在时补入 `dm.chassis-dimensionStandType=desktop`，使图集区分标准支架和 VESA 配置。两端口与四端口机型仍按各自处理器配置取图。
4. 有颜色或屏幕尺寸选择的机型，不能使用多色汇总图作为某个 SKU 的图片。图集返回的 `imageKey` 还要与所请求的颜色、尺寸一致；不一致则停止写入。
5. 原图 URL 只接受 Apple 的官方图片 CDN，原样保留其查询参数作为来源证据。既有验证发现修改 `wid` / `hei` 后继续使用原 `.v` 值会返回 404，因此不能自行拼接缩略图 URL。界面通过 `imageDisplayUrl` 加载已验证的包内缩图，不能只靠 CSS 显示尺寸缩小大原图。
6. 新一次映射失败时清除旧图片字段，保留缺失原因并使更新失败，避免旧颜色图片伪装成新选择的成功结果。

## 展示资源与旧缓存兼容

`miniprogram/utils/product-image-fit.js` 优先按已验证的精确原图 URL 匹配包内资源，也接受已映射的本地路径；URL 不再匹配时，可按已验证的相同 `partNumber` 恢复资源。旧缓存里的远端展示 URL、轮换后的原图 URL，以及此前生成的本地 `.webp` 路径，都须经过这层映射。真正未知的 SKU／图源显示占位或隐藏图片，不猜颜色、机型或 CDN 参数。

查询选配、查询结果、小哨、历史、会员待配置目标和商品选择器均绑定 `imageDisplayUrl`。原始 `imageUrl` 留作来源，不作为图片加载失败的回退地址。目录或图源变化必须同时重建并校验展示资源；`--check` 会检查目录指纹、全部 SKU 覆盖、文件哈希、格式与尺寸／字节预算。

当前包内使用透明 PNG 和基线 JPEG，是已记录的真机兼容修复：此前本地 `.webp` 被开发者工具代码包白名单剔除，造成模拟器读盘正常、手机预览缺图。不得仅为满足“现代格式”建议再把包内资源改回 `.webp`。模板里的 `webp` 属性仅是解码选项，不会将 PNG／JPEG 自动转换为 WebP。图片格式项仍需在实际上传包上取得微信质检结果，不能以本地编码或属性设置替代。

## 更新与复核命令

以下命令在项目根目录运行。首次采集或刷新官方页面会产生真实外部 GET 请求；离线模式使用已有原始缓存。

为现有目录补图使用 `tools/catalog/enrich-images.mjs`，保留现有 SKU 和供应接口验证资料。离线模式须通过 `--day` 指定原始页面与图集缓存齐全的快照日期；当前来源混合了两个历史日期，不能直接将单一旧日期当作完整当前目录重新生成。缺少缓存时可按需获取官方来源；图集请求串行执行、间隔 750 毫秒、无自动重试，遇到 403 / 429 / 541 停止。任何 SKU 未匹配到图片时，主目录不会被该次更新覆盖。

重新建立整套产品目录时使用 `npm run catalog:products`。该流程已包含图片映射；它按新抓取的页面重建目录，因此后续仍需单独运行原有供应接口抽样验证流程。只补图片应使用 `enrich-images.mjs`。

映射更新成功后验证并同步：

```powershell
node tools/catalog/verify-images.mjs
python tools/catalog/verify-image-decode.py
npm run catalog:sync
node tools/assets/build-product-thumbnails.mjs --python python
node tools/assets/build-product-thumbnails.mjs --check
node --test tests/catalog-images.test.mjs tests/product-image-fit.test.mjs tests/product-thumbnails.test.mjs
```

Python 需要 Pillow。图片下载脚本每个唯一 URL 只保存一份，最多 3 个并发；若本地已有匹配哈希的原图则直接复用。解码脚本再次检查文件哈希并完整解码。缩图构建默认只读取已有、哈希匹配的原图；缺少原图时先恢复缓存，或明确使用 `--download` 获取原样来源。`--check` 及单元测试不联网，不依赖被忽略的大型原始素材。

仅核对当前包内资源，无需重新采集或重建时，运行 `node tools/assets/build-product-thumbnails.mjs --check` 即可。

## 小程序与云端目录

目录服务透传原图 URL、文案、宽高和来源，并将 `imagesGeneratedAt` 纳入目录版本。云端目录更新后，客户端按目录版本刷新缓存；展示时仍通过包内映射解析小图。前端精确 SKU 图片索引可兼容云端旧目录中缺少图片的相同 `partNumber`，不跨 SKU 或颜色猜测。新增 SKU 需要随前端交付对应展示资产；仅更新云端目录不保证旧客户端拥有新图片。

2026-10-26 此次复核与文档更新只验证已有本地目录、包内资源及映射；没有重新采集图片、修改线上目录或完成新一轮图片真机验收。此前其他后端部署的状态见各自部署证据，不能用本页的旧结论覆盖。商品图片尺寸、图片格式及首次切页三项仍待对应当前上传包的微信逐项复测，详见 [微信质检追踪](WECHAT_QUALITY_3.3.1.md) 和 [本轮运行质量记录](RUNTIME_QUALITY_2026-10-26.md)。

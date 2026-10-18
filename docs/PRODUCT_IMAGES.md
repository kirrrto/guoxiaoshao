# 产品图片来源与更新

## 当前覆盖

2026-09-15 本地目录共 292 个零售 SKU，292 个都有官方产品图片，合并后为 113 个图片 URL。逐个实际 GET 检查得到 113 个 HTTP 200，全部通过 Pillow 的文件结构检查、完整像素解码及 SHA-256 校验；总下载量为 45,033,409 字节。没有缺图占位或生成图片。

图片与规格的关系来自官方数据：

- 248 个 SKU：购买页 `products[].imageKey` 精确关联同页 `imageDictionary`。不同容量可以共享图片，颜色和机型仍由各 SKU 的 `imageKey` 决定。
- 37 个 Mac SKU：按官方配置维度调用 28 个去重后的商品图集请求，取得所选颜色、屏幕尺寸和外观配置的 `summary` 图片。部分不同芯片配置共享同一个官方外观图集。
- 7 个 SKU：Mac mini、Mac Studio 和 Apple Vision Pro 的单一产品系列摘要图。这些标准 SKU 没有影响图片外观的颜色、屏幕尺寸等选项；来源明确记录为 `apple-family-summary`。

图片版本为 `2026-09-15T07:02:18.681Z`。本地目录和云函数随包目录的产品文件完全相同，SHA-256 为 `0273e07bd8767bb824488499fb2f51b471555d7998f7ed82422e9664e2b0d8fd`。

人工打开核对了勃艮第酒红色 iPhone 18 Pro Max、天蓝色 13 英寸 MacBook Air、粉色两端口 iMac、蓝色 AirPods Max 的图片本体，图像颜色、设备外观与对应官方文案相符。完整 113 张图片均经过自动解码检查；这四张是额外视觉抽查。

## 文件与证据

- `catalog/products.json`：主产品目录，保留此前 SKU 和供应接口验证资料，新增 `imageUrl`、`imageAlt`、尺寸、来源 URL、`imageKey`、用于匹配的配置维度。
- `cloudfunctions/gxs_api/catalog/products.json`：由 `npm run catalog:sync` 同步的云函数随包目录。
- `evidence/catalog/2026-09-15/images.manifest.json`：23 份官方购买页的 URL、原始文件位置、内容哈希，以及 28 个匹配成功的图集请求。
- `evidence/catalog/2026-09-15/images.verification.json`：每个图片的精确 URL、关联 SKU、HTTP 响应、文件大小、哈希与实际解码格式和尺寸。
- `evidence/raw/2026-09-15/<familyKey>.html`：官方购买页原文。
- `evidence/raw/2026-09-15/image-galleries/`：图集响应原文和 HTTP 证据。
- `evidence/raw/2026-09-15/image-files/`：113 张未改动的官方图片及下载记录；此目录已受 `evidence/raw/` 的 Git 忽略规则覆盖，不增加源码包体积。

解码报告的 `assetDirectory` 与每条 `assetFile` 组合即为本机原图路径。原始素材和报告可用于复核，报告中的 SKU 列表可以反向定位图片。

## 映射规则

1. 先按零件号匹配购买页中的原始 SKU，使用该行的 `imageKey`；不按相似产品名称、颜色近似值或家族中的第一张图片匹配。
2. Mac 页面的 `window.buyFlowGallery.productGalleryData.summary.warmStateImageSetRules` 指定图集所需的配置维度。请求形式与官方页面脚本一致：每项使用单独的 `dm.<dimension>=<value>` 参数。
3. iMac 标准零售行的容器名称包含 `_STAND_`，官方配置枚举将 `desktop` 标为“支架”。仅在这两项证据同时存在时补入 `dm.chassis-dimensionStandType=desktop`，使图集区分标准支架和 VESA 配置。两端口与四端口机型仍按各自处理器配置取图。
4. 有颜色或屏幕尺寸选择的机型，不能使用多色汇总图作为某个 SKU 的图片。图集返回的 `imageKey` 还要与所请求的颜色、尺寸一致；不一致则停止写入。
5. 图片 URL 只接受 Apple 的官方图片 CDN，原样保留其查询参数。实际验证发现，修改 `wid` / `hei` 后继续使用原 `.v` 值会返回 404，因此不能自行拼接缩略图 URL。界面应通过展示尺寸和懒加载控制显示。
6. 新一次映射失败时清除旧图片字段，保留缺失原因并使更新失败，避免旧颜色图片伪装成新选择的成功结果。

## 更新与复核命令

以下命令在项目根目录运行。首次采集或刷新官方页面会产生真实外部 GET 请求；离线模式使用已有原始缓存。

为现有目录补图，并保留现有 SKU 的供应接口验证资料：

```powershell
node tools/catalog/enrich-images.mjs --day 2026-09-15 --offline
```

如果缺少对应图集缓存，去掉 `--offline` 可按需请求官方图集。图集请求串行执行、间隔 750 毫秒、无自动重试；遇到 403 / 429 / 541 停止。任何 SKU 未匹配到图片时，主目录不会被该次更新覆盖。

重新建立整套产品目录时使用 `npm run catalog:products`。该流程已包含图片映射；它按新抓取的页面重建目录，因此后续仍需单独运行原有供应接口抽样验证流程。只补图片应使用 `enrich-images.mjs`。

映射更新成功后验证并同步：

```powershell
node tools/catalog/verify-images.mjs
python tools/catalog/verify-image-decode.py
npm run catalog:sync
node --test tests/catalog-images.test.mjs
```

Python 需要 Pillow。图片下载脚本每个唯一 URL 只保存一份，最多 3 个并发；若本地已有匹配哈希的原图则直接复用。第二个脚本再次检查文件哈希并完整解码；运行单元测试不联网，不依赖被忽略的大型原始素材。

## 小程序与云端目录

目录服务透传图片 URL、文案、宽高和来源，并将 `imagesGeneratedAt` 纳入目录版本。重新初始化云端目录后，旧版本客户端缓存会刷新。小程序本地的精确 SKU 图片索引可为云端旧目录中缺少图片的相同 `partNumber` 补图，不跨 SKU 或颜色猜测。

本轮只更新本地源码和目录文件，没有部署云函数、写入线上目录或启用云端采集。正式运行还需要在实际小程序环境中确认官方图片域名访问以及客户端图片加载状态。

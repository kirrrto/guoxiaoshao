# v3.3.1 微信质检问题追踪

**当前为 2026-10-21 修订候选，GitHub 同步与提审均暂停。** 此前维护者手机扫码预览反馈“查询页、选择器和小哨页商品图均加载失败，且查询卡片‘修改’按钮换行”。经本地代码包链路核实：微信开发者工具代码包白名单（`white.miniProgram`）不含 `.webp`，`filterNotSupportCodePkgFile` 将 119 个本地 `.webp` 全部按 `NOT_WHITELIST_FILE` 剔除，导致模拟器直接读盘看似正常而真机预览包完全缺失商品图；查询卡片 `.selection-summary-change` 固定 `flex-basis: 58px` 则在 430px 等视口或放大字号下将“修改”挤成两行。现已将包内展示资源改为白名单与真机兼容的 47 个透明 PNG 与 72 个不透明基线 JPEG（共 119 个文件、595,221 B），兼容旧 `.webp` 缓存路径迁移，并修复“修改”按钮换行。待维护者授权生成新预览并手机扫码验收；新微信云测尚未重跑，四项均未取得对应修订包的通过记录，仍保持 open。

历史输入：2026-10-21，维护者确认五张截图和启动明细均为此前上传 v3.3.1 后重新测试的结果。仍按有效失败处理，不能因为本地测试通过或源码无对应名称而判为旧报告、缓存或误报；本次修订后的验证与该次失败报告分别记录。

## 输入与来源

- 截图总览任务 ID：14127；iPhone 11 微信版本 8.0.71。启动总体为良好；华为 P40 运行性能栏为较差，最佳实践及综合体验为优秀。不同栏目不能互相代替。
- 上传的 Excel 文件名包含任务 ID 195099、iPhone 11。文件内是 20 张表、1196 条相对时间轴事件，不包含版本或测试日期。两任务属于本版复测的依据是维护者的明确确认，精确上传包到源码提交的映射仍未核验。
- `startup_end - startup_start`：需下载代码包 10 次平均 939.1 ms，已下载代码包 10 次平均 870.8 ms，与截图的 939/871 ms 对应。首页初次渲染区间 28–70 ms，不代表业务数据全部可用。表中没有官方 LongTask 分类与函数堆栈，不能把耗时事件相加当作阻塞总时间。
- 失败报告追溯时的审查源码基线：`92766492210e39dd1e36b49a5085730db32a1d2e`，此前已同步 GitHub。下述 2026-10-21 修订在此之后完成；已生成微信预览包，未重跑云测、未提审、未正式发布，也未部署云函数。

## 逐项结果

| 质检项 | 以前处理了什么 | 当前证据与未完成内容 |
| --- | --- | --- |
| 声明但未使用 `channel-video` | 旧提交 `3617f5a` 曾误加空占位组件；`6abe788` 删除空组件及六页引用 | 已在原版 3.17.3 基础库的空页面独立重现：内置组件无前缀别名进入未使用组件审计。状态为 `platform defect pending WeChat verification`；仍保持 open，尚未取得对应上传包的微信侧通过证据，详见下文 |
| WebView 自定义 tabBar 首次切换闪烁 | 旧方案仍使用自定义组件，仅改善初始选中态、节点保留与生命周期同步 | 已移除 `tabBar.custom` 和自定义底栏组件，改用微信原生导航；保留路由防重、弹层/键盘隐藏及页面退出清理，并为原生显示/隐藏的瞬时失败添加有限重试。实际开发者工具编译通过，3,060 项离线几何检查通过；尚无 iOS/Android 首次切页连续帧和新云测通过证据，因此仍 open |
| 商品图片尺寸过大 | 3.0.1 压缩的是页眉 Logo；截至 `9276649`，商品 helper 仍返回原地址 | 已按 118 个精确官方原图及 297 个 SKU 构建包内缩图。报告中的 Duo 星光白从 940×1112、684,465 B（668.42 KiB）变为 183×216、5,284 B，保留透明与比例。查询、关注、历史、选择器、会员待配置目标、两处日历及旧缓存均使用展示资源；新云测尚未验证尺寸项，仍 open |
| 商品图片非现代格式 | 截至 `9276649`，商品展示仍直接下载 PNG | 基础库 `WAProgneWebview.js` 仅对 `http(s)://` 网络图片采集 `collect-image-info`；此前改为本地 `.webp` 时因开发者工具代码包白名单不含 `.webp`（`NOT_WHITELIST_FILE`）导致真机预览包漏打图片。现改为 119 个包内轻量 PNG／JPEG（47 个透明 PNG + 72 个不透明 JPEG，合计 595,221 B），保留原始 URL/精确 SKU，不猜改 CDN 参数，也不在错误时回退大 PNG。待真机扫码与新云测验证，仍 open |

图片原始证据位于 `evidence/catalog/2026-09-15/images.verification.json`，同图对应四个 SKU。保持原始来源 URL 与降低展示资源大小是两个要求，需要分别验证。

### 2026-10-21 修订实现与验证

- **展示资源与更新契约**：[构建脚本](../tools/assets/build-product-thumbnails.mjs) 和 [编码脚本](../tools/assets/encode-product-thumbnails.py) 只缩放、编码 SHA256 已核验的原始商品图；不生成替代商品。因微信代码包白名单不含 `.webp` 且 `<image webp>` 仅面向网络资源，透明原图编码为 256 色 PNG（保留透明边缘与不透明主体），不透明原图编码为基线 JPEG。卡片最长 216px、每张上限 12 KiB，实测 1,359–9,114 B；日历海报最长 720px、上限 64 KiB（实测 28,226 B）。完整尺寸、格式、字节和来源关系见 [素材 manifest](../evidence/assets/product-thumbnails.manifest.json)。精确 URL 优先匹配，已知 SKU 的旧缓存、轮换 URL 或此前 `.webp` 本地路径均可自动解析到当前包内资源；真正未知的 SKU/URL 显示占位或隐藏图片。目录或图源更新必须同步重建资产，`--check` 对目录哈希、SKU 覆盖、文件哈希、禁止包内 `.webp` 及预算进行校验。
- **查询卡片“修改”按钮不换行**：移除 `miniprogram/pages/query/index.wxss` 中 `.selection-summary-change.ui-action` 的固定 `116rpx`／`max-width: 72px` 与 `flex-basis: 58px` 限制，改为按内容自适应并保持 `white-space: nowrap; word-break: keep-all`，由左侧门店文本自适应换行，并在 `check-layout.mjs` 与 `check-native-tabs.mjs` 中增加单行与不裁切校验。
- **代码和回归**：整仓 **1,614 / 1,614** 测试通过，0 失败、0 跳过；源码检查 **541 个文件、0 错误**。图片测试检查实际 PNG／JPEG 文件头、尺寸、字节、透明度记录、来源映射、旧缓存与旧 `.webp` 路径恢复以及失败不回退大图；底栏测试覆盖路由、弹层、键盘、生命周期、桥接失败和延迟回调。这些结果不代替微信云测。
- **离线布局**：默认 84、主流程 318、配置弹层 48 案，浅深色各一轮，共 **900** 个布局快照和 **3,060** 个原生底栏几何场景（含 1x／1.3x 字号下的“修改”按钮单行校验）通过；包内 PNG／JPEG 全部加载成功。六份布局和六份几何报告对应相同的 240 个业务源文件，并在结束后重新核对源码哈希。工具只模拟原生导航占用的视口，不证明首帧或切页连续帧无闪烁。
- **开发者工具白名单与解析核验**：使用 D 盘安装的微信开发者工具 **2.02.2610202** 内部 `filterNotSupportCodePkgFile` 与 `Parser.parse` 实测：此前 119 个 `.webp` 为 0 / 119 通过（`whiteListHasWebp: false`，`NOT_WHITELIST_FILE`，见 `output/quality-fix/devtools-webp-local-probe.json`），解释了模拟器读盘正常而真机预览包（当时仅 **1,066,652 B**）缺失商品图的原因；改为 PNG／JPEG 后 **119 / 119** 全部通过代码包白名单与尺寸解析。新预览包待维护者授权生成并手机扫码确认。

上述本地日志、摘要和开发者工具截图保存在忽略目录 `output/quality-fix/`，包括 `final-tests.log`、`source-check.log`、`ui-final-summary.json`、`wechat-preview-info.json` 和星光白展示截图。它们不是新微信云测任务，也不构成提审或正式发布记录。

### `channel-video` 的独立重现与边界

2026-10-21，使用本机官方 3.17.3 SDK，在隔离的空白 Chromium 页面中原样加载 `WAWebview.js`，没有加载本项目 JS/WXML，`__wxAppCode__` 为空。基础库注册了 155 个组件名，其中同时包含 `channel-video` 与 `wx-channel-video`。执行从同一 SDK 原样提取的 `WAProgneWebview.js` 审计回调后，空页面仍产生 `unused-component-data`，唯一项目为 `channel-video`，数量为 1。

根因链条是基础库先以 `channel-video` 注册内置组件，再追加 `wx-channel-video` 别名；审计枚举注册表时仅按 `wx`、`exparser-inspector` 前缀及页面名称排除内部组件，没有排除原始无前缀别名。这是实际运行原始 SDK 得到的独立证据，不再仅依据业务源码搜索推断来源。当前业务源文件和组件 JSON 扫描仍无该声明。对应云测使用的精确基础库/上传包与本地源码映射尚未核验，因此不将该项登记为 closed。

- 精简证据：[channel-video-sdk-reproduction.json](../evidence/verification/3.3.1-quality/channel-video-sdk-reproduction.json)。包含 SDK 包与原文件 SHA256、审计片段与偏移、空页面输出、源码指纹和扫描结果；不包含完整基础库或个人绝对路径。
- 可复现工具：[wechat-component-audit.mjs](../tools/quality/wechat-component-audit.mjs)。只读取已安装 SDK，在独立 headless 页面运行；禁用页面网络，不修改安装目录、项目组件注册表、渲染引擎或质检状态。原审计回调自身的创建监听仅作用于该隔离页面/测试 fixture。
- 独立测试：[wechat-component-audit.test.mjs](../tests/wechat-component-audit.test.mjs)。四组对照覆盖普通内置组件排除、无前缀别名误计入、真正未使用业务组件检出、已实例化业务组件排除。通过表示确认本地过滤行为，不表示微信云测通过。

本地重现需要已安装 Playwright 和 Chromium 浏览器。工具自动发现 Windows 开发者工具缓存中与 `project.config.json` 对应版本的 SDK，也可用 `--sdk` 指定；`--browser` 可指定浏览器。示例中的 Playwright 路径应换成本机已安装包目录，无需安装或上传任何小程序包：

```powershell
node tools/quality/wechat-component-audit.mjs --playwright '<本机 Playwright 包目录>' --out output/channel-video-sdk-reproduction.json
node --test tests/wechat-component-audit.test.mjs
```

未发现可确认的业务配置排除入口。3.17.3 注册辅助函数会同时建立 exparser 与 glass-easel 组件对象，单为消除此告警切换引擎没有验证依据。当前不加空组件、不隐藏实例化该组件、不修改微信基础库或审计结果。下一步需对相同源码指纹的实际上传包进行微信侧验证，并用这份最小重现核对平台修复；这仍是外部验收阻塞项。

## 此前本地测试为什么漏报

截至审查基线 `9276649`，`tests/product-image-fit.test.mjs` 明确断言展示 URL 等于原图 URL；当时的图片测试保证来源、SKU、可解码和失败处理，没有传输体积或格式预算。旧导航测试主要检查生命周期执行后的选中状态，没有原生首帧/连续帧证据。原发布预检没有逐项带出历史云测失败。当前修订已替换上述原图断言并增加实际资源预算检查，历史漏报原因仍保留在此。

因此，之前存在源码优化，但不具备“所有报告问题已解决”的证据。本次审查漏掉了未闭环质检项，不能归因于维护者未反复提醒，也没有证据归因于本次其他模型的修改覆盖了修复。

## 后续版本的约束

`config/wechat-quality-findings.json` 保存这四个未关闭检查项，`tools/release/check.mjs` 将其纳入预检。原有源码检查通过单独报告为 `sourceChecksPassed`；存在未关闭或缺少对应当前版本复验记录的质检问题时，整体预检失败。更改版本号不能抹掉未解决记录。

关闭一项必须记录对应版本、前端源码指纹、测试任务、设备和通过证据；同版本号但源码已改变时，旧记录也不能继续通过。预检核验人工登记的记录及源码指纹，不自动抓取或判读微信报告，也不自动证明指纹与上传包的对应关系。本地改动、Node 通过、离线截图及开发者工具编译均不得代替微信复验。生产部署、实际付款、收信等原有外部验收依然独立。图片和底栏的实现修订已完成；四项微信质检仍未关闭，不得把本地通过改写为微信云测验收通过。

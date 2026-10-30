# 标准配置目录采集

`node tools/catalog/fetch-products.mjs` 读取 `families.json` 中启用的中国官网购买页。Mac 系列还会顺序读取该页面明确链接的同系列配置页，最多 48 页，每次请求间隔 2 秒；不跟随跨域、其他系列、查询参数或重定向，不重试限流响应。配置页的零售 SKU、芯片、内存和存储必须由官网选中配置及标签共同解析。

`--only macbook-pro-proled-xdr,mac-studio` 只生成局部结果供核查，不覆盖正式目录。根页和配置页的原始响应保存在 `evidence/raw/<日期>/`，HTTP 状态与哈希保存在 `evidence/catalog/<日期>/products.manifest.json`。`--offline <日期>` 根据同一 manifest 回放配置页并复核哈希；旧证据没有配置页时会明确停止，需要重新进行该系列的受限采集。

配置页 HTTP/解析失败、链接数量超限，或当前目录中的 Mac SKU 在本次结果中消失时，采集返回非零退出码，只写诊断和局部结果，不覆盖 `catalog/products.json`。`mac_catalog_removal_requires_review` 会列出缺失的系列与 SKU。维护时先用 `--only` 检查对应官网根页、配置页和已保留的证据：页面布局变化就修复解析并补回归 fixture；确为下架则单独明确调整目录及相关取货支持状态，再重新运行采集。不要删除缺失检查来跳过差异。

目录存在不代表门店支持或有货。后续图片核验、取货抽样和 `sync-to-function.mjs` 仍按各自证据执行。

## 定制配置与零售 SKU 分开

上述选中页补采解决标准零售 SKU 的遗漏，不等于覆盖全部 Mac 定制选项。Mac Studio 根页中的 `CONFIGURABLE` 底座没有 `btrOrFdPartNumber`，但官网仍允许选择不同芯片、内存和存储。不能因为解析器只收 `CH/A`，就把未输出的定制配置解释为官网不存在。

公开 `GET /shop/api/cto/update-config` 使用官网页面提供的 collection 及 `sv.<dimension>` 当前选项，返回 `options.<dimension>.compatibleOptions` 与 `selectedKits`。`upgradeOptions` 意味着需要调整芯片等依赖，不能直接并入当前芯片的兼容列表。配置的实际身份由 `selectedKits.aosContainerPartNumber` 和完整 `productConfiguration` 共同决定；不能猜测 `065-…` 选项号、虚造零售编号或把所有配置合并到一个容器号。

2026-10-30 的 Mac Studio 四种芯片兼容矩阵保存在 [公开定制配置证据](../../evidence/catalog/2026-10-30/mac-studio-cto-research.json)。[逐项配置采集](../../evidence/catalog/2026-10-30/mac-studio-configurations.json) 已根据兼容约束解析全部 45 个组合（3 个标准零售 SKU、42 个定制配置），每项都核对返回的芯片/内存/存储、容器号和完整选项标识；导入器拒绝缺项、重复、被阻断或自动改写依赖的响应。不能直接做所有选项的笛卡尔积。

官网定制取货使用 `fulfillment-messages`、`parts.i=<容器>` 及 `option.i=<完整选项列表>`，响应在 `body.content.pickupMessage` 下。Apple 官网定制 Mac 不支持 Apple Store 店内取货，因此 42 个定制配置仅作配置参考，不进入客户端查询、关注或提醒候选；3 个标准零售 SKU 的查询不受影响。适配器和精确身份核对代码保留用于未来兼容验证，但不能把公开选项或内部 `CTO_` 身份当成可查询取货目标。生产库存轮询不因这些人工目录研究增加目标。

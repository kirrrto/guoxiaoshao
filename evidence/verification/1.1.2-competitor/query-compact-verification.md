# Query 紧凑摘要专项验收

验证时间：2026-09-16。使用独立无头 Edge 进程渲染项目 WXML/WXSS 生成的 HTML，不操作用户微信或开发者工具。

## 覆盖和结果

- 320、375、430 px 三种宽度；原始字号与 130% 字号。
- free、member、expired、empty、error、longcontent 六种场景，共 36 组。
- 横向溢出 0，裁切文本 0，摘要图片/文字/修改按钮重叠 0。
- 摘要/展开/错误状态 36 组符合预期。摘要状态保留已挂载但隐藏的完整选择器。
- 所检查的查询区可见且可用操作按钮触区均至少 44 × 44 px。
- 已人工查看窄屏大字、长标题、展开首屏、真实银色与蓝色图片的代表截图。

## 本轮发现并修复

原 88 rpx 按钮高度在 320 px 视口下只有约 37.53 px；摘要“修改”按钮宽度约 39.25 px。仅在 query 页面新增最小 44 px 的本地约束，保留较宽屏幕原来的 rpx 尺寸。修复后 320 px 原始/130% 字号的“修改”均为 44 × 44 px，查询与关注均为 271.94 × 44 px。未调整全局按钮、业务逻辑或支付/会员规则。

## 真实产品图片

通过 `--remote-images` 分别构建并实测以下实际目录 SKU；每种颜色均验证摘要和展开模式，共 4 个可见主图：

- MJTD4CH/A：iPhone 18 Pro 512GB 银色，imageKey 为 `iphone-18-pro-finish-select-silver-202609`。
- MJTF4CH/A：iPhone 18 Pro 512GB 冰川蓝色，imageKey 为 `iphone-18-pro-finish-select-glacier-202609`。

4 个主图均精确匹配对应 SKU 的目录 URL，实际由 `store.storeimages.cdn-apple.com` 加载，解码成功，原图 940 × 1112。隐藏选择器中的图片状态另列入 JSON，不参与可见主图成功判定。主图银蓝颜色已目视核对。此结果证明这两个样本的目录映射与本次网络加载，不代表所有型号或微信域名配置都已通过真机验证。

## 证据

- 完整结构化结果：`query-compact-layout.json`。
- 摘要/展开代表首屏：`query/query-member-375-font100-first-screen.png`、`query/query-free-375-font100-first-screen.png`。
- 320 px 大字与长文本：`query/query-member-320-font130.png`、`query/query-longcontent-320-font130.png`。
- 375/430 px 大字与长文本：同目录相应宽度的 `query-member-*-font130.png` 和 `query-longcontent-*-font130.png`。
- 银色/蓝色实图：`query/query-real-silver-member-375.png`、`query/query-real-blue-member-375.png`，以及对应 `free` 展开截图。
- 独立复现脚本：`C:\Users\Administrator\Documents\ChatGPT\果小哨\check-query-compact-1.1.2.mjs`。

## 证据边界

这是源文件生成的浏览器近似渲染，不是微信真机结果。130% 测试逐个放大原始计算字号，不等同于特定手机系统字体缩放。截图顶部保留离线模拟标记。展开/摘要代表图来自不同账户场景，用于展示布局状态，不作为相同用户操作前后耗时或转化率证据。交互、查询计费幂等和异步滚动保护由相应源码回归测试单独验证。

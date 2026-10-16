# 2.0.0 性能与 source map 核对

本记录依据维护者提供的 2026-09-11 至 2026-10-11 微信性能截图、`D:/gh_176c26ca938e_15.zip` 和本次修改前的 1.6.1 本地备份。截图中的耗时属于原报告样本；本次没有取得升级后的真机性能分布，不能据此声称已提升某个百分比或所有问题耗时归零。

## 已处理的路径

| 报告现象 | 2.0.0 改动 | 保留的行为 |
| --- | --- | --- |
| App onLaunch 长任务；initCloud/ensureCloud 样本 74 ms | 支持的微信客户端通过 `wx.nextTick` 在下一时间片创建云 SDK；提醒设置模块延后读取，避免其依赖链在 App 顶层加载目录 | 并发页面共用一次初始化，10 秒连接截止，失败可重试，迟到初始化不覆盖新连接；朋友圈预览仍不连接云服务 |
| App 启动计数同步读写 | 启动计数使用异步 storage；首页等待独立计数 Promise 后决定是否显示收藏提示，不阻塞目录呈现 | 第二次启动后提示、关闭提示持久化；旧环境缺少异步 API 时兼容同步路径 |
| 查询/历史页启动多次同步读本地缓存 | 新增 `utils/session.js`，选择、查询快照、收藏提示异步读取；同 key 的读取共用 Promise 和内存快照 | 读取失败或 1.2 秒未返回时降级；用户新写入的值优先于迟到的旧读取；异步写按 key 排序 |
| `gxs_catalog_v1` 重复读取 | 目录缓存一个进程最多读取一次；保留目录索引与并发刷新复用；用本地版本请求服务器，失败仍可使用内置目录 | 服务端版本更新、失败退避、显式刷新、账户切换后旧响应隔离继续生效 |
| 自定义 tab 切换闪烁 | 新实例不预先选中「查询」；两种图标常驻并切换透明度，键盘/弹层使用 hidden 保留导航节点 | 当前原生页面决定选中态，失败导航不误选，快速重复点击仍共用导航锁 |
| 声明但首屏未使用的组件 | 查询、小哨、历史页的条件显示 `target-picker` 配置占位组件，配合已有 requiredComponents 用时注入 | 实际需要的编辑器保留；本地源码已没有截图提到的 channel-video，不按旧截图误删正常功能 |

支付、扣次查询操作 ID、提醒授权 outbox 和通知测试编号仍沿用各自的可靠存储机制，没有为了降低同步 API 数量改成可丢弃 UI 缓存。`follow` 页面剩余授权恢复读取也属于该类行为。

`wx.nextTick` 的下一时间片语义已对照 [微信官方 API typings](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)；它不等于真机完成首屏绘制的证明。原始 SDK 初始化工作仍然存在，目标是移出启动同步任务并消除重复读取。

## 归档内容与版本差异

- ZIP SHA-256：`930CB475BCBF7D7A28B755CA6F87FC1304D7FEF16EAEBC91497AE09765BA523F`。
- 共 9 个 Source Map v3 文件：完整 app-service、appservice.app 与 7 个 chunk。主映射包含 38 个 `sourcesContent`，版本文件声明 `1.6.1`。
- 与 `tmp/v2-input/baseline-1.6.1.zip` 中源码归一 CRLF 后比较：36 个文件相同；映射额外包含 `utils/notification-permission.js`；`pages/notification-test/index.js` 不同，映射内容 20,789 个字符、本地备份 11,423 个字符。
- 映射中的通知测试版本包括权限说明、账号隔离和 20 秒调用截止等变化。它没有对应 WXML、完整后端契约或发布证明，因此本次没有直接把映射内容覆盖回工程。
- 使用仓库 Acorn 按 ES2020 解析全部 38 份来源 JS，未发现语法错误。这只能排除这些来源文本的解析失败，不能排除运行时错误或基础库兼容问题。

**该 ZIP 是源码映射，不是真实错误日志。** 未包含可确认的发生时间、机型、基础库版本、异常调用栈或请求结果，因此不能从中定位某一次线上异常。现有运行时诊断继续记录 action、phase、attempt、duration、平台错误码与安全格式的 requestId，不记录业务 payload。已知且完全由基础库栈组成的超时降为 warning；未知或包含业务代码的异常保留 error。

## 验证记录与发布后采样

本专项执行以下 8 个测试文件，**62 项通过**：`startup-performance-v2`、`performance-ux`、`floating-tab-bar`、`startup-timeout-recovery`、`startup-resilience`、`app-entry-recovery`、`api-deadline-recovery`、`ux-overlay-navigation`。新增 8 项行为验证覆盖原生异步路径、迟到缓存读取、storage 回调丢失、顺序写入、目录读取复用及两页启动恢复。全仓回归结果见版本发布记录。

上线前还需在微信开发者工具与 iOS/Android 真机检查：冷启动和四 tab 首次切换、编辑弹层首次加载、键盘关闭恢复导航、弱网/断网重试、朋友圈预览进入正常页面。升级后的首屏时间、长任务、同步 API 计数和 tab 闪烁应使用相同设备与网络样本复测；本地 Node 测试和浏览器预览不能替代这些测量。

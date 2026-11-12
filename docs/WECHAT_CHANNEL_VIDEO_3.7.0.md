# 微信质检的 `channel-video` 告警

维护者提供的质检表中，小哨、历史、我的、攻略四页各报告 1 项 `channel-video`。攻略是普通页面。报告任务号、版本、执行时间、设备、测试基础库和代码包标识尚待补齐。工程指定的基础库为 3.17.3。历史任务 14190 对应 3.4.0，本轮微信侧复测仍待确认。

## 本地复现

微信开发者工具的 WCC 分别编译四个原始 WXML。小哨、历史、我的分别声明 4、3、3 个业务组件，其标签都可在对应编译产物找到。攻略未声明业务组件。四份编译产物均未出现视频号组件，项目也未全局声明该组件。[本次编译与基础库复现记录](../evidence/verification/3.7.0/channel-video-local.json)

在不加载任何项目页面的空白 WebView 中，原版 3.17.3 基础库自行注册了 `channel-video` 和 `wx-channel-video`。同一个基础库的审计回调排除 `wx` 开头的名字，留下无前缀的内置别名。空页产生的唯一一条告警是 `channel-video`，数量为 1。阳性对照仍能检出真正声明但未创建的业务组件。这个复现能说明平台告警的一种来源；当前云测任务实际运行的基础库和上传包仍需通过原报告核对。

| 本机官方基础库 | 空页注册名数 | 空页上报 | 未创建的测试组件 | 已创建的测试组件 |
| --- | ---: | --- | --- | --- |
| 3.17.3 | 155 | `channel-video` × 1 | 检出 | 排除 |
| 3.17.5 | 156 | `channel-video` × 1 | 检出 | 排除 |
| 3.17.6 | 158 | `channel-video` × 1 | 检出 | 排除 |

三版 SDK 的原始审计回调 SHA-256 相同。将工程的开发基础库升到以上两版，空页仍可复现此告警。[跨版本 SDK 摘要与原文件哈希](../evidence/verification/3.7.0/channel-video-sdk-controls.json)

在已安装微信开发者工具、3.17.3 和 Playwright Chromium 的 Mac 上，可从仓库根目录运行以下命令。

```sh
node tools/quality/wechat-component-audit.mjs \
  --wcc /Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc \
  --out output/channel-video-local.json
node --test tests/wechat-component-audit.test.mjs
```

Windows 可传入本机 WCC 路径。若基础库放在自定义位置，增加 `--sdk <3.17.3.wxvpkg 路径>`。

## 提请微信复核时需要的材料

1. 在[微信云测](https://minitest.weixin.qq.com/cloudtest/)打开原任务，保存任务链接、开发版本及上传时间、运行时基础库、机型和四页告警明细。记录该包对应的源码指纹。
2. 在平台反馈入口附上任务链接和上述本地 JSON，指出攻略页没有自定义组件，而空页加载原版 SDK 仍能产生同名告警。请微信核对该任务的版本和审计是否将内置的无前缀别名计入未使用业务组件。
3. 在同一上传包上重新测量四页，保存任务号、设备、基础库和各页结果。微信侧逐页通过后，再按项目流程登记质检结果。此前的本地复现、原生模板编译和服务端功能验证各自单独保留。

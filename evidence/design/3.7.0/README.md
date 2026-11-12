# 3.7.0 四页视觉验收

2026-11-12 的本地候选。会员身份、有效期与名额使用同一张账户卡的底色。有效会员继续使用正式黑金哨标，年卡状态使用小面积金色文字。查询、关注、历史三处商品图统一居左。小哨的日期贴近具体事项，历史的日期和门店位于同一组查询条件。[会员调整前后](member-comparison.png) · [四页微信模拟器实图](four-tabs.png) · [四页深色预览](dark.png)

## 微信开发者工具

在 430 × 752px 浅色模拟器上使用本地合成的商品、库存、历史和年卡数据。隔离项目保留四个入口的原始 WXML、WXSS、品牌图片、主题与原生 tab，使用固定页面数据防止触发真实支付或通知。开发者工具测量到会员身份区域与账户卡均为 `#FFFFFF`。同一份样例实测 18 个控件，宽高均至少 44px。原生编译器另行编译了 12 个模板和 15 个样式文件。[测量结果、指纹和范围](verification.json)

## 离线检查

- 查询、关注、历史和我的四页共 96 组，覆盖 320、375、430px、浅深色和减少动态选项。320px 情景另施加 1.3 倍字号。
- 试用、周卡、月卡、年卡、有效未知档位、过期和普通用户共 70 组。按实际结果测量，所有有效会员卡与账户表面相同，浅色为 `#FFFFFF`，深色为 `#181D1A`。受测身份栏文字最低对比度 5.41∶1。
- 套餐与会员页的原生按钮宽度压力样例覆盖 10 种宽度、12 种场景和浅深两个主题，共 240 组。断言分别检查有效期的确切时刻与剩余天数。
- Impeccable 0.1.18 检测四个 HTML 预览时返回 20 项小字号告警，定位到 4 个模拟说明条和 16 个模拟 tab 标签。微信控件的尺寸由上面的原生测量记录。

### 复核

仓库内的预览工具可以重建主要样例。

```sh
node tools/ui-preview/build.mjs --v350-only --out output/v370-ui/v350
node tools/ui-preview/build.mjs --out output/v370-ui/tabs
node tools/ui-preview/check-v360.mjs output/v370-ui/v350 output/v370-ui/tabs output/v370-ui/four-pages.json
node tools/ui-preview/build.mjs --membership-native-only --out output/v370-ui/member
node tools/ui-preview/check-layout.mjs output/v370-ui/member
node tools/ui-preview/check-layout.mjs output/v370-ui/member --dark
```

视觉数据来自离线样例和开发者工具。云端执行、真机授权与收信、审核、上传及线上发布状态以对应发布记录为准。本轮布局及颜色调整没有新增业务请求或数据迁移。

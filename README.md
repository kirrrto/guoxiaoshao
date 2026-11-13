# 果小哨 · v3.7.0

果小哨是一款微信小程序，用来查询 Apple 直营店的取货情况、关注指定配置和门店，也可以记录个人事项的到期日。查询结果附有实际观测时间，采样中断期间的库存无法追溯。

**当前源码是 v3.7.0 发布候选。** 本版改进了四个主页面、查询超时恢复和扣次处理。11 月 13 日 20:47 开发者工具已上传开发版，后续已清理小程序外围目录与补齐有货复查起点调度；四项微信官方质检及后端容量验收待复测，尚未正式发布。[本版说明与验收记录](docs/RELEASE_3.7.0.md)

## 使用

- 在「查询」选择型号、容量、颜色和门店。免费用户可通过签到与任务获取查询次数，会员可在「小哨」持续关注目标。
- 在「小哨」管理关注与到期事项。到货、断货提醒需分别获得微信授权，每条使用对应的 1 次提醒额度。在「我的」体验微信提醒，每条测试消息消耗 1 次查询次数。
- 「历史」按日期查看取货记录。「我的」可查看会员权益、使用次数与提醒设置。

## 打开工程

微信开发者工具中选择「导入项目」，选中含有 `project.config.json` 的**仓库根目录**。配置内的 `miniprogramRoot` 指向 `miniprogram/`，页面入口是 `miniprogram/app.json`。若提示找不到 `app.json`，核对导入目录和 `project.private.config.json` 的本地覆盖，再关闭并重开工程。

运营端需单独导入 `tools/admin-miniprogram/`，云端会校验管理员身份。[运营端使用说明](tools/admin-miniprogram/README.md)

## 本地检查

本项目 CI 使用 Node.js 24。首次开发时，在仓库根目录安装依赖与测试浏览器。

```sh
npm ci
npm ci --prefix cloudfunctions/gxs_api
npm ci --prefix cloudfunctions/gxs_monitor
npm ci --prefix cloudfunctions/cloudbase_auth
npx --no-install playwright install chromium
```

安装完成后可运行以下检查。

```sh
node tools/build-monitor.mjs --check
npm test
npm run check
node tools/release/check.mjs
```

监控函数的依赖从 `gxs_api` 生成。修改共享实现后运行 `node tools/build-monitor.mjs`。最后一条命令会列出尚未通过的发布条件。GitHub Actions 只执行检查，云端部署与微信发布单独操作。

## 自行部署与许可

自行部署请使用自己的小程序 AppID、云环境、订阅模板和支付配置。服务端密钥存放在云端环境变量中。生产账号、运营权限和线上会员服务由维护者单独授权。

原创代码采用 MIT 许可。商品图和上游数据沿用各自的权利约定，上游数据源的使用授权仍待确认。[MIT 许可证](LICENSE) · [第三方说明](THIRD_PARTY_NOTICES.md)

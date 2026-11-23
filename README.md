# 果小哨 · v3.8.3

果小哨是一款微信小程序，用来查询 Apple 直营店的取货情况、关注指定配置和门店，也可以记录个人事项的到期日。查询结果附有实际观测时间，采样中断期间的库存无法追溯。

**当前源码为 v3.8.3 发布候选。** 月卡、年卡可免扣次查询日本、台湾和香港的门店库存，也可直接关注。在「我的」签到可领 1 次查询，最多攒 10 次。[v3.8.3 发布说明与验收](docs/RELEASE_3.8.3.md)

## 使用

小程序默认跟随微信界面语言，支持简体中文和 English。可在「我的」切换语言，并随时恢复跟随系统。

- 在「查询」选择型号、容量、颜色和门店。免费用户每日签到可领 1 次查询，余额最多攒 10 次。在「小哨」可以关注大陆门店，后台只自动查询仍有有效关注的配置和门店。
- 在「小哨」管理关注与到期事项。到货、断货提醒需分别获得微信授权，每条使用对应的 1 次提醒额度。在「我的」体验微信提醒，每条测试消息消耗 1 次查询次数。
- 在「其他站点」切换日本、台湾、香港，选择当地在售规格和直营店。iPhone、iPad、Mac、AirPods、HomePod 的标准配置可查，Apple Watch 表壳、Vision Pro 验配与 Mac 自选配置可浏览。有效月卡、年卡直接查询且免扣次，三个站点均可用。站点开放公众查询后，七天卡可查新品，免费账户可在当地上市满 30 天后使用签到次数。月卡或年卡可保存关注，微信提醒还需要站点开启监测、发送及对应语言的订阅授权。大陆库存关注在「小哨」管理。
- 在「我的」查看会员权益、使用次数与提醒设置。

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

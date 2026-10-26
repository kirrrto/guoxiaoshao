# 从 GitHub 上传微信版本

入口：[上传微信版本](https://github.com/kirrrto/guoxiaoshao/actions/workflows/wechat-upload.yml)。

## 首次配置

1. 小程序管理员登录微信公众平台，在开发设置中下载 **代码上传密钥**。对应 AppID 为 `wxe96ad9e77b602f1b`。这不是 AppSecret。
2. 打开仓库 Settings → Secrets and variables → Actions，在 Secrets 中新增 `WECHAT_PRIVATE_KEY`，值为下载的私钥文件完整内容。不要把私钥提交到仓库或发在聊天中。
3. 配置上传网络。建议使用 Linux 固定出口 IP 的自托管 GitHub Actions runner，添加自定义标签 `wechat-upload`，将出口 IP 加入微信代码上传白名单。仓库 Variables 中设置 `WECHAT_UPLOAD_RUNNER=wechat-upload`。验证任务仍在 GitHub 托管 runner 运行。
4. 网络配置完成后，设置仓库 Variable `WECHAT_UPLOAD_NETWORK_READY=true`。这个变量只是配置完成标记，实际连通性必须通过微信上传验证。

未设置 WECHAT_UPLOAD_RUNNER 时使用 ubuntu-latest。普通 GitHub 托管 runner 的出口 IP 会变化，不适合直接配置固定 IP 白名单；不能仅设置 NETWORK_READY 就当作网络已接通。不建议为了自动上传关闭白名单。自托管 runner 应专用于受信任的仓库代码，避免运行不受信任的 PR。

## 每次更新

1. 将经过审查的版本代码同步到 master，先完成仓库内版本号和更新说明同步。
2. 打开 Actions → 上传微信版本 → Run workflow，选择 master。
3. 填写与 package.json 完全一致的版本号、1–180 字的上传说明。默认勾选“只检查”，可先运行检查。
4. 正式上传时取消“只检查”。工作流会先安装锁定依赖，检查监测代码、运行测试和源码/发布候选检查，再调用微信官方 miniprogram-ci 上传。
5. 查看运行摘要中的源码提交和上传结果；到微信公众平台将开发版本设为体验版，真机验收后提审，审核通过后发布。

“只检查”成功不表示密钥已经配置或验证通过；查看摘要中的待配置项。只有实际上传步骤成功才证明微信接受了本次开发版本。

本工作流只上传前端开发版本。云函数、数据库规则、采集服务仍须按对应发布文档独立部署和验收。release check 通过也不代表 publicationReady=true，更不代表正式上线。

## 常见失败

- 版本号不一致：先同步源码版本，不要只改上传表单。
- 缺少 WECHAT_PRIVATE_KEY：添加 Actions Secret，保留 PEM 的头尾和换行。
- IP 不在白名单：检查实际运行机器的公网出口和微信后台配置。
- 发布候选检查失败：修复日志中的问题，不跳过现有检查。
- 上传成功但用户看不到新版本：开发版本还需要验收、提审和正式发布。

工具来源：[微信官方 miniprogram-ci](https://github.com/wechat-miniprogram/miniprogram-ci-dist)。上传工具固定为 npm 已发布的 2.1.31；升级应单独验证。项目检查依赖使用仓库 lockfile；上传工具的传递依赖由安装时解析。

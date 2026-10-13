# 持续检查与独立运营项目

## 本地和 CI 使用同一套检查

工作流 `.github/workflows/verify.yml` 在 push、pull request 或手动触发时运行：

1. Node.js 24 环境安装根目录锁定的开发依赖。
2. 三个云函数分别执行 `npm ci`，不运行安装脚本。
3. 校验 `gxs_monitor` 生成产物与源码依赖闭包一致。
4. 运行离线测试、UTF-8/语法/资源检查和发布前检查。

工作流只使用仓库读取权限，不读取云密钥、不部署、不运行商品抓取/目录导入，也不发送微信消息。网络只用于检出代码和安装锁定依赖。仓库已同步到 GitHub，2026-09-28 已核对修复基线 `57185d6` 的 [Actions 运行成功](https://github.com/kirrrto/guoxiaoshao/actions/runs/36367960385)。新提交必须核对自己的运行结果，不能沿用旧提交的成功状态。

采用官方 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)，固定其完整 commit SHA，关闭 checkout 的持久凭证和 setup-node 自动缓存。版本与 SHA 在 2026-09-16 核对。

## 消费者与运营工具隔离

消费者 `app.json` 仅四个业务页面，管理页面及其依赖放在 `tools/admin-miniprogram/` 的独立项目内。发布检查会拒绝将管理页重新塞回消费者包的变更。具体使用方法见 [独立运营工具](../tools/admin-miniprogram/README.md)。

独立项目沿用现有资源方 AppID 和后端权限，不新增身份授权。服务端仍是管理权限的最终判断来源；页面拆分不能替代后端鉴权。

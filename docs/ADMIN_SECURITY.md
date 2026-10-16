# 管理权限与配置审计

本文说明源码约束；实际云端功能只有部署本版本后才会生效。用户会员兑换和支付规则没有因本次加固而改变。

## 权限来源

- 所有身份只读取 `cloud.getWXContext()`。请求体的 `isAdmin`、`isOperator`、`SOURCE`、`userKey` 等声明均不授予权限。
- 小程序管理员必须命中完整的 `appid:openid` 名单 `adminUserKeys`。已删除旧版裸 `adminOpenids` 授权分支，避免跨 AppID 混用身份。
- 可信云端操作来源沿用 `identity.js` 的来源链白名单；它必须没有用户身份且不是跨账号用户调用。有 OPENID 的开发者工具调用仍按普通用户或名单管理员处理。
- 名单管理员可修改业务配置，但 `admin.updateConfig` 不允许其提交 `adminUserKeys`，即使名单内容与当前相同也拒绝，错误码为 `admin_assignment_forbidden`。
- 管理员任命、撤销只允许通过可信云端运维调用 `admin.updateConfig` 完成。将名单清空不会删除可信环境操作者的恢复途径。
- 配置事务开始后再次使用最新名单校验调用者，防止已经撤销的管理员利用先前通过的路由权限检查写入配置。

## 配置版本与旧客户端保护

`admin.getConfig` 从同一次读取返回 `{ config, revision }`；历史配置没有版本字段时返回 `revision: 0`。运营页面保存必须携带读取时的 `expectedRevision`。服务端在配置事务内核验版本，再写入配置和审计；两名管理员基于同一版本提交时仅一方成功，另一方收到 `config_revision_conflict`，不会覆盖其他管理员的更新或把持续补充模式恢复成旧的每日硬上限。

普通小程序名单管理员没有携带 `expectedRevision` 时，返回 `config_revision_required`，要求更新运营小程序并重新加载配置；这条限制同样覆盖尚未升级的运营客户端。传入非安全非负整数返回 `invalid_config_revision`。新版编辑器没有读到版本时禁止保存，版本冲突后保留未保存的编辑文本，提示先重新加载最新配置后合并修改；重新加载前应先复制需要保留的修改。

只有 `identity.js` 根据可信 SDK 上下文认定的无用户云端运维身份（`isOperator`）可以省略版本，兼容已有部分更新脚本；一旦提供版本，同样接受有效性与并发检查。请求体伪造 `isOperator`、`identity` 或 `SOURCE` 不能获得该例外，有 OPENID 的开发者工具调用仍须携带版本。云端脚本也推荐先读取版本再提交，省略版本的可信运维仍应避免发送陈旧的全量配置。

## 同事务审计

每次成功的 `admin.updateConfig` 同时提交两份文档：

1. `gxs_config/runtime`：合并最新配置、`updatedAt`、`updatedBy` 和递增的 `configRevision`。
2. `gxs_config/config_audit_<UUID>`：独立追加的 `kind=runtime_config_audit` 记录。保存时间、SDK 请求 ID、来源、操作者类型与脱敏标识、修订号、本次请求字段、实际变化字段和脱敏前后值。

审计写入失败时，配置变更也回滚。审计 ID 碰撞会被拒绝，不覆盖旧记录。并发事务重新读取当前配置和权限，自动重试不会留下未提交的审计。提交相同配置仍保留一次请求记录，但 `changedKeys` 为空。应用不提供审计记录的修改或删除接口。

操作者与管理员名单保存可关联的 SHA-256 标识及部分掩码，不重复保存完整 OPENID。前后值保留数字、布尔开关和结构；文本及模板 ID 保存哈希和长度，凭据、令牌等敏感键直接标为 `redacted`。这些审计记录用于追踪变化，不能据此还原被脱敏文本。配置文档里的最近修改者 `updatedBy` 仍为完整业务账号键，仅限服务端与有权限的环境运维访问。

## 数据库权限和查看方式

审计复用现有 `gxs_config`，不需要新增集合或索引，遵守既有 `config/database.security-rules.json`：

```json
{ "read": false, "write": false }
```

客户端不得直接读写该集合。管理员接口不返回审计历史；有环境权限的运维人员可在云开发数据库控制台按 `kind=runtime_config_audit` 查看记录，并核对 `revision`、`requestId` 和脱敏操作者标识。不要给整个 `gxs_config` 设置 TTL，也不要为普通客户端开放权限。

应用级审计不能阻止拥有数据库或云环境完整控制权的人员直接改库、删除记录或替换代码。直接在控制台编辑 `runtime` 也绕过本审计，因此日常配置变更应通过 `admin.updateConfig`；紧急直接改库须另留运维记录。环境控制权管理、平台操作日志和备份仍需由环境管理者维护。

## 本地验证

```powershell
node --test tests/admin-security.test.mjs tests/config-revision.test.mjs tests/config-regression.test.mjs tests/config-auth-diagnostics.test.mjs tests/account-ux.test.mjs tests/backend-reliability.test.mjs
```

覆盖客户端伪造权限、名单管理员受限、可信云端任命、撤权竞态、旧客户端缺版本拒绝、两管理员陈旧配置回写、可信运维脚本兼容、配置与审计原子回滚、审计脱敏、并发修订和已有审计不可覆盖。测试不调用生产写接口。

# 第三方依赖与素材说明

本项目原创代码、脚本、测试和文档采用根目录的 [MIT License](LICENSE)。本文件记录第三方依赖和素材的来源；第三方内容沿用各自的许可，不由项目维护者重新授权为 MIT。

## 直接 npm 依赖

- **Acorn 8.18.0**：JavaScript 语法分析工具，根项目开发依赖；采用 MIT。版权声明为 `Copyright (C) 2012-2022 by various contributors (see AUTHORS)`。见 [上游仓库](https://github.com/acornjs/acorn)、[上游许可证](https://github.com/acornjs/acorn/blob/master/acorn/LICENSE) 及安装包中的 `LICENSE`、`AUTHORS`。
- **wx-server-sdk 4.0.2**：三个云函数与可选采集工具使用的微信云开发服务端 SDK；采用 MIT。版权声明为 `Copyright (c) 2018 wechat-miniprogram`。见 [上游仓库](https://github.com/wechat-miniprogram/wx-server-sdk)、[上游许可证](https://github.com/wechat-miniprogram/wx-server-sdk/blob/master/LICENSE) 及安装包中的 `LICENSE`。

版本、下载来源和完整性校验以各目录的 `package-lock.json` 为准。SDK 的间接依赖使用各自许可证；本节列出直接依赖，不是全部依赖的许可审计。复制或分发带 `node_modules` 的构建产物时，应保留相应依赖的许可证和版权声明。

## 商品图片、目录与外部服务

- 产品目录、门店信息及产品图片链接来自 Apple 网站。来源与生成流程见 [产品图片说明](docs/PRODUCT_IMAGES.md) 和 `catalog/` 中的来源字段。
- `miniprogram/config/product-images.js` 及目录数据包含第三方图片 URL。项目代码的 MIT 许可不授予这些图片、第三方原文、标识或其他上游作品的再许可权；其权利仍属于相应权利人。
- 上游网页、图片或接口可访问，不等于已取得使用、再分发或商业采集授权。项目目前尚未确认上游数据源授权；使用边界见 [上游保护说明](docs/UPSTREAM_PROTECTION.md)。
- 微信、CloudBase、支付及订阅消息服务由相应平台提供，使用这些服务须遵守平台规则。开源代码许可不提供平台账号、凭据或果小哨线上服务的使用权。

## 品牌资源与标识

果小哨品牌图形的制作过程见 [品牌说明](docs/BRAND_MINT.md)、[普通版生成记录](docs/brand/logo-generation.md) 和 [会员版生成记录](docs/brand/logo-member-generation.md)。参考照片未作为源码素材收录。

软件许可不表示获得果小哨或第三方的商标授权，也不表示维护者或第三方对衍生项目的官方认可。第三方名称用于说明项目功能、兼容性或来源，不表示合作或背书。

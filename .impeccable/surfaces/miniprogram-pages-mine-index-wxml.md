---
version: 1
slug: "miniprogram-pages-mine-index-wxml"
primary_target: "miniprogram/pages/mine/index.wxml"
related_targets: ["miniprogram/pages/mine/index.wxss"]
---

# Surface: 我的 / 会员

mode: Operate
audience: 已用过查询的微信用户，回来看账户、续费、提醒与次数
job: 一眼读懂当前套餐与名额，必要时开通或延长；管理提醒与次数
must remain: 主绿操作色、系统中文字体、四原生 tab、价格/退款/名额/授权事实可访问、服务端 planId 与实付为准
success: 首屏不再像说明书；会员卡像通行证；字号只有阶梯里的角色

## Direction contract

THESIS: 我的页是账户工作台，不是规则手册。首屏只放身份、权益与下一步；规则进折叠。拒绝「每张卡里再套一段说明文」的网页式堆叠。

OWN-WORLD: 白底页面与浅灰托盘。主绿用于主按钮与就绪态。会员卡沿用果哨标志和深墨通行证，年卡用暖金提示剩余天数。字号只走 `--fs-*` 六级，页面禁止再写独立 clamp。

STORY: 用户先知道自己是谁、有没有会员、名额多少、下一步点哪里；买之前才展开价格与规则。

FIRST VIEWPORT: 顶栏「果小哨 · 我的」→ 账户/通行证卡（标志、状态、有效期或三栏权益、一个主 CTA）→ 需要时才露出套餐列表。微信提醒与次数卡在首屏下方，默认不展开细则。

FORM: 黑金会员通行证（seed:cb7d4dbb2918bc74）。签名动作是通行证材质与极简卡面，不是整页换肤。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

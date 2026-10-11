# 2.0.0 界面验证记录

2026-10-11，以当前小程序源码生成离线预览。主入口为 tmp/ui-preview-v2/index.html，通知测试入口为 tmp/ui-preview-notification-test-v2/index.html。清单保存小程序 JS、JSON、WXML、WXSS 的 SHA-256；布局与导航检查开始、结束均核对源码，构建时刻见各 manifest.json 的 generatedAt。

## 范围与结果

主专项执行真实页面加载、配置选择、查询格式化、购买目标恢复、套餐选择、攻略入口和首次日历展示逻辑，以模拟云函数结果驱动当前 WXML/WXSS。18 种场景形成 33 个页面状态，覆盖查询、小哨、历史、我的、攻略五页，宽度为 320、375、390、430、768、1024px。

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| 主专项构建 | 198 个 HTML，0 表达式错误 | tmp/ui-preview-v2/manifest.json |
| 主专项浅／深色 | 各 198 个，所有错误项为 0 | 主目录 layout-metrics.json、layout-metrics-dark.json |
| 主专项导航 | 720 项，0 失败 | 主目录 floating-tab-metrics.json |
| 通知测试构建 | 21 个 HTML，0 表达式错误 | tmp/ui-preview-notification-test-v2/manifest.json |
| 通知测试浅／深色 | 各 21 个，所有错误项为 0 | 通知目录 layout-metrics.json、layout-metrics-dark.json |

布局错误项包括入口无效链接、表达式、必要文案缺失、不应出现的文案、横向溢出、文本裁切、图片失败、替代配置布局及日历布局。两个入口按实际清单联动页面／场景／宽度，浏览器遍历全部可选组合，并核对全部清单页面均可达。

导航 720 项分为 696 个可见 tab 组合（1×／1.3×字体、0／34px 模拟安全区）、18 个攻略非 tab 页面和 6 个开屏日历隐藏导航场景。细分数量保存于报告 coverage；summary 只记录总数和失败数。

## 业务状态覆盖

- 原有账户／观测状态：免费、会员、未知、过期、会员受限、服务异常、已付费未配置、待发售新品、带目标的购买入口、长文字。独立断言未知／过期／服务异常使用重查动作，受限新品保留权限入口，付费后需主动继续配置。
- 促销：月卡和年卡分别选择，覆盖优惠有效与结束时刻。模拟月卡当前价 14.99 元／标准价 30 元、年卡当前价 129 元／标准价 360 元；到期场景禁止残留两种优惠价及“限时优惠”。当前应付价、时长、优惠截止和购买条款仍可见。
- 攻略：默认选购准备、新品日历展开、通知 FAQ 展开，由页面实际入口与状态生成。日历检查七列排布，预购与发售标记不改变商品查询权限。
- 开屏日历：实际调用查询页 onLoad／onShow／onReady 并等待 maybeOpenCalendar，单独展示首次日历。检查弹窗在视口内、底部 tab 隐藏；普通查询截图保留无弹窗状态。每日一次、永久忽略当前日历版本和关闭后的恢复由对应行为测试验证。
- 通知测试：沿用可发送、无额度、已受理、结果不明、明确失败、确认收到、暂未收到 7 场景，宽度 320／375／430px。status／feedback 返回同一模拟 userKey，通过真实加载和显示方法绑定账户；不执行原生授权或发送。

bootstrap.features 打开主专项界面开关，growthEvents 保持关闭，构建断言不调用事件上报。既有 payment 专项夹具同步新报价与促销契约，历史待确认订单仍使用原订单金额；本轮最终 UI 验收未额外运行该专项，支付行为以项目对应测试记录为准。

## 目视检查与修正

- 320／375px：开屏日历日期和按钮完整可读；月卡／年卡并排、周卡下置，标准价和优惠价不挤压。带目标购买入口保留具体商品与门店，购买条款仍可访问。
- 浅／深色：目视日历弹窗、通知测试已受理页、会员入口及查询下一步；主要操作与正文层次保持可辨。FAQ 展开后答案可完整滚动阅读。
- 1024px：预检发现攻略标题、日期、账户抬头和弹窗按钮受 rpx 放大；实现方增加宽屏字号与间距限制后重新生成截图，手机布局保持原样。
- 渲染器补充小程序元素选择器转换和 checkbox 的浏览器近似，使日历子布局与永久忽略控件能够参与预览；没有引入竞品图片或文章素材。

代表截图位于 tmp/ui-preview-v2/screenshots/（深色在 screenshots-dark/）：

- query-v2-calendar-modal-375-first-screen.png
- query-v2-calendar-modal-320-first-screen.png
- query-v2-calendar-modal-1024-first-screen.png
- guide-v2-guide-calendar-375-first-screen.png
- guide-v2-guide-calendar-1024-first-screen.png
- guide-v2-guide-faq-375.png
- mine-v2-promotion-monthly-375-first-screen.png
- mine-v2-promotion-annual-320-first-screen.png
- mine-v2-promotion-monthly-1024-first-screen.png
- mine-v2-promotion-expired-annual-375-first-screen.png

通知测试代表图：tmp/ui-preview-notification-test-v2/screenshots/notification-test-notification-test-accepted-375.png，深色同名文件在 screenshots-dark/。

## 复现与证据边界

依次执行 build.mjs --v2-only --out tmp/ui-preview-v2、该目录的 check-layout.mjs（浅色及 --dark）、check-floating-tabs.mjs；再执行 build.mjs --notification-test-only --out tmp/ui-preview-notification-test-v2 及该目录的浅／深色布局检查。脚本均位于 tools/ui-preview/，完整命令见该目录 README.md。

主专项普通场景固定时钟为北京时间 2026-10-11 15:00；优惠结束场景为 2026-12-01 00:00。服务端促销结束时刻 2026-11-30T16:00:00.000Z 不含该时刻，界面显示优惠至 11 月 30 日 23:59。通知专项保留模拟时钟 2026-09-15 15:00。每个快照的 previewDate 记录夹具时间，不代表真实业务发生时间。

浏览器将实际模板和样式转换为近似 HTML/CSS，并非微信渲染引擎。账户、库存、服务状态和价格返回值来自夹具，不调用生产云函数。远程商品图片关闭，使用本地占位与资源；“0 图片失败”不代表验证官方图片网络。

截图中的提示条与标题栏由预览器添加；整页截图会把固定导航留在首次视口的位置，弹窗应以首屏截图判断，长页面应结合滚动后的局部截图判断。未验证真实支付、消息送达、原生订阅授权、触摸／键盘、基础库兼容及冷启动性能；这些仍以微信开发者工具和 iOS／Android 真机为准。性能与 source map 证据见 docs/PERFORMANCE_2.0.0.md。

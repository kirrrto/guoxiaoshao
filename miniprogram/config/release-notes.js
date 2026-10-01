// Dates describe the available change records, not an inferred public release date.
// Sources: docs/RELEASE_<version>.md, RELEASE_1.0.1_CLEANUP.md,
// docs/PROGRESS.md and docs/UX_IMPROVEMENTS_0.2.1.md.
// The 1.4.3 upload was confirmed by the maintainer; its exact change list is not available.
// 1.1.8 was renamed to 1.4.0. The v1.3.0 Git tag points to a 1.1.7 package,
// so neither is listed as an independently verified product version.
const RELEASE_NOTES = [
  {
    version: '1.5.0',
    title: '界面更清晰，操作更顺手',
    dateText: '更新记录 · 2026-09-30',
    highlights: [
      '统一展开、收起和设置按钮，让可点击的操作更清楚。',
      '查询结果采用左图右信息，商品与门店状态更紧凑。',
      '简化关注和会员页面，完善保存结果与旧提醒的处理。',
      '新增更新公告入口，随时查看各版本的主要变化。',
    ],
  },
  {
    version: '1.4.3',
    title: '版本记录',
    dateText: '更新记录 · 2026-09-30',
    highlights: [
      '该版本已登记，更新小结暂缺。',
    ],
    note: '详细记录补充后更新。',
  },
  {
    version: '1.4.2',
    title: '会员入口与门店名称优化',
    dateText: '更新记录 · 2026-09-30',
    highlights: [
      '调整兑换码入口位置，让会员开通路径更清晰。',
      '补全武汉、苏州、昆明和长沙的门店商场名称。',
      '门店选择、查询和历史记录使用一致的名称，支持按商场搜索。',
    ],
  },
  {
    version: '1.4.1',
    title: '提醒授权与操作稳定性修复',
    dateText: '更新记录 · 2026-09-28',
    highlights: [
      '到货和断货共用一个增加次数按钮，分别显示授权结果。',
      '修复快速切换配置后的查询和保存问题。',
      '改善后台检测恢复、网络异常提示和提醒反馈体验。',
    ],
  },
  {
    version: '1.4.0',
    title: '增加断货提醒与变化复查',
    dateText: '更新记录 · 2026-09-24',
    highlights: [
      '新增会员断货提醒，到货与断货分别使用对应的提醒次数。',
      '库存变化后加快复查，确认变化后再发送提醒。',
      '在“我的”页显示版本号，方便核对当前版本。',
    ],
  },
  {
    version: '1.1.7',
    title: '深色模式与提醒体验',
    dateText: '更新记录 · 2026-09-24',
    highlights: [
      '支持跟随系统切换深色模式。',
      '新增首次到货提醒免费体验，点击消息可查看提醒详情。',
      '提醒次数支持累加，改善启动加载与断网恢复。',
    ],
  },
  {
    version: '1.1.6',
    title: '7 天会员与支付',
    dateText: '更新记录 · 2026-09-20',
    highlights: [
      '接入 7 元／7 天会员购买与续费，不自动续费。',
      '有效会员续费时顺延剩余天数。',
      '订单确认中退出后，可重新进入继续查询支付结果。',
    ],
  },
  {
    version: '1.1.5',
    title: '微信订阅提醒接入',
    dateText: '更新记录 · 2026-09-20',
    highlights: [
      '接入微信到货订阅提醒的授权与发送流程。',
      '分别展示授权结果和发送服务状态。',
      '授权失效时提供重新授权指引。',
    ],
  },
  {
    version: '1.1.4',
    title: '历史数据与查询退次',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '历史没有记录时说明原因，避免把未采集显示为零次变化。',
      '空历史查询退还次数，重复请求不重复扣次或退次。',
      '最近观测与所选日期的历史分开展示。',
    ],
  },
  {
    version: '1.1.3',
    title: '稳定性与权限修补',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '改善查询失败提示及失败退次。',
      '加强手动查询和后台监测的请求保护。',
      '将管理功能与用户小程序分离。',
    ],
  },
  {
    version: '1.1.2',
    title: '查询摘要与提醒体检',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '新增查询配置摘要，查询成功后自动定位结果。',
      '提醒体检说明未就绪原因，并提供对应处理入口。',
      '最近浏览支持恢复原商品、门店和日期条件。',
    ],
  },
  {
    version: '1.1.1',
    title: '每日任务与快捷关注',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '修复浏览历史任务奖励及余额刷新。',
      '可直接关注当前商品和门店，无需先查询库存。',
      '过期查询结果显示为待更新，旧结果单独标注。',
    ],
  },
  {
    version: '1.1.0',
    title: '玻璃界面与后台监测',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '统一轻玻璃卡片与绿色操作样式。',
      '增加关闭小程序后继续运行的云端监测。',
      '分别展示关注开关、后台检测、消息发送和微信授权状态。',
    ],
  },
  {
    version: '1.0.1',
    title: '会员兑换与状态修正',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '增加兑换码开通会员入口。',
      '区分库存待更新、状态未知与缺少观测。',
      '从用户小程序中移除开发验收入口。',
    ],
  },
  {
    version: '1.0.0',
    title: '首版基础功能',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '支持按型号、容量、颜色和门店查询取货信息。',
      '支持保存关注配置、查看历史记录。',
      '提醒记录支持删除、清空和翻页。',
    ],
  },
  {
    version: '0.2.1',
    title: '早期体验优化',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '调整型号与容量排序，选择配置更方便。',
      '支持城市拼音、首字母与门店名称搜索。',
      '改善首次进入与切换页面的加载体验。',
    ],
  },
  {
    version: '0.2.0',
    title: '早期基础能力',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '建立商品、门店查询与历史记录基础。',
      '支持保存关注配置及会员权益管理。',
      '查询全部失败时退还次数。',
    ],
  },
];

module.exports = { RELEASE_NOTES };

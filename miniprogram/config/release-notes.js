// Dates describe the available change records, not an inferred public release date.
// Sources: docs/RELEASE_<version>.md, RELEASE_1.0.1_CLEANUP.md,
// docs/PROGRESS.md and docs/UX_IMPROVEMENTS_0.2.1.md.
// The 1.4.3 upload was confirmed by the maintainer; its exact change list is not available.
// 1.1.8 was renamed to 1.4.0. The v1.3.0 Git tag points to a 1.1.7 package,
// so neither is listed as an independently verified product version.
// User-facing summaries use 2–3 short highlights, at most 90 characters total.
// Keep technical details and complete acceptance records in release documents.
const RELEASE_NOTES = [
  {
    version: '1.6.1',
    title: '提醒补充与会员权益优化',
    dateText: '更新记录 · 2026-10-08',
    highlights: [
      '提醒次数支持快速连点补充，保留已有次数并恢复待同步记录。',
      '月卡、年卡支持 4 个配置 × 4 家门店，周卡保持 3 × 3。',
      '优化页面排版，更新公告支持翻页。',
    ],
  },
  {
    version: '1.6.0',
    title: '打开恢复与购买、提醒流程修复',
    dateText: '更新记录 · 2026-10-08',
    highlights: [
      '改善连接恢复、查询重试和会员订单确认，减少重复操作。',
      '会员记录与提醒详情更清晰，备选颜色和门店查询更顺手。',
      '统一浅色、深色界面的绿色样式，续费继续顺延会员天数。',
    ],
  },
  {
    version: '1.5.3',
    title: '会员升级、测试通知与备选查询',
    dateText: '更新记录 · 2026-10-05',
    highlights: [
      '新增月卡、年卡及长期套餐升级，剩余天数顺延，不自动续费。',
      '支持测试通知与收件反馈，朋友分享可带入商品和门店。',
      '优化签到、备选查询、历史速览和提醒次数不足提示。',
    ],
  },
  {
    version: '1.5.2',
    title: '提醒权限与使用体验',
    dateText: '更新记录 · 2026-10-02',
    highlights: [
      '持续关注与微信提醒调整为会员专属，免费用户保留次数查询。',
      '完善授权引导、查询恢复和账户状态同步。',
    ],
  },
  {
    version: '1.5.1',
    title: '会员查询与提醒稳定性修复',
    dateText: '更新记录 · 2026-10-01',
    highlights: [
      '修复共享查询额度耗尽后无法恢复的问题。',
      '改善会员生效、网络重试和页面状态同步。',
      '提醒发送前复核库存，完善更新延迟和异常提示。',
    ],
  },
  {
    version: '1.5.0',
    title: '界面更清晰，操作更顺手',
    dateText: '更新记录 · 2026-09-30',
    highlights: [
      '统一操作按钮，查询结果改为左图右信息。',
      '简化关注与会员页面，改善保存和旧提醒处理。',
      '新增更新公告，可查看各版本变化。',
    ],
  },
  {
    version: '1.4.3',
    title: '版本记录',
    dateText: '更新记录 · 2026-09-30',
    highlights: [
      '已登记此版本。',
      '更新小结暂缺。',
    ],
    note: '详细记录补充后更新。',
  },
  {
    version: '1.4.2',
    title: '会员入口与门店名称优化',
    dateText: '更新记录 · 2026-09-30',
    highlights: [
      '调整兑换码入口，会员开通更清晰。',
      '补全武汉、苏州、昆明和长沙的门店名称。',
      '查询、选择与历史统一门店名称，支持商场搜索。',
    ],
  },
  {
    version: '1.4.1',
    title: '提醒授权与操作稳定性修复',
    dateText: '更新记录 · 2026-09-28',
    highlights: [
      '到货、断货共用次数补充按钮，分别显示授权结果。',
      '修复快速切换配置后的查询与保存问题。',
      '改善检测恢复、网络提示和提醒反馈。',
    ],
  },
  {
    version: '1.4.0',
    title: '增加断货提醒与变化复查',
    dateText: '更新记录 · 2026-09-24',
    highlights: [
      '新增会员断货提醒，到货与断货分别使用授权次数。',
      '库存变化后加快复查，确认后再提醒。',
      '“我的”页新增当前版本号。',
    ],
  },
  {
    version: '1.1.7',
    title: '深色模式与提醒体验',
    dateText: '更新记录 · 2026-09-24',
    highlights: [
      '支持跟随系统切换深色模式。',
      '新增首次到货提醒免费体验，消息可打开提醒详情。',
      '提醒次数可累加，改善启动和断网恢复。',
    ],
  },
  {
    version: '1.1.6',
    title: '7 天会员与支付',
    dateText: '更新记录 · 2026-09-20',
    highlights: [
      '新增 7 元／7 天会员购买与续费，不自动续费。',
      '续费顺延剩余天数，未确认订单可重新查询结果。',
    ],
  },
  {
    version: '1.1.5',
    title: '微信订阅提醒接入',
    dateText: '更新记录 · 2026-09-20',
    highlights: [
      '接入微信到货提醒的授权与发送。',
      '分别展示授权结果、发送状态，授权失效时提示重新授权。',
    ],
  },
  {
    version: '1.1.4',
    title: '历史数据与查询退次',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '说明历史无记录的原因，区分未采集与零次变化。',
      '空历史查询退还次数，重复请求不重复扣次或退次。',
      '最近观测与所选日期的历史分开展示。',
    ],
  },
  {
    version: '1.1.3',
    title: '稳定性与权限修补',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '改善查询失败提示与退次。',
      '加强查询、后台监测的请求保护，分离管理功能。',
    ],
  },
  {
    version: '1.1.2',
    title: '查询摘要与提醒体检',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '新增查询配置摘要，查询后自动定位结果。',
      '提醒体检提供未就绪原因及处理入口。',
      '最近浏览可恢复商品、门店与日期。',
    ],
  },
  {
    version: '1.1.1',
    title: '每日任务与快捷关注',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '修复历史任务奖励和余额刷新。',
      '可直接关注商品与门店，无需先查库存。',
      '过期查询标为待更新，并注明旧结果。',
    ],
  },
  {
    version: '1.1.0',
    title: '玻璃界面与后台监测',
    dateText: '更新记录 · 2026-09-16',
    highlights: [
      '统一轻玻璃卡片与绿色操作样式。',
      '增加云端持续监测，离开小程序仍可运行。',
      '分别展示关注、检测、发送与授权状态。',
    ],
  },
  {
    version: '1.0.1',
    title: '会员兑换与状态修正',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '新增兑换码开通会员入口。',
      '区分待更新、未知与缺少观测的库存状态。',
      '移除面向开发验收的入口。',
    ],
  },
  {
    version: '1.0.0',
    title: '首版基础功能',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '支持按型号、容量、颜色和门店查询取货信息。',
      '可保存关注配置、查看历史记录。',
      '提醒记录支持删除、清空和翻页。',
    ],
  },
  {
    version: '0.2.1',
    title: '早期体验优化',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '调整型号和容量排序，改善首次加载与切页体验。',
      '支持城市拼音、首字母及门店名称搜索。',
    ],
  },
  {
    version: '0.2.0',
    title: '早期基础能力',
    dateText: '更新记录 · 2026-09-15',
    highlights: [
      '建立商品、门店查询与历史记录功能。',
      '支持保存关注配置和管理会员权益。',
      '查询全部失败时退还次数。',
    ],
  },
];

module.exports = { RELEASE_NOTES };

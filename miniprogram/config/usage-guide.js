// Original product guidance; external pickup steps checked against Apple China
// shopping help on 2026-10-11. Do not promise stock reservations or delivery.
module.exports = {
  checkedOn: '2026-10-11',
  stages: [
    { id: 'prepare', label: '选购准备', title: '先选好想要的配置', note: '提前确认目标配置与取货门店。', action: 'query', actionText: '去选择配置与门店', steps: [
      { title: '确定型号、颜色与容量', text: '在 Apple 官方渠道核对配置与售价，提前备好 Apple 账户、取货人信息与付款方式。' },
      { title: '选择方便前往的门店', text: '在果小哨选中对应配置与门店；标为「尚未开放取货」的配置需等待接口开放。' },
      { title: '先看一次查询结果', text: '同时看状态与观测时间：「待确认」不等于无货，「可取货」也不代表已锁定库存。' },
    ] },
    { id: 'monitor', label: '开启小哨', title: '让提醒真正准备好', note: '开通会员后，保存关注并完成微信授权。', action: 'follow', actionText: '去检查小哨状态', steps: [
      { title: '保存想关注的配置', text: '在「小哨」启用关注（周卡 3×3、月卡 4×4、年卡 5×5），当前名额可在「我的」查看。' },
      { title: '允许微信提醒', text: '主动点击「补充提醒次数」授权接收；微信提醒授权与查询次数分开计算。' },
      { title: '检查提醒条件', text: '确认关注已开启、会员有效、授权充足且不在免打扰时段；可发测试消息验证（扣 1 次查询额度）。' },
    ] },
    { id: 'notice', label: '收到提醒', title: '照着目标，去官方确认', note: '核对配置 → 找到门店 → 确认取货 → 下单。', action: 'follow', actionText: '去核对关注配置', steps: [
      { title: '先读清楚通知', text: '核对型号、容量、颜色、门店与提醒时间；库存随时可能变化。' },
      { title: '查看官方取货选项', text: '前往 Apple 官方商店选择同一配置与门店，核对可选取货日期与时段。' },
      { title: '以结账页面完成购买', text: '确认商品、取货人与付款金额后提交订单；若已售罄可继续保留关注。' },
    ] },
    { id: 'pickup', label: '完成取货', title: '等到官方取货通知再出发', note: '果小哨到货提醒不等于 Apple 订单取货通知。', action: 'follow', actionText: '去整理关注', steps: [
      { title: '确认订单状态', text: '付款后在 Apple 官方订单中确认结果；果小哨不代下单，也不同步订单状态。' },
      { title: '准备取货信息', text: '收到 Apple 正式取货通知后，携带订单号与有效身份证件前往对应门店。' },
      { title: '买到后整理关注', text: '买到后可暂停或删除关注；删除关注不会影响 Apple 订单或退还会员费。' },
    ] },
  ],
  faqs: [
    { id: 'notification', title: '开通会员，为什么还没收到提醒？', text: '请到「小哨」确认关注已开启、检查最近观测时间与提醒条件，并在提醒记录查看投递状态。没有发现有货、授权不足或处于免打扰时不会发送；微信受理后是否弹窗取决于手机系统设置。' },
    { id: 'continuous', title: '一直有货，为什么没有反复提醒？', text: '确认有货时仅提醒 1 次，同一轮持续有货不重复消耗次数；可在「小哨」查看有货门店与检查时间。' },
    { id: 'refresh', title: '取货信息会自动更新吗？', text: '已开启的关注由后台自动检测并同步到页面，无需手动查询；需要单查时可从门店详情跳至查询页。' },
    { id: 'test', title: '测试通知和真实到货提醒有什么不同？', text: '测试通知标有【测试】，消耗 1 次查询额度且不查库存；正式提醒需有效会员、启用关注与微信授权次数。' },
    { id: 'stock', title: '提示可取货，就一定能买到吗？', text: '观测仅反映标注时间的门店状态，不含剩余件数；能否下单取货请以 Apple 官方结账页为准。' },
    { id: 'release', title: '商品已发售，为什么还不能查？', text: '需对应商品与门店开放官方取货接口并通过核验后才可查询或监测。' },
    { id: 'membership', title: '会员会自动续费吗？到期后怎么办？', text: '按次购买，不自动续费；重复购买有效期顺延，到期后保留配置与剩余提醒次数。' },
    { id: 'history', title: '历史趋势能预测下一次补货吗？', text: '历史仅供回看已记录变化，不预测后续补货时间或数量；请结合采样覆盖摘要判断。' },
  ],
};

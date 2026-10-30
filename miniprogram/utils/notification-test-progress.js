/** A provider acceptance or message-page visit is not a delivery receipt. */
function testProgress(test) {
  const status = test && test.status;
  const authorized = ['authorized', 'sending', 'accepted', 'uncertain', 'failed'].includes(status);
  const received = Boolean(test && test.feedback === 'received');
  const notReceived = Boolean(test && test.feedback === 'not_received');
  const authorizationExpired = test && ['needs_authorization', 'authorization_expired'].includes(test.reason);
  return [
    { id: 'authorize', title: '微信授权', state: authorizationExpired || status === 'needs_authorization' ? 'warn' : authorized ? 'done' : 'pending',
      detail: authorizationExpired ? '需重新授权' : authorized ? '已确认授权' : '等待你允许' },
    { id: 'send', title: '提交微信', state: status === 'accepted' ? 'done' : ['failed', 'uncertain'].includes(status) ? 'warn' : 'pending',
      detail: status === 'accepted' ? '微信已受理' : status === 'failed' ? '发送失败' : status === 'uncertain' ? '结果待确认' : status === 'sending' ? '正在确认' : '尚未发送' },
    { id: 'receive', title: '实际查收', state: received ? 'done' : notReceived ? 'warn' : 'pending',
      detail: received ? '你已确认收到' : notReceived ? '你反馈未收到' : '等待你确认' },
  ];
}

module.exports = { testProgress };

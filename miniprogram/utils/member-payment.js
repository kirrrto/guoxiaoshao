// The server owns prices, signatures and membership fulfilment. This module
// persists only an account-scoped order reference, never login codes/signatures.
const STORAGE_PREFIX = 'gxs_member_payment_v1:';
const ORDER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const POLL_DELAYS = [1500, 3000, 5000];
const INITIAL = { paymentBusy: false, paymentChecking: false, paymentPendingId: '', paymentCanRetry: false, paymentMessage: '', paymentError: '' };
const DEFAULT_PURCHASE_NOTICE = '该产品为一次性虚拟服务，一经售出不予退款。一次购买 7 天，已有会员按剩余有效期顺延，不自动续费。';

function purchaseNotice(product = {}) {
  const note = typeof product.note === 'string' ? product.note.trim() : '';
  return note || DEFAULT_PURCHASE_NOTICE;
}

function knownVersionBelow(value, minimum) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)*$/.test(value)) return false;
  const actual = value.split('.').map(Number), expected = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    if ((actual[i] || 0) !== (expected[i] || 0)) return (actual[i] || 0) < (expected[i] || 0);
  }
  return false;
}

function paymentAvailability(product = {}, wxApi = {}) {
  if (!product.enabled || !product.paymentReady) return { ready: false, reason: '会员付费购买暂未开放，兑换码开通仍可使用。' };
  let info = {};
  try { info = wxApi.getDeviceInfo ? wxApi.getDeviceInfo() : wxApi.getSystemInfoSync ? wxApi.getSystemInfoSync() : {}; } catch (_) { /* Use capability detection below. */ }
  if (info.platform === 'devtools') return { ready: false, reason: '请在手机微信中打开小程序购买会员。' };
  if (info.platform === 'ios' && product.iosEnabled === false) return { ready: false, reason: 'iPhone 购买暂未开放，兑换码开通仍可使用。' };
  let supported = typeof wxApi.requestVirtualPayment === 'function';
  try {
    const base = wxApi.getAppBaseInfo ? wxApi.getAppBaseInfo() : wxApi.getSystemInfoSync ? wxApi.getSystemInfoSync() : info;
    if (info.platform === 'ios') {
      const system = String(info.system || '').match(/^(?:iOS|iPhone OS)\s+(\d+(?:[._]\d+)*)/i);
      if (system && knownVersionBelow(system[1].replace(/_/g, '.'), '15')) return { ready: false, reason: '请将 iPhone 更新到 iOS 15 或更高版本后再购买。' };
      if (knownVersionBelow(base.version, '8.0.68')) return { ready: false, reason: '请将微信更新到 8.0.68 或更高版本后再购买。' };
    }
    const version = String(base.SDKVersion || '').split('.').map(Number);
    const modernSdk = version[0] > 2 || (version[0] === 2 && (version[1] > 19 || (version[1] === 19 && version[2] >= 2)));
    if (!modernSdk && wxApi.canIUse && !wxApi.canIUse('requestVirtualPayment')) supported = false;
  } catch (_) { supported = false; }
  if (!supported) return { ready: false, reason: info.platform === 'ios' ? '当前 iPhone 的微信或系统版本暂不支持购买，请更新后重试。' : '当前微信版本暂不支持购买，请更新微信后重试。' };
  return { ready: true, reason: '' };
}

function paymentErrorText(error) {
  const code = error && error.code;
  if (code === 'payment_not_enabled') return '会员付费购买暂未开放。已有订单仍可查询结果。';
  if (code === 'payment_storage_failed') return '无法保存订单信息，本次未发起支付。请检查手机存储后重试。';
  if (code === 'payment_login_failed') return '微信身份确认未完成，请重试这笔订单。';
  if (code === 'payment_runtime_unsupported') return '当前微信或系统版本暂不支持购买，请更新后重试。';
  if (code === 'unknown_order') return '这笔订单尚未查询到，可以继续查询，或点击继续支付重试同一笔订单。';
  if (code === 'payment_check_pending' || code === 'payment_pending') return '支付正在确认中，请稍后查询，勿重复下单。';
  return '支付结果暂未确认。请查询这笔订单的结果，勿重复下单。';
}

function membershipValid(value) {
  return value && typeof value.active === 'boolean' && Number.isFinite(value.remainingMs) && value.remainingMs >= 0 && (!value.active || value.remainingMs > 0)
    && (Number.isFinite(Date.parse(value.expiresAt)) || (!value.active && value.expiresAt === null));
}

function createPaymentController({ wx: wxApi, call, onUpdate, onResolved, setTimer = setTimeout, clearTimer = clearTimeout, makeId = () => `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` }) {
  let account = '', pendingId = '', generation = 0, pollGeneration = 0, disposed = false, visible = false;
  let busy = false, checking = false, timer = null, product = {}, state = { ...INITIAL };
  const emit = patch => { if (!disposed) { state = { ...state, ...patch }; onUpdate({ ...state }); } };
  const current = version => !disposed && generation === version;
  const key = () => STORAGE_PREFIX + encodeURIComponent(account);
  const stopPolling = () => { pollGeneration++; if (timer !== null) clearTimer(timer); timer = null; checking = false; emit({ paymentChecking: false }); };
  const forget = () => {
    try { wxApi.removeStorageSync(key()); } catch (_) { /* A restored terminal order is safely checked again. */ }
    pendingId = ''; emit({ paymentPendingId: '', paymentCanRetry: false });
  };
  const save = orderId => {
    try {
      wxApi.setStorageSync(key(), { orderId });
      const saved = wxApi.getStorageSync(key());
      if (!saved || saved.orderId !== orderId) throw Error('not_saved');
    } catch (_) { throw { code: 'payment_storage_failed' }; }
    pendingId = orderId; emit({ paymentPendingId: orderId });
  };

  async function check({ automatic = false, attempt = 0 } = {}) {
    if (disposed || !account || !pendingId || checking || busy || (automatic && !visible)) return 'blocked';
    const version = generation, readVersion = pollGeneration, orderId = pendingId;
    checking = true; emit({ paymentChecking: true, paymentError: '', paymentCanRetry: false });
    let outcome = 'pending';
    try {
      const result = await call('member.checkOrder', { orderId });
      if (!current(version) || readVersion !== pollGeneration || orderId !== pendingId) return 'stale';
      const order = result && result.order, membership = result && result.membership;
      if (!order || order.orderId !== orderId) throw { code: 'payment_check_pending' };
      const delivered = ['fulfilled', 'partially_refunded'].includes(order.status) && Number.isFinite(Date.parse(order.fulfilledAt));
      if (delivered && membershipValid(membership)) {
        const activated = membership.active && membership.remainingMs > 0 && Number.isFinite(Date.parse(membership.expiresAt));
        forget();
        emit({ paymentMessage: activated ? order.status === 'partially_refunded' ? '订单已部分退款，会员有效期已按服务端结果更新。' : '支付已确认，会员已开通。' : '这笔订单已处理，当前会员未生效或已到期。', paymentError: '' });
        outcome = 'resolved';
        await onResolved({ order, membership, activated });
      } else if (['refunded', 'cancelled', 'failed'].includes(order.status)) {
        forget();
        emit({ paymentMessage: order.status === 'refunded' ? '这笔订单已退款，会员状态以当前账户为准。' : order.status === 'cancelled' ? '这笔订单已关闭，可重新购买。' : '这笔订单支付失败，可重新购买。', paymentError: '' });
        outcome = 'terminal';
        if (order.status === 'refunded' && membershipValid(membership)) await onResolved({ order, membership, activated: false });
      } else {
        const providerPending = order.paymentPending === true || order.providerStatus === 0 || order.providerStatus === 1;
        outcome = order.status === 'created' && !providerPending ? 'created' : 'pending';
        emit({ paymentCanRetry: outcome === 'created', paymentMessage: outcome === 'created' ? '这笔订单尚未确认支付。可查询结果，或继续支付同一笔订单。' : '支付正在确认中，会员开通结果以服务端确认为准。' });
      }
    } catch (error) {
      if (!current(version) || readVersion !== pollGeneration || orderId !== pendingId) return 'stale';
      outcome = error && error.code === 'unknown_order' ? 'unknown' : 'error';
      emit({ paymentError: paymentErrorText(error), paymentCanRetry: outcome === 'unknown' });
    } finally {
      if (current(version) && readVersion === pollGeneration) { checking = false; emit({ paymentChecking: false }); }
    }
    if (current(version) && readVersion === pollGeneration && pendingId === orderId && automatic && visible && ['pending', 'created'].includes(outcome) && attempt < POLL_DELAYS.length) {
      timer = setTimer(() => { timer = null; check({ automatic: true, attempt: attempt + 1 }); }, POLL_DELAYS[attempt]);
    }
    return outcome;
  }

  async function buy() {
    if (disposed || !account || busy || checking) return;
    const version = generation;
    const availability = paymentAvailability(product, wxApi);
    if (!availability.ready) { emit({ paymentError: availability.reason }); return; }
    stopPolling();
    // A retry always checks the same order first; a paid/unknown-result order
    // must never reopen the cashier or silently become another purchase.
    if (pendingId) {
      const outcome = await check();
      if (!current(version) || !['created', 'unknown'].includes(outcome) || busy || checking) return;
    }
    busy = true; emit({ paymentBusy: true, paymentError: '', paymentCanRetry: false, paymentMessage: '正在准备订单…' });
    let confirmAfter = true;
    try {
      if (!pendingId) {
        const id = makeId();
        if (!ORDER_ID.test(id)) throw { code: 'payment_storage_failed' };
        save(id);
      }
      const orderId = pendingId;
      const login = await new Promise((resolve, reject) => {
        if (typeof wxApi.login !== 'function') { reject({ code: 'payment_login_failed' }); return; }
        wxApi.login({ timeout: 10000, success: value => value && value.code ? resolve(value.code) : reject({ code: 'payment_login_failed' }), fail: () => reject({ code: 'payment_login_failed' }) });
      });
      if (!current(version)) return;
      if (!visible) { emit({ paymentMessage: '操作已暂停，订单号已保留。返回后请先查询订单状态。', paymentCanRetry: false }); return; }
      const result = await call('member.createOrder', { orderId, loginCode: login });
      if (!current(version)) return;
      if (result && result.ok === false && result.reason === 'payment_pending') {
        emit({ paymentMessage: '支付正在确认中，请查询这笔订单的结果，勿重复下单。', paymentError: '', paymentCanRetry: false });
        return;
      }
      if (!result || !result.ok) throw { code: result && result.reason || 'payment_not_enabled' };
      if (!result.order || result.order.orderId !== orderId) throw { code: 'payment_check_pending' };
      if (result.payment === null || result.order.paymentPending === true || result.order.providerStatus === 0 || result.order.providerStatus === 1
        || ['paid', 'fulfilled', 'partially_refunded', 'refunded', 'cancelled', 'failed'].includes(result.order.status)) {
        emit({ paymentMessage: '订单已受理，正在确认会员状态…' }); return;
      }
      if (!visible) { emit({ paymentMessage: '操作已暂停，订单号已保留。返回后请先查询订单状态。', paymentCanRetry: false }); return; }
      const payment = result.payment;
      if (!payment || ['mode', 'signData', 'paySig', 'signature'].some(name => typeof payment[name] !== 'string' || !payment[name])) throw { code: 'payment_check_pending' };
      emit({ paymentMessage: '请在微信支付窗口确认。' });
      await new Promise((resolve, reject) => {
        wxApi.requestVirtualPayment({ mode: payment.mode, signData: payment.signData, paySig: payment.paySig, signature: payment.signature,
          success: resolve, fail: reject });
      });
      if (current(version)) emit({ paymentMessage: '微信已返回支付结果，正在等待服务端确认…' });
    } catch (error) {
      if (!current(version)) return;
      const message = error && error.errMsg || '';
      if (/cancel/i.test(message) || (error && error.errCode === -2)) { confirmAfter = false; emit({ paymentMessage: '已取消本次支付，请查询订单状态。订单号已保留。', paymentError: '', paymentCanRetry: false }); }
      else if (/not support|unsupported|not available|低版本|不支持/i.test(message)) emit({ paymentError: paymentErrorText({ code: 'payment_runtime_unsupported' }), paymentCanRetry: false });
      else emit({ paymentError: paymentErrorText(error), paymentCanRetry: false });
    } finally {
      if (current(version)) {
        busy = false; emit({ paymentBusy: false });
        // Querying is safe after either payment callback. No callback grants
        // membership, and no lifecycle path is allowed to invoke the cashier.
        if (confirmAfter && visible && pendingId && !state.paymentError && !state.paymentCanRetry) await check({ automatic: true });
      }
    }
  }

  return {
    sync(identity, nextProduct) {
      product = nextProduct || {};
      const nextAccount = identity && typeof identity.userKey === 'string' ? identity.userKey : '';
      if (nextAccount === account || disposed) return;
      stopPolling(); generation++; account = nextAccount; busy = false; pendingId = '';
      let stored;
      try { stored = account ? wxApi.getStorageSync(key()) : null; } catch (_) { stored = null; }
      if (stored && ORDER_ID.test(stored.orderId)) pendingId = stored.orderId;
      state = { ...INITIAL };
      emit({ paymentPendingId: pendingId, paymentMessage: pendingId ? '发现一笔待确认订单，可以查询支付结果。' : '' });
    },
    show() { if (disposed) return; visible = true; if (pendingId && !busy && !checking) { stopPolling(); return check({ automatic: true }); } },
    hide() { visible = false; stopPolling(); },
    dispose() { visible = false; stopPolling(); disposed = true; generation++; },
    buy,
    check() { if (disposed || busy || checking) return; stopPolling(); return check({ automatic: true }); },
    getState() { return { ...state }; },
  };
}

module.exports = { paymentAvailability, paymentErrorText, createPaymentController, purchaseNotice, DEFAULT_PURCHASE_NOTICE, STORAGE_PREFIX };

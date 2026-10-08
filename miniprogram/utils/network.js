/**
 * Network reachability shared by the pages. The floating tab bar shows a notice
 * while the phone is offline, and the visible page reloads once it reconnects.
 */
let online = true;
let watching = false;
const listeners = new Set();

function update(next) {
  if (next === online) return;
  const restored = next && !online;
  online = next;
  for (const listener of listeners) {
    try { listener(online, restored); } catch (e) { console.error('[gxs] network listener', e); }
  }
}

function watch() {
  if (watching) return;
  watching = true;
  let receivedChange = false;
  try {
    if (typeof wx.getNetworkType === 'function') wx.getNetworkType({ success: res => {
      // The initial read can finish after a live reconnect/disconnect event.
      // Never let that older snapshot leave the app stuck in the wrong state.
      if (!receivedChange) update(res.networkType !== 'none');
    }, fail() {} });
    if (typeof wx.onNetworkStatusChange === 'function') wx.onNetworkStatusChange(res => {
      receivedChange = true;
      update(Boolean(res && res.isConnected));
    });
  } catch (e) { /* Older clients: treat the network as available. */ }
}

/** listener(online, restored): restored is true only on an offline → online change. */
function subscribeNetwork(listener) {
  watch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isOnline() { return online; }

module.exports = { subscribeNetwork, isOnline };

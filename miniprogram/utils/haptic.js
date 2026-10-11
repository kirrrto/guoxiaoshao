/** A light tap that confirms a completed action; skipped where the phone has no haptics. */
function confirmTap() {
  try {
    if (typeof wx.vibrateShort === 'function') wx.vibrateShort({ type: 'light', fail() {} });
  } catch (e) { /* no haptics */ }
}

module.exports = { confirmTap };

// Native navigation is a bridge-owned surface, without a getTabBar component.
export function nativeTabBar(rt, { deferred = false } = {}) {
  let hidden = false;
  const commands = [], keyboardListeners = new Set();
  for (const [method, value] of [['hideTabBar', true], ['showTabBar', false]]) {
    rt.wx[method] = options => {
      const command = { method, options, finish(ok = true) {
        if (ok) { hidden = value; options.success?.({}); } else options.fail?.({});
        options.complete?.({});
      } };
      commands.push(command);
      if (!deferred) command.finish();
    };
  }
  rt.wx.onKeyboardHeightChange = listener => keyboardListeners.add(listener);
  rt.wx.offKeyboardHeightChange = listener => keyboardListeners.delete(listener);
  return { commands, keyboardListeners, get hidden() { return hidden; },
    keyboard(height) { for (const listener of keyboardListeners) listener({ height }); } };
}

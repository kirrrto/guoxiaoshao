// WeChat exposes its own interface language. Explicit choices belong to this device.
const { readSession, writeSession } = require('./session');
const KEY = 'gxs_ui_language_v1';
const tabs = ['查询', '小哨', '其他站点', '我的'];
const titles = { query: '果小哨 · 门店查询', follow:'果小哨 · 我的小哨', markets:'果小哨 · 其他站点',
  mine:'果小哨 · 我的', history:'果小哨 · 历史记录', guide:'选购与取货攻略', deadlines:'到期提醒',
  'notification-test':'果小哨 · 体验微信提醒', 'notice-board':'公告' };
const listeners = new Set();
let preference = 'system', deviceLanguage, restored, selectionRevision = 0, lastTabs, visiblePage;
let english;

function detectLanguage() {
  let code;
  try { if (typeof wx.getAppBaseInfo === 'function') code = wx.getAppBaseInfo().language; } catch (_) {}
  if (!code) {
    try { if (typeof wx.getSystemInfoSync === 'function') code = wx.getSystemInfoSync().language; } catch (_) {}
  }
  return /^en(?:[-_]|$)/i.test(code || '') ? 'en' : 'zh-CN';
}
function getLanguage() {
  if (preference !== 'system') return preference;
  if (!deviceLanguage) deviceLanguage = detectLanguage();
  return deviceLanguage;
}
function getLanguagePreference() { return preference; }
function dictionary() {
  if (!english) english = require('../i18n/dictionary').english();
  return english;
}
function t(text) {
  return getLanguage() === 'en' ? require('../i18n/translate').text(dictionary(), text) : text;
}
function navigation(page, route) {
  if (page !== visiblePage || typeof wx === 'undefined') return;
  const lang = getLanguage();
  if (lastTabs !== lang && typeof wx.setTabBarItem === 'function') {
    lastTabs = lang;
    tabs.forEach((label,index) => wx.setTabBarItem({ index, text: t(label), fail() { lastTabs = null; } }));
  }
  if (titles[route] && typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title: t(titles[route]) });
}
function notify() { for (const listener of listeners) listener(); }
function refreshDeviceLanguage() {
  const before = getLanguage();
  deviceLanguage = detectLanguage();
  if (before !== getLanguage()) notify();
}
function restore() {
  if (!restored) {
    const revision = selectionRevision;
    restored = readSession(KEY).then(value => {
      if (revision !== selectionRevision || !['en','zh-CN','system'].includes(value)) return;
      if (value !== preference) { preference = value; notify(); }
    });
  }
  return restored;
}
function setLanguage(value) {
  if (!['en','zh-CN','system'].includes(value)) return false;
  selectionRevision++;
  if (value === 'system') deviceLanguage = detectLanguage();
  preference = value;
  notify();
  writeSession(KEY,value);
  return true;
}
function attach(instance, scope, route) {
  if (!instance._applyLanguage) {
    instance._applyLanguage = () => {
      const lang = getLanguage();
      const changed = instance._interfaceLanguage !== lang;
      const patch = {};
      if (changed && scope !== 'markets') {
        if (lang === 'en') patch.ui = require('../i18n/view').attachView(instance, scope, dictionary());
        else if (instance.data.ui) {
          instance._detachLanguageView?.();
          patch.ui = null;
        }
      }
      if ('uiLanguage' in instance.data && instance.data.uiLanguage !== lang) patch.uiLanguage = lang;
      if ('uiLanguagePreference' in instance.data && instance.data.uiLanguagePreference !== preference) patch.uiLanguagePreference = preference;
      instance._interfaceLanguage = lang;
      if (Object.keys(patch).length) instance.setData(patch);
      if (changed && typeof instance.onInterfaceLanguage === 'function') instance.onInterfaceLanguage(lang);
      if (route) navigation(instance,route);
    };
    listeners.add(instance._applyLanguage);
  }
  instance._applyLanguage();
  restore();
}
function detach(instance) {
  instance._detachLanguageView?.();
  listeners.delete(instance._applyLanguage);
  instance._applyLanguage = null;
  instance._interfaceLanguage = null;
  if (visiblePage === instance) visiblePage = null;
}
function page(route, definition) {
  return { ...definition, data: { ...(route === 'markets' ? {} : { ui:null }), ...definition.data },
    onLoad(...args) { attach(this,route,route); return definition.onLoad?.apply(this,args); },
    onShow(...args) { visiblePage = this; attach(this,route,route); return definition.onShow?.apply(this,args); },
    onHide(...args) { if (visiblePage === this) visiblePage = null; return definition.onHide?.apply(this,args); },
    onUnload(...args) { detach(this); return definition.onUnload?.apply(this,args); } };
}
function component(scope, definition) {
  const lifetimes = definition.lifetimes || {};
  const properties = definition.properties || {};
  const keys = Object.keys(properties).filter(key => ['string', 'object'].includes(typeof properties[key].value));
  // Native parent bindings can update object subfields without calling this
  // component's setData. Observe those subfields, not the ui data we publish.
  const observed = keys.map(key => typeof properties[key].value === 'string' ? key : key + '.**').join(', ');
  const observers = { ...definition.observers };
  const original = observers[observed];
  if (keys.length) observers[observed] = function (...args) {
    if (this._updateLanguageProperties) {
      const props = {};
      for (const key of keys) props[key] = this.data[key];
      this._updateLanguageProperties(props);
    }
    original?.apply(this, args);
  };
  return { ...definition, data: { ui:null, ...definition.data },
    observers,
    lifetimes: { ...lifetimes, attached(...args) { attach(this,scope); return lifetimes.attached?.apply(this,args); },
      detached(...args) { detach(this); return lifetimes.detached?.apply(this,args); } } };
}
function modal(options, { localizedContent = false } = {}) {
  if (getLanguage() !== 'en') return wx.showModal(options);
  const translated = { ...options, confirmText: t(options.confirmText || '确定'), cancelText: t(options.cancelText || '取消') };
  if (options.title) translated.title = t(options.title);
  if (options.content && !localizedContent) translated.content = t(options.content);
  // WeChat limits custom modal button labels to four full-width characters.
  const compact = { 'Continue editing':'Edit', 'View membership':'View', 'Keep watch':'Keep', 'Discard changes':'Discard', 'Try again':'Retry' };
  for (const key of ['confirmText','cancelText']) if (translated[key].length > 8) translated[key] = compact[translated[key]] || (key === 'confirmText' ? 'OK' : 'Cancel');
  return wx.showModal(translated);
}
function toast(options) { return wx.showToast({ ...options, title: t(options.title) }); }
module.exports = { getLanguage, getLanguagePreference, setLanguage, refreshDeviceLanguage, restore, page, component, t, modal, toast };

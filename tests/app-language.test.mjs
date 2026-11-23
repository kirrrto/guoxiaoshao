import { registeredPages } from '../tools/lib/mini-packages.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);

test('a fresh install follows WeChat, writes no preference and translates native navigation', async () => {
  const rt=runtime(), tabs=new Map(), titles=[];
  let host='en_GB';
  rt.wx.getAppBaseInfo=()=>({language:host});
  rt.wx.setTabBarItem=({index,text})=>tabs.set(index,text);
  rt.wx.setNavigationBarTitle=({title})=>titles.push(title);
  const lang=rt.load('utils/language.js');
  const page=lang.page('query',{data:{},onShow(){}});
  page.setData=patch=>Object.assign(page.data,patch);
  page.onLoad(); page.onShow(); await lang.restore();
  assert.equal(lang.getLanguagePreference(),'system');
  assert.equal(lang.getLanguage(),'en');
  assert.deepEqual([...tabs.values()],['Search','Watches','Regions','Me']);
  assert.equal(titles.at(-1),'Guoxiaoshao · Store Search');
  assert.equal(rt.storage.has('gxs_ui_language_v1'),false);
  host='zh_Hant';lang.refreshDeviceLanguage();
  assert.equal(lang.getLanguage(),'zh-CN');
  assert.deepEqual([...tabs.values()],['查询','小哨','其他站点','我的']);
  lang.setLanguage('en');host='ja';lang.refreshDeviceLanguage();
  assert.equal(lang.getLanguage(),'en');
  lang.setLanguage('system');
  assert.equal(lang.getLanguage(),'zh-CN');
  assert.equal(rt.calls.length,0);
  page.onUnload();
});

test('a delayed saved preference cannot overwrite a newer selection and an explicit choice survives relaunch', async () => {
  const rt=runtime();let finish;
  rt.wx.getAppBaseInfo=()=>({language:'en-US'});
  rt.wx.getStorage=options=>{finish=options.success;};
  const lang=rt.load('utils/language.js'),pending=lang.restore();
  lang.setLanguage('zh-CN');finish({data:'en'});await pending;
  assert.equal(lang.getLanguage(),'zh-CN');
  const next=runtime();next.wx.getAppBaseInfo=()=>({language:'en-US'});
  next.storage.set('gxs_ui_language_v1',rt.storage.get('gxs_ui_language_v1'));
  const nextLang=next.load('utils/language.js');await nextLang.restore();
  assert.equal(nextLang.getLanguage(),'zh-CN');
  nextLang.setLanguage('system');assert.equal(nextLang.getLanguage(),'en');
});

test('all consumer pages and controls participate in language changes and the renderers stay in sync', () => {
  const root=new URL('../miniprogram/',import.meta.url);
  const app=JSON.parse(fs.readFileSync(new URL('app.json',root)));
  for(const route of registeredPages(app)) {
    const js=fs.readFileSync(new URL(route+'.js',root),'utf8');
    assert.match(js,/utils\/language/);
    if(!route.includes('/markets/')) assert.match(fs.readFileSync(new URL(route+'.wxml',root),'utf8'),/i18n\/render\.wxs/);
  }
  for(const name of fs.readdirSync(new URL('components/',root))) {
    assert.match(fs.readFileSync(new URL('components/'+name+'/index.wxml',root),'utf8'),/i18n\/render\.wxs/);
  }
  assert.equal(fs.readFileSync(new URL('i18n/translate.js',root),'utf8'),fs.readFileSync(new URL('i18n/render.wxs',root),'utf8'));
});

test('English sends scoped dictionaries on every surface, including dynamic SKU, native property, and language updates', () => {
  const rt = runtime();
  const lang = rt.load('utils/language.js');
  const render = rt.load('i18n/translate.js');
  const scopes = rt.load('i18n/en.js')[2];
  lang.setLanguage('en');
  for (const scope of Object.keys(scopes)) {
    // Exercise exactly what a view sends, excluding unrelated page service calls.
    const page = lang.page(scope, { data: {} });
    page.setData = function(patch, callback) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'ui.words') this.data.ui.words = value;
        else this.data[key] = value;
      }
      callback?.call(this);
    };
    page.onLoad();
    assert.ok(Buffer.byteLength(JSON.stringify({ ui: page.data.ui })) < 64 * 1024, scope);
    assert.equal(page.data.ui.words['iPhone 18 Pro Max 1TB 勃艮第酒红色'], undefined);
    let returned = false;
    const privateTitle = '张三自己写的活动 456';
    const label = 'iPhone 18 Pro Max 1TB 勃艮第酒红色';
    page.setData({ rows: [{ label, title: privateTitle }] }, () => { returned = true; });
    assert.equal(returned, true);
    assert.equal(render.t(page.data.ui, label), lang.t(label));
    assert.equal(render.t(page.data.ui, privateTitle), privateTitle);
    assert.equal(Object.hasOwn(page.data.ui.words, privateTitle), false);
    page.setData({ rows: [] });
    assert.equal(page.data.ui.words[label], undefined, 'replaced collections release their SKU entries');
    page.onUnload();
  }
  const comp = rt.instance('components/reminder-authorization/index.js', { subscription: { title: '浅金色' } });
  comp.lifetimes.attached.call(comp);
  assert.equal(render.t(comp.data.ui, '浅金色'), 'Light Gold');
  comp.setData({ 'subscription.title': '桃粉色', 'subscription.second': '浅金色' });
  assert.equal(render.t(comp.data.ui, '桃粉色'), 'Blush');
  assert.equal(render.t(comp.data.ui, '浅金色'), 'Light Gold');
  comp.setData({ 'subscription.second': '' });
  assert.equal(Object.hasOwn(comp.data.ui.words, '浅金色'), false);
  const observed = Object.keys(comp.observers).find(key => key.includes('subscription.**'));
  comp.data.subscription.title = '浅粉色';
  comp.observers[observed].call(comp);
  assert.equal(render.t(comp.data.ui, '浅粉色'), 'Soft Pink');
  assert.equal(Object.hasOwn(comp.data.ui.words, '桃粉色'), false);
  lang.setLanguage('zh-CN');
  assert.equal(comp.data.ui, null);
  lang.setLanguage('en');
  assert.equal(render.t(comp.data.ui, '浅粉色'), 'Soft Pink');
  comp.lifetimes.detached.call(comp);
});

test('WeChat WXS numeric array indices preserve slot values on both sides of the language switch', () => {
  const src = fs.readFileSync(new URL('../miniprogram/i18n/render.wxs', import.meta.url), 'utf8');
  // In native WXS a string key such as "0" does not access an array element.
  // JavaScript converts it implicitly, so reproduce WeChat's operand before JS coerces it.
  const nativeArrayReads = src.replace(/\bargs\[(\w+)\]/g, 'at(args,$1)');
  const render = Function('module','at', nativeArrayReads + ';return module.exports;')({}, (array, index) =>
    typeof index === 'number' ? array[index] : undefined);
  const en = { words: { '剩余 {0} 天': '{0} days left', '编号 {1}，余额 {0}': '{1} has {0} credits' }, patterns: [] };
  assert.equal(render.m(en, '剩余 {0} 天', [167]), '167 days left');
  assert.equal(render.m(en, '编号 {1}，余额 {0}', [0, 'oUSE…0001']), 'oUSE…0001 has 0 credits');
  assert.equal(render.m(null, '编号 {1}，余额 {0}', [0, 'oUSE…0001']), '编号 oUSE…0001，余额 0');
});

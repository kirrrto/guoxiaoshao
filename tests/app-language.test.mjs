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
  for(const route of app.pages) {
    const js=fs.readFileSync(new URL(route+'.js',root),'utf8');
    assert.match(js,/utils\/language/);
    if(!route.includes('/markets/')) assert.match(fs.readFileSync(new URL(route+'.wxml',root),'utf8'),/i18n\/render\.wxs/);
  }
  for(const name of fs.readdirSync(new URL('components/',root))) {
    assert.match(fs.readFileSync(new URL('components/'+name+'/index.wxml',root),'utf8'),/i18n\/render\.wxs/);
  }
  assert.equal(fs.readFileSync(new URL('i18n/translate.js',root),'utf8'),fs.readFileSync(new URL('i18n/render.wxs',root),'utf8'));
  const dictionary=require('../miniprogram/i18n/dictionary').english();
  assert.ok(Buffer.byteLength(JSON.stringify(dictionary))<1024*1024,'one native view update must fit the bridge');
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

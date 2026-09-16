import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

for (const version of ['develop', 'trial', 'release']) {
  test(`${version}: retired sandbox flags cannot bypass cloud initialization or membership API`, async () => {
    const rt = runtime(undefined, { realApi: true }), requests = [];
    rt.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: version } });
    rt.storage.set('gxs_acceptance_v1', { version: 1, enabled: true, mode: 'member', expiresAt: '2099-01-01' });
    rt.load('app.js');
    let connections = 0;
    rt.app.ensureCloud = async () => { connections++; return { callFunction: async ({data}) => {
      requests.push(data);
      return { result: { ok: true, data: { actualAccount: true, membership: { active: false } } } };
    } }; };
    rt.app.onLaunch(); await rt.app.cloudReady;
    assert.equal(connections, 1);
    const api = rt.load('utils/api.js');
    assert.equal((await api.call('user.bootstrap')).membership.active, false);
    assert.equal((await api.call('member.redeemCode', {code:'TEST-CODE'})).actualAccount, true);
    assert.deepEqual(requests.map(r=>r.action), ['user.bootstrap','member.redeemCode']);
    assert.equal(requests[1].payload.code, 'TEST-CODE');
  });
}

test('retired test cache never replaces real-account recovery IDs or saved results', () => {
  const rt = runtime(), operation = rt.load('utils/operation.js');
  const payload = { partNumber: 'SKU-A', storeNumbers: ['R001'] };
  const realId = operation.begin('q', payload);
  rt.storage.set('gxs_acceptance_v1', { version:1, enabled:true, mode:'member' });
  rt.storage.set('acceptance_gxs_pending_q_v1', {id:'wrong-test-id'});
  rt.storage.set('gxs_query_result_v1', {real:true});
  rt.storage.set('acceptance_gxs_query_result_v1', {real:false});
  assert.equal(operation.begin('q',payload),realId);
  const {localKey}=rt.load('utils/local-key.js');
  assert.equal(rt.wx.getStorageSync(localKey('gxs_query_result_v1')).real,true);
  operation.finish('q');
  assert.equal(rt.storage.has('gxs_pending_q_v1'),false);
  assert.equal(rt.storage.get('gxs_query_result_v1').real,true);
});

test('upload directory contains neither the retired page nor a sandbox execution path', () => {
  const mini=new URL('../miniprogram/',import.meta.url);
  const app=JSON.parse(fs.readFileSync(new URL('app.json',mini),'utf8'));
  assert.equal(app.pages.some(p=>p.includes('acceptance')),false);
  assert.equal(fs.existsSync(new URL('utils/acceptance.js',mini)),false);
  for(const ext of ['js','json','wxml','wxss']) assert.equal(fs.existsSync(new URL(`pages/acceptance/index.${ext}`,mini)),false);
  for(const file of fs.readdirSync(mini,{recursive:true}).filter(p=>/\.(js|wxml)$/.test(p))) {
    const source=fs.readFileSync(new URL(file.replaceAll('\\','/'),mini),'utf8');
    assert.doesNotMatch(source,/功能验收|pages\/acceptance|acceptance\.(?:handle|isEnabled|configure)/,file);
  }
  const mine=fs.readFileSync(new URL('pages/mine/index.wxml',mini),'utf8');
  assert.match(mine,/兑换码开通/); assert.match(mine,/付费购买（暂未开放）/);
});

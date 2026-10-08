import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

for (const connected of [true, false]) {
  test(`a delayed initial network read cannot overwrite the latest ${connected ? 'online' : 'offline'} event`, () => {
    const rt = runtime(); let initial, change;
    rt.wx.getNetworkType = options => { initial = options.success; };
    rt.wx.onNetworkStatusChange = callback => { change = callback; };
    const network = rt.load('utils/network.js'), seen = [];
    network.subscribeNetwork((online, restored) => seen.push({ online, restored }));
    change({ isConnected: connected });
    initial({ networkType: connected ? 'none' : 'wifi' });
    assert.equal(network.isOnline(), connected);
    assert.equal(seen.filter(value => value.restored).length, 0, 'an old initial response cannot trigger a false recovery refresh');
    change({ isConnected: !connected });
    assert.equal(network.isOnline(), !connected, 'subsequent live changes still work');
  });
}

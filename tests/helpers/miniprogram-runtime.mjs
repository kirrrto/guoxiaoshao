import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../miniprogram');
const copy = value => JSON.parse(JSON.stringify(value));
export function runtime(handler = async () => ({}), options = {}) {
  const root = path.resolve(options.root || defaultRoot);
  const storage = new Map(), timers = new Map(), cache = new Map(), calls = [], messages = [];
  let nextId = 0, captured, app = { globalData: { bootstrap: null, catalog: null, pendingFollow: null } };
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, copy(value)), removeStorageSync: key => storage.delete(key),
    showToast: value => messages.push(value), showModal: value => messages.push(value), stopPullDownRefresh() {}, switchTab() {}, navigateTo() {},
    requestSubscribeMessage: async ({ tmplIds }) => Object.fromEntries(tmplIds.map(id => [id, 'accept'])),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'consumer' } }) };
  const api = { newId: prefix => `${prefix}-frontend-test-${++nextId}`, toast: value => messages.push(value), showError: value => messages.push(value),
    call: async (action, payload = {}) => { calls.push({ action, payload: copy(payload) }); return handler(action, payload); } };
  const load = rel => {
    const filename = path.resolve(root, rel);
    if (filename === path.join(root, 'utils/api.js') && !options.realApi) return api;
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const sandbox = { module, exports: module.exports, console: { ...console, error: value => messages.push(String(value)) }, Date, Map, Set, Promise, wx, getApp: () => app,
      getCurrentPages: () => options.getCurrentPages ? options.getCurrentPages() : [],
      App: value => { app = value; captured = value; }, Page: value => { captured = value; }, Component: value => { captured = value; },
      setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
      setInterval: () => { throw Error('Use non-overlapping visible polling'); }, clearInterval() {},
      require: id => load(path.relative(root, path.resolve(path.dirname(filename), id.endsWith('.js') ? id : `${id}.js`))) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return module.exports;
  };
  const instance = (rel, properties = {}) => {
    load(rel); const definition = captured;
    const object = { ...definition, ...(definition.methods || {}), data: { ...copy(definition.data || {}), ...properties } };
    object.setData = patch => { for (const [key, value] of Object.entries(patch)) { const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = object.data; for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {}); target[parts.at(-1)] = value; } };
    object.triggerEvent = (name, detail) => { object.lastEvent = { name, detail }; };
    return object;
  };
  return { load, instance, wx, storage, calls, messages, timers, get app() { return app; },
    async nextTimer() { const entry = timers.entries().next().value; if (!entry) return false; timers.delete(entry[0]); await entry[1].fn(); return true; } };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseApplePickup, buildPickupUrl, fetchPickup } = require('../cloudfunctions/gxs_api/lib/apple-pickup.js');

const observedAt = '2026-09-15T01:23:45.000Z';
const target = (storeNumber, partNumber) => ({ storeNumber, partNumber });

function envelope(stores, extra = {}) {
  return JSON.stringify({ head: { status: '200', data: {} }, body: { stores, ...extra } });
}
function store(storeNumber, parts, storeName = `Apple ${storeNumber}`) {
  const partsAvailability = {};
  for (const [partNumber, pickupDisplay, quote, title] of parts) {
    partsAvailability[partNumber] = {
      partNumber,
      pickupDisplay,
      pickupSearchQuote: quote,
      storePickEligible: true,
      messageTypes: { regular: { storePickupQuote: quote, storePickupProductTitle: title } },
    };
  }
  return { storeNumber, storeName, partsAvailability };
}

test('buildPickupUrl mirrors the storefront request shape', () => {
  const url = buildPickupUrl('R577', ['MG714CH/A', 'MJTC4CH/A']);
  assert.equal(url.origin + url.pathname, 'https://www.apple.com.cn/shop/retail/pickup-message');
  assert.equal(url.searchParams.get('pl'), 'true');
  assert.equal(url.searchParams.get('mts.0'), 'regular');
  assert.equal(url.searchParams.get('parts.0'), 'MG714CH/A');
  assert.equal(url.searchParams.get('parts.1'), 'MJTC4CH/A');
  assert.equal(url.searchParams.get('store'), 'R577');
  assert.throws(() => buildPickupUrl('R577', []), TypeError);
  assert.throws(() => buildPickupUrl('', ['MG714CH/A']), TypeError);
});

test('known pickupDisplay values map to distinct statuses including pending', () => {
  const body = envelope([store('R577', [
    ['A1', 'available', '今天可取货', 'iPhone 17 256GB 黑色'],
    ['A2', 'unavailable', '目前无法取货', 'iPhone 18 Pro 512GB 黑色'],
    ['A3', 'ineligible', null, 'iPhone Air'],
    ['A4', 'default', '请于 9 月 22 日查看具体供应状况', 'Mac mini'],
  ])]);
  const targets = ['A1', 'A2', 'A3', 'A4'].map(part => target('R577', part));
  const result = parseApplePickup({ httpStatus: 200, body, targets, observedAt });
  assert.deepEqual(result.map(o => o.status), ['available', 'unavailable', 'ineligible', 'pending']);
  assert.equal(result[3].pickupDisplay, 'default');
  assert.equal(result[3].quote, '请于 9 月 22 日查看具体供应状况');
  assert.equal(result[0].productTitle, 'iPhone 17 256GB 黑色');
  assert.equal(result[0].storeName, 'Apple R577');
  assert.ok(result.every(o => o.reason === null && o.observedAt === observedAt));
});

test('transport and envelope failures never become unavailable', () => {
  const targets = [target('R577', 'A1')];
  const cases = [
    [{ httpStatus: 503, body: '' }, 'http_error'],
    [{ httpStatus: 200, body: '<html>' }, 'invalid_json'],
    [{ httpStatus: 200, body: JSON.stringify({ head: { status: '500' }, body: {} }) }, 'invalid_envelope'],
    [{ httpStatus: 200, body: JSON.stringify({ head: { status: '200' } }) }, 'missing_body'],
    [{ httpStatus: 200, body: JSON.stringify({ head: { status: '200' }, body: { errorMessage: '系统繁忙' } }) }, 'upstream_error'],
    [{ httpStatus: 200, body: JSON.stringify({ head: { status: '200' }, body: {} }) }, 'missing_stores'],
    [{ httpStatus: 200, body: envelope([]) }, 'empty_stores'],
  ];
  for (const [input, code] of cases) {
    const [observation] = parseApplePickup({ ...input, targets, observedAt });
    assert.equal(observation.status, 'unknown', code);
    assert.equal(observation.reason.code, code);
  }
});

test('store and part reconciliation is explicit per target', () => {
  const body = envelope([store('R577', [['A1', 'available', '今天', 't']]), store('R639', [['A1', 'weird', null, 't']])]);
  const result = parseApplePickup({
    httpStatus: 200, body, observedAt,
    targets: [target('R577', 'A1'), target('R577', 'A9'), target('R000', 'A1'), target('R639', 'A1')],
  });
  assert.equal(result[0].status, 'available');
  assert.equal(result[1].reason.code, 'missing_part');
  assert.equal(result[2].reason.code, 'missing_store');
  assert.equal(result[3].reason.code, 'unknown_pickup_display');
  assert.equal(result[3].pickupDisplay, 'weird');
});

test('parseApplePickup rejects implicit capture time or targets', () => {
  assert.throws(() => parseApplePickup({ httpStatus: 200, body: '{}', targets: [target('R577', 'A1')], observedAt: '2026-09-15 09:00' }), TypeError);
  assert.throws(() => parseApplePickup({ httpStatus: 200, body: '{}', targets: [], observedAt }), TypeError);
  assert.throws(() => parseApplePickup({ httpStatus: 200, body: '{}', targets: [{ storeNumber: 'R577' }], observedAt }), TypeError);
});

test('fetchPickup wraps a single bounded request and reports transport errors as unknown', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    assert.ok(url.href.includes('store=R577'));
    return new Response(envelope([store('R577', [['A1', 'unavailable', '暂无', 'x']])]), { status: 200 });
  };
  const clock = [new Date('2026-09-15T00:00:00Z'), new Date('2026-09-15T00:00:01.250Z')];
  const { record, observations } = await fetchPickup({ storeNumber: 'R577', partNumbers: ['A1'], fetchImpl, now: () => clock.shift() });
  assert.equal(calls, 1);
  assert.equal(record.httpStatus, 200);
  assert.equal(record.elapsedMs, 1250);
  assert.equal(observations[0].status, 'unavailable');
  assert.equal(observations[0].observedAt, '2026-09-15T00:00:01.250Z');

  const failing = await fetchPickup({ storeNumber: 'R577', partNumbers: ['A1'], fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(failing.record.error.message, 'ECONNRESET');
  assert.equal(failing.observations[0].status, 'unknown');
  assert.equal(failing.observations[0].reason.code, 'transport_error');
});

'use strict';
/**
 * Apple China retail pickup source adapter.
 *
 * `buildPickupUrl` composes the public storefront request used by the
 * consumer site; `parseApplePickup` turns one response into per-target
 * observations without network access or a clock; `fetchPickup` performs a
 * single bounded GET (no retries, no redirects, no cookies).
 *
 * Observation semantics (validated 2026-09-15, see docs/APPLE_SOURCE_VALIDATION.md):
 *  - only `partsAvailability[SKU].pickupDisplay` decides status;
 *  - `available` / `unavailable` / `ineligible` are kept distinct;
 *  - `default` (seen on not-yet-released products with a "请于 X 月 X 日查看"
 *    quote) becomes `pending`: pickup is not open yet, which is neither an
 *    error nor an out-of-stock result;
 *  - any transport, envelope or reconciliation failure yields `unknown`,
 *    never `unavailable`;
 *  - `observedAt` is the caller's capture time, not an Apple inventory time;
 *  - quotes/titles keep upstream text which may contain HTML: render as text.
 */

const PICKUP_ENDPOINT = 'https://www.apple.com.cn/shop/retail/pickup-message';
const STATUS_BY_DISPLAY = { available: 'available', unavailable: 'unavailable', ineligible: 'ineligible', default: 'pending' };
const MAX_BYTES = 512 * 1024;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonemptyText = value => (typeof value === 'string' && value.trim() ? value : null);

function buildPickupUrl(storeNumber, partNumbers) {
  if (!nonemptyText(storeNumber)) throw new TypeError('storeNumber is required');
  if (!Array.isArray(partNumbers) || partNumbers.length === 0 || partNumbers.some(part => !nonemptyText(part))) {
    throw new TypeError('partNumbers must be a non-empty list of part numbers');
  }
  const url = new URL(PICKUP_ENDPOINT);
  url.searchParams.set('pl', 'true');
  url.searchParams.set('mts.0', 'regular');
  partNumbers.forEach((part, index) => url.searchParams.set(`parts.${index}`, part));
  url.searchParams.set('store', storeNumber);
  return url;
}

function parseApplePickup({ httpStatus, body, targets, observedAt }) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.some(target => !isRecord(target)
    || !nonemptyText(target.storeNumber) || !nonemptyText(target.partNumber))) {
    throw new TypeError('targets must contain explicit storeNumber/partNumber pairs');
  }
  if (typeof observedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt))) {
    throw new TypeError('observedAt must be an explicit capture timestamp with a time zone');
  }
  const captureTime = new Date(observedAt).toISOString();
  const observations = targets.map(({ storeNumber, partNumber }) => ({
    storeNumber,
    storeName: null,
    partNumber,
    status: 'unknown',
    pickupDisplay: null,
    quote: null,
    productTitle: null,
    observedAt: captureTime,
    reason: null,
  }));
  const failAll = (code, message) => observations.map(observation => ({ ...observation, reason: { code, message } }));

  if (httpStatus !== 200) return failAll('http_error', `Expected HTTP 200; received ${String(httpStatus)}`);
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return failAll('invalid_json', 'Response is not valid JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.head) || ![200, '200'].includes(parsed.head.status)) {
    return failAll('invalid_envelope', 'Missing or unsuccessful head.status');
  }
  if (!isRecord(parsed.body)) return failAll('missing_body', 'Response has no body object');
  if (parsed.body.errorMessage !== undefined && parsed.body.errorMessage !== null) {
    if (typeof parsed.body.errorMessage !== 'string') return failAll('invalid_envelope', 'body.errorMessage has an unexpected type');
    if (parsed.body.errorMessage.trim()) return failAll('upstream_error', parsed.body.errorMessage);
  }
  if (!Array.isArray(parsed.body.stores)) return failAll('missing_stores', 'Response has no stores array');
  if (parsed.body.stores.length === 0) return failAll('empty_stores', 'Apple returned no stores; this is not an unavailable result');

  return observations.map(observation => {
    const fail = (code, message) => ({ ...observation, reason: { code, message } });
    const matches = parsed.body.stores.filter(store => isRecord(store) && store.storeNumber === observation.storeNumber);
    if (matches.length !== 1) {
      return fail(matches.length ? 'duplicate_store' : 'missing_store',
        `Expected one result for store ${observation.storeNumber}; received ${matches.length}`);
    }
    const store = matches[0];
    observation.storeName = nonemptyText(store.storeName) ? store.storeName.trim() : null;
    if (!isRecord(store.partsAvailability) || !Object.prototype.hasOwnProperty.call(store.partsAvailability, observation.partNumber)
      || !isRecord(store.partsAvailability[observation.partNumber])) {
      return fail('missing_part', `No product result for ${observation.partNumber}`);
    }
    const part = store.partsAvailability[observation.partNumber];
    const regular = isRecord(part.messageTypes && part.messageTypes.regular) ? part.messageTypes.regular : {};
    observation.pickupDisplay = typeof part.pickupDisplay === 'string' ? part.pickupDisplay : null;
    observation.quote = nonemptyText(part.pickupSearchQuote) || nonemptyText(regular.storePickupQuote);
    observation.productTitle = nonemptyText(regular.storePickupProductTitle);
    if (part.partNumber !== undefined && part.partNumber !== observation.partNumber) {
      return fail('part_mismatch', 'Product partNumber does not match its availability map key');
    }
    if (!Object.prototype.hasOwnProperty.call(STATUS_BY_DISPLAY, observation.pickupDisplay)) {
      return fail('unknown_pickup_display', 'Missing or unrecognized product pickupDisplay');
    }
    observation.status = STATUS_BY_DISPLAY[observation.pickupDisplay];
    return observation;
  });
}

/**
 * One bounded request for a store and its part numbers. Returns
 * { record, observations }. Never throws for upstream failures: they become
 * `unknown` observations with a transport reason.
 */
async function fetchPickup({ storeNumber, partNumbers, fetchImpl = fetch, now = () => new Date(), timeoutMs = 10000 }) {
  const url = buildPickupUrl(storeNumber, partNumbers);
  const started = now();
  const record = {
    storeNumber,
    partNumbers: [...partNumbers],
    requestUrl: url.href,
    startedAt: started.toISOString(),
    httpStatus: null,
    bytes: 0,
    elapsedMs: null,
    finishedAt: null,
    error: null,
    retryAfter: null,
  };
  let bodyText = null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    record.httpStatus = response.status;
    record.retryAfter = response.headers.get('retry-after');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error('response_size_limit');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    record.bytes = body.length;
    bodyText = body.toString('utf8');
  } catch (error) {
    record.error = { name: error.name, message: error.message, code: (error.cause && error.cause.code) || error.code || null };
  }
  const finished = now();
  record.elapsedMs = finished.getTime() - started.getTime();
  record.finishedAt = finished.toISOString();
  const targets = partNumbers.map(partNumber => ({ storeNumber, partNumber }));
  const observations = record.error
    ? parseApplePickup({ httpStatus: 0, body: null, targets, observedAt: record.finishedAt })
      .map(observation => ({ ...observation, reason: { code: 'transport_error', message: record.error.message } }))
    : parseApplePickup({ httpStatus: record.httpStatus, body: bodyText, targets, observedAt: record.finishedAt });
  return { record, observations, bodyText };
}

module.exports = { PICKUP_ENDPOINT, STATUS_BY_DISPLAY, buildPickupUrl, parseApplePickup, fetchPickup };

import { createHash } from 'node:crypto';

const ALLOWED_HOSTS = new Set(['www.apple.com.cn', 'store.storeimages.cdn-apple.com', 'storeimages.cdn-apple.com']);
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * One bounded GET against the public Apple China storefront.
 * No retries, no redirects, no cookies. Returns the raw body plus a
 * capture record suitable for evidence manifests.
 */
export async function boundedGet(url, { accept = 'application/json, text/html;q=0.9, */*;q=0.5', timeoutMs = 20000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    throw new Error(`Refusing to fetch non-Apple URL: ${url}`);
  }
  const started = Date.now();
  const record = {
    requestUrl: target.href,
    method: 'GET',
    startedAt: new Date(started).toISOString(),
    retries: 0,
  };
  let body = Buffer.alloc(0);
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: accept,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error('response_size_limit');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
    record.httpStatus = response.status;
    record.headers = Object.fromEntries(['content-type', 'date', 'cache-control', 'retry-after', 'location']
      .map(key => [key, response.headers.get(key)]).filter(([, value]) => value !== null));
    record.bytes = body.length;
    record.sha256 = createHash('sha256').update(body).digest('hex');
  } catch (error) {
    record.error = { name: error.name, message: error.message, cause: error.cause?.code ?? null };
  }
  record.elapsedMs = Date.now() - started;
  record.finishedAt = new Date().toISOString();
  return { record, body, text: body.toString('utf8') };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

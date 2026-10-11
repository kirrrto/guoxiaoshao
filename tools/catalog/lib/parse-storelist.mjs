const decodeEntities = text => text
  .replace(/<!--.*?-->/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");
const stripTags = html => decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();

/**
 * Parse https://www.apple.com.cn/retail/storelist/ into store records.
 *
 * The page groups stores under province accordions; each store link carries
 * `data-store-number`. Store name, city, address and phone are read from the
 * surrounding `.store-address` block. Non-store retail links (business,
 * geniusbar, ...) never carry a store number and are ignored.
 */
export function parseStoreList(html) {
  const stores = [];
  const provincePattern = /<div class="state">([\s\S]*?)(?=<div class="state">|<\/section>|$)/g;
  let provinceMatch;
  while ((provinceMatch = provincePattern.exec(html)) !== null) {
    const block = provinceMatch[1];
    const labelMatch = block.match(/<span class="label">([^<]*)<\/span>/);
    const province = labelMatch ? stripTags(labelMatch[1]) : null;
    const storePattern = /<div class="store-address"[^>]*>([\s\S]*?)<\/address><\/div><\/div>/g;
    let storeMatch;
    while ((storeMatch = storePattern.exec(block)) !== null) {
      const item = storeMatch[1];
      const link = item.match(/<a[^>]*data-store-number="([^"]+)"[^>]*href="\/retail\/([a-z0-9-]+)\/?"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) continue;
      const cityMatch = item.match(/<span>([\s\S]*?)<a /);
      const addressMatch = item.match(/<address>([\s\S]*?)$/);
      const addressLines = addressMatch ? stripTags(addressMatch[1]).split('\n').map(s => s.trim()).filter(Boolean) : [];
      const phone = addressLines.length && /^[\d\s()+-]+$/.test(addressLines[addressLines.length - 1])
        ? addressLines.pop() : null;
      stores.push({
        storeNumber: link[1].trim(),
        slug: link[2],
        name: stripTags(link[3]),
        city: cityMatch ? stripTags(cityMatch[1]).replace(/[,，]\s*$/, '').trim() : null,
        province,
        address: addressLines.join(' '),
        phone,
        pageUrl: `https://www.apple.com.cn/retail/${link[2]}/`,
      });
    }
  }
  const seen = new Set();
  const unique = stores.filter(store => {
    if (seen.has(store.storeNumber)) return false;
    seen.add(store.storeNumber);
    return true;
  });
  if (unique.length !== stores.length) {
    throw new Error(`Store list contains duplicate store numbers (${stores.length - unique.length})`);
  }
  return unique;
}

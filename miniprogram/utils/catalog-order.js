/** Presentation order is independent of SKU codes and database query order. */
const text = value => String(value || '').trim();
const compareText = (a, b) => text(a).localeCompare(text(b), 'zh-CN', { numeric: true });

// Announcement dates of the currently bundled generations, checked against
// Apple Newsroom on 2026-09-15. They are not shipping dates or image timestamps.
// New catalog releases should supply releaseDate/releaseOrder and override this
// compatibility map, which also fixes catalogs already deployed without dates.
const FAMILY_RELEASES = {
  'iphone-18-pro': ['2026-09-09', 'https://www.apple.com.cn/newsroom/2026/09/apple-debuts-iphone-18-pro-and-iphone-18-pro-max/'],
  'iphone-duo': ['2026-09-09', 'https://www.apple.com.cn/newsroom/2026/09/apple-unveils-iphone-duo/'],
  'iphone-17e': ['2026-03-02', 'https://www.apple.com.cn/newsroom/2026/03/apple-introduces-iphone-17e/'],
  'iphone-air': ['2025-09-09', 'https://www.apple.com/newsroom/2025/09/introducing-iphone-air-a-powerful-new-iphone-with-a-breakthrough-design/'],
  'iphone-17': ['2025-09-09', 'https://www.apple.com/uk/newsroom/2025/09/apple-introduces-iphone-17/'],
  'iphone-16': ['2024-09-09', 'https://www.apple.com/newsroom/2024/09/apple-introduces-iphone-16-and-iphone-16-plus/'],
  'ipad-pro': ['2025-10-15', 'https://www.apple.com/sg/newsroom/2025/10/apple-introduces-the-powerful-new-ipad-pro-with-the-m5-chip/'],
  'ipad-air': ['2026-03-02', 'https://www.apple.com/newsroom/2026/03/apple-introduces-the-new-ipad-air-powered-by-m4/'],
  'ipad': ['2025-03-04', 'https://www.apple.com/newsroom/2025/03/apple-introduces-ipad-air-with-powerful-m3-chip-and-new-magic-keyboard/'],
  'ipad-mini': ['2024-10-15', 'https://www.apple.com/newsroom/2024/10/apple-introduces-powerful-new-ipad-mini-built-for-apple-intelligence/'],
  'macbook-air': ['2026-03-03', 'https://www.apple.com/newsroom/2026/03/apple-introduces-the-new-macbook-air-with-m5/'],
  'macbook-pro': ['2026-03-03', 'https://www.apple.com/newsroom/2026/03/apple-introduces-macbook-pro-with-all-new-m5-pro-and-m5-max/'],
  'macbook-neo': ['2026-03-04', 'https://www.apple.com/newsroom/2026/03/say-hello-to-macbook-neo/'],
  'imac': ['2024-10-28', 'https://www.apple.com/uk/newsroom/2024/10/apple-introduces-new-imac-supercharged-by-m4-and-apple-intelligence/'],
  'mac-mini': ['2026-08-25', 'https://www.apple.com/uk/newsroom/2026/08/apple-unveils-a-more-powerful-mac-mini-featuring-the-all-new-m6-and-m5-pro/'],
  'mac-studio': ['2026-08-25', 'https://www.apple.com/newsroom/2026/08/apple-introduces-new-mac-studio-with-m5-max-and-m5-ultra/'],
  'airpods-pro-3': ['2025-09-09', 'https://www.apple.com/newsroom/2025/09/introducing-airpods-pro-3-the-ultimate-audio-experience/'],
  'airpods-5': ['2026-09-09', 'https://www.apple.com/newsroom/2026/09/apple-introduces-airpods-5-with-best-in-class-open-ear-active-noise-cancellation/'],
  'airpods-max-2': ['2026-03-16', 'https://www.apple.com/newsroom/2026/03/apple-introduces-airpods-max-2-powered-by-h2/'],
  'apple-vision-pro': ['2025-10-15', 'https://www.apple.com/ca/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/'],
  'homepod': ['2023-01-18', 'https://www.apple.com/newsroom/2023/01/apple-introduces-the-new-homepod-with-breakthrough-sound-and-intelligence/'],
  'homepod-mini': ['2020-10-13', 'https://www.apple.com/newsroom/2020/10/apple-introduces-homepod-mini-a-powerful-smart-speaker-with-amazing-sound/'],
};

function capacityBytes(value) {
  const match = text(value).match(/^(\d+(?:\.\d+)?)\s*([KMGT])(?:I?B)(?:\b|\s|存储|固态)/i);
  return match ? Number(match[1]) * Math.pow(1024, 'KMGT'.indexOf(match[2].toUpperCase()) + 1) : null;
}

function compareCapacities(a, b) {
  const left = capacityBytes(a), right = capacityBytes(b);
  if (left !== null && right !== null) return left - right || compareText(a, b);
  if (left !== null || right !== null) return left === null ? 1 : -1;
  return compareText(a, b);
}

// A screen size (e.g. MacBook 16 inch) is not a generation. Only explicit
// generation names are compared; cross-family recency comes from metadata.
function generation(value) {
  const name = text(value).toLowerCase().replace(/[-_]/g, ' ');
  let match = name.match(/\biphone\s+(\d+)(e)?\b/);
  if (match) return { line: 'iphone', number: Number(match[1]) };
  match = name.match(/\b(airpods(?:\s+(?:pro|max))?)\s+(\d+)\b/);
  if (match) return { line: match[1], number: Number(match[2]) };
  match = name.match(/^(.*?)第\s*(\d+)\s*代/);
  return match ? { line: match[1], number: Number(match[2]) } : null;
}

function releaseRank(value) {
  if (Number.isFinite(value.releaseOrder)) return value.releaseOrder;
  const known = FAMILY_RELEASES[value.familyKey];
  const releaseDate = value.releaseDate || (known && known[0]);
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(releaseDate || '')) {
    const date = Date.parse(releaseDate);
    if (Number.isFinite(date)) return date;
  }
  return null;
}

function compareRecency(a, b, leftName, rightName) {
  const left = releaseRank(a), right = releaseRank(b);
  if (left !== null && right !== null && left !== right) return right - left;
  const lg = generation(leftName), rg = generation(rightName);
  if (lg && rg && lg.line === rg.line && lg.number !== rg.number) return rg.number - lg.number;
  return 0;
}

function sortFamilies(families) {
  const ordered = families.map((family, index) => ({ family, index })).sort((a, b) => {
    const ao = Number.isFinite(a.family.catalogOrder) ? a.family.catalogOrder : a.index;
    const bo = Number.isFinite(b.family.catalogOrder) ? b.family.catalogOrder : b.index;
    return ao - bo;
  }).map(entry => entry.family);
  // Reorder comparable entries in their existing slots. Mixing a numeric
  // comparison with an unrelated family fallback in Array.sort is non-transitive.
  const reorder = (indices, compare) => {
    const sorted = indices.map(index => ordered[index]).sort(compare);
    indices.forEach((index, i) => { ordered[index] = sorted[i]; });
  };
  const dated = [];
  ordered.forEach((family, index) => {
    if (releaseRank(family) !== null) dated.push(index);
  });
  reorder(dated, (a, b) => releaseRank(b) - releaseRank(a));
  const lines = {};
  ordered.forEach((family, index) => {
    const value = generation(family.name || family.familyKey);
    if (value) (lines[value.line] || (lines[value.line] = [])).push(index);
  });
  // An incoming numbered generation without its date must still precede its
  // predecessors. When every date is known, the verified chronology wins.
  Object.values(lines).forEach(indices => {
    if (indices.some(index => releaseRank(ordered[index]) === null)) reorder(indices, (a, b) => generation(b.name || b.familyKey).number - generation(a.name || a.familyKey).number);
  });
  return ordered;
}

function sortModels(models, products = []) {
  const meta = name => products.find(p => (p.model || p.familyName || p.familyKey) === name) || {};
  return [...models].sort((a, b) => compareRecency(meta(a), meta(b), a, b) || compareText(a, b));
}

// These aliases cover the mainland Apple retail cities in the bundled catalog.
// Store names remain searchable in Chinese; official slugs are also searchable.
const CITY_ALIASES = {
  '合肥': ['hefei', 'hf'], '北京': ['beijing', 'bj'], '重庆': ['chongqing', 'cq'],
  '福州': ['fuzhou', 'fz'], '厦门': ['xiamen', 'xm'], '广州': ['guangzhou', 'gz'],
  '深圳': ['shenzhen', 'sz'], '南宁': ['nanning', 'nn'], '郑州': ['zhengzhou', 'zz'],
  '武汉': ['wuhan', 'wh'], '长沙': ['changsha', 'cs'], '南京': ['nanjing', 'nj'],
  '苏州': ['suzhou', 'sz'], '无锡': ['wuxi', 'wx'], '大连': ['dalian', 'dl'],
  '沈阳': ['shenyang', 'sy'], '济南': ['jinan', 'jn'], '青岛': ['qingdao', 'qd'],
  '上海': ['shanghai', 'sh'], '成都': ['chengdu', 'cd'], '天津': ['tianjin', 'tj'],
  '昆明': ['kunming', 'km'], '杭州': ['hangzhou', 'hz'], '宁波': ['ningbo', 'nb'],
  '温州': ['wenzhou', 'wz'],
};
const normalizeSearch = value => text(value).toLowerCase().replace(/[\s\u3000·'’-]/g, '');
function storeMatches(store, query) {
  const terms = text(query).toLowerCase().split(/\s+/).map(normalizeSearch).filter(Boolean);
  if (!terms.length) return true;
  const fields = [store.city, store.province, store.name, store.officialName, store.address, store.storeNumber].map(normalizeSearch);
  const aliases = CITY_ALIASES[store.city] || [];
  return terms.every(term => fields.some(field => field.includes(term)) || aliases.some(alias => term.length <= 2 ? alias === term : alias.startsWith(term)) || (term.length > 2 && normalizeSearch(store.slug).includes(term)));
}

module.exports = { capacityBytes, compareCapacities, sortFamilies, sortModels, storeMatches, CITY_ALIASES, FAMILY_RELEASES };

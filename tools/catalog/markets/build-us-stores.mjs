// Fetch the official US Apple Store directory (read-only HTTP GET) and maintain the
// "US" store list in cloudfunctions/gxs_api/lib/market-stores.json.
// Usage: node tools/catalog/markets/build-us-stores.mjs [--check]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const storeFile = path.join(root, 'cloudfunctions/gxs_api/lib/market-stores.json');
const checkOnly = process.argv.includes('--check');

const TAX_FREE_STATES = {
  Oregon: '俄勒冈州（免税州）',
  Delaware: '特拉华州（免税州）',
  'New Hampshire': '新罕布什尔州（免税州）',
  Alaska: '阿拉斯加州（安克雷奇免税）',
};
const TAX_FREE_STATE_EN = {
  Oregon: 'Oregon (Tax-free)',
  Delaware: 'Delaware (Tax-free)',
  'New Hampshire': 'New Hampshire (Tax-free)',
  Alaska: 'Alaska (Tax-free)',
};
const PRIORITY_STATES = [
  'Oregon', 'Delaware', 'New Hampshire', 'Alaska',
  'California', 'New York', 'Washington', 'Massachusetts', 'Texas', 'Florida',
  'Illinois', 'New Jersey', 'Pennsylvania', 'Virginia', 'Georgia',
  'District of Columbia', 'Hawaii', 'Nevada',
];
const STATE_ZH = {
  ...TAX_FREE_STATES,
  Alabama: '亚拉巴马州', Arizona: '亚利桑那州', Arkansas: '阿肯色州', California: '加利福尼亚州',
  Colorado: '科罗拉多州', Connecticut: '康涅狄格州', 'District of Columbia': '华盛顿特区',
  Florida: '佛罗里达州', Georgia: '佐治亚州', Hawaii: '夏威夷州', Idaho: '爱达荷州',
  Illinois: '伊利诺伊州', Indiana: '印第安纳州', Iowa: '艾奥瓦州', Kansas: '堪萨斯州',
  Kentucky: '肯塔基州', Louisiana: '路易斯安那州', Maine: '缅因州', Maryland: '马里兰州',
  Massachusetts: '马萨诸塞州', Michigan: '密歇根州', Minnesota: '明尼苏达州', Mississippi: '密西西比州',
  Missouri: '密苏里州', Nebraska: '内布拉斯加州', Nevada: '内华达州', 'New Jersey': '新泽西州',
  'New Mexico': '新墨西哥州', 'New York': '纽约州', 'North Carolina': '北卡罗来纳州',
  Ohio: '俄亥俄州', Oklahoma: '俄克拉荷马州', Pennsylvania: '宾夕法尼亚州', 'Rhode Island': '罗得岛州',
  'South Carolina': '南卡罗来纳州', Tennessee: '田纳西州', Texas: '得克萨斯州',
  Utah: '犹他州', Virginia: '弗吉尼亚州', Washington: '华盛顿州', Wisconsin: '威斯康星州',
};
const CITY_ZH = {
  Portland: '波特兰', Tigard: '蒂加德（波特兰都会区）', Newark: '纽瓦克（特拉华）',
  Nashua: '纳舒厄', Salem: '塞勒姆（新罕布什尔）', Manchester: '曼彻斯特', Anchorage: '安克雷奇',
  'New York': '纽约', Brooklyn: '纽约 · 布鲁克林', Bronx: '纽约 · 布朗克斯', 'Staten Island': '纽约 · 斯泰滕岛',
  'Los Angeles': '洛杉矶', 'Beverly Hills': '比佛利山', 'Santa Monica': '圣莫尼卡', Glendale: '格伦代尔',
  Pasadena: '帕萨迪纳', 'San Francisco': '旧金山', Cupertino: '库比蒂诺', 'Palo Alto': '帕洛阿尔托',
  'San Jose': '圣何塞', 'Santa Clara': '圣克拉拉', Irvine: '尔湾', 'Costa Mesa': '科斯塔梅萨',
  'San Diego': '圣地亚哥', Seattle: '西雅图', Bellevue: '贝尔维尤（西雅图）', Tacoma: '塔科马',
  Boston: '波士顿', Cambridge: '剑桥（波士顿）', Chicago: '芝加哥', Washington: '华盛顿哥伦比亚特区',
  Honolulu: '檀香山', Miami: '迈阿密', 'Miami Beach': '迈阿密海滩', Orlando: '奥兰多', Tampa: '坦帕',
  Atlanta: '亚特兰大', Austin: '奥斯汀', Dallas: '达拉斯', Houston: '休斯敦', 'San Antonio': '圣安东尼奥',
  'Las Vegas': '拉斯维加斯', Phoenix: '凤凰城', Scottsdale: '斯科茨代尔', Denver: '丹佛',
  Philadelphia: '费城', Pittsburgh: '匹兹堡', Minneapolis: '明尼阿波利斯', Detroit: '底特律',
  Charlotte: '夏洛特', Raleigh: '罗利', Nashville: '纳什维尔', 'New Orleans': '新奥尔良',
  'Salt Lake City': '盐湖城', Columbus: '哥伦布', Cleveland: '克利夫兰', Cincinnati: '辛辛那提',
  Baltimore: '巴尔的摩', 'Kansas City': '堪萨斯城', 'Saint Louis': '圣路易斯', Milwaukee: '密尔沃基',
  Indianapolis: '印第安纳波利斯', 'San Mateo': '圣马特奥', Burlingame: '伯林盖姆',
};
const STATE_TIMEZONES = {
  Hawaii: 'Pacific/Honolulu',
  Alaska: 'America/Anchorage',
  Arizona: 'America/Phoenix',
  California: 'America/Los_Angeles', Nevada: 'America/Los_Angeles', Oregon: 'America/Los_Angeles', Washington: 'America/Los_Angeles',
  Colorado: 'America/Denver', Idaho: 'America/Denver', 'New Mexico': 'America/Denver', Utah: 'America/Denver',
  Alabama: 'America/Chicago', Arkansas: 'America/Chicago', Illinois: 'America/Chicago', Iowa: 'America/Chicago',
  Kansas: 'America/Chicago', Louisiana: 'America/Chicago', Minnesota: 'America/Chicago', Mississippi: 'America/Chicago',
  Missouri: 'America/Chicago', Nebraska: 'America/Chicago', Oklahoma: 'America/Chicago', Tennessee: 'America/Chicago',
  Texas: 'America/Chicago', Wisconsin: 'America/Chicago',
  Connecticut: 'America/New_York', Delaware: 'America/New_York', 'District of Columbia': 'America/New_York',
  Florida: 'America/New_York', Georgia: 'America/New_York', Indiana: 'America/New_York', Kentucky: 'America/New_York',
  Maine: 'America/New_York', Maryland: 'America/New_York', Massachusetts: 'America/New_York', Michigan: 'America/New_York',
  'New Hampshire': 'America/New_York', 'New Jersey': 'America/New_York', 'New York': 'America/New_York',
  'North Carolina': 'America/New_York', Ohio: 'America/New_York', Pennsylvania: 'America/New_York',
  'Rhode Island': 'America/New_York', 'South Carolina': 'America/New_York', Virginia: 'America/New_York',
};
// Texas (El Paso R492 -> Mountain) and Tennessee (Knoxville R203 -> Eastern) sit across state timezone borders.
const STORE_TIMEZONE_OVERRIDES = { R492: 'America/Denver', R203: 'America/New_York' };

const FLAGSHIP_STORE_META = {
  R077: { name: '先锋广场 Pioneer Place', shortName: '波特兰先锋广场' },
  R090: { name: '华盛顿广场 Washington Sq', shortName: '波特兰华盛顿广场' },
  R102: { name: 'Christiana Mall（免税）', shortName: '特拉华 Christiana' },
  R354: { name: 'Pheasant Lane', shortName: '新罕布什尔 Pheasant' },
  R027: { name: 'Rockingham Park', shortName: '新罕布什尔 Rockingham' },
  R631: { name: 'The Mall of New Hampshire', shortName: '新罕布什尔 Mall', shortNameEn: 'Mall of NH' },
  R262: { name: '安克雷奇第五大道', shortName: '安克雷奇第五大道', shortNameEn: 'Anchorage 5th Ave' },
  R095: { name: '第五大道 Fifth Avenue', shortName: '纽约第五大道' },
  R415: { name: '中央车站 Grand Central', shortName: '纽约中央车站' },
  R654: { name: '世贸中心 World Trade Ctr', shortName: '纽约世贸中心' },
  R250: { name: '西 14 街 West 14th St', shortName: '纽约西 14 街' },
  R251: { name: '上西区 Upper West Side', shortName: '纽约上西区' },
  R582: { name: '上东区 Upper East Side', shortName: '纽约上东区' },
  R594: { name: '威廉斯堡 Williamsburg', shortName: '布鲁克林威廉斯堡' },
  R715: { name: '布鲁克林市中心', shortName: '布鲁克林市中心', shortNameEn: 'Downtown Brooklyn' },
  R824: { name: 'Apple Park 访客中心', shortName: 'Apple Park', shortNameEn: 'Apple Park' },
  R075: { name: '联合广场 Union Square', shortName: '旧金山联合广场' },
  R050: { name: 'The Grove（洛杉矶）', shortName: '洛杉矶 The Grove' },
  R720: { name: '塔楼剧院 Tower Theatre', shortName: '洛杉矶塔楼剧院' },
  R124: { name: '比佛利中心 Beverly Center', shortName: '比佛利中心' },
  R051: { name: '圣莫尼卡第三街长廊', shortName: '圣莫尼卡第三街', shortNameEn: '3rd St Promenade' },
  R004: { name: '南海岸广场 South Coast', shortName: '南海岸广场' },
  R146: { name: '尔湾光谱中心 Spectrum', shortName: '尔湾光谱中心', shortNameEn: 'Irvine Spectrum' },
  R099: { name: '斯坦福购物中心 Stanford', shortName: '斯坦福购物中心', shortNameEn: 'Stanford Shopping' },
  R003: { name: '贝尔维尤广场 Bellevue Sq', shortName: '贝尔维尤广场' },
  R072: { name: '大学村 University Village', shortName: '西雅图大学村' },
  R149: { name: '博伊尔斯顿街 Boylston St', shortName: '波士顿 Boylston' },
  R035: { name: '密歇根大道 Michigan Ave', shortName: '芝加哥密歇根大道' },
  R516: { name: '卡内基图书馆 Carnegie', shortName: '华盛顿卡内基馆' },
  R073: { name: '阿拉莫阿那 Ala Moana', shortName: '檀香山 Ala Moana' },
};

const SHORT_EN_OVERRIDES = {
  R026: 'Chandler Fashion',
  R031: 'Scottsdale Fashion',
  R286: 'Promenade at Chenal',
  R451: 'Americana at Brand',
  R338: 'Briargate Shops',
  R111: 'St. Johns Town Ctr',
  R615: 'University Town Ctr',
  R066: 'Fashion Mall Keystn',
  R235: 'Lakeside Shopping',
  R622: 'Blackstone Valley',
  R616: 'Eastwood Towne Ctr',
  R324: 'Colony Park',
  R138: 'Freehold Raceway',
  R753: 'Mall at Bay Plaza',
  R417: 'Polaris Fashion',
  R316: 'Univ Park Village',
  R151: 'Southlake Town Sq',
  R078: 'Short Pump Town Ctr',
  R598: 'Stonebridge Potomac',
};

const PRIORITY_STORES = {
  Oregon: ['R077', 'R090', 'R134'],
  California: ['R824', 'R075', 'R050', 'R720', 'R004', 'R146', 'R099'],
  'New York': ['R095', 'R415', 'R654', 'R032', 'R250', 'R251', 'R582'],
  Washington: ['R003', 'R072'],
  Hawaii: ['R073', 'R210'],
};

const decodeEntities = text => String(text || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/\s+/g, ' ').trim();

function makeShortEn(storeNumber, nameEn) {
  if (SHORT_EN_OVERRIDES[storeNumber]) return SHORT_EN_OVERRIDES[storeNumber];
  if (FLAGSHIP_STORE_META[storeNumber]?.shortNameEn) return FLAGSHIP_STORE_META[storeNumber].shortNameEn;
  if (Array.from(nameEn).length <= 20) return undefined;
  throw Error(`Missing shortNameEn <= 20 chars for ${storeNumber}: ${nameEn}`);
}

function validateUsStores(us) {
  assert.ok(Array.isArray(us) && us.length >= 265, `Expected >= 265 US stores, got ${us?.length}`);
  const seenNumbers = new Set();
  const seenStates = [];
  const zhNotices = new Set();
  const enNotices = new Set();
  const fits = value => value && Array.from(value).length <= 20;
  for (const store of us) {
    assert.match(store.storeNumber, /^R\d{3}$/);
    assert.equal(seenNumbers.has(store.storeNumber), false, `Duplicate US storeNumber: ${store.storeNumber}`);
    seenNumbers.add(store.storeNumber);
    assert.ok(store.state && store.stateEn && store.city && store.cityEn && store.name && store.nameEn, store.storeNumber);
    assert.ok(store.timeZone && /^(?:America|Pacific)\//.test(store.timeZone), store.storeNumber + ' missing timeZone');
    if (seenStates.at(-1) !== store.stateEn) {
      assert.equal(seenStates.includes(store.stateEn), false, `Non-contiguous state block: ${store.stateEn}`);
      seenStates.push(store.stateEn);
    }
    const shortEn = store.shortNameEn || store.nameEn;
    assert.ok(fits(shortEn), `${store.storeNumber} shortNameEn exceeds 20 chars: ${shortEn}`);
    const enNotice = [`US · ${store.nameEn}`, `US · ${shortEn}`, store.nameEn, shortEn].find(fits);
    assert.ok(enNotice, `Cannot fit EN notice for ${store.storeNumber}`);
    assert.equal(enNotices.has(enNotice), false, `Duplicate EN notice: ${enNotice}`);
    enNotices.add(enNotice);

    const shortZh = store.shortName || store.shortNameEn || store.name;
    const zhNotice = [`美国 · ${store.name}`, `美国 · ${shortZh}`, store.name, shortZh].find(fits);
    assert.ok(zhNotice, `Cannot fit ZH notice for ${store.storeNumber}: ${store.name}`);
    assert.equal(zhNotices.has(zhNotice), false, `Duplicate ZH notice: ${zhNotice}`);
    zhNotices.add(zhNotice);
  }
  assert.deepEqual(seenStates.slice(0, 4), ['Oregon (Tax-free)', 'Delaware (Tax-free)', 'New Hampshire (Tax-free)', 'Alaska (Tax-free)']);
  assert.equal(seenStates.length, 45);
  assert.ok(seenStates.includes('District of Columbia'));
  return { regions: seenStates.length, states: seenStates.length - 1 };
}

const current = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
if (checkOnly) {
  const coverage = validateUsStores(current.US);
  console.log(JSON.stringify({ checked: true, usStores: current.US.length, ...coverage, timeZones: [...new Set(current.US.map(s => s.timeZone))].sort() }));
  process.exit(0);
}

const response = await fetch('https://www.apple.com/retail/storelist/', {
  headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  signal: AbortSignal.timeout(20000),
});
if (response.status !== 200) throw Error(`Apple storelist HTTP ${response.status}`);
const html = await response.text();
const stateRe = /<button[^>]*id="accordion-button-[^"]+"[^>]*><span class="label">([^<]+)<\/span>[\s\S]*?<div[^>]*class="[^"]*stores-list-en_US[^"]*"[^>]*>([\s\S]*?)<\/div><\/div><\/div>/g;

const parsedByState = new Map();
for (const match of html.matchAll(stateRe)) {
  const rawState = decodeEntities(match[1]);
  const stores = [];
  for (const entry of match[2].matchAll(/<div class="store-address hcard_US"[\s\S]*?<span>([^<]+)<!-- -->,<!-- --> <a[^>]*data-store-number="(R\d{3})"[^>]*>([^<]+)<\/a>/g)) {
    stores.push({ storeNumber: entry[2], cityEn: decodeEntities(entry[1]), nameEn: decodeEntities(entry[3]), rawState });
  }
  if (stores.length) parsedByState.set(rawState, stores);
}

const orderedStates = [
  ...PRIORITY_STATES.filter(name => parsedByState.has(name)),
  ...[...parsedByState.keys()].filter(name => !PRIORITY_STATES.includes(name)).sort(),
];

const usStores = [];
for (const rawState of orderedStates) {
  const state = STATE_ZH[rawState];
  if (!state) throw Error('Missing Chinese state mapping: ' + rawState);
  const stateEn = TAX_FREE_STATE_EN[rawState] || rawState;
  const preferred = PRIORITY_STORES[rawState] || [];
  const sorted = [...parsedByState.get(rawState)].sort((a, b) => {
    const ai = preferred.indexOf(a.storeNumber), bi = preferred.indexOf(b.storeNumber);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.cityEn.localeCompare(b.cityEn) || a.nameEn.localeCompare(b.nameEn);
  });
  for (const item of sorted) {
    const timeZone = STORE_TIMEZONE_OVERRIDES[item.storeNumber] || STATE_TIMEZONES[rawState];
    if (!timeZone) throw Error('Missing timezone for ' + rawState + ' ' + item.storeNumber);
    const flagship = FLAGSHIP_STORE_META[item.storeNumber];
    const name = flagship?.name || item.nameEn;
    const city = CITY_ZH[item.cityEn] || item.cityEn;
    const shortNameEn = makeShortEn(item.storeNumber, item.nameEn);
    const shortName = flagship?.shortName;
    usStores.push({
      storeNumber: item.storeNumber,
      state,
      stateEn,
      city,
      cityEn: item.cityEn,
      name,
      nameEn: item.nameEn,
      ...(shortName ? { shortName } : {}),
      ...(shortNameEn ? { shortNameEn } : {}),
      timeZone,
    });
  }
}

const coverage = validateUsStores(usStores);
fs.writeFileSync(storeFile, JSON.stringify({ ...current, US: usStores }, null, 2) + '\n');
console.log(JSON.stringify({ updated: true, usStores: usStores.length, ...coverage }));

// Convert a regional storefront’s packaged-product selectors and linked Mac
// configurations into the regional directory. Input is cached official HTML.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractProductSelectionData, extractMetricsProducts } from '../lib/parse-buy-page.mjs';
const require = createRequire(import.meta.url);
const mainland = require('../../../catalog/products.json').products;
const families = require('../families.json').families;
const labels = require('../../i18n/source/catalog');
const [code, root, mode] = process.argv.slice(2);
if (!['JP','HK'].includes(code) || !root || (mode && mode !== '--check')) throw Error('Usage: node tools/catalog/markets/extract-regional.mjs JP|HK <cached buy pages> [--check]');
const region = code.toLowerCase();
const read = filename => fs.readFileSync(path.join(root,filename),'utf8');
const news = 'https://www.apple.com/' + (code === 'HK' ? 'hk/en' : 'jp') + '/newsroom/';
const spring = '2026/03/macbook-neo-iphone-17e-ipad-air-with-m4-and-more-are-now-available/';
const autumn = '2026/09/get-ready-to-experience-iphone-18-pro-the-new-apple-watch-lineup-and-airpods-5/';
const iphone17 = '2025/09/get-ready-to-discover-the-next-generation-of-iphone-apple-watch-and-airpods/';
const m5 = '2025/10/new-ipad-pro-14-inch-macbook-pro-and-apple-vision-pro-now-available/';
const dates = [
  ['2026-03-11',spring,'iphone-17e ipad-air macbook-air macbook-neo macbook-pro studio-display studio-display-xdr'],
  ['2026-09-18',autumn,'iphone-18-pro airpods-5 apple-watch apple-watch-ultra apple-watch-hermes apple-watch-hermes-ultra'],
  ['2026-09-22','2026/09/the-new-mac-mini-and-mac-studio-are-available-today/','mac-mini mac-studio'],
  ['2026-10-23','2026/09/apple-unveils-iphone-duo/','iphone-duo'],
  ['2025-09-19',iphone17,'iphone-air iphone-17 apple-watch-se airpods-pro-3'],
  ['2024-09-20','2024/09/the-iphone-16-lineup-airpods-4-apple-watch-series-10-arrive-around-the-world/','iphone-16'],
  ['2025-10-22',m5,'ipad-pro apple-vision-pro'],
  ['2026-11-06','2026/10/apple-gives-ipad-mini-its-biggest-update-ever/','ipad-mini'],
  ['2025-03-12','2025/03/apple-introduces-ipad-air-with-powerful-m3-chip-and-new-magic-keyboard/','ipad'],
  ['2026-11-06','2026/10/apple-unveils-groundbreaking-macbook-pro-with-proled-xdr-display/','macbook-pro-proled-xdr'],
  ['2026-11-06','2026/10/apple-unveils-new-imac-with-m6/','imac'],
  ['2023-02-03','2023/01/apple-introduces-the-new-homepod-with-breakthrough-sound-and-intelligence/','homepod'],
  ['2026-10-30','2026/10/apple-announces-the-next-generation-of-homepod-mini/','homepod-mini-2'],
];
const normalize = value => String(value || '').replace(/\s+/g,' ').trim();
function english(text) {
  const normalized = normalize(text);
  if (!/[\u3400-\u9fff]/.test(normalized)) return normalized;
  if (!labels[normalized]) throw Error('Missing English label: '+normalized);
  return labels[normalized];
}
function catalogRow(product, partNumber) {
  const title = normalize(product.title);
  const titleEn = english(title);
  const color = product.attributes.color;
  const model = normalize(product.model).replace(/(\d+) 英寸/g,'$1″').replace('PROLED XDR 显示屏','PROLED XDR');
  const result = { partNumber, model, title, titleEn, artworkPart:product.partNumber };
  if (color) Object.assign(result,{color, colorEn:english(color)});
  if (product.attributes.capacity) result.capacity = product.attributes.capacity;
  if (product.category === 'ipad') {
    const details = [product.attributes.connection, product.attributes.finish].filter(Boolean);
    result.configuration = details.join(' · ');
    result.configurationEn = details.map(english).join(' · ');
  }
  if (product.dimensionValues.dimensionCharging) {
    const charging = product.dimensionValues.dimensionCharging;
    const cases = {usbc:['USB-C 充电盒','USB-C charging case'], wirelesscharging:['无线充电盒','Wireless charging case']};
    if (!cases[charging]) throw Error('Unrecognized charging case: '+charging);
    [result.configuration, result.configurationEn] = cases[charging];
  }
  return result;
}
const dimKey = (entry, key) => entry[key] ?? entry['watch_cases-'+key];
const watchSizes = {space_gray:['深空灰色','Space Gray'],natural:['原色','Natural'],black:['黑色','Black'],darkbronze:['深古铜色','Dark Bronze'],nightblue:['深蓝色','Night Blue'],pearlwhite:['珍珠白色','Pearl White'],lightgold:['浅金色','Light Gold'],radiantgold:['亮金色','Radiant Gold'],midnight:['午夜色','Midnight'],starlight:['星光色','Starlight'],silver:['银色','Silver']};
const materials = {aluminum:['铝金属','Aluminum'],titanium:['钛金属','Titanium'],ceramic:['陶瓷','Ceramic']};
function watchRow(family, data, raw) {
  const d = raw.dimensions;
  const label = normalize(data.watchProductSelectionDataNoJS?.[0]?.text);
  const model = label.match(/^Apple Watch (?:Hermès )?(?:Series |Ultra |SE )?\d+/)?.[0];
  if (!model) throw Error('Unrecognized regional watch: '+label);
  const size = dimKey(d,'dimensionCaseSize'), tone = watchSizes[dimKey(d,'dimensionColor')];
  const material = materials[dimKey(d,'dimensionCaseMaterial')];
  const cellular = dimKey(d,'dimensionConnection');
  const signals = cellular === 'gpscell' ? ['GPS + 蜂窝网络','GPS + Cellular'] : [cellular === 'gps' ? 'GPS' : '',cellular === 'gps' ? 'GPS' : ''];
  if (!size || !tone || (dimKey(d,'dimensionCaseMaterial') && !material)) throw Error('Unknown Apple Watch case');
  const detail = [0,1].map(i=>[size,material?.[i],tone[i],signals[i]].filter(Boolean).join(' · '));
  return {id:family.familyKey+'-'+raw.part.split('/')[0],partNumber:null,model,title:model+' '+detail[0],titleEn:model+' '+detail[1],
    color:tone[0],colorEn:tone[1],configuration:detail[0],configurationEn:detail[1],querySupported:false,monitorSupported:false,reason:'case_and_band'};
}
function monitorRow(family, raw, metric) {
  const glass = raw.dimensionFinish==='matte'?'纳米纹理玻璃':'标准玻璃';
  const stand = {tiltadjuststand:'可调倾斜度支架',tiltheightadjuststand:'可调倾斜度和高度支架',vesa:'VESA 转换器'}[raw.dimensionStandType];
  if(!stand || !['matte','glossy'].includes(raw.dimensionFinish) || !metric?.name) throw Error('Unknown display configuration');
  const configuration = glass+' · '+stand;
  return {partNumber:raw.partNumber,model:family.displayName,title:family.displayName+' '+configuration,titleEn:normalize(metric.name),configuration,configurationEn:normalize(metric.name)};
}
function localDimensions(raw) {
  return raw.dimensions || Object.fromEntries(Object.entries(raw).filter(([key,value])=>/(?:^|-)dimension(?!Steporder)/.test(key)&&typeof value==='string'));
}
function matchMainland(familyKey, dims, artworkKey) {
  const candidates = mainland.filter(product=>product.familyKey===familyKey && !product.partNumber.startsWith('CTO_')
    && Object.entries(dims).every(([key,value])=>product.dimensionValues[key]===value));
  if(candidates.length!==1) throw Error('Ambiguous local configuration: '+JSON.stringify([familyKey,dims,candidates.length]));
  const product = candidates[0];
  if (artworkKey && product.imageKey && artworkKey!==product.imageKey) {
    // Apple occasionally uses regional image key variants. Keep the exact public SKU but no mismatched art.
    return {...product, partNumber:undefined};
  }
  return product;
}
function canonical(html) {
  const url = new URL(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]);
  if (url.origin !== 'https://www.apple.com' || !url.pathname.startsWith('/'+region+'/')) throw Error('Wrong storefront: '+url);
  return url.href;
}
const neoSpecs = read('macbook-neo-specs.html');
canonical(neoSpecs);
const fixedNeoMemory = /8GB(?: unified memory|のユニファイドメモリ)/i.test(neoSpecs);
const macColors = {
  skyblue:['天蓝色','Sky Blue'],midnight:['午夜色','Midnight'],starlight:['星光色','Starlight'],
  silver:['银色','Silver'],spaceblack:['深空黑色','Space Black'],indigo:['靛蓝色','Indigo'],
  citrus:['柑橘黄色','Citrus'],blush:['桃粉色','Blush'],green:['绿色','Green'],pink:['粉色','Pink'],
  blue:['蓝色','Blue'],yellow:['黄色','Yellow'],purple:['紫色','Purple'],orange:['橙色','Orange'],
};
const glassTypes = {standard:['标准玻璃','Standard glass'],glossy:['标准玻璃','Standard glass'],
  matte:['纳米纹理玻璃','Nano-texture glass'],nano_texture:['纳米纹理玻璃','Nano-texture glass']};
function macProduct(family, partNumber, dim, chip) {
  const selectedColor=dim['chassis-dimensionColor'],color=macColors[selectedColor];
  const glass=dim['display-dimensionFinish'],finish=glassTypes[glass];
  if ((selectedColor&&!color)||(glass&&!finish)) throw Error('Unknown finish: '+partNumber);
  const cores=dim['processor-dimensionChip-cpuCoreCount-gpuCoreCount']||dim['processor-cpuCoreCount-gpuCoreCount'];
  const [cpu,gpu]=String(cores).split('-').slice(-2);
  const capacity=String(dim['storage-dimensionCapacity']).toUpperCase(),memory=String(dim['memory-dimensionMemory']).toUpperCase();
  if (!/^\d+(?:GB|TB)$/.test(capacity)||!/^\d+GB$/.test(memory)||!/^\d+$/.test(cpu)||!/^\d+$/.test(gpu)) throw Error('Incomplete hardware: '+partNumber);
  const modelName=family.familyKey==='macbook-pro-proled-xdr'?'MacBook Pro (PROLED XDR)':family.displayName;
  const size=dim['chassis-dimensionScreensize']?.replace(/inch$/,'″');
  const model=[modelName,size].filter(Boolean).join(' ');
  const zh=[chip,cpu+' 核 CPU／'+gpu+' 核 GPU',memory+' 内存',finish?.[0]].filter(Boolean).join(' · ');
  const en=[chip,cpu+'-core CPU / '+gpu+'-core GPU',memory+' memory',finish?.[1]].filter(Boolean).join(' · ');
  const row={partNumber,model,title:[model,zh,capacity,color?.[0]].filter(Boolean).join(' · '),
    titleEn:[model,en,capacity,color?.[1]].filter(Boolean).join(' · '),capacity,configuration:zh,configurationEn:en};
  if(color) Object.assign(row,{color:color[0],colorEn:color[1]});
  // The physical enclosure and color determine this catalog thumbnail. Never copy a mainland SKU as the query target.
  const image=mainland.find(p=>p.familyKey===family.familyKey && !p.partNumber.startsWith('CTO_')
    && ['chassis-dimensionScreensize','chassis-dimensionColor'].every(k=>p.dimensionValues[k]===dim[k]));
  if(image) row.artworkPart=image.partNumber;
  return row;
}
function macDetails(family, link) {
  const html = read('config/'+link.file);
  const selectedUrl = new URL(canonical(html));
  if (!selectedUrl.pathname.startsWith('/'+region+'/shop/buy-mac/'+family.familyKey+'/') || new URL(link.url).href !== selectedUrl.href) throw Error('Unexpected Mac configuration: '+selectedUrl);
  const block = html.match(/<script type="application\/json" id="metrics">([\s\S]*?)<\/script>/);
  const data = block && JSON.parse(block[1]).data, selected = data?.buyflow?.userSelections, items = data?.products;
  if (!selected || items?.length!==1 || items[0].category!=='mac') throw Error('Incomplete selected Mac: '+link.url);
  const cpu=selected.PROCESSOR, chip=cpu?.dimensionChip;
  const dim = {'storage-dimensionCapacity':selected.STORAGE.dimensionValue};
  if (selected.MEMORY) dim['memory-dimensionMemory'] = selected.MEMORY.dimensionValue;
  else if (family.familyKey==='macbook-neo' && fixedNeoMemory) dim['memory-dimensionMemory']='8gb';
  else throw Error('Missing selected memory: '+link.url);
  if(cpu?.cpuCoreCount && cpu?.gpuCoreCount) {
    const suffix=[cpu.cpuCoreCount,cpu.gpuCoreCount].join('-');
    if(chip) {dim['processor-dimensionChip']=chip; dim['processor-dimensionChip-cpuCoreCount-gpuCoreCount']=chip+'-'+suffix;}
    else dim['processor-cpuCoreCount-gpuCoreCount']=suffix;
  }
  if(selected.CHASSIS_COLOR) dim['chassis-dimensionColor']=selected.CHASSIS_COLOR;
  if(selected.SCREEN_SIZE) dim['chassis-dimensionScreensize']=selected.SCREEN_SIZE;
  if(selected.DISPLAY_FINISH) dim['display-dimensionFinish']=selected.DISPLAY_FINISH;
  const title=normalize(html.match(/<title>([^<]+)/)?.[1]);
  const namedChip=chip ? chip.toUpperCase().replace(/(PRO|MAX|ULTRA)$/,x=>' '+x[0]+x.slice(1).toLowerCase())
    : title.match(/\bM[456]\b/i)?.[0] || (family.familyKey==='macbook-neo' && /A18\s?Pro/i.test(neoSpecs) ? 'A18 Pro' : '');
  if (!namedChip) throw Error('Missing chip identity on '+link.url);
  const row = macProduct(family,items[0].partNumber,dim,namedChip);
  row.sourceUrl = selectedUrl.href;
  if (family.familyKey==='macbook-pro' && chip==='m6') Object.assign(row,{releaseDate:'2026-11-06',releaseSource:news+'2026/10/apple-introduces-the-new-14-inch-macbook-pro-with-m6/'});
  return row;
}
const configLinks = JSON.parse(read('config/links.json'));
const output = [];
for (const family of families) {
  if (['ipad-10-2','homepod-mini'].includes(family.familyKey)) continue; // redirects / duplicate prior generation
  const html=read(family.familyKey+'.html');
  const sourceUrl=canonical(html);
  if (!sourceUrl.includes('/shop/buy-')) throw Error('Not a local buy page: '+sourceUrl);
  if (family.familyKey==='studio-display-xdr') family.displayName='Studio Display XDR';
  const selection = extractProductSelectionData(html);
  if(!selection?.products?.length) throw Error('Missing regional selector: '+sourceUrl);
  const metrics = new Map(extractMetricsProducts(html).map(item=>[item.partNumber,item]));
  let products;
  if (family.category==='watch') products=selection.products.map(raw=>watchRow(family,selection,raw));
  else if (family.familyKey.startsWith('studio-display')) products=selection.products.map(raw=>monitorRow(family,raw,metrics.get(raw.partNumber)));
  else if (family.category==='mac') {
    products=configLinks.filter(link=>link.key===family.familyKey).map(link=>macDetails(family,link));
    const linked = new Set([...html.matchAll(/<a\b[^>]*?\shref\s*=\s*(["'])([\s\S]*?)\1/gi)]
      .map(match=>match[2].trim()).filter(href=>href.startsWith(sourceUrl+'/') && !/[?#]/.test(href))
      .map(href=>new URL(href).href));
    assert.deepEqual(new Set(products.map(row=>row.sourceUrl)), linked, 'Incomplete regional configuration link set: '+family.familyKey);
    const included=new Set(products.map(row=>row.partNumber));
    assert.equal(included.size,products.length,'Duplicate regional Mac SKU: '+family.familyKey);
    for (const raw of selection.products) if(raw.btrOrFdPartNumber && !included.has(raw.btrOrFdPartNumber)) throw Error('Missing regional retail configuration '+raw.btrOrFdPartNumber);
    if (selection.products.some(raw => raw.type === 'CONFIGURABLE' && !raw.btrOrFdPartNumber)) {
      const model = family.displayName.replace('PROLED XDR 显示屏','PROLED XDR');
      products.push({ id:'custom-'+family.familyKey, partNumber:null, model,
        title:model+' 定制配置', titleEn:model+' custom configuration',
        querySupported:false, monitorSupported:false, reason:'custom_configuration' });
    }
  } else products=selection.products.filter(raw=>raw.partNumber && !raw.isCarrierDevice && !raw.comingSoon && !raw.isComingSoon).map(raw=>{
    const dims=localDimensions(raw), metric=metrics.get(raw.partNumber);
    if (family.category==='iphone' && !dims.dimensionCapacity) {
      const capacity=metric?.name?.match(/\b(\d+(?:GB|TB))\b/i)?.[1];
      if (!capacity) throw Error('Missing capacity for '+raw.partNumber);
      dims.dimensionCapacity=capacity.toLowerCase();
    }
    // In October Apple refreshed the HomePod photo. Both storefronts still name
    // the second generation and offer the same white and midnight enclosures.
    const sameHomePod = family.familyKey === 'homepod' && /HomePod\s*[（(](?:2nd generation|第2世代)[）)]/i.test(html)
      && ['midnight','white'].includes(dims.dimensionColor)
      && raw.imageKey === 'homepod-select-'+dims.dimensionColor+'-202610';
    const match = matchMainland(family.familyKey,dims,sameHomePod ? null : raw.imageKey);
    const row = catalogRow(match,raw.partNumber);
    if (family.category==='vision') Object.assign(row,{id:'vision-'+row.capacity.toLowerCase(),partNumber:null,querySupported:false,monitorSupported:false,reason:'fitting_required'});
    return row;
  });
  for(const product of products) if(product.partNumber && !/^[A-Z0-9]{5,12}\/A$/.test(product.partNumber)) throw Error('Unverified retail part: '+product.partNumber);
  const date=dates.find(([, ,keys])=>keys.split(' ').includes(family.familyKey));
  const familyRow={familyKey:family.familyKey,category:family.category,model:family.displayName,sourceUrl};
  if(date) Object.assign(familyRow,{releaseDate:date[0],releaseSource:news+date[1]});
  if(family.familyKey==='airpods-max-2') Object.assign(familyRow,{availableBy:'2026-04-30',releaseSource:news+'2026/03/apple-introduces-airpods-max-2-powered-by-h2/'});
  familyRow.products=products;
  output.push(familyRow);
}
const destination=new URL('../../../catalog/markets/'+region+'.json',import.meta.url);
const result = {code,families:output};
if (mode === '--check') assert.deepEqual(result,JSON.parse(fs.readFileSync(destination)),code+' source differs from captured pages');
else fs.writeFileSync(destination, JSON.stringify(result,null,2)+'\n');

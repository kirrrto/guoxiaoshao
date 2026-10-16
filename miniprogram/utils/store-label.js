/** Location labels for official stores whose names are only their city.
 * Addresses checked against apple.com.cn/retail/{slug}/ on 2026-09-30.
 * Keep upstream names and store numbers intact; enrich only presentation.
 */
const CITY_NAMED_STORES = {
  R575: { city: '武汉', name: '武汉武商 MALL', address: '武汉市江汉区解放大道 690 号 武商 MALL B 座 2F' },
  R688: { city: '苏州', name: '苏州中心商场', address: '苏州市苏州工业园区 苏州中心商场' },
  R670: { city: '昆明', name: '昆明顺城购物中心', address: '昆明市五华区东风西路 11 号 顺城购物中心' },
  R617: { city: '长沙', name: '长沙国金中心', address: '长沙市芙蓉区解放西路 188 号 长沙国金中心一层' },
};

function storeLabel(storeNumber, fallback) {
  const name = String(fallback || '').trim();
  const location = CITY_NAMED_STORES[storeNumber];
  if (location && (!name || name === storeNumber || name === location.city || name === `Apple ${location.city}`)) return location.name;
  return name || storeNumber;
}

function presentStore(store) {
  const location = CITY_NAMED_STORES[store.storeNumber];
  return { ...store, name: storeLabel(store.storeNumber, store.name),
    officialName: store.officialName || store.name,
    address: store.address || (location && location.address) || '',
  };
}

function storeLabelWithCity(storeNumber, fallback, city) {
  const name = storeLabel(storeNumber, fallback);
  return city && name && !name.startsWith(city) ? `${city} · ${name}` : name;
}

module.exports = { storeLabel, storeLabelWithCity, presentStore };

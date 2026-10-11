#!/usr/bin/env node
/** Local-only release gate. Calendar dates never grant pickup support. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { toProductDoc } = require('../../cloudfunctions/gxs_api/lib/services/catalog');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const officialHosts = new Set(['apple.com.cn', 'www.apple.com.cn', 'apple.com', 'www.apple.com']);
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const isOfficial = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && officialHosts.has(url.hostname) && !url.username && !url.password; }
  catch { return false; }
};

export function checkLaunchReadiness({ catalog, launches, asOf }) {
  const errors = [], launchReports = [], seen = new Set();
  if (!dateOnly(asOf)) errors.push('invalid_as_of_date');
  if (!catalog || !Array.isArray(catalog.families) || !Array.isArray(catalog.products)) return { passed: false, errors: ['invalid_catalog'], launches: [] };
  if (!Array.isArray(launches)) return { passed: false, errors: ['invalid_launch_registry'], launches: [] };
  for (const launch of launches) {
    const key = launch && launch.familyKey;
    const issue = code => errors.push(`${key || 'unknown'}:${code}`);
    if (typeof key !== 'string' || !/^[a-z0-9-]{1,64}$/.test(key)) { issue('invalid_family_key'); continue; }
    if (seen.has(key)) issue('duplicate_family');
    seen.add(key);
    if (!isOfficial(launch.sourceUrl)) issue('official_source_required');
    if (!isOfficial(launch.officialUrl)) issue('official_product_url_required');
    if (!dateOnly(launch.verifiedOn) || launch.verifiedOn > asOf) issue('invalid_verification_date');
    if (!dateOnly(launch.releaseDate)) issue('invalid_release_date');
    if (launch.timezone !== 'Asia/Shanghai') issue('explicit_beijing_timezone_required');
    for (const field of ['preorderAt', 'displayUntil']) {
      if (typeof launch[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\+08:00$/.test(launch[field])
        || !dateOnly(launch[field].slice(0, 10)) || !Number.isFinite(Date.parse(launch[field]))) issue(`invalid_${field}`);
    }
    if (Date.parse(launch.preorderAt) > Date.parse(`${launch.releaseDate}T23:59:59+08:00`)) issue('preorder_after_release');
    if (Date.parse(launch.displayUntil) <= Date.parse(`${launch.releaseDate}T00:00:00+08:00`)) issue('display_window_ends_before_release');
    const family = catalog.families.find(row => row.familyKey === key);
    const products = catalog.products.filter(row => row.familyKey === key);
    if (!family) issue('catalog_family_missing');
    if (!products.length) issue('catalog_products_missing');
    if (family && family.productCount !== products.length) issue('catalog_product_count_mismatch');
    const verification = family && family.pickupVerification;
    if (verification && verification.verified && (!verification.sampledPartNumber || !products.some(p => p.partNumber === verification.sampledPartNumber))) issue('verified_family_missing_valid_sample');
    const projected = products.map(product => toProductDoc(product, family));
    const readiness = projected.map(product => ({ partNumber: product.partNumber, comingSoon: product.comingSoon, supported: product.supported }));
    for (const product of projected) {
      if (product.comingSoon && product.supported) issue(`coming_soon_is_supported:${product.partNumber}`);
      if (product.supported && !(verification && verification.verified)) issue(`unsupported_evidence:${product.partNumber}`);
    }
    const blockers = [];
    if (products.some(product => product.comingSoon)) blockers.push('catalog_coming_soon');
    if (!(verification && verification.verified)) blockers.push('pickup_not_verified');
    if (!(verification && verification.sampledPartNumber)) blockers.push('no_sampled_sku');
    launchReports.push({ familyKey: key, title: launch.title, sourceUrl: launch.sourceUrl, officialUrl: launch.officialUrl,
      editorialVerifiedOn: launch.verifiedOn, sourceContentRevalidated: false, preorderAt: launch.preorderAt, releaseDate: launch.releaseDate,
      catalogProductCount: products.length, effectiveSupportedCount: projected.filter(product => product.supported).length,
      comingSoonCount: products.filter(product => product.comingSoon).length, sampledPartNumber: verification && verification.sampledPartNumber || null,
      pickupVerificationStatus: verification && verification.status || 'unknown', blockers, variants: readiness,
      operationalStatus: projected.some(product => product.supported) ? 'catalog_support_present_requires_release_acceptance' : 'not_open_for_query_or_monitoring',
      nextSteps: blockers.length ? ['核对官方可售状态与真实 SKU', '经授权完成真实门店取货采样', '更新并同步目录后重新核验限制、查询与提醒'] : ['经授权完成发布前真机、目录和监测验收'] });
  }
  return { schemaVersion: 1, asOf, timezone: 'Asia/Shanghai', localOnly: true, networkAccessed: false, productionChanged: false,
    calendarEnablesService: false, passed: errors.length === 0, errors, launches: launchReports,
    interpretation: '通过仅表示本地登记格式和目录状态一致；不证明来源网页本次已联网核实，不证明取货或监测服务已开放。' };
}

function main() {
  const asOf = process.argv.find(arg => arg.startsWith('--as-of='))?.slice(8)
    || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const catalogFile = path.join(root, 'catalog/products.json');
  const bundleFile = path.join(root, 'cloudfunctions/gxs_api/catalog/products.json');
  const raw = fs.readFileSync(catalogFile);
  const report = checkLaunchReadiness({ catalog: JSON.parse(raw), launches: require('../../miniprogram/config/product-launches'), asOf });
  const hash = data => createHash('sha256').update(data).digest('hex');
  report.catalogSha256 = hash(raw);
  report.cloudBundleMatchesLocal = fs.existsSync(bundleFile) && hash(fs.readFileSync(bundleFile)) === report.catalogSha256;
  if (!report.cloudBundleMatchesLocal) { report.passed = false; report.errors.push('cloud_catalog_bundle_out_of_sync'); }
  const output = path.join(root, 'evidence/verification/2.0.0/launch-readiness.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, output, launches: report.launches.map(launch => ({ familyKey: launch.familyKey, products: launch.catalogProductCount, supported: launch.effectiveSupportedCount, blockers: launch.blockers })), errors: report.errors }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

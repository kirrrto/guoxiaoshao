#!/usr/bin/env node
// Reuse already verified original images and encoded assets when adding exact
// configurations of the same appearance. Unknown images require normal verify/build.
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url), hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(resolve(root,p),'utf8'));
const write=(p,v)=>fs.writeFileSync(resolve(root,p),JSON.stringify(v,null,2)+'\n');
const catalog=read('catalog/products.json'), day=catalog.imagesGeneratedAt.slice(0,10);
const reportFile=`evidence/catalog/${day}/images.verification.json`, report=read(reportFile);
const imageManifestFile=`evidence/catalog/${day}/images.manifest.json`, imageManifest=read(imageManifestFile);
const thumbnailFile='miniprogram/config/product-thumbnails.js', mapping=require(resolve(root,thumbnailFile));
const manifestFile='evidence/assets/product-thumbnails.manifest.json', manifest=read(manifestFile);
const groups=new Map();
for(const p of catalog.products){if(!groups.has(p.imageUrl))groups.set(p.imageUrl,[]);groups.get(p.imageUrl).push(p);}
for(const [url,products] of groups){
  const proof=report.entries.find(e=>e.imageUrl===url), asset=manifest.assets.find(a=>a.source===url);
  if(!proof||!asset||proof.record.httpStatus!==200||!report.decodeVerified||proof.record.sha256!==asset.sourceSha256)throw Error('unverified_original:'+url);
  if(hash(fs.readFileSync(resolve(root,report.assetDirectory,proof.assetFile)))!==proof.record.sha256)throw Error('original_hash_mismatch');
  for(const r of asset.renditions)if(hash(fs.readFileSync(resolve(root,'miniprogram'+r.path)))!==r.sha256)throw Error('rendition_hash_mismatch');
  proof.products=products.map(p=>({partNumber:p.partNumber,familyKey:p.familyKey,title:p.title,color:p.attributes.color||null}));
  asset.parts=products.map(p=>p.partNumber).sort();
}
if(groups.size!==report.entries.length||groups.size!==mapping.assets.length)throw Error('image_set_changed_use_full_image_build');
report.totalSkus=catalog.products.length;report.catalogImagesGeneratedAt=catalog.imagesGeneratedAt;
report.mappingUpdatedAt=new Date().toISOString();
write(reportFile,report);
imageManifest.generatedAt=catalog.imagesGeneratedAt;imageManifest.products=catalog.count;imageManifest.mapped=catalog.imageCount;
for(const source of imageManifest.sources){source.count=catalog.products.filter(p=>p.familyKey===source.familyKey).length;}
const studioSource=imageManifest.sources.find(s=>s.familyKey==='mac-studio');
if(studioSource)studioSource.configurationEvidence=`evidence/catalog/${day}/mac-studio-configurations.json`;
imageManifest.mappingNote='Original URLs and encoded image bytes are unchanged. Exact Mac Studio configurations share the already verified Mac Studio appearance; SKU membership has been rebuilt and all original/rendition hashes rechecked.';
write(imageManifestFile,imageManifest);
const U='https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/', S='https://www.apple.com.cn/shop/buy-';
const E=[], B={}, index=new Map();
for(const p of catalog.products){
  const entry=[p.imageUrl.startsWith(U)?p.imageUrl.slice(U.length):p.imageUrl,p.imageAlt,p.imageWidth,p.imageHeight,p.imageSource,p.imageSourceUrl.startsWith(S)?p.imageSourceUrl.slice(S.length):p.imageSourceUrl];
  const key=JSON.stringify(entry);if(!index.has(key)){index.set(key,E.length);E.push(entry);}B[p.partNumber]=index.get(key);
}
const imagesFile=resolve(root,'miniprogram/config/product-images.js'),code=fs.readFileSync(imagesFile,'utf8');
const start=code.indexOf('const E = '),end=code.indexOf('const out = {}');
if(start<0||end<start)throw Error('unsupported_image_mapping_format');
fs.writeFileSync(imagesFile,code.slice(0,start)+`const E = ${JSON.stringify(E)};\nconst B = ${JSON.stringify(B)};\n`+code.slice(end));
mapping.byPart=Object.fromEntries(catalog.products.map(p=>{const index=mapping.assets.findIndex(a=>a.source===p.imageUrl);if(index<0)throw Error('missing_thumbnail');return[p.partNumber,index];}));
fs.writeFileSync(resolve(root,thumbnailFile),'// Generated from verified original image and exact configuration mappings.\nmodule.exports = '+JSON.stringify(mapping)+';\n');
manifest.catalogSha256=hash(fs.readFileSync(resolve(root,'catalog/products.json')));
manifest.mappingSha256=hash(fs.readFileSync(resolve(root,thumbnailFile)));
manifest.catalogImagesGeneratedAt=catalog.imagesGeneratedAt;manifest.generatedAt=new Date().toISOString();
manifest.incrementalBuild={reusedVerifiedAssets:manifest.assets.length,newlyEncodedAssets:0,sourceHashesRechecked:true,reason:'Only exact-configuration membership changed; original and encoded image hashes were rechecked.'};
write(manifestFile,manifest);
console.log(JSON.stringify({products:catalog.count,assets:manifest.assets.length,bytes:manifest.totalBytes,catalogSha256:manifest.catalogSha256}));

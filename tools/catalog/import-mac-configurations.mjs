#!/usr/bin/env node
// Import only a complete, individually resolved official configuration capture.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMacConfigurationCapture } from './lib/apply-mac-configurations.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2), day=args.includes('--day')?args[args.indexOf('--day')+1]:new Date().toISOString().slice(0,10);
if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('invalid_evidence_day');
const file=resolve(root,'catalog/products.json');
const catalog=JSON.parse(await readFile(file,'utf8'));
const capture=JSON.parse(await readFile(resolve(root,'evidence/catalog',day,'mac-studio-configurations.json'),'utf8'));
const next=applyMacConfigurationCapture(catalog,capture);
await writeFile(file,JSON.stringify(next,null,2)+'\n');
const discoveryFile=resolve(root,'tools/catalog/families.json');
const discovery=JSON.parse(await readFile(discoveryFile,'utf8'));
const family=discovery.families.find(f=>f.familyKey==='mac-studio');
family.officialConfigurations=next.families.find(f=>f.familyKey==='mac-studio').officialConfigurations;
family.configurationCapture=`evidence/catalog/${day}/mac-studio-configurations.json`;
await writeFile(discoveryFile,JSON.stringify(discovery,null,2)+'\n');
console.log(JSON.stringify({products:next.count,studio:next.families.find(f=>f.familyKey==='mac-studio').productCount,generatedAt:next.generatedAt}));

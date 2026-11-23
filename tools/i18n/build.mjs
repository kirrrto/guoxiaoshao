// Pack the complete English UI locally. Repeated strings reference earlier UTF-8
// bytes; no network, native codec or third-party decompressor is needed on phones.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const words = Object.assign({}, ...['stock','account','support','catalog','common'].map(name => require('./source/' + name)));
const input = Buffer.from(JSON.stringify(words));
// The decoder supports any earlier 64 KiB match. Check several candidates so
// common SKU prefixes and release-note wording can actually use that window.
const output = [], last = new Map(), previous = new Int32Array(input.length).fill(-1);
let literal = [];
function flush() {
  if (literal.length) output.push(literal.length - 1, ...literal);
  literal = [];
}
const keyAt = i => (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];
function remember(i) {
  const key = keyAt(i);
  previous[i] = last.get(key) ?? -1;
  last.set(key, i);
}
for (let i = 0; i < input.length;) {
  let length = 0, distance = 0, candidate = last.get(keyAt(i)) ?? -1;
  for (let tries = 0; tries < 64 && candidate >= 0 && i - candidate <= 65535; tries++) {
    let n = 0;
    while (n < 130 && i + n < input.length && input[candidate + n] === input[i + n]) n++;
    if (n > length) { length = n; distance = i - candidate; }
    if (n === 130) break;
    candidate = previous[candidate];
  }
  if (length >= 4) {
    flush(); output.push(128 + length - 3, distance & 255, distance >> 8);
    for (let j=0; j<length; j++) remember(i+j);
    i+=length;
  } else {
    remember(i); literal.push(input[i++]); if (literal.length===128) flush();
  }
}
flush();
const encoded = Buffer.from(output).toString('base64');
const path = new URL('../../miniprogram/i18n/en.js', import.meta.url);
const keys = Object.keys(words), views = {};
for (const area of ['pages', 'components']) {
  const root = new URL('../../miniprogram/' + area + '/', import.meta.url);
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  for (const name of directories.map(entry => entry.name).sort()) {
    const markup = fs.readFileSync(new URL(name + '/index.wxml', root), 'utf8');
    if (!markup.includes('i18n/render.wxs')) continue;
    // Dynamic values come from view data. Keep literals in conditionals, picker
    // labels and accessibility attributes even before a view has loaded data.
    views[name] = keys.flatMap((key, index) => markup.includes(key) ? [index] : []);
  }
}
const file = '// Generated with node tools/i18n/build.mjs. Edit tools/i18n/source.\nmodule.exports = [' + input.length + ',\n' + JSON.stringify(encoded) + ',\n' + JSON.stringify(views) + '];\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(path,'utf8') !== file) throw Error('Rebuild English copy with node tools/i18n/build.mjs');
} else fs.writeFileSync(path,file);
const decoded = require('../../miniprogram/i18n/unpack')([input.length,encoded]);
if (JSON.stringify(decoded) !== input.toString()) throw Error('English dictionary failed its round trip');
console.log(JSON.stringify({messages:Object.keys(words).length,sourceBytes:input.length,packagedBytes:Buffer.byteLength(file)}));

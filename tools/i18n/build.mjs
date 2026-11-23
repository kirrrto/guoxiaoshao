// Pack the complete English UI locally. Repeated strings reference earlier UTF-8
// bytes; no network, native codec or third-party decompressor is needed on phones.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const words = Object.assign({}, ...['stock','account','support','catalog','common'].map(name => require('./source/' + name)));
const input = Buffer.from(JSON.stringify(words));
const output = [], last = new Map();
let literal = [];
function flush() {
  if (literal.length) output.push(literal.length - 1, ...literal);
  literal = [];
}
const keyAt = i => (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];
for (let i = 0; i < input.length;) {
  const key = keyAt(i), previous = last.get(key), distance = i - previous;
  let length = 0;
  if (distance > 0 && distance <= 65535) {
    while (length < 130 && i + length < input.length && input[previous + length] === input[i + length]) length++;
  }
  if (length >= 4) {
    flush(); output.push(128 + length - 3, distance & 255, distance >> 8);
    for (let j=0; j<length; j++) last.set(keyAt(i+j), i+j);
    i+=length;
  } else {
    last.set(key,i); literal.push(input[i++]); if (literal.length===128) flush();
  }
}
flush();
const encoded = Buffer.from(output).toString('base64');
const path = new URL('../../miniprogram/i18n/en.js', import.meta.url);
const file = '// Generated with node tools/i18n/build.mjs. Edit tools/i18n/source.\nmodule.exports = [' + input.length + ',\n' + JSON.stringify(encoded) + '];\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(path,'utf8') !== file) throw Error('Rebuild English copy with node tools/i18n/build.mjs');
} else fs.writeFileSync(path,file);
const decoded = require('../../miniprogram/i18n/unpack')([input.length,encoded]);
if (JSON.stringify(decoded) !== input.toString()) throw Error('English dictionary failed its round trip');
console.log(JSON.stringify({messages:Object.keys(words).length,sourceBytes:input.length,packagedBytes:Buffer.byteLength(file)}));

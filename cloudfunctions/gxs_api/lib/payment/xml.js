'use strict';
const { fail } = require('./errors');

const MAX_BODY_BYTES = 65536;

function utf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { fail('payment_callback_invalid_encoding'); }
}

function decodeBody(body, isBase64Encoded) {
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BODY_BYTES) fail('payment_callback_too_large');
    return utf8(body);
  }
  if (typeof body !== 'string') fail('payment_callback_invalid_body');
  if (isBase64Encoded) {
    if (body.length > Math.ceil(MAX_BODY_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) fail('payment_callback_invalid_encoding');
    const decoded = Buffer.from(body, 'base64');
    if (decoded.toString('base64') !== body) fail('payment_callback_invalid_encoding');
    return decodeBody(decoded, false);
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) fail('payment_callback_too_large');
  return body;
}

function unescapeXml(text) {
  if (/&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)/.test(text)) fail('payment_callback_invalid_xml');
  return text.replace(/&(amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);/g, (all, value) => {
    const named = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
    if (Object.hasOwn(named, value)) return named[value];
    const point = value.startsWith('#x') ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    if (!Number.isSafeInteger(point) || point > 0x10ffff || point === 0 || (point < 32 && ![9, 10, 13].includes(point)) || (point >= 0xd800 && point <= 0xdfff)) fail('payment_callback_invalid_xml');
    return String.fromCodePoint(point);
  });
}

// Deliberately a small XML subset: WeChat event elements + text/CDATA. No DTD,
// entities, attributes, comments, namespaces, mixed content or duplicate keys.
// This avoids regex field extraction accepting ambiguous financial messages.
function parseXml(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_BODY_BYTES) fail('payment_callback_too_large');
  source = source.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, '').trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source) || /<!DOCTYPE|<!ENTITY|<\?|<!--/i.test(source)) fail('payment_callback_invalid_xml');
  let position = 0; let nodes = 0;
  function element(depth) {
    if (depth > 8 || ++nodes > 256) fail('payment_callback_invalid_xml');
    const opening = /^<([A-Za-z_][A-Za-z0-9_]*)(\s*\/)?>/.exec(source.slice(position));
    if (!opening) fail('payment_callback_invalid_xml');
    const name = opening[1]; position += opening[0].length;
    if (opening[2]) return { name, value: '' };
    const children = Object.create(null); let content = ''; let hasChildren = false;
    while (position < source.length) {
      if (source.startsWith(`</${name}>`, position)) {
        position += name.length + 3;
        if (hasChildren && content.trim()) fail('payment_callback_invalid_xml');
        return { name, value: hasChildren ? children : content.trim() };
      }
      if (source.startsWith('<![CDATA[', position)) {
        const end = source.indexOf(']]>', position + 9);
        if (end < 0) fail('payment_callback_invalid_xml');
        content += source.slice(position + 9, end); position = end + 3;
      } else if (source[position] === '<') {
        const child = element(depth + 1);
        if (Object.hasOwn(children, child.name)) fail('payment_callback_duplicate_field');
        children[child.name] = child.value; hasChildren = true;
      } else {
        const end = source.indexOf('<', position);
        if (end < 0) fail('payment_callback_invalid_xml');
        content += unescapeXml(source.slice(position, end)); position = end;
      }
    }
    fail('payment_callback_invalid_xml');
  }
  const root = element(0);
  if (position !== source.length || root.name !== 'xml' || !root.value || typeof root.value !== 'object') fail('payment_callback_invalid_xml');
  return root.value;
}

module.exports = { MAX_BODY_BYTES, utf8, decodeBody, parseXml };

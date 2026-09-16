#!/usr/bin/env node
/**
 * Generate the tab-bar icons (81×81 PNG, active/inactive) without any image
 * dependency: shapes are rasterised with 4× supersampling and encoded as PNG
 * using zlib. Output: miniprogram/images/tab/<name>[-active].png
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'miniprogram', 'images', 'tab');
fs.mkdirSync(outDir, { recursive: true });

const SIZE = 81;
const SS = 4;
const ACTIVE = [0x00, 0xc3, 0x75];
const INACTIVE = [0x6c, 0x81, 0x79];

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);
const circle = (cx, cy, r) => (x, y) => dist(x, y, cx, cy) <= r;
const ring = (cx, cy, r, w) => (x, y) => Math.abs(dist(x, y, cx, cy) - r) <= w / 2;
const segment = (x1, y1, x2, y2, w) => (x, y) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return dist(x, y, x1 + t * dx, y1 + t * dy) <= w / 2;
};
const roundRect = (x1, y1, x2, y2, r) => (x, y) => {
  const qx = Math.max(x1 + r - x, 0, x - (x2 - r));
  const qy = Math.max(y1 + r - y, 0, y - (y2 - r));
  return Math.hypot(qx, qy) <= r;
};
const clip = (shape, predicate) => (x, y) => shape(x, y) && predicate(x, y);
const union = (...shapes) => (x, y) => shapes.some(s => s(x, y));
const subtract = (shape, hole) => (x, y) => shape(x, y) && !hole(x, y);
const polygon = points => (x, y) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// 果小哨：果叶、带圆孔的口哨和两道短声线。与现有品牌标志呼应。
// 声线是静态品牌图形，不表示小程序会播放声音。
const whistle = union(
  subtract(union(circle(32, 49, 21), polygon([[32, 29], [51, 22], [66, 33], [66, 40], [49, 48], [44, 59]])),
    union(circle(31, 50, 10), polygon([[48, 28], [54, 32], [58, 31], [52, 27]]))),
  (x, y) => circle(24, 14, 13)(x, y) && circle(32, 26, 16)(x, y),
  segment(61, 16, 64, 8, 4),
  segment(69, 23, 75, 18, 4),
);

const ICONS = {
  // 查询：放大镜
  query: union(ring(35, 35, 19, 7), segment(48, 48, 67, 67, 8)),
  // 小哨：口哨，与页面提醒图形共用同一形状。
  follow: whistle,
  // 历史：时钟
  history: union(ring(40.5, 40.5, 27, 7), segment(40.5, 40.5, 40.5, 23, 6), segment(40.5, 40.5, 53, 47, 6)),
  // 我的：人像
  mine: union(circle(40.5, 27, 13), clip(circle(40.5, 70, 25), (x, y) => y <= 66)),
};

function render(shape, rgb) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let py = 0; py < SIZE; py++) {
    raw[py * (SIZE * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < SIZE; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (shape(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hits++;
        }
      }
      const alpha = Math.round((hits / (SS * SS)) * 255);
      const offset = py * (SIZE * 4 + 1) + 1 + px * 4;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
      raw[offset + 3] = alpha;
    }
  }
  return raw;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function png(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, shape] of Object.entries(ICONS)) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), png(render(shape, INACTIVE)));
  fs.writeFileSync(path.join(outDir, `${name}-active.png`), png(render(shape, ACTIVE)));
  console.log(`wrote ${name}.png / ${name}-active.png`);
}

const brandDir = path.join(root, 'miniprogram', 'images', 'brand');
fs.mkdirSync(brandDir, { recursive: true });
fs.writeFileSync(path.join(brandDir, 'whistle-green.png'), png(render(whistle, ACTIVE)));
console.log('wrote brand/whistle-green.png');

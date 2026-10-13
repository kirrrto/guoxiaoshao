#!/usr/bin/env node
/**
 * Generate tab-bar and labelled UI icons (81×81 PNG) without any image
 * dependency: shapes are rasterised with 4× supersampling and encoded as PNG
 * using zlib. Outputs: miniprogram/images/tab/<name>[-active].png and
 * miniprogram/images/ui/<name>.png. UI icons share a rounded 6px stroke and
 * are intended for roughly 20px display beside a visible text label.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'miniprogram', 'images', 'tab');
const uiDir = path.join(root, 'miniprogram', 'images', 'ui');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(uiDir, { recursive: true });

const SIZE = 81;
const SS = 4;
// #008F59: 4.14:1 on white, 3.80:1 on #F2F6F4, 3.81:1 on #1B251F.
// Keep the existing brand asset separate from functional icon contrast.
const ACTIVE = [0x00, 0x8f, 0x59];
const BRAND_GREEN = [0x00, 0xc3, 0x75];
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
const outlineRect = (x1, y1, x2, y2, r, w = 6) => subtract(
  roundRect(x1, y1, x2, y2, r), roundRect(x1 + w, y1 + w, x2 - w, y2 - w, Math.max(0, r - w)),
);
const strokePath = (points, w = 6) => union(...points.slice(1).map((point, i) => segment(...points[i], ...point, w)));
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

const UI_ICONS = {
  // 发售日期：带页眉和装订线的日历，不表示后台定时任务已开启。
  calendar: union(
    outlineRect(13, 19, 68, 70, 9), segment(17, 34, 64, 34, 6),
    segment(27, 12, 27, 24, 6), segment(54, 12, 54, 24, 6),
    segment(26, 46, 31, 46, 6), segment(48, 46, 53, 46, 6),
    segment(26, 58, 31, 58, 6), segment(48, 58, 53, 58, 6),
  ),
  // 产品配置：圆角手机轮廓，保持通用，不描绘未验证的新机外观。
  device: union(outlineRect(23, 10, 58, 71, 10), segment(35, 61, 46, 61, 5)),
  // 所选门店：屋檐、卷帘及入口。
  store: union(
    strokePath([[15, 33], [22, 15], [59, 15], [66, 33]]),
    ...[23.5, 40.5, 57.5].map(cx => clip(ring(cx, 33, 8.5, 6), (x, y) => y >= 33)),
    strokePath([[20, 45], [20, 68], [61, 68], [61, 45]]),
    strokePath([[34, 68], [34, 50], [47, 50], [47, 68]]),
  ),
  // 订单/支付记录：纸张与明细，避免银行卡图形暗示额外支付渠道。
  receipt: union(
    strokePath([[23, 12], [58, 12], [58, 69], [51, 64], [44, 69], [37, 64], [30, 69], [23, 64], [23, 12]]),
    segment(33, 27, 48, 27, 6), segment(33, 40, 48, 40, 6), segment(33, 53, 42, 53, 6),
  ),
  // 权益与规则：盾牌配确认勾；仅作分组装饰，不替代服务状态。
  shield: union(
    strokePath([[40.5, 11], [64, 20], [62, 43], [55, 57], [40.5, 69], [26, 57], [19, 43], [17, 20], [40.5, 11]]),
    strokePath([[29, 38], [38, 47], [52, 31]]),
  ),
  // 微信提醒：圆顶铃铛；声音及真实送达仍由旁边文案说明。
  notification: union(
    clip(ring(40.5, 34, 19, 6), (x, y) => y <= 34),
    strokePath([[21.5, 34], [21.5, 46], [15, 56], [66, 56], [59.5, 46], [59.5, 34]]),
    segment(40.5, 10, 40.5, 15, 6),
    clip(ring(40.5, 56, 10, 6), (x, y) => y >= 61),
  ),
  // 已完成/核心权益：圆环配确认勾，必须仍搭配具体状态文字。
  check: union(ring(40.5, 40.5, 27, 6), strokePath([[27, 40], [37, 50], [54, 31]])),
  // 更新公告：扩音器，与用于微信提醒的铃铛区分。
  news: union(
    strokePath([[14, 31], [28, 31], [57, 18], [57, 56], [28, 44], [14, 44], [14, 31]]),
    strokePath([[26, 44], [31, 65], [42, 65], [37, 48]]),
    segment(66, 27, 71, 23, 5), segment(66, 39, 73, 39, 5),
  ),
  // 兑换码开通：两侧半圆缺口的票券，不是支付或订单收据。
  ticket: union(
    subtract(
      subtract(roundRect(12, 20, 69, 62, 7), union(circle(12, 41, 8), circle(69, 41, 8))),
      subtract(roundRect(18, 26, 63, 56, 2), union(circle(12, 41, 14), circle(69, 41, 14))),
    ),
    segment(26, 41, 33, 41, 6), ...[31, 41, 51].map(cy => circle(47, cy, 2.5)),
  ),
  // 使用攻略：摊开的书页，保留明显书脊。
  guide: union(
    strokePath([[40.5, 23], [30, 17], [14, 17], [14, 62], [29, 62], [40.5, 68], [52, 62], [67, 62], [67, 17], [51, 17], [40.5, 23], [40.5, 68]]),
    segment(24, 33, 31, 33, 5), segment(24, 45, 31, 45, 5),
    segment(50, 33, 57, 33, 5), segment(50, 45, 57, 45, 5),
  ),
  // 隐私说明：锁形分组图标，不作额外安全保证。
  privacy: union(
    clip(ring(40.5, 29, 15, 6), (x, y) => y <= 29),
    segment(25.5, 29, 25.5, 36, 6), segment(55.5, 29, 55.5, 36, 6),
    outlineRect(18, 34, 63, 70, 8), circle(40.5, 49, 4), segment(40.5, 49, 40.5, 58, 5),
  ),
  // 免责声明：圆圈中的信息符号，与带勾的完成状态分开。
  info: union(ring(40.5, 40.5, 27, 6), circle(40.5, 26, 3.5), segment(40.5, 39, 40.5, 55, 6)),
  // 意见反馈：带文字横线与尾角的对话气泡。
  feedback: union(
    strokePath([[21, 17], [60, 17], [67, 24], [67, 50], [60, 57], [41, 57], [27, 69], [27, 57], [21, 57], [14, 50], [14, 24], [21, 17]]),
    segment(26, 31, 55, 31, 6), segment(26, 43, 46, 43, 6),
  ),
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

for (const [name, shape] of Object.entries(UI_ICONS)) {
  fs.writeFileSync(path.join(uiDir, `${name}.png`), png(render(shape, ACTIVE)));
  console.log(`wrote ui/${name}.png`);
}

const brandDir = path.join(root, 'miniprogram', 'images', 'brand');
fs.mkdirSync(brandDir, { recursive: true });
fs.writeFileSync(path.join(brandDir, 'whistle-green.png'), png(render(whistle, BRAND_GREEN)));
console.log('wrote brand/whistle-green.png');

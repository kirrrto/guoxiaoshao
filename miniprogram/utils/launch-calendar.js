const launches = require('../config/product-launches');
const { fmtDate, fmtTime } = require('./format');
const { productThumbnailUrl } = require('./product-image-fit');

// Calendar dates are editorial information. They never enable a product or a
// monitor, and UTC arithmetic keeps weekday placement identical on all devices.
function calendarView(entry, now = Date.now()) {
  const preorderDate = fmtDate(entry.preorderAt);
  const monthKey = entry.releaseDate.slice(0, 7);
  const [year, month] = monthKey.split('-').map(Number);
  const offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = [];
  for (let index = 0; index < Math.ceil((offset + count) / 7) * 7; index++) {
    const day = index - offset + 1;
    const valid = day > 0 && day <= count;
    const date = valid ? `${monthKey}-${String(day).padStart(2, '0')}` : '';
    const label = date === preorderDate ? '预购' : (date === entry.releaseDate ? '发售' : '');
    cells.push({ key: String(index), day: valid ? day : '', label, today: date === fmtDate(now) });
  }
  const stage = launchStage(entry, now);
  return { ...entry, imageDisplayUrl: productThumbnailUrl(entry.imageUrl, 'poster'), id: `${entry.familyKey}:${entry.preorderAt}:${entry.releaseDate}`,
    monthText: `${year} 年 ${month} 月`, cells, weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    preorderDateText: preorderDate.slice(5).replace('-', '.'), releaseDateText: entry.releaseDate.slice(5).replace('-', '.'),
    preorderTimeText: fmtTime(entry.preorderAt).slice(0, 5),
    preorderWeekdayText: weekdayText(preorderDate), releaseWeekdayText: weekdayText(entry.releaseDate),
    stage, stageText: stageText(entry, stage, now),
    preorderState: stage === 'upcoming' ? 'next' : 'done',
    releaseState: stage === 'released' ? 'done' : stage === 'preorder' ? 'next' : 'later' };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayText(date) {
  const [year, month, day] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function launchStage(entry, now) {
  if (now < Date.parse(entry.preorderAt)) return 'upcoming';
  return now < Date.parse(`${entry.releaseDate}T00:00:00+08:00`) ? 'preorder' : 'released';
}

// Hour precision stays accurate while a notice is open without a running timer.
function stageText(entry, stage, now) {
  if (stage === 'released') return '已正式发售';
  if (stage === 'preorder') return '预购进行中';
  const hours = Math.floor((Date.parse(entry.preorderAt) - now) / 3600000);
  if (hours < 1) return '预购即将开始';
  return hours < 24 ? `距预购 ${hours} 小时` : `距预购 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function activeCalendars(now = Date.now(), opening = false) {
  return launches.filter(entry => Number.isFinite(Date.parse(entry.preorderAt))
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)
    && now < Date.parse(opening ? (entry.openingUntil || entry.displayUntil) : entry.displayUntil))
    .map(entry => calendarView(entry, now));
}

function shouldOpenCalendar(entry, saved, now = Date.now()) {
  return Boolean(entry && (!saved || saved.id !== entry.id || (!saved.muted && saved.day !== fmtDate(now))));
}

// Follow readiness comes from the active catalog, independently of the dates.
function withFollowReadiness(calendar, catalog) {
  const products = catalog && catalog.products || [];
  const family = products.filter(product => product.familyKey === calendar.familyKey);
  const supported = family.filter(product => product.supported === true && !product.comingSoon);
  return { ...calendar,
    followNotice: supported.length ? (supported.length === family.length ? '已支持保存关注' : '部分配置已支持保存关注') : '',
    followNoticeDetail: supported.length ? '会员可选择配置与门店，授权后接收提醒。' : '' };
}

/** One-line launch status for the guide entry; generic copy outside a launch window. */
function guideNote(now = Date.now()) {
  const calendar = activeCalendars(now)[0];
  if (!calendar) return '从选择配置，到收到提醒后下单';
  if (calendar.stage === 'upcoming') return `${calendar.title} · ${calendar.preorderDateText} ${calendar.preorderTimeText} 开启预购`;
  if (calendar.stage === 'preorder') return `${calendar.title} · ${calendar.releaseDateText} 正式发售`;
  return `${calendar.title} 已发售 · 查看取货攻略`;
}

module.exports = { activeCalendars, calendarView, guideNote, shouldOpenCalendar, withFollowReadiness };

const launches = require('../config/product-launches');
const { fmtDate, fmtTime } = require('./format');

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
  return { ...entry, id: `${entry.familyKey}:${entry.preorderAt}:${entry.releaseDate}`,
    monthText: `${year} 年 ${month} 月`, cells, weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    preorderDateText: preorderDate.slice(5).replace('-', '.'), releaseDateText: entry.releaseDate.slice(5).replace('-', '.'),
    preorderTimeText: fmtTime(entry.preorderAt).slice(0, 5),
    phase: now < Date.parse(entry.preorderAt) ? '预购准备' : (fmtDate(now) < entry.releaseDate ? '预购已开始' : '已发售'),
    countdown: countdownView(entry, now) };
}

/** Live countdown toward preorder or release; editorial only, no side effects. */
function countdownView(entry, now = Date.now()) {
  const preorderAt = Date.parse(entry.preorderAt);
  const releaseAt = Date.parse(`${entry.releaseDate}T00:00:00+08:00`);
  if (!Number.isFinite(preorderAt)) return null;
  let targetAt = preorderAt;
  let label = '距预购还有';
  if (now >= preorderAt && Number.isFinite(releaseAt) && now < releaseAt) {
    targetAt = releaseAt;
    label = '距正式发售还有';
  } else if (now >= preorderAt && (!Number.isFinite(releaseAt) || now >= releaseAt)) {
    return { label: '已开启', done: true, days: 0, hours: 0, minutes: 0, text: '已开启' };
  }
  const left = Math.max(0, targetAt - now);
  const totalMinutes = Math.floor(left / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} 天`);
  parts.push(`${hours} 小时`);
  parts.push(`${minutes} 分`);
  return { label, done: false, days, hours, minutes, text: parts.join(' ') };
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

module.exports = { activeCalendars, calendarView, countdownView, shouldOpenCalendar };

function fmtDateTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '—';
  return new Date(date.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}
module.exports = { fmtDateTime };

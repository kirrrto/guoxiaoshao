/** Fail closed: an empty or incomplete audit is not evidence of readability. */
export function colorAuditFailures(records) {
  if (!Array.isArray(records) || !records.length) return ['No controls sampled'];
  const active = records.filter(record => !record.disabled);
  if (!active.length) return ['No active controls sampled'];
  return active.flatMap(record => {
    if (record.measurementError) return [`${record.page}/${record.scenario}: ${record.label || record.className || 'control'} ${record.measurementError}`];
    if (!Number.isFinite(record.minRatio) || !Number.isFinite(record.threshold) || record.threshold <= 0) return ['Invalid contrast measurement'];
    return record.minRatio < record.threshold ? [`${record.page}/${record.scenario}: ${record.label || record.className || 'control'} below contrast target`] : [];
  });
}

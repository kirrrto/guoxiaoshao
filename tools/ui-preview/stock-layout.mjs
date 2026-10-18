/** Browser-only checks for follow cards, including native-button cascade regressions. */
export function inspectStockLayout(expected = null) {
  const errors = [], geometry = [];
  if (!expected) return { stockLayoutErrors: errors, stockGeometry: geometry };
  const card = document.querySelector('.follow');
  const text = selector => card?.querySelector(selector)?.textContent.trim() || '';
  if (!card) return { stockLayoutErrors: ['Expected stock card is missing'], stockGeometry: geometry };
  if (text('.follow-stock-label') !== expected.headline) errors.push('Stock headline confuses current availability with a previous result');
  if (text('.follow-stock-time') !== expected.headlineAge) errors.push('Stock headline age does not belong to its displayed result');
  if (card.querySelectorAll('.store-row').length !== (expected.expanded ? 2 : 0)) errors.push('Store details do not respect the requested disclosure state');
  if (Boolean(card.querySelector('.follow-partial-note')) !== expected.partial) errors.push('Mixed fresh and stale stores lost their partial-result note');
  if (Boolean(card.querySelector('[data-preview-action="onPickupInfo"]')) !== expected.pickupAvailable) errors.push('Pickup action must require a fresh available store');
  if (card.classList.contains('follow-available') !== expected.pickupAvailable) errors.push('Historical availability must not receive the current-stock emphasis');
  for (const action of ['onQueryFollow', 'onEdit', 'onViewHistory', 'onRemove']) {
    if (Boolean(card.querySelector(`[data-preview-action="${action}"]`)) !== expected.expanded) errors.push(`Management action ${action} does not follow the detail disclosure`);
  }
  if (Boolean(document.querySelector('[data-preview-action="onRetryAuthorizationSync"]')) !== expected.authorizationPending) errors.push('Authorization sync recovery does not match pending grants');
  if (card.querySelector('.follow-summary, .follow-summary-grid')) errors.push('Stock card reintroduced the redundant reminder summary');
  const button = card.querySelector('[data-preview-action="onToggleFollowDetails"]');
  if (!button) errors.push('Follow detail disclosure is missing');
  else {
    const bounds = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const r = bounds(button), parent = bounds(button.parentElement), ps = getComputedStyle(button.parentElement);
    const left = parent.x + parseFloat(ps.borderLeftWidth) + parseFloat(ps.paddingLeft);
    const right = parent.right - parseFloat(ps.borderRightWidth) - parseFloat(ps.paddingRight);
    const count = button.querySelector('.follow-detail-count'), label = button.querySelector('.follow-detail-label');
    const item = { button: r, container: { left, right, width: right - left }, labels: [] };
    geometry.push(item);
    if (Math.abs(r.x - left) > 1.5 || Math.abs(r.right - right) > 1.5) errors.push(`Follow detail button does not fill its card content (${r.width.toFixed(1)} / ${(right - left).toFixed(1)})`);
    if (r.height < 43.5) errors.push('Follow detail button touch target is shorter than 44px');
    if (button.scrollWidth > button.clientWidth + 1) errors.push('Follow detail button content is clipped');
    for (const [name, element] of [['count', count], ['label', label]]) {
      if (!element) { errors.push(`Follow detail ${name} is missing`); continue; }
      const box = bounds(element), lines = [], rects = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          if (!lines.some(top => Math.abs(top - rect.top) < 2)) lines.push(rect.top);
          rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
      }
      item.labels.push({ name, box, lines: lines.length, rects });
      if (lines.length !== 1) errors.push(`Follow detail ${name} must stay on one line (${lines.length} lines)`);
      if (rects.some(rect => rect.left < box.x - 1 || rect.right > box.right + 1) || element.scrollWidth > element.clientWidth + 1) errors.push(`Follow detail ${name} text is clipped`);
      if (box.x < r.x || box.right > r.right + 1 || box.y < r.y || box.bottom > r.bottom + 1) errors.push(`Follow detail ${name} exceeds its button`);
    }
    if (count && label) {
      const a = bounds(count), b = bounds(label);
      if (a.right > b.x - 1) errors.push('Follow detail labels overlap or lose their separation');
      if (Math.abs(a.y + a.height / 2 - b.y - b.height / 2) > 2) errors.push('Follow detail labels are not aligned on one row');
    }
  }
  return { stockLayoutErrors: errors, stockGeometry: geometry };
}

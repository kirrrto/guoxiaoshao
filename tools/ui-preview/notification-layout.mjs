/** Browser-only layout checks for the actual notification-test template. */
export function inspectNotificationLayout(expected = null) {
  const errors = [], buttons = [], cards = [], typography = [];
  if (!expected) return { notificationGeometry: { buttons, cards, typography }, notificationLayoutErrors: errors };
  const close = (a, b) => Math.abs(a - b) <= 1.5;
  const bounds = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const content = element => {
    const r = bounds(element), s = getComputedStyle(element);
    const left = r.x + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
    const right = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
    return { left, right, width: right - left };
  };
  const visible = element => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
  const root = document.querySelector('.test-page');
  if (!visible(root)) { errors.push('Notification test page is missing'); return { notificationGeometry: { buttons, cards, typography }, notificationLayoutErrors: errors }; }
  for (const card of root.querySelectorAll('.test-card')) {
    const box = bounds(card), parent = content(card.parentElement);
    cards.push({ box, parent });
    if (box.x < parent.left - 1.5 || box.right > parent.right + 1.5) errors.push('Notification card exceeds its page content');
    if (innerWidth >= 720 && box.width > 600) errors.push('Notification card is excessively wide on tablet');
  }
  const feedback = [...root.querySelectorAll('button[data-preview-action="onFeedback"]')];
  for (const element of root.querySelectorAll('button')) {
    const box = bounds(element), parent = content(element.parentElement), action = element.dataset.previewAction;
    buttons.push({ action, text: element.textContent.trim(), disabled: element.disabled, box, parent });
    if (box.height < 43.5) errors.push(`${action} touch target is shorter than 44px`);
    if (!feedback.includes(element) && (!close(box.x, parent.left) || !close(box.right, parent.right))) errors.push(`${action} button does not fill its row (${box.width.toFixed(1)} / ${parent.width.toFixed(1)})`);
    if (element.scrollWidth > element.clientWidth + 1.5) errors.push(`${action} button label is clipped`);
    const fontSize = parseFloat(getComputedStyle(element).fontSize);
    typography.push({ action, fontSize });
    if (fontSize < 13.9 || fontSize > 25) errors.push(`${action} button font is outside readable bounds (${fontSize.toFixed(1)}px)`);
  }
  if (feedback.length) {
    if (feedback.length !== 2 || feedback[0].parentElement !== feedback[1].parentElement) errors.push('Feedback choices must share one two-column row');
    else {
      const parent = content(feedback[0].parentElement), first = bounds(feedback[0]), second = bounds(feedback[1]);
      const gap = parseFloat(getComputedStyle(feedback[0].parentElement).columnGap) || 0;
      const width = (parent.width - gap) / 2;
      if (!close(first.width, width) || !close(second.width, width) || !close(first.x, parent.left) || !close(second.right, parent.right) || !close(first.y, second.y) || first.right > second.x - 1) errors.push('Feedback choices do not occupy equal separated columns');
    }
  }
  const action = name => [...root.querySelectorAll(`button[data-preview-action="${name}"]`)];
  const starts = action('onStart'), continues = action('onContinue'), pending = action('onViewPending');
  if (expected.blocked && (starts.length || continues.length)) errors.push('Unresolved sending result must not offer another send');
  if (expected.canContinue && (continues.length !== 1 || starts.length)) errors.push('Authorized test must recover its original request');
  if (expected.canContinue && continues.some(element => element.disabled !== Boolean(expected.busy || expected.loading || !expected.ready || expected.blocked))) errors.push('Original test recovery incorrectly depends on current quota');
  if (expected.pendingOther && (pending.length !== 1 || starts.length)) errors.push('Other pending request must be recoverable without a fresh send');
  if (expected.loading || !expected.ready || expected.balance < 1) {
    if (starts.some(element => !element.disabled)) errors.push('Fresh send is enabled while unavailable or without quota');
  }
  const expectFeedback = ['accepted', 'uncertain'].includes(expected.status);
  if (expectFeedback && starts.some(element => element.classList.contains('test-primary'))) errors.push('Fresh retest incorrectly competes with the result as a primary action');
  if (expectFeedback && feedback.length !== 2) errors.push('Received/not-received feedback choices are missing');
  if (!expectFeedback && feedback.length) errors.push('Feedback is shown before a potentially sent message');
  const needsCheck = Boolean(expected.status || expected.error || !expected.ready || expected.canContinue || expected.pendingOther);
  if (action('onCheck').length !== (needsCheck ? 1 : 0)) errors.push('Original-result recovery control count does not match the current state');
  if ((expected.feedback === 'received' || expected.ready && expected.balance < 1 && !expected.blocked && !expected.canContinue && !expected.pendingOther) && !action('onGoMine').length) errors.push('Return-to-membership control is missing');
  if (expected.status && !visible(root.querySelector('.test-status-heading'))) errors.push('Current test result is missing');
  if (feedback.some(element => element.disabled !== Boolean(expected.busy || expected.loading))) errors.push('Feedback is incorrectly disabled by the unresolved result');
  if (Boolean(expected.showTestRules) !== visible(root.querySelector('.test-rules'))) errors.push('Rules disclosure does not match its expanded state');
  if (Boolean(expected.showTroubleshooting) !== visible(root.querySelector('.test-help-steps'))) errors.push('Troubleshooting disclosure does not match its expanded state');
  for (const [selector, minimum, maximum] of [['.test-title', 20, 36], ['.test-copy', 13, 22], ['.test-tip', 12, 20]]) {
    for (const element of root.querySelectorAll(selector)) {
      const fontSize = parseFloat(getComputedStyle(element).fontSize);
      typography.push({ selector, fontSize });
      if (fontSize < minimum - 0.1 || fontSize > maximum + 0.1) errors.push(`${selector} font is outside readable bounds (${fontSize.toFixed(1)}px)`);
    }
  }
  return { notificationGeometry: { buttons, cards, typography }, notificationLayoutErrors: errors };
}

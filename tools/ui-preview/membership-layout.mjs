/** Runs in the preview browser. Geometry evidence is not native WeChat evidence. */
export function inspectMembershipLayout(expected = null) {
  const errors = [], cards = [], utilities = [], typography = [];
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
  const overlaps = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1.5;
  const packages = [...document.querySelectorAll('.membership-package')];
  for (const [index, element] of packages.entries()) {
    const parent = content(element.parentElement), box = bounds(element), inner = content(element);
    const parts = Object.fromEntries(['heading', 'pricing', 'benefit', 'choice'].map(name => [name, element.querySelector(`.membership-package-${name}`)]));
    const partBounds = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part && bounds(part)]));
    cards.push({ index: index + 1, parent, box, inner, ...partBounds });
    if (!close(box.x, parent.left) || !close(box.right, parent.right)) errors.push(`Package ${index + 1} does not fill its container (${box.width.toFixed(1)} / ${parent.width.toFixed(1)})`);
    if (index && box.y < bounds(packages[index - 1]).bottom - 1.5) errors.push(`Package ${index + 1} overlaps the previous package`);
    for (const [name, part] of Object.entries(parts)) {
      if (!visible(part)) { errors.push(`Package ${index + 1} is missing visible ${name}`); continue; }
      const r = partBounds[name];
      if (r.x < inner.left - 1.5 || r.right > inner.right + 1.5 || part.scrollWidth > part.clientWidth + 1.5) errors.push(`Package ${index + 1} ${name} exceeds the card content`);
    }
    // At small widths leave at least half the row (up to 112px) to the plan's
    // name and entitlement copy; merely fitting inside the viewport is not enough.
    const minimumMainWidth = Math.min(112, inner.width * 0.55);
    for (const name of ['heading', 'benefit']) {
      if (partBounds[name] && partBounds[name].width < minimumMainWidth - 1.5) errors.push(`Package ${index + 1} ${name} is a narrow text column (${partBounds[name].width.toFixed(1)} < ${minimumMainWidth.toFixed(1)})`);
    }
    if (overlaps(partBounds.heading, partBounds.pricing) || overlaps(partBounds.benefit, partBounds.choice)) errors.push(`Package ${index + 1} primary information overlaps its trailing content`);
  }
  const header = document.querySelector('.account-header'), membership = document.querySelector('.membership-card');
  const badge = header?.querySelector('.account-status');
  const account = header && { box: bounds(header), logo: header.querySelector('.account-logo') && bounds(header.querySelector('.account-logo')), content: header.querySelector('.account-header-content') && bounds(header.querySelector('.account-header-content')), status: badge && { text: badge.textContent.trim(), className: badge.className, color: getComputedStyle(badge).color, backgroundColor: getComputedStyle(badge).backgroundColor } };
  if (expected) {
    if (packages.length !== expected.packages) errors.push(`Expected ${expected.packages} membership packages, received ${packages.length}`);
    if (expected.planIds && JSON.stringify(packages.map(element => element.getAttribute('data-plan-id'))) !== JSON.stringify(expected.planIds)) errors.push('Visible package tiers do not match the current purchase mode');
    if (expected.entryActions) {
      const actions = [...(membership?.querySelectorAll('[data-preview-action="onOpenMembershipRenew"], [data-preview-action="onOpenMembershipUpgrade"]') || [])].filter(element => !element.closest('.membership-shop'));
      if (JSON.stringify(actions.map(element => element.textContent.trim())) !== JSON.stringify(expected.entryActions)) errors.push('Membership summary has incorrect purchase entry buttons');
      if (actions.length === 2) {
        const a = bounds(actions[0]), b = bounds(actions[1]);
        if (!close(a.width, b.width) || !close(a.y, b.y) || a.right >= b.x || a.height < 44 || b.height < 44) errors.push('Member renewal and upgrade actions must be equal-width adjacent touch targets');
      }
    }
    if (!visible(membership)) errors.push('Membership card is missing');
    if (expected.accountHeader) {
      if (!visible(header)) errors.push('Account header is missing');
      else {
        if (!membership?.contains(header)) errors.push('Account header is not inside the membership card');
        const logo = header.querySelector('.account-logo'), copy = header.querySelector('.account-header-content');
        if (!visible(logo) || !logo.complete || !logo.naturalWidth) errors.push('Account logo is missing or not loaded');
        if (!visible(copy) || bounds(copy).width < 130) errors.push('Account heading is a narrow text column');
        const status = header.querySelector('.account-status') || (expected.active ? header.querySelector('.account-brand') : null);
        if (!visible(status) || expected.active && !status.textContent.includes('会员') || !visible(header.querySelector('.identity-copy'))) errors.push('Account status or identity-copy control is missing');
        if (expected.accountState) {
          const statusText = { member: '会员已开通', expired: '会员已到期', free: '免费用户' }[expected.accountState];
          if (!badge || badge.textContent.trim() !== statusText || !badge.classList.contains(`account-status-${expected.accountState}`)) errors.push(`Account badge does not identify ${expected.accountState} membership`);
          if (!logo || bounds(logo).width < 55.5 || bounds(logo).height < 55.5) errors.push('Account logo is smaller than the 56px brand size');
        }
        if (logo && copy && overlaps(bounds(logo), bounds(copy))) errors.push('Account logo overlaps account information');
      }
    }
    if (expected.active && !visible(document.querySelector('.member-overview'))) errors.push('Active membership remaining time is missing');
    const links = [...document.querySelectorAll('.account-link')];
    if (links.length !== expected.utilityLinks) errors.push(`Expected ${expected.utilityLinks} utility links, received ${links.length}`);
    const iconSources = new Set();
    for (const [index, link] of links.entries()) {
      const icon = link.querySelector('img'), label = link.querySelector('.ui-disclosure-label'), trailing = link.querySelector('.ui-disclosure-meta') || link.querySelector('.ui-chevron');
      const box = bounds(link), parent = content(link.parentElement);
      utilities.push({ index: index + 1, text: label?.textContent || '', box, icon: icon && bounds(icon) });
      if (!close(box.x, parent.left) || !close(box.right, parent.right)) errors.push(`Utility link ${index + 1} does not fill its row`);
      if (!visible(icon) || !icon.complete || !icon.naturalWidth || bounds(icon).width < 18 || bounds(icon).height < 18) errors.push(`Utility link ${index + 1} is missing a visible loaded icon`);
      if (icon) iconSources.add(icon.src);
      if (!visible(label) || label.scrollWidth > label.clientWidth + 1.5) errors.push(`Utility link ${index + 1} label is missing or clipped`);
      if (icon && label && overlaps(bounds(icon), bounds(label)) || trailing && label && overlaps(bounds(trailing), bounds(label))) errors.push(`Utility link ${index + 1} label overlaps its icon or trailing control`);
    }
    if (iconSources.size !== expected.utilityLinks) errors.push(`Utility links do not have ${expected.utilityLinks} distinct icons`);
    if (expected.notificationEntryInMembership) {
      const entries = [...document.querySelectorAll('.notification-test-entry')];
      if (entries.length !== 1 || !visible(entries[0]) || !membership?.contains(entries[0])) errors.push('Reminder experience entry must be visible exactly once inside membership');
      const text = entries[0]?.textContent.replace(/\s+/g, '') || '';
      const note = entries[0]?.closest('.member-notification-experience')?.querySelector('.notification-test-note');
      const noteText = note?.textContent.replace(/\s+/g, '') || '';
      if (!text.includes('体验微信提醒')) errors.push('Reminder experience entry is missing its label');
      if (!visible(note) || !/1次|1个查询次数/.test(noteText) || !noteText.includes('授权') || !noteText.includes('测试') || !noteText.includes('非真实放货')) errors.push('Reminder experience note is missing cost, authorization or test-message facts');
    }
    for (const [selector, maximum] of [['.member-free-note', 20], ['.member-allowance', 20], ['.member-duration', 20], ['.payment-entry', 24], ['.member-number', 40], ['.balance', 44]]) {
      for (const element of document.querySelectorAll(selector)) {
        const fontSize = parseFloat(getComputedStyle(element).fontSize);
        typography.push({ selector, fontSize, maximum });
        if (fontSize > maximum + 0.1) errors.push(`${selector} font is oversized (${fontSize.toFixed(1)}px > ${maximum}px)`);
      }
    }
  }
  return { membershipGeometry: { cards, account, utilities, typography }, membershipLayoutErrors: errors };
}

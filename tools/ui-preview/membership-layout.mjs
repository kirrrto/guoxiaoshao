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
  const transparent = color => color === 'rgba(0, 0, 0, 0)' || color === 'transparent';

  // Plan rows: one tray, each row a full-width touch target with its parts in place.
  const packages = [...document.querySelectorAll('.membership-package')];
  for (const [index, element] of packages.entries()) {
    const parent = content(element.parentElement), box = bounds(element), inner = content(element);
    const parts = Object.fromEntries(['radio', 'heading', 'pricing', 'benefit'].map(name => [name, element.querySelector(`.membership-package-${name}`)]));
    const partBounds = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part && bounds(part)]));
    cards.push({ index: index + 1, parent, box, inner, ...partBounds });
    if (!close(box.x, parent.left) || !close(box.right, parent.right)) errors.push(`Package ${index + 1} does not fill its container (${box.width.toFixed(1)} / ${parent.width.toFixed(1)})`);
    if (box.height < 43.5) errors.push(`Package ${index + 1} is shorter than a 44px touch target`);
    if (index && box.y < bounds(packages[index - 1]).bottom - 1.5) errors.push(`Package ${index + 1} overlaps the previous package`);
    for (const [name, part] of Object.entries(parts)) {
      if (!visible(part)) { errors.push(`Package ${index + 1} is missing visible ${name}`); continue; }
      const r = partBounds[name];
      if (r.x < inner.left - 1.5 || r.right > inner.right + 1.5 || part.scrollWidth > part.clientWidth + 1.5) errors.push(`Package ${index + 1} ${name} exceeds the row content`);
    }
    // At small widths leave at least half the row (up to 112px) to the plan's
    // name and allowance; merely fitting inside the viewport is not enough.
    const minimumMainWidth = Math.min(112, inner.width * 0.45);
    if (partBounds.heading && partBounds.heading.width < minimumMainWidth - 1.5) errors.push(`Package ${index + 1} heading is a narrow text column (${partBounds.heading.width.toFixed(1)} < ${minimumMainWidth.toFixed(1)})`);
    if (overlaps(partBounds.heading, partBounds.pricing) || overlaps(partBounds.radio, partBounds.heading)) errors.push(`Package ${index + 1} primary information overlaps its neighbours`);
    const selected = element.classList.contains('membership-package-selected');
    const price = element.querySelector('.membership-package-price')?.textContent.trim();
    const standard = element.querySelector('.membership-standard-price')?.textContent.trim();
    const spokenPrice = standard ? '优惠价' + price + '，标准价' + standard : price;
    if (!price || !element.getAttribute('aria-label')?.includes(spokenPrice)) errors.push(`Package ${index + 1} does not announce its displayed price correctly`);
    if (parts.radio && selected === transparent(getComputedStyle(parts.radio).backgroundColor)) errors.push(`Package ${index + 1} radio does not show its selected state`);
    if (selected === transparent(getComputedStyle(element).backgroundColor)) errors.push(`Package ${index + 1} row does not lift when selected`);
  }
  if (packages.length && packages.filter(element => element.classList.contains('membership-package-selected')).length !== 1) errors.push('Exactly one plan must be selected');

  const header = document.querySelector('.account-header'), membership = document.querySelector('.membership-card');
  const badge = header?.querySelector('.account-status');
  const account = header && { box: bounds(header), logo: header.querySelector('.account-logo') && bounds(header.querySelector('.account-logo')), content: header.querySelector('.account-header-content') && bounds(header.querySelector('.account-header-content')), status: badge && { text: badge.textContent.trim(), className: badge.className } };
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
      for (const action of actions) if (bounds(action).height < 43.5) errors.push('Purchase entry is shorter than a 44px touch target');
    }
    if (!visible(membership)) errors.push('Membership section is missing');

    // Identity row: brand mark, status and the copyable account id.
    if (expected.accountHeader) {
      if (!visible(header)) errors.push('Account header is missing');
      else {
        if (!membership?.contains(header)) errors.push('Account header is not inside the membership section');
        const logo = header.querySelector('.account-logo'), mark = logo?.querySelector('img'), copy = header.querySelector('.account-header-content');
        if (!visible(logo) || !mark || !mark.complete || !mark.naturalWidth) errors.push('Account brand mark is missing or not loaded');
        else {
          const box = bounds(logo);
          if (box.width < 43.5 || !close(box.width, box.height)) errors.push('Account brand mark must be a square of at least 44px');
          if (getComputedStyle(logo).overflow !== 'hidden') errors.push('Account brand mark must clip the light margin of its image');
          if (expected.active && (mark.naturalWidth !== 96 || mark.getAttribute('aria-label') !== '果小哨会员标志')) errors.push('Active members must see the named member mark');
        }
        if (!visible(copy) || bounds(copy).width < 130) errors.push('Account heading is a narrow text column');
        const identity = header.querySelector('.identity-copy');
        if (!visible(identity) || bounds(identity).height < 43.5) errors.push('Identity-copy control is missing or shorter than 44px');
        if (expected.accountState) {
          const statusText = { expired: '会员已到期', free: '免费用户' }[expected.accountState];
          if (!badge || !badge.classList.contains(`account-status-${expected.accountState}`)) errors.push(`Account status does not identify ${expected.accountState} membership`);
          else if (statusText ? badge.textContent.trim() !== statusText : !badge.textContent.includes('会员')) errors.push('Account status text does not match the membership state');
        }
        if (logo && copy && overlaps(bounds(logo), bounds(copy))) errors.push('Account brand mark overlaps account information');
      }
    }

    // The pass is the one dark object: top-level, solid fallback, never nested in a tray.
    const passes = [...document.querySelectorAll('.member-pass')];
    const expectsPass = expected.active || expected.offer;
    if (passes.length !== (expectsPass ? 1 : 0)) errors.push(`Expected ${expectsPass ? 1 : 0} member pass, received ${passes.length}`);
    for (const pass of passes) {
      const style = getComputedStyle(pass);
      if (pass.closest('.card')) errors.push('The member pass must not sit inside another tray');
      if (transparent(style.backgroundColor)) errors.push('The member pass needs a solid colour behind its gradient');
      if (membership && (!close(bounds(pass).x, content(membership).left) || !close(bounds(pass).right, content(membership).right))) errors.push('The member pass must span the section');
      const watermark = pass.querySelector('.member-pass-watermark');
      if (!watermark || !watermark.complete || !watermark.naturalWidth) errors.push('The pass watermark did not load');
      if (expected.active) {
        if (!visible(pass.querySelector('.member-overview'))) errors.push('Active membership remaining time is missing');
        const cells = [...pass.querySelectorAll('.member-delivery-cell')];
        if (cells.length !== 2 || cells.some(cell => !visible(cell))) errors.push('The pass must show saved follows and stores per follow');
        const link = pass.querySelector('button.member-delivery-link');
        if (!link || bounds(link).height < 43.5) errors.push('Saved-follows entry must be a 44px touch target');
        if (cells.length === 2 && overlaps(bounds(cells[0]), bounds(cells[1]))) errors.push('Pass allowance cells overlap');
        if (membership.classList.contains('membership-annual') !== (expected.currentPlanId === 'member_365d')) errors.push('The annual accent must follow the current plan');
      } else {
        if (!visible(pass.querySelector('.member-pass-title'))) errors.push('The offer pass is missing its title');
        if (pass.querySelectorAll('.member-pass-benefit').length !== 3) errors.push('The offer pass must list three benefits');
      }
      for (const text of pass.querySelectorAll('.member-pass-title, .member-pass-benefit, .member-renewal, .member-validity, .member-delivery-cell, .member-enhanced')) {
        if (visible(text) && (bounds(text).x < bounds(pass).x - 1.5 || bounds(text).right > bounds(pass).right + 1.5)) errors.push('Pass text exceeds the pass');
      }
    }

    const links = [...document.querySelectorAll('.account-link')];
    if (links.length !== expected.utilityLinks) errors.push(`Expected ${expected.utilityLinks} utility links, received ${links.length}`);
    const iconSources = new Set();
    for (const [index, link] of links.entries()) {
      const icon = link.querySelector('img'), label = link.querySelector('.ui-disclosure-label'), trailing = link.querySelector('.ui-disclosure-meta') || link.querySelector('.ui-chevron');
      const box = bounds(link), parent = content(link.parentElement);
      utilities.push({ index: index + 1, text: label?.textContent || '', box, icon: icon && bounds(icon) });
      if (!close(box.x, parent.left) || !close(box.right, parent.right)) errors.push(`Utility link ${index + 1} does not fill its row`);
      if (box.height < 43.5) errors.push(`Utility link ${index + 1} is shorter than 44px`);
      if (!visible(icon) || !icon.complete || !icon.naturalWidth || bounds(icon).width < 18 || bounds(icon).height < 18) errors.push(`Utility link ${index + 1} is missing a visible loaded icon`);
      if (icon) iconSources.add(icon.src);
      if (!visible(label) || label.scrollWidth > label.clientWidth + 1.5) errors.push(`Utility link ${index + 1} label is missing or clipped`);
      if (icon && label && overlaps(bounds(icon), bounds(label)) || trailing && label && overlaps(bounds(trailing), bounds(label))) errors.push(`Utility link ${index + 1} label overlaps its icon or trailing control`);
    }
    if (iconSources.size !== expected.utilityLinks) errors.push(`Utility links do not have ${expected.utilityLinks} distinct icons`);

    // Rendered type scale: every visible text on the page uses one of the six sizes.
    const scale = expected.fontScale || 1, allowed = [12, 13, 15, 17, 22, 28].map(size => size * scale);
    const page = document.querySelector('.mine-page');
    const seen = new Map();
    for (const element of page ? page.querySelectorAll('*') : []) {
      if (!visible(element) || ![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) continue;
      const fontSize = parseFloat(getComputedStyle(element).fontSize);
      if (!seen.has(fontSize)) seen.set(fontSize, element.className || element.tagName);
    }
    for (const [fontSize, sample] of seen) {
      typography.push({ fontSize, sample });
      if (!allowed.some(size => Math.abs(size - fontSize) < 0.06)) errors.push(`Text is off the type scale: ${fontSize}px (${sample})`);
    }
  }
  return { membershipGeometry: { cards, account, utilities, typography }, membershipLayoutErrors: errors };
}

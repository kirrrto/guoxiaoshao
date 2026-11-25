/** Runs inside the offline Chromium document, never inside WeChat. */
export function inspectDeadlineLayout({ saving = false, conflict = false, unavailable = false } = {}) {
  const deadlineLayoutErrors = [];
  const scopes = [...document.querySelectorAll('.deadline-page, .deadline-home, .inventory-home-heading, .inventory-home-recent')];
  if (!scopes.length) return { deadlineLayoutErrors, deadlineControls: [], deadlineText: [] };
  const visible = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
  const controls = scopes.flatMap(scope => [...scope.querySelectorAll('button, input, .deadline-picker')]).filter(visible);
  const disabled = element => element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
    || element.parentElement?.hasAttribute('disabled') || element.parentElement?.getAttribute('aria-disabled') === 'true';
  const deadlineControls = controls.map(element => {
    const box = element.getBoundingClientRect();
    return { class: element.className, label: element.getAttribute('aria-label') || element.textContent.trim(),
      width: box.width, height: box.height, disabled: disabled(element) };
  });
  for (const control of deadlineControls) if (control.width < 43.99 || control.height < 43.99) deadlineLayoutErrors.push(`Touch target ${control.label || control.class} is ${control.width.toFixed(1)} x ${control.height.toFixed(1)}`);
  const deadlineText = scopes.flatMap(scope => [...scope.querySelectorAll('*')]).filter(element => visible(element) && !element.children.length && element.textContent.trim())
    .map(element => ({ class: element.className, label: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize) }));
  for (const text of deadlineText) if (text.fontSize < 11.99) deadlineLayoutErrors.push(`Functional text ${text.label} is ${text.fontSize.toFixed(1)}px`);
  const manageLabel = document.querySelector('.deadline-home-manage > span');
  if (manageLabel && ['管理', 'Manage'].includes(manageLabel.textContent.trim())) {
    const label = document.createRange();
    label.selectNodeContents(manageLabel);
    if (label.getClientRects().length > 1) deadlineLayoutErrors.push('The short management action wraps mid-word');
  }
  for (const row of document.querySelectorAll('.deadline-home-row')) {
    const date = row.querySelector('.deadline-home-date')?.getBoundingClientRect();
    const title = row.querySelector('.deadline-home-title')?.getBoundingClientRect();
    if (!date || !title || date.right > title.left + 1) deadlineLayoutErrors.push('Due date and item title need separate columns');
    const plan = row.querySelector('.deadline-next-time');
    if (plan && row.querySelector('.deadline-home-state')) deadlineLayoutErrors.push('Scheduled item repeats its status beside the reminder time');
  }
  for (const input of document.querySelectorAll('.deadline-editor input')) if (!input.getAttribute('aria-label')) deadlineLayoutErrors.push('Deadline input is missing an accessible name');
  if (unavailable) {
    for (const element of document.querySelectorAll('button[data-preview-action="onOpenDeadlines"], .deadline-add, button[data-preview-action="onSave"]')) if (visible(element) && !disabled(element)) deadlineLayoutErrors.push('Unavailable service has an enabled create/manage/save action');
  }
  if (saving) {
    const editor = document.querySelector('.deadline-editor');
    if (!editor) deadlineLayoutErrors.push('Saving editor is missing');
    else for (const element of editor.querySelectorAll('button, input, .deadline-picker')) {
      if (!disabled(element)) deadlineLayoutErrors.push(`Saving control is unlocked: ${element.className}`);
    }
  }
  if (conflict) {
    const save = document.querySelector('button[data-preview-action="onSave"]');
    const reload = document.querySelector('button[data-preview-action="onReloadEditor"]');
    if (!save || !disabled(save)) deadlineLayoutErrors.push('Conflicted draft must not be resubmittable');
    if (!reload || disabled(reload)) deadlineLayoutErrors.push('Conflicted draft needs an available explicit reload action');
  }
  return { deadlineLayoutErrors, deadlineControls, deadlineText };
}

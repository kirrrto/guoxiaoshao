/** Browser-only measurements for actual target-picker configuration disclosure. */
export function inspectConfigurationLayout({ expected = false, expanded = false } = {}) {
  const configurationLayoutErrors = [];
  const scope = document.querySelector('.configuration-scope');
  if (!expected) return { configurationLayoutErrors, configurationControls: [], configurationText: [] };
  if (!scope) return { configurationLayoutErrors: ['Mac Studio configuration disclosure is missing'], configurationControls: [], configurationText: [] };
  const visible = element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
  const configurationControls = [...scope.querySelectorAll('button')].filter(visible).map(element => {
    const box = element.getBoundingClientRect();
    return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: box.width, height: box.height };
  });
  for (const control of configurationControls) if (control.width < 43.99 || control.height < 43.99) configurationLayoutErrors.push(`Configuration action ${control.label} is ${control.width.toFixed(1)} x ${control.height.toFixed(1)}`);
  const configurationText = [...scope.querySelectorAll('*')].filter(element => visible(element) && !element.children.length && element.textContent.trim()).map(element => ({ label: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize) }));
  for (const text of configurationText) if (text.fontSize < 11.99) configurationLayoutErrors.push(`Configuration text ${text.label} is ${text.fontSize.toFixed(1)}px`);
  const options = scope.querySelectorAll('.configuration-option').length;
  if (options !== (expanded ? 4 : 0)) configurationLayoutErrors.push(`Expected ${expanded ? 4 : 0} official chip groups, received ${options}`);
  if (!document.querySelector('.component-target-picker .product-copy')?.textContent.includes('MHQJ4CH/A')) configurationLayoutErrors.push('Configuration disclosure lost the supported retail SKU');
  const toggle = scope.querySelector('button[data-preview-action="onToggleConfigurations"]');
  if (!toggle?.getAttribute('aria-label')) configurationLayoutErrors.push('Configuration disclosure is missing its accessible name');
  return { configurationLayoutErrors, configurationControls, configurationText };
}

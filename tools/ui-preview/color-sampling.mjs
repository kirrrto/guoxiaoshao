/** Runs in the preview browser after scrolling the target into view. */
export function visibleColorSamplePoints(element) {
  const points = [], bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return points;
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.visibility !== 'visible' || Number(style.opacity) === 0) return points;
  }
  for (const x of [.32, .5, .68]) for (const y of [.4, .5, .6]) {
    const hit = document.elementFromPoint(bounds.left + bounds.width * x, bounds.top + bounds.height * y);
    // A dialog, sticky heading or fixed footer may cover the control. Its
    // pixels are not the control's background and must never be scored as one.
    if (hit && (hit === element || element.contains(hit))) points.push({ x, y });
  }
  return points;
}

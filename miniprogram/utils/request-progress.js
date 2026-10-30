/** One delayed hint per explicit request; never starts or repeats a request. */
function startProgress(page, slowMessage) {
  stopProgress(page);
  page.setData({ requestSlow: false });
  page.requestProgressTimer = setTimeout(() => {
    page.requestProgressTimer = null;
    if (!page.pageRetired && page.data.querying) page.setData({ requestSlow: true, requestProgressText: slowMessage });
  }, 6000);
}

function stopProgress(page) {
  if (page.requestProgressTimer) clearTimeout(page.requestProgressTimer);
  page.requestProgressTimer = null;
}

module.exports = { startProgress, stopProgress };

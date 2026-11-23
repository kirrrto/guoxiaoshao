'use strict';
const { hasAdminTestAccess } = require('./membership');

const PREVIEW_MARKETS = Object.freeze(['JP', 'TW', 'HK']);

function canPreviewMarket(market, user, config) {
  return PREVIEW_MARKETS.includes(market) && hasAdminTestAccess(user, config);
}

module.exports = { PREVIEW_MARKETS, canPreviewMarket };

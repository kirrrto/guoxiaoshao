'use strict';
const { hasAdminTestAccess, planSnapshot } = require('./membership');

const MEMBER_QUERY_MARKETS = Object.freeze(['JP', 'TW', 'HK', 'US']);

function canPreviewMarket(market, user, config) {
  return MEMBER_QUERY_MARKETS.includes(market) && hasAdminTestAccess(user, config);
}

function canReadMarket(market, user, config, now) {
  return config?.internationalMarkets?.[market] === true
    || (MEMBER_QUERY_MARKETS.includes(market) && planSnapshot(user, now).enhanced);
}

module.exports = { MEMBER_QUERY_MARKETS, canReadMarket, canPreviewMarket };

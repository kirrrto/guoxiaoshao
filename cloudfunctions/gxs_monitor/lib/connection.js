'use strict';
/**
 * Shared-environment identifiers (not secrets). Mirrors config/cloudbase.connection.json
 * at the repository root; keep both in sync when the environment changes.
 */
module.exports = Object.freeze({
  envId: 'flowermean-6gjaxfqhf6c13e88',
  region: 'ap-shanghai',
  resourceAppid: 'wxc6dfebb77650f3a9',
  consumerAppid: 'wxe96ad9e77b602f1b',
  /** Mini programs whose users may use this API. The resource owner is included for console/IDE testing. */
  allowedAppids: ['wxe96ad9e77b602f1b', 'wxc6dfebb77650f3a9'],
});

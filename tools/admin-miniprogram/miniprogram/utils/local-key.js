// Keep operator retries distinct from consumer storage and other environments.
const config = require('../config/cloud');
function localKey(key) { return `gxs_operator:${config.resourceAppid}:${config.resourceEnv}:${key}`; }
module.exports = { localKey };

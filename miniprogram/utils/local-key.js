// Only real-account storage is used. Retired test data has a different prefix.
function localKey(key) { return key; }
module.exports = { localKey };

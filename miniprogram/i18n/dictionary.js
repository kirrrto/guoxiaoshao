// The English dictionary is first required only after English is selected.
function english() {
  const words = require('./unpack')(require('./en'));
  const patterns = [];
  for (const [key, value] of Object.entries(words)) {
    if (!/\{\d+\}/.test(key)) continue;
    const parts = key.split(/(\{\d+\})/);
    const slots = parts.filter((_, i) => i % 2).map(s => Number(s.slice(1,-1)));
    const literals = parts.filter((_, i) => i % 2 === 0);
    if (literals.some(Boolean)) patterns.push({ literals, slots, value });
  }
  patterns.sort((a,b) => b.literals.join('').length - a.literals.join('').length);
  return { words, patterns };
}
module.exports = { english };

const { text } = require('./translate');
const literalsByView = new Map();
const ideograph = /[\u2e80-\u9fff]/;
let dictionaryKeys;

function literalWords(scope, full) {
  if (!literalsByView.has(scope)) {
    if (!dictionaryKeys) dictionaryKeys = Object.keys(full.words);
    const indices = require('./en')[2][scope];
    if (!indices) throw Error('Missing English view scope: ' + scope);
    const words = {};
    for (const i of indices) words[dictionaryKeys[i]] = full.words[dictionaryKeys[i]];
    literalsByView.set(scope, words);
  }
  return literalsByView.get(scope);
}

function collect(value, full, words) {
  if (typeof value === 'string') {
    // Track trusted dictionary entries used by the normal translator, including
    // the product/color/store inside a composed label. Never copy raw user text.
    const exact = full.words[value];
    if (typeof exact === 'string') words.set(value, exact);
    else if (ideograph.test(value)) text(full, value, (key, en) => words.set(key, en));
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, full, words);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collect(item, full, words);
  }
}

function replacePath(value, parts, index, replacement) {
  if (index === parts.length) return replacement;
  const key = parts[index];
  const copy = Array.isArray(value) ? value.slice() : { ...value };
  copy[key] = replacePath(value && value[key], parts, index + 1, replacement);
  return copy;
}

// The logic layer retains the full dictionary for system dialogs and toasts.
// The renderer needs only template literals and the current page/component data.
function attachView(instance, scope, full) {
  const fixed = literalWords(scope, full);
  const fields = new Map();
  let current = fixed;
  function update(patch) {
    let changed = false;
    const affected = new Map();
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.match(/[^.[\]]+/g);
      const root = parts[0];
      if (root === 'ui') continue;
      // WeChat applies data-path writes synchronously. Project just the affected
      // branches for this render, including overlapping paths in the same patch.
      const source = affected.has(root) ? affected.get(root) : instance.data[root];
      affected.set(root, replacePath(source, parts, 1, value));
    }
    for (const [root, value] of affected) {
      const before = fields.get(root);
      const next = new Map();
      collect(value, full, next);
      if (next.size === (before?.size || 0) && [...next.keys()].every(k => before.has(k))) continue;
      changed = true;
      if (next.size) fields.set(root, next);
      else fields.delete(root);
    }
    if (!changed) return;
    const words = { ...fixed };
    for (const values of fields.values()) for (const [key, en] of values) words[key] = en;
    if (Object.keys(words).length === Object.keys(current).length && Object.keys(words).every(k => current[k] === words[k])) return;
    current = words;
    return words;
  }

  update(instance.data);
  const nativeSetData = instance.setData;
  instance.setData = function (patch, callback) {
    const words = update(patch);
    // Include new translations in the same render as their data and preserve
    // WeChat's callback and data-path behavior for existing callers.
    return nativeSetData.call(this, words ? { ...patch, 'ui.words': words } : patch, callback);
  };
  instance._updateLanguageProperties = props => {
    const words = update(props);
    if (words) nativeSetData.call(instance, { 'ui.words': words });
  };
  instance._detachLanguageView = () => {
    instance.setData = nativeSetData;
    instance._updateLanguageProperties = null;
    instance._detachLanguageView = null;
  };
  return { words: current, patterns: full.patterns };
}
module.exports = { attachView };

import path from 'node:path';
import { parse } from 'acorn';
import { packageRoot, registeredPages } from '../lib/mini-packages.mjs';

// Only executable imports count. Comments or guide text can contain a require example.
function staticScriptImports(source) {
  const imports = [];
  function visit(node) {
    if (!node?.type) return;
    const request = node.type === 'CallExpression' && node.callee.name === 'require'
      ? node.arguments[0] : node.source;
    if (node.type !== 'ImportExpression' && typeof request?.value === 'string') imports.push(request.value);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child?.type) visit(child);
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  return imports;
}

// Each page starts in its registered package. Component declarations and JS
// imports pass that ownership on to every transitive dependency, including cycles.
function misplacedMainScripts(app, dependencies) {
  const owners = new Map();
  function visit(file, owner) {
    if (!dependencies.has(file)) return;
    const usedBy = owners.get(file) || new Set();
    if (usedBy.has(owner)) return;
    owners.set(file, usedBy.add(owner));
    for (const child of dependencies.get(file)) visit(child, owner);
  }
  visit('app.js', '');
  for (const page of registeredPages(app)) visit(page + '.js', packageRoot(app, page));

  const issues = [];
  for (const file of [...dependencies.keys()].sort()) {
    if (packageRoot(app, file)) continue;
    const usedBy = owners.get(file) || new Set();
    if (!usedBy.has('')) issues.push({ file, usedByPackages: [...usedBy].sort() });
  }
  return issues;
}

export function analyzePackageImports(app, packagedFiles, exclusions, readFile) {
  const excludedImports = [], crossPackageImports = [], missingScriptImports = [];
  const packaged = new Set(packagedFiles);
  const scriptDependencies = new Map(packagedFiles.filter(file => file.endsWith('.js')).map(file => [file, []]));
  for (const relative of packagedFiles.filter(file => /\.(?:js|wxs|json|wxml|wxss)$/.test(file))) {
    const contents = readFile(relative);
    let references;
    if (relative.endsWith('.json')) references = Object.values(JSON.parse(contents).usingComponents || {});
    else if (relative.endsWith('.js')) references = staticScriptImports(contents);
    else {
      const pattern = relative.endsWith('.wxss') ? /(?:@import\s+['"]|url\(\s*['"]?)([^'"\s)]+)['"]?/g
        : relative.endsWith('.wxml') ? /<(?:import|include|wxs|image|cover-image)\b[^>]*?\bsrc\s*=\s*['"]([^'"]+)['"]/g
        : /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
      references = Array.from(contents.matchAll(pattern), match => match[1]);
    }
    for (const specifier of references) {
      if (specifier.includes('://') || specifier.startsWith('data:') || specifier.includes('{{')) continue;
      const target = specifier.startsWith('/') ? specifier.slice(1) : path.posix.join(path.posix.dirname(relative), specifier);
      if (exclusions.has(target) || exclusions.has(target + '.js')) excludedImports.push({ relative, target });
      const importer = relative.replace(/\.json$/, '.js');
      if (scriptDependencies.has(importer) && (relative.endsWith('.json') || specifier.startsWith('.') || specifier.startsWith('/'))) {
        const resolved = [target, target + '.js', target + '.json', target + '/index.js'].find(file => packaged.has(file));
        if (!resolved) missingScriptImports.push({ relative, target });
        else if (scriptDependencies.has(resolved)) scriptDependencies.get(importer).push(resolved);
      }
      const targetBundle = packageRoot(app, target);
      if (targetBundle && targetBundle !== packageRoot(app, relative)) crossPackageImports.push({ relative, target });
    }
  }
  return { excludedImports, crossPackageImports, missingScriptImports, misplacedMainScripts: misplacedMainScripts(app, scriptDependencies) };
}

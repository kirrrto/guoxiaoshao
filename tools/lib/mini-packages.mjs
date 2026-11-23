// Subpackage routes keep the same public path as their source files.
export function registeredPages(app) {
  return [...app.pages, ...(app.subPackages || []).flatMap(group => group.pages.map(page => group.root + '/' + page))];
}

export function packageRoot(app, file) {
  return (app.subPackages || []).find(group => file.startsWith(group.root + '/'))?.root || '';
}

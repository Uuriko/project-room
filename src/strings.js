import catalog from '../strings/en.js';
// Synchronous catalog imports keep first paint independent of network requests.
// Callers escape HTML parameters before inserting translated markup; textContent
// callers pass plain text. Replacement never recursively interprets user data.
export function uiText(key, parameters = {}) {
  if (!Object.hasOwn(catalog, key)) throw new Error(key);
  return catalog[key].replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name) => {
    if (!Object.hasOwn(parameters, name)) throw new Error([key, name].join(':'));
    return String(parameters[name] ?? '');
  });
}

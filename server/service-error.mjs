// Shared typed-error primitive for the server layer.
//
// server/store.mjs used to own ServiceError, which created import cycles:
// server/jev-shadow-journal.mjs and server/spam-quarantine-journal.mjs are
// imported BY store.mjs but also imported ServiceError FROM it. The cycle
// resolves in ESM today, but it is fragile (evaluation order decides which
// side sees an uninitialized binding first). ServiceError now lives here;
// store.mjs re-exports it, so every existing `import { ServiceError } from
// "./store.mjs"` keeps resolving to this exact class object and all
// `instanceof` checks behave identically.

export class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

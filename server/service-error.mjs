// Shared typed-error primitive for the server layer.
//
// server/store.mjs used to own ServiceError, which created import cycles:
// the per-kind journals were imported by store.mjs and imported ServiceError
// from it. ServiceError now lives here. store.mjs re-exports it, and
// server/journal.mjs imports it from this file, so every existing
// `import { ServiceError } from "./store.mjs"` keeps resolving to this exact
// class object and all `instanceof` checks behave identically.

export class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

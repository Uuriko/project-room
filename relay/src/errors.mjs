// Typed relay failures. HTTP handlers turn these into JSON. Anything else
// becomes a generic 500 so a stack or a bearer never leaves the isolate.

export class RelayError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function relayError(status, code, message, extra) {
  return new RelayError(status, code, message, extra);
}

// Enroll failures use the daemon's flat body: { "error": "code_invalid" }.
export function enrollFailure(status, code) {
  const error = new RelayError(status, code, code);
  error.flat = true;
  return error;
}

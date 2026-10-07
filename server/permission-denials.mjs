// Lane E3 (permissions legibility): one-line permission-denial constructor.
//
// Denying call sites use this instead of a bare `fail(403, ...)` so the
// denial names the missing permission token. The token is stamped on the
// thrown ServiceError (symbol-keyed, never serialized); server/http.mjs
// reads it in the error handler and the AX layer (src/agent-error.mjs)
// renders a permission-aware hint/next: the token plus the real recovery
// (POST the room's /access-requests, which the owner reviews) instead of
// the legacy "ask the owner to mint a guest invite" dead end.
//
// Fail-closed: an unknown token still throws a valid ServiceError, just
// unannotated — the AX layer falls back to the legacy generic denial.
import { ServiceError } from "./service-error.mjs";
import { annotatePermissionDenial, isPermissionToken } from "../src/agent-error.mjs";

export { annotatePermissionDenial, isPermissionToken };

export function permissionDenial(status, code, message, permission) {
  return annotatePermissionDenial(new ServiceError(status, code, message), permission);
}

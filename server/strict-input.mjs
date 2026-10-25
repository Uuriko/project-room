// Unknown keys on search, event filters, and strict write bodies are 422.
// `next` is reserved on error detail, so the handler stamps it here from
// the offending key and the keys the route accepts.

export const SEARCH_QUERY_KEYS = Object.freeze(["q", "kind", "limit", "before", "cursor", "auth"]);
export const EVENT_QUERY_KEYS = Object.freeze(["after", "limit", "actor", "since", "until", "type", "mentions", "compact", "auth", "tail"]);

export function applyStrictInputNext(errorBody, strictInput) {
  if (!errorBody || !strictInput || typeof strictInput !== "object") return errorBody;
  const offending = (Array.isArray(strictInput.offending) ? strictInput.offending : [strictInput.offending])
    .filter(key => typeof key === "string" && key.length > 0);
  const accepted = (Array.isArray(strictInput.accepted) ? strictInput.accepted : [])
    .filter(key => typeof key === "string");
  const named = offending.length ? offending.join(", ") : "the extra field";
  const allowed = accepted.length ? accepted.join(", ") : "none";
  const command = `Offending: ${named}. Accepted keys: ${allowed}. Resend without the extra fields.`;
  errorBody.hint = command;
  errorBody.next = [{ command }];
  return errorBody;
}

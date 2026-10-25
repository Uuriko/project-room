import { humanErrorMessage } from "./error-copy.js";
import { uiText } from "./strings.js";

// Fields that name one write. A retry that mints a fresh one of these still
// means the same post when the rest of the body matches an unanswered attempt.
const KEY_FIELDS = ["id", "requestId", "idempotencyKey"];

function stable(value) {
  if (Array.isArray(value)) return ["[", value.map(item => stable(item)).join(","), "]"].join("");
  if (value && typeof value === "object") {
    const parts = Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => [JSON.stringify(key), stable(value[key])].join(":"));
    return ["{", parts.join(","), "}"].join("");
  }
  return JSON.stringify(value ?? null);
}

export function createWriteRetries() {
  const pending = new Map();
  return {
    // Remember this write until a response settles it. An unanswered retry
    // with the same payload reuses the key, including a freshly minted id.
    claim(method, path, data) {
      const record = data && typeof data === "object" && !Array.isArray(data) ? data : null;
      const rest = record ? { ...record } : data ?? null;
      if (record) for (const name of KEY_FIELDS) delete rest[name];
      const fingerprint = [method, path, stable(rest)].join("\n");
      const field = record && KEY_FIELDS.find(name => typeof record[name] === "string" && record[name]);
      const stored = pending.get(fingerprint);
      if (stored && field) record[field] = stored;
      const key = stored || (field ? record[field] : crypto.randomUUID());
      pending.set(fingerprint, key);
      return { fingerprint, key };
    },
    settle(claim, keep) {
      if (!claim) return;
      if (keep) pending.set(claim.fingerprint, claim.key);
      else pending.delete(claim.fingerprint);
    }
  };
}

function maybeSaved(status) {
  const error = new Error(uiText("error.maybeSaved"));
  error.code = "maybe_saved";
  error.unconfirmed = true;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function roomBusy(status) {
  const error = new Error(uiText("error.roomBusy"));
  error.code = "room_busy";
  if (Number.isInteger(status)) error.status = status;
  return error;
}

const lostTransport = error => error?.name === "AbortError" || error?.name === "TimeoutError";

// A proxy HTML page (Cloudflare 502/524) is not JSON. A write that ends this
// way, or whose request was aborted, may already be stored.
export async function settleResponse(response, { write = false } = {}) {
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    if (lostTransport(error)) throw error;
    const status = response.status;
    if (write && (status === 502 || status === 524)) throw maybeSaved(status);
    if (status === 502 || status === 524) throw roomBusy(status);
    const fallback = new Error(humanErrorMessage({ status }));
    fallback.status = status;
    throw fallback;
  }
  if (!response.ok) {
    const serverError = body?.error ?? {};
    const error = new Error(humanErrorMessage({ status: response.status, code: serverError.code, message: serverError.message }));
    error.status = response.status;
    error.code = serverError.code;
    if (body?.proof) error.proof = body.proof;
    throw error;
  }
  return body;
}

export function unansweredWrite(error) {
  if (!lostTransport(error) || error?.code === "maybe_saved") return null;
  const wrapped = maybeSaved(error.status);
  wrapped.cause = error;
  return wrapped;
}

export const writeMethod = method => {
  const verb = String(method || "GET").toUpperCase();
  return verb !== "GET" && verb !== "HEAD";
};

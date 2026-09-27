import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

const exact = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
};

// The room supplies data, never an instruction, capability or execution policy.
// This label is not an LLM prompt-injection defense; the OS isolation enforces
// the no-network/no-ambient-file boundary even if a model obeys hostile text.
export function createHostEnvelope(input) {
  exact(input, ["requestId", "request", "messages", "preparation"], "host input");
  if (typeof input.requestId !== "string" || !input.requestId || !input.request
    || typeof input.request !== "object" || !Array.isArray(input.messages)
    || !input.preparation || typeof input.preparation !== "object") throw new Error("Invalid host input shape");
  let snapshot;
  try {
    const value = JSON.stringify({ requestId: input.requestId, request: input.request,
      messages: input.messages, preparation: input.preparation });
    snapshot = JSON.parse(value);
    if (typeof snapshot.requestId !== "string" || !snapshot.requestId || !snapshot.request
      || typeof snapshot.request !== "object" || Array.isArray(snapshot.request) || !Array.isArray(snapshot.messages)
      || !snapshot.preparation || typeof snapshot.preparation !== "object" || Array.isArray(snapshot.preparation))
      throw new Error("Invalid host input shape");
  }
  catch { throw new Error("Host input must be JSON serializable"); }
  return { version: 1, kind: "project-room-addressed-request", context: { trust: "untrusted-room-data", ...snapshot } };
}

// Operator-only fixed profile. No room data or model output is allowed here.
export function validateHostPolicy(policy, cwd) {
  exact(policy, ["version", "checkout", "filesystem", "network", "ambientSecrets", "externalEffects"], "host policy");
  if (policy.version !== 1 || policy.filesystem !== "checkout-write" || policy.network !== "none"
    || policy.ambientSecrets !== "none" || policy.externalEffects !== "none"
    || !isAbsolute(policy.checkout ?? "") || !isAbsolute(cwd ?? "")) throw new Error("Unsupported host policy");
  let checkout, actual;
  try { checkout = realpathSync(policy.checkout); actual = realpathSync(cwd); }
  catch { throw new Error("Host policy checkout is unavailable"); }
  // Refuse aliases as well as different roots, rather than silently blessing a
  // symlinked path that later changes its destination.
  if (checkout !== policy.checkout || actual !== cwd || checkout !== actual)
    throw new Error("Host policy checkout must match the real workspace root");
  return { version: 1, checkout, filesystem: "checkout-write", network: "none",
    ambientSecrets: "none", externalEffects: "none" };
}

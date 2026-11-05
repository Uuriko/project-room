import { terminalWork } from "../src/workflow.js";

// Shared pure board state selectors; no repository or storage dependency.
const msOf = value => (typeof value === "string" ? Date.parse(value) : Number.NaN);

export function boardStateForWorkItem(item, nowMs) {
  switch (item?.state) {
    case "superseded": return "closed";
    case "completed": return terminalWork(item) ? "done" : "delivered";
    case "blocked": return "blocked";
    case "working": return "in_progress";
    case "accepted": return liveClaim(item, nowMs) ? "claimed" : "unclaimed";
    default: return "unclaimed"; // proposed
  }
}

export function liveClaim(item, nowMs) {
  const claim = item?.claim;
  if (!claim || claim.status !== "active") return null;
  const expires = msOf(claim.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return null;
  return claim;
}


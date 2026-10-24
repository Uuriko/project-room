// Live collision warnings. Given the files an agent is about to touch and the
// room's open claims, say who already holds each file in one plain sentence,
// e.g. "Codex's agent is editing src/app.js (claim c-12)". Matching folds case
// so SRC/app.js and src/app.js warn on case-insensitive filesystems (macOS,
// Windows) even though claim leases keep case. Directory claims cover their
// children. Pure module: no I/O.
const CLOSED = new Set(["done", "withdrawn", "closed", "expired", "released", "rejected"]);

export function normalizePath(path) {
  if (typeof path !== "string") return null;
  const parts = [];
  for (const part of path.trim().replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

const covers = (held, wanted) => held === wanted || wanted.startsWith(held + "/");

export function collisionWarnings(files, claims, { self = null } = {}) {
  const wanted = [...new Set((Array.isArray(files) ? files : []).map(normalizePath).filter(Boolean))];
  const warnings = [];
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (!claim || typeof claim.id !== "string") continue;
    if (CLOSED.has(String(claim.status ?? "").toLowerCase())) continue;
    if (self && (claim.ownerId === self || claim.id === self)) continue;
    const held = (Array.isArray(claim.files) ? claim.files : []).map(normalizePath).filter(Boolean);
    for (const file of wanted) {
      const hit = held.find(h => covers(h, file) || covers(h.toLowerCase(), file.toLowerCase()));
      if (!hit) continue;
      const caseOnly = !covers(hit, file);
      const who = claim.ownerName ? `${claim.ownerName}'s agent` : "Another agent";
      warnings.push(Object.freeze({
        file, heldPath: hit, claimId: claim.id, owner: claim.ownerName ?? null, caseOnly,
        text: `${who} is editing ${hit}${caseOnly ? ` (same file as ${file} on macOS and Windows)` : ""} (claim ${claim.id})`,
      }));
    }
  }
  warnings.sort((a, b) => a.file.localeCompare(b.file) || a.claimId.localeCompare(b.claimId));
  return Object.freeze(warnings);
}

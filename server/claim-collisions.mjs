// Claim file-collision detector (RC-2026-09-18-045).
//
// Parallel lanes collide on shared files unless the protocol prevents it:
// claims name the exact files they will touch, and open claims with
// overlapping file lists are flagged BEFORE work starts. This module is the
// pure, dependency-free detector: given board claims with file lists, it
// returns every file claimed by two or more open claims.
//
// Pure module: no I/O, frozen outputs, malformed inputs throw
// ClaimCollisionError (coded errors).
class ClaimCollisionError extends Error {
  constructor(code, message) { super(message); this.name = "ClaimCollisionError"; this.code = code; }
}
const fail = (code, message) => { throw new ClaimCollisionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_collision_input", message); };

// Claims in these states no longer hold their files; they are ignored.
const CLOSED_STATUSES = ["done", "withdrawn", "closed", "expired", "released", "rejected"];

// Normalize a claimed path: trim, drop leading ./, collapse duplicate
// slashes, drop trailing slashes. Case is preserved (repo paths are
// case-sensitive).
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const normalizeFile = path => {
  check(typeof path === "string" && path.trim().length > 0, "files must be non-empty strings");
  check(!CONTROL_CHAR_RE.test(path), "files must not contain control characters");
  // Unicode canonicalization: NFD and NFC spellings name the same file
  // (e.g. café.mjs); without it two claims on the same file silently miss.
  let p = path.normalize("NFC").trim().replace(/\/+/g, "/");
  // Absolute paths are outside the repo-relative contract. Folding /x into
  // x would hide the author's intent instead of refusing it.
  check(!p.startsWith("/"), "files must be repo-relative paths, not absolute");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const parts = [];
  for (const part of p.split("/")) {
    // A "." segment is never a directory, so src/./app.js is src/app.js.
    // Empty segments come from duplicate slashes; both are dropped before
    // ".." resolution.
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Interior ".." climbs inside the root (src/foo/../app.js). A ".."
      // with nothing left to pop escapes the repo root and is rejected —
      // keeping it as a key would silently bless a traversal.
      if (parts.length === 0) fail("invalid_collision_input", "files must not escape the repo root (..)");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  p = parts.join("/");
  check(p.length > 0 && p !== ".", "files must name a real path");
  return p;
};

const validateClaim = claim => {
  check(claim !== null && typeof claim === "object", "claims must be objects");
  check(typeof claim.id === "string" && claim.id.length > 0, "claim.id must be a non-empty string");
  check(Array.isArray(claim.files), "claim.files must be an array");
  check(claim.status === undefined || typeof claim.status === "string",
    "claim.status must be a string if given");
  check(claim.lane === undefined || typeof claim.lane === "string",
    "claim.lane must be a string if given");
  const files = [...new Set(claim.files.map(normalizeFile))].sort();
  return { id: claim.id, lane: claim.lane ?? null, status: claim.status ?? "submitted", files };
};

// Find file collisions across open claims. Returns a frozen array of
// { file, claims: [ids], lanes: [lanes] } sorted by file. Claims in a closed
// status (done/withdrawn/closed/expired/released/rejected) are ignored, as
// are duplicate file entries within a single claim.
export function findClaimCollisions(claims) {
  check(Array.isArray(claims), "claims must be an array");
  const open = claims.map(validateClaim)
    .filter(c => !CLOSED_STATUSES.includes(c.status.toLowerCase()));
  const byFile = new Map();
  for (const claim of open) {
    for (const file of claim.files) {
      if (!byFile.has(file)) byFile.set(file, []);
      const holders = byFile.get(file);
      if (!holders.some(h => h.id === claim.id)) holders.push(claim);
    }
  }
  const collisions = [...byFile.entries()]
    .filter(([, holders]) => holders.length > 1)
    .map(([file, holders]) => Object.freeze({
      file,
      claims: Object.freeze(holders.map(h => h.id).sort()),
      lanes: Object.freeze([...new Set(holders.map(h => h.lane).filter(Boolean))].sort()),
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return Object.freeze(collisions);
}

// Convenience: true when the claim set has no open file collisions.
export function claimsAreCollisionFree(claims) {
  return findClaimCollisions(claims).length === 0;
}

export { ClaimCollisionError };

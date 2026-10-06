// Compact read of the existing work-claim list. One pull can show which
// open claims already declare the same file. This does not create a claim,
// post a message, or start a worker.
import { findClaimCollisions } from "../server/claim-collisions.mjs";

const ACTIVE = new Set(["claimed", "in_progress", "blocked"]);

export function normalizeClaimPath(path) {
  if (typeof path !== "string" || path.trim().length === 0 || path.length > 512) {
    const error = new Error("invalid_text_plug");
    error.code = "invalid_text_plug";
    throw error;
  }
  let normalized = path.trim().replace(/\/+/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    const error = new Error("invalid_text_plug");
    error.code = "invalid_text_plug";
    throw error;
  }
  return normalized;
}

function activeClaims(claims) {
  if (!Array.isArray(claims)) return [];
  return claims.filter(item => item && typeof item.id === "string" && ACTIVE.has(item.state));
}

export function swarmBriefFromClaims(roomId, claims, { limit = 20 } = {}) {
  const open = activeClaims(claims);
  const declared = open.filter(item => Array.isArray(item.files) && item.files.length > 0);
  let collisions = [];
  try {
    collisions = findClaimCollisions(declared.map(item => ({
      id: item.id,
      lane: typeof item.owner === "string" ? item.owner : undefined,
      status: item.state,
      files: item.files,
    })));
  } catch {
    collisions = [];
  }
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 20;
  return {
    roomId,
    open: open.length,
    collisions: collisions.slice(0, cap).map(row => ({
      file: row.file,
      claims: [...row.claims],
      owners: [...row.lanes],
    })),
    truncated: collisions.length > cap,
  };
}

export function holdersForPath(claims, path) {
  const wanted = normalizeClaimPath(path);
  const rows = [];
  for (const item of activeClaims(claims)) {
    if (!Array.isArray(item.files)) continue;
    const files = item.files.filter(file => {
      try { return normalizeClaimPath(file) === wanted; } catch { return false; }
    });
    if (!files.length) continue;
    rows.push({
      id: item.id,
      owner: typeof item.owner === "string" ? item.owner : null,
      state: item.state,
      leaseExpiresAt: typeof item.leaseExpiresAt === "string" ? item.leaseExpiresAt : null,
    });
  }
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return rows;
}

export function resolveMemberId(members, token) {
  if (typeof token !== "string" || !token.trim()) return null;
  const rows = Array.isArray(members) ? members : [];
  const active = rows.filter(row => row && row.active !== false && typeof (row.memberId ?? row.id) === "string");
  const exact = active.find(row => (row.memberId ?? row.id) === token);
  if (exact) return exact.memberId ?? exact.id;
  const named = active.filter(row => {
    const name = row.displayName ?? row.name;
    return typeof name === "string" && name.toLowerCase() === token.toLowerCase();
  });
  if (named.length === 1) return named[0].memberId ?? named[0].id;
  return null;
}

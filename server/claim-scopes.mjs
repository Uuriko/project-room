// Live admission policy, not a change to historical event replay. Reservations
// coordinate this room only; they neither authorize nor stop external execution.
import { claimRepositoryOf, claimBranchOf, normalizeClaimRepository, ClaimError } from './work-claims.mjs';
import { activeClaim } from '../src/workflow.js';

export class ClaimScopeError extends Error {
  constructor(message) { super(message); this.status = 422; this.code = 'invalid_claim_scope'; }
}

// Live admission only. The reducer still accepts an older event whose lease
// or ** was valid when it was recorded.
export const CLAIM_MAX_LEASE_MS_DEFAULT = 24 * 60 * 60 * 1000;

export function claimMaxLeaseMs(env = globalThis.process?.env ?? {}) {
  const raw = env.CLAIM_MAX_LEASE_MS;
  if (raw == null || raw === "") return CLAIM_MAX_LEASE_MS_DEFAULT;
  if (!/^[1-9]\d*$/.test(String(raw))) return CLAIM_MAX_LEASE_MS_DEFAULT;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : CLAIM_MAX_LEASE_MS_DEFAULT;
}

export function claimLeaseRefusal(incoming, maxLeaseMs = claimMaxLeaseMs()) {
  if (incoming.type !== "claim.acquired" && incoming.type !== "claim.renewed") return null;
  const expiresAt = Date.parse(incoming.data?.expiresAt);
  const at = Date.parse(incoming.at);
  if (!(Number.isFinite(expiresAt) && Number.isFinite(at) && expiresAt - at > maxLeaseMs)) return null;
  const hours = maxLeaseMs / 3_600_000;
  const window = Number.isInteger(hours) && hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.ceil(maxLeaseMs / 60_000)} minutes`;
  return `Claim expiry must be within ${window}. Renew the claim to extend it.`;
}

export function wholeRepoClaimRefusal(incoming, canDecide) {
  if (incoming.type !== "claim.acquired") return null;
  if (!Array.isArray(incoming.data?.paths) || !incoming.data.paths.some(path => path === "**")) return null;
  if (canDecide) return null;
  return "A claim covering a whole repository with ** needs the decide permission.";
}

function pathScope(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f\\]/.test(value)) {
    throw new ClaimScopeError('Use explicit relative paths or a folder followed by /**.');
  }
  if (value === '**') return { path: '', subtree: true };
  const subtree = value.endsWith('/**');
  const path = (subtree ? value.slice(0, -3) : value).replace(/^\.\//, '');
  if (!path || /[*?\[\]{}]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new ClaimScopeError('Use explicit relative paths, folder/**, or ** for the whole repository.');
  }
  return { path, subtree };
}

export function claimScope(claim) {
  for (const key of ['repository', 'ref']) {
    if (typeof claim[key] !== 'string' || !claim[key] || claim[key] !== claim[key].trim() || /[\x00-\x1f\x7f]/.test(claim[key])) {
      throw new ClaimScopeError('Repository and revision must be explicit, without surrounding whitespace.');
    }
  }
  try { claimRepositoryOf(normalizeClaimRepository(claim.repository)); }
  catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    throw new ClaimScopeError('Use a repository name of at most 200 letters, numbers, dots, underscores, slashes or hyphens, or a public HTTPS GitHub repository URL.');
  }
  try { claimBranchOf(claim.ref); }
  catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    throw new ClaimScopeError('Use a ref of at most 200 letters, numbers, dots, underscores, slashes or hyphens.');
  }
  if (!Array.isArray(claim.paths) || !claim.paths.length) throw new ClaimScopeError('Choose at least one path.');
  return claim.paths.map(pathScope);
}

const covers = (scope, other) => scope.path === other.path || (scope.subtree && (!scope.path || other.path.startsWith(scope.path + '/')));

export function conflictingClaim(workItems, candidate, now) {
  const paths = claimScope(candidate.claim);
  const repository = normalizeClaimRepository(candidate.claim.repository);
  for (const item of Object.values(workItems)) {
    if (item.id === candidate.id || !activeClaim(item, now)) continue;
    const claim = item.claim;
    // Repository identities unify public GitHub URLs with owner/name; refs remain
    // declared strings, not proofs of external isolation. Cross-room coordination is deliberately not claimed.
    const otherRepository = normalizeClaimRepository(claim.repository);
    const githubAlias = repository !== candidate.claim.repository || otherRepository !== claim.repository;
    const sameRepository = typeof otherRepository === "string" && (githubAlias
      ? otherRepository.toLowerCase() === repository.toLowerCase() : otherRepository === repository);
    if (!sameRepository || claim.ref !== candidate.claim.ref) continue;
    let existing;
    try { existing = claimScope(claim); }
    catch { return item; } // Ambiguous legacy scope needs explicit release/review.
    if (paths.some(path => existing.some(other => covers(path, other) || covers(other, path)))) return item;
  }
  return null;
}

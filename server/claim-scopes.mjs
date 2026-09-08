// Live admission policy, not a change to historical event replay. Reservations
// coordinate this room only; they neither authorize nor stop external execution.
import { activeClaim } from '../src/workflow.js';

export class ClaimScopeError extends Error {
  constructor(message) { super(message); this.status = 422; this.code = 'invalid_claim_scope'; }
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
  if (!Array.isArray(claim.paths) || !claim.paths.length) throw new ClaimScopeError('Choose at least one path.');
  return claim.paths.map(pathScope);
}

const covers = (scope, other) => scope.path === other.path || (scope.subtree && (!scope.path || other.path.startsWith(scope.path + '/')));

export function conflictingClaim(workItems, candidate, now) {
  const paths = claimScope(candidate.claim);
  for (const item of Object.values(workItems)) {
    if (item.id === candidate.id || !activeClaim(item, now)) continue;
    const claim = item.claim;
    // Repository and ref are declared identities, not resolved aliases or proofs
    // of external isolation. Cross-room coordination is deliberately not claimed.
    if (claim.repository !== candidate.claim.repository || claim.ref !== candidate.claim.ref) continue;
    let existing;
    try { existing = claimScope(claim); }
    catch { return item; } // Ambiguous legacy scope needs explicit release/review.
    if (paths.some(path => existing.some(other => covers(path, other) || covers(other, path)))) return item;
  }
  return null;
}

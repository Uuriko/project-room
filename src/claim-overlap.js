// Shared original claim warning predicate. This records overlaps, never grants
// access or blocks a claim; both full replay and scoped recovery use this leaf.
const claimPath = value => {
  const text = String(value).trim().replace(/^\.\//, "");
  if (text === "**") return { path: "", subtree: true };
  const subtree = text.endsWith("/**");
  return { path: (subtree ? text.slice(0, -3) : text).replace(/\/+$/, ""), subtree };
};
const covers = (scope, other) => scope.path === other.path || (scope.subtree && (!scope.path || other.path.startsWith(`${scope.path}/`)));
export function prepareClaimOverlap(workItemId, repository, paths, at) {
  return { workItemId, mine: paths.map(claimPath), repo: String(repository).trim().toLowerCase(), at };
}
export function matchClaimOverlap(query, other) {
  if (other.id === query.workItemId || !other.claim || !(other.claim.status === "active" && Date.parse(other.claim.expiresAt) > Date.parse(query.at))) return null;
  if (String(other.claim.repository).trim().toLowerCase() !== query.repo) return null;
  const shared = other.claim.paths.filter(path => { const theirs = claimPath(path); return query.mine.some(own => covers(own, theirs) || covers(theirs, own)); });
  return shared.length ? { workItemId: other.id, holderId: other.claim.holderId, paths: shared.slice(0, 16) } : null;
}

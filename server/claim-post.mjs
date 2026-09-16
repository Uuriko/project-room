// Claim-enforcing room.post (B004). A pure post validator for the room's
// write path: a post that references a work item (via workId) is accepted
// only when the posting agent holds an active claim on that work item. Posts
// without a workId pass freely (chat is open); posts from the room owner
// pass freely (the owner outranks claims). The claims list uses the B006
// work-claims shape ({ id, owner, state }); done work is postable by anyone.
// Pure, dependency-free, deterministic; frozen outputs. The HTTP/MCP wiring
// that calls this validator is a later slice.
const ACTIVE = ["claimed", "in_progress", "blocked"];
class PostError extends Error { constructor(code, message) { super(message); this.name = "PostError"; this.code = code; } }
const fail = (code, message) => { throw new PostError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_post", message); };

const postOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "post must be an object");
  check(typeof value.authorId === "string" && value.authorId.length > 0, "post authorId must be text");
  check(typeof value.body === "string" && value.body.length > 0 && value.body.length <= 20000, "post body must be 1..20000 characters");
  if (value.workId !== undefined && value.workId !== null) check(typeof value.workId === "string" && value.workId.length > 0, "workId must be text");
  return value;
};
const claimsOf = value => {
  if (value === undefined || value === null) return [];
  check(Array.isArray(value), "claims must be a list");
  return value.map(claim => {
    check(claim !== null && typeof claim === "object", "claims must be objects");
    check(typeof claim.id === "string", "claim needs an id");
    return claim;
  });
};
// Validate a post. Returns the frozen accepted post ({ authorId, body,
// workId?, enforced: whether a claim check ran }). Throws PostError when a
// work-referencing post lacks a valid claim.
export function validatePost(post, claims, { ownerId } = {}) {
  const item = postOf(post);
  const registry = claimsOf(claims);
  if (item.workId === undefined || item.workId === null) {
    return Object.freeze({ authorId: item.authorId, body: item.body, enforced: false });
  }
  if (ownerId !== undefined && item.authorId === ownerId) {
    return Object.freeze({ authorId: item.authorId, body: item.body, workId: item.workId, enforced: false });
  }
  const claim = registry.find(entry => entry.id === item.workId);
  if (!claim) fail("claim_required", `post references work "${item.workId}" but no claim exists — claim it first`);
  if (claim.state === "done") {
    return Object.freeze({ authorId: item.authorId, body: item.body, workId: item.workId, enforced: true });
  }
  if (!ACTIVE.includes(claim.state) || claim.owner !== item.authorId) {
    fail("claim_required", `post references work "${item.workId}" but ${item.authorId} does not hold an active claim on it`);
  }
  return Object.freeze({ authorId: item.authorId, body: item.body, workId: item.workId, enforced: true });
}
// Batch: partition posts into accepted and refused (for the caller to report).
export function partitionPosts(posts, claims, options = {}) {
  check(Array.isArray(posts), "posts must be a list");
  const accepted = [], refused = [];
  for (const post of posts) {
    try { accepted.push(validatePost(post, claims, options)); }
    catch (error) { refused.push(Object.freeze({ post, code: error.code, reason: error.message })); }
  }
  return Object.freeze({ accepted: Object.freeze(accepted), refused: Object.freeze(refused) });
}
export { PostError, ACTIVE };

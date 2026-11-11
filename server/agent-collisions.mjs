// Collision alerts for agents holding overlapping work.
//
// The board already refuses a second exclusive file lease. This module is
// the advisory side: when two different agents hold live claims that touch
// the same file (including a directory lease), the same pull request, or
// the same repo and branch, both are named in one room post and each agent
// is woken. They coordinate the merge. The exclusive lease is unchanged.
//
// ROOM_COLLISION_ALERTS is off, on, or a comma-separated room list. Off
// posts nothing and wakes nobody. GitHub's pull-request diff is not stored
// on the claim; a pull overlaps when the URL matches, and changedFiles on
// the claim or the pull record count as files when a caller has them.

import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";
import { enqueueClaimWake } from "./work-claim-events.mjs";

const FLAG = "ROOM_COLLISION_ALERTS";
const LIVE = new Set(["claimed", "in_progress", "blocked"]);

export function collisionAlertsEnabled(store, roomId) {
  const bag = store && Object.hasOwn(store, "featureEnv") ? store.featureEnv : process.env;
  const raw = bag && typeof bag[FLAG] === "string" ? bag[FLAG].trim() : "";
  if (raw === "on" || raw === "1" || raw === "true") return true;
  if (!raw || raw === "off" || raw === "0" || raw === "false") return false;
  return raw.split(",").map(part => part.trim()).filter(Boolean).includes(roomId);
}

function slotsOf(claim) {
  const blocks = claim?.fileBlocks && typeof claim.fileBlocks === "object" ? claim.fileBlocks : {};
  const slots = [];
  for (const path of claim?.files ?? []) {
    if (typeof path !== "string" || !path) continue;
    const block = typeof blocks[path] === "string" && blocks[path] ? blocks[path] : null;
    slots.push({ path, block });
  }
  const pulls = Array.isArray(claim?.pullRequests) && claim.pullRequests.length
    ? claim.pullRequests
    : (claim?.pullRequest ? [claim.pullRequest] : []);
  for (const pull of pulls) {
    for (const path of [...(pull?.files ?? []), ...(pull?.changedFiles ?? [])]) {
      if (typeof path === "string" && path.trim()) slots.push({ path: path.trim(), block: null });
    }
  }
  for (const path of claim?.changedFiles ?? []) {
    if (typeof path === "string" && path.trim()) slots.push({ path: path.trim(), block: null });
  }
  return slots;
}

function slotsOverlap(left, right) {
  if (left.path === right.path) return !left.block || !right.block || left.block === right.block;
  if (!left.block && right.path.startsWith(`${left.path}/`)) return true;
  if (!right.block && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

function pullUrls(claim) {
  const pulls = Array.isArray(claim?.pullRequests) && claim.pullRequests.length
    ? claim.pullRequests
    : (claim?.pullRequest ? [claim.pullRequest] : []);
  const urls = [];
  for (const pull of pulls) {
    const url = typeof pull === "string" ? pull : pull?.url;
    if (typeof url === "string" && url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function liveClaims(claims) {
  return (claims ?? []).filter(claim => claim && LIVE.has(claim.state) && typeof claim.owner === "string" && claim.owner);
}

// Pairs of live claims with different owners. Each pair lists the overlap
// parts: { kind: "file"|"pull"|"branch", key }.
export function findAgentOverlaps(claims) {
  const live = liveClaims(claims);
  const pairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const left = live[i];
      const right = live[j];
      if (left.owner === right.owner || left.id === right.id) continue;
      const parts = [];
      const seen = new Set();
      for (const a of slotsOf(left)) {
        for (const b of slotsOf(right)) {
          if (!slotsOverlap(a, b)) continue;
          const key = a.path === b.path ? (a.block && b.block ? `${a.path} (${a.block})` : a.path) : (a.path.length <= b.path.length ? a.path : b.path);
          if (seen.has(key)) continue;
          seen.add(key);
          parts.push({ kind: "file", key });
        }
      }
      for (const url of pullUrls(left)) {
        if (pullUrls(right).includes(url)) parts.push({ kind: "pull", key: url });
      }
      if (left.repo && left.branch && left.repo === right.repo && left.branch === right.branch) {
        parts.push({ kind: "branch", key: `${left.repo}@${left.branch}` });
      }
      if (parts.length === 0) continue;
      const [first, second] = left.id < right.id ? [left, right] : [right, left];
      pairs.push(Object.freeze({
        left: Object.freeze({ claimId: first.id, owner: first.owner }),
        right: Object.freeze({ claimId: second.id, owner: second.owner }),
        parts: Object.freeze(parts)
      }));
    }
  }
  pairs.sort((a, b) => (a.left.claimId < b.left.claimId ? -1 : a.left.claimId > b.left.claimId ? 1 : a.right.claimId < b.right.claimId ? -1 : 1));
  return Object.freeze(pairs);
}

function plain(value) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function detailOf(parts) {
  const files = parts.filter(part => part.kind === "file").map(part => part.key);
  const pulls = parts.filter(part => part.kind === "pull").map(part => part.key);
  const branches = parts.filter(part => part.kind === "branch").map(part => part.key);
  const bits = [];
  if (files.length) bits.push(`files ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}`);
  if (pulls.length) bits.push(`pull request ${pulls.slice(0, 4).join(", ")}`);
  if (branches.length) bits.push(`branch ${branches.join(", ")}`);
  return bits.join("; ");
}

function memberName(members, memberId) {
  const member = members?.[memberId];
  const name = plain(member?.displayName);
  return name || "an agent";
}

function postAlert(store, roomId, { material, body, memberIds, members }) {
  const room = store.room(roomId);
  const ownerId = room?.state?.room?.ownerId;
  const author = room?.state?.members?.[ownerId];
  if (!author || author.active === false) return null;
  const messageId = stableEventId("cx", material);
  const posted = appendRoomEvent(store, roomId, {
    id: messageId,
    type: "message.posted",
    actorId: author.id,
    data: { messageId, body }
  });
  for (const memberId of memberIds) {
    if (members?.[memberId]?.kind !== "agent") continue;
    enqueueClaimWake(store, roomId, memberId, messageId, { reason: "collision", actorId: author.id });
  }
  return posted ? messageId : messageId;
}

// Lease-expiry notice. When a lapsed lease is auto-released, the sweep wakes
// only the lapsed owner; agents whose live claims overlap the freed paths
// never learn the item is free. Tell each overlapping live claim holder (a
// different owner, same repo when both name one) once per lapse. Advisory
// only, same flag and post path as collision alerts. Pure selector first.
export function leaseExpiryTargets(claims, expired) {
  if (!expired?.id) return Object.freeze([]);
  const freed = slotsOf(expired);
  if (!freed.length) return Object.freeze([]);
  const targets = [];
  for (const claim of liveClaims(claims)) {
    if (claim.id === expired.id || !claim.owner || claim.owner === expired.owner) continue;
    if (expired.repo && claim.repo && claim.repo !== expired.repo) continue;
    const overlap = [];
    for (const a of slotsOf(claim)) for (const b of freed) {
      if (slotsOverlap(a, b) && !overlap.includes(b.path)) overlap.push(b.path);
    }
    if (overlap.length) targets.push(Object.freeze({ claimId: claim.id, owner: claim.owner, overlap: Object.freeze(overlap) }));
  }
  targets.sort((a, b) => (a.claimId < b.claimId ? -1 : 1));
  return Object.freeze(targets);
}

// Who handed this claim to its holder, from history already on the claim:
// the latest "reassigned:<owner>" stamp, else the "created" stamp. No new
// field. A trimmed history (SEC-2 cap) or a system or self create yields null.
export function leaseExpiryProposer(expired) {
  const history = Array.isArray(expired?.history) ? expired.history : [];
  const owner = expired?.owner;
  if (!owner) return null;
  let by = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const action = history[i]?.action;
    if (action === `reassigned:${owner}` || action === "created") { by = history[i]?.agentId ?? null; break; }
  }
  if (typeof by !== "string" || !by || by === "system" || by === owner) return null;
  return by;
}

// Never throws. Idempotent per (room, expired claim, lapsed lease time,
// target claim): a repeat sweep of the same lapse coalesces on the post id.
export function notifyLeaseExpired(store, roomId, expired) {
  try {
    if (!collisionAlertsEnabled(store, roomId)) return [];
    if (!store?.room || !store?.workClaims?.list) return [];
    const claims = store.workClaims.list(roomId);
    const members = store.room(roomId)?.state?.members ?? {};
    const lapse = String(expired?.leaseExpiresAt ?? "");
    const sent = [];
    for (const target of leaseExpiryTargets(claims, expired)) {
      if (members?.[target.owner]?.kind !== "agent") continue;
      const paths = target.overlap.slice(0, 8).map(plain).join(", ") + (target.overlap.length > 8 ? ` and ${target.overlap.length - 8} more` : "");
      const body = `${memberName(members, target.owner)} (${plain(target.claimId)}): the lease on ${plain(expired.id)} held by ${memberName(members, expired.owner)} expired and was released. Paths it held that overlap your claim are now free: ${paths}. The item is unclaimed; check the Board before taking it.`;
      const material = `${roomId}\0lease_expired\0${expired.id}\0${lapse}\0${target.claimId}`;
      try {
        postAlert(store, roomId, { material, body, memberIds: [target.owner], members });
        sent.push(material);
      } catch (error) {
        console.error("lease expiry notice failed:", error?.message ?? error);
      }
    }
    const proposer = leaseExpiryProposer(expired);
    if (proposer && members?.[proposer]?.kind === "agent") {
      const body = `${memberName(members, proposer)}: the lease on ${plain(expired.id)}, which you handed to ${memberName(members, expired.owner)}, expired and was released with no result. The item is unclaimed; reassign it or take it from the Board.`;
      const material = `${roomId}\0lease_expired_proposer\0${expired.id}\0${lapse}\0${proposer}`;
      try {
        postAlert(store, roomId, { material, body, memberIds: [proposer], members });
        sent.push(material);
      } catch (error) {
        console.error("lease expiry notice failed:", error?.message ?? error);
      }
    }
    return sent;
  } catch (error) {
    console.error("lease expiry notice failed:", error?.message ?? error);
    return [];
  }
}

function pairInvolvesAgent(members, pair) {
  return members?.[pair.left.owner]?.kind === "agent" || members?.[pair.right.owner]?.kind === "agent";
}

// After a live claim is saved. Idempotent: the post id is the pair plus the
// overlap, and the wake coalesces on that same id. Never throws.
export function notifyClaimCollisions(store, roomId, item) {
  if (!collisionAlertsEnabled(store, roomId)) return [];
  if (!item?.owner || !LIVE.has(item.state)) return [];
  if (!store?.room || !store?.workClaims?.list) return [];
  let claims = [];
  try { claims = store.workClaims.list(roomId); } catch { return []; }
  let members = {};
  try { members = store.room(roomId)?.state?.members ?? {}; } catch { return []; }
  const sent = [];
  for (const pair of findAgentOverlaps(claims)) {
    if (pair.left.claimId !== item.id && pair.right.claimId !== item.id) continue;
    if (!pairInvolvesAgent(members, pair)) continue;
    const body = `${memberName(members, pair.left.owner)} (${pair.left.claimId}) and ${memberName(members, pair.right.owner)} (${pair.right.claimId}) both hold ${detailOf(pair.parts)}. Coordinate the merge.`;
    const material = `${roomId}\0${pair.left.claimId}\0${pair.right.claimId}\0${pair.parts.map(part => `${part.kind}:${part.key}`).join("\0")}`;
    try {
      postAlert(store, roomId, { material, body, memberIds: [pair.left.owner, pair.right.owner], members });
      sent.push(material);
    } catch (error) {
      console.error("collision alert failed:", error?.message ?? error);
    }
  }
  return sent;
}

// A refused exclusive lease still tells the holder. The caller already has
// the 409. Runs after that transaction rolls back. Never throws.
export function alertLeaseRefusal(store, roomId, { claimId, callerId, conflict }) {
  if (!collisionAlertsEnabled(store, roomId)) return [];
  if (!store?.room || typeof claimId !== "string" || typeof callerId !== "string") return [];
  let members = {};
  try { members = store.room(roomId)?.state?.members ?? {}; } catch { return []; }
  const holders = Array.isArray(conflict?.conflicts) ? conflict.conflicts : [];
  const sent = [];
  for (const entry of holders) {
    const holderId = entry?.holder?.owner;
    const holderClaim = entry?.holder?.claimId;
    if (typeof holderId !== "string" || typeof holderClaim !== "string") continue;
    if (members[callerId]?.kind !== "agent" && members[holderId]?.kind !== "agent") continue;
    const files = Array.isArray(entry.files) ? entry.files.filter(file => typeof file === "string") : [];
    const body = `${memberName(members, callerId)} tried to claim ${plain(claimId)}, which overlaps ${memberName(members, holderId)} (${plain(holderClaim)}) on files ${files.slice(0, 8).join(", ") || "the same path"}. Coordinate the merge.`;
    const material = `${roomId}\0refused\0${claimId}\0${holderClaim}\0${files.join("\0")}`;
    try {
      postAlert(store, roomId, { material, body, memberIds: [callerId, holderId], members });
      sent.push(material);
    } catch (error) {
      console.error("collision alert failed:", error?.message ?? error);
    }
  }
  return sent;
}

// Concurrent-change notice. A clean textual merge does not mean the other
// live work still fits: nearly half of agent merge conflicts hit PRs with no
// shared files (MergeGym, arXiv 2610.04779), and telling an agent what the
// concurrent change was recovered most semantic breakages (arXiv 2609.25396).
// When a claim's pull request merges, every other live claim in the same
// repository is told what landed, which of its paths overlap, and to rebase
// and re-run its tests. Same flag and post path as collision alerts; advisory
// only, never a lease change. Pure selector first so it is testable alone.
export function concurrentMergeTargets(claims, merged) {
  if (!merged?.id || typeof merged.repo !== "string" || !merged.repo) return Object.freeze([]);
  const mergedSlots = slotsOf(merged);
  const targets = [];
  for (const claim of liveClaims(claims)) {
    if (claim.id === merged.id || claim.repo !== merged.repo) continue;
    if (merged.owner && claim.owner === merged.owner && claim.branch && claim.branch === merged.branch) continue;
    const overlap = [];
    for (const a of slotsOf(claim)) for (const b of mergedSlots) {
      if (slotsOverlap(a, b) && !overlap.includes(a.path)) overlap.push(a.path);
    }
    targets.push(Object.freeze({ claimId: claim.id, owner: claim.owner, overlap: Object.freeze(overlap) }));
  }
  targets.sort((a, b) => (a.claimId < b.claimId ? -1 : 1));
  return Object.freeze(targets);
}

export function notifyConcurrentMerge(store, roomId, merged, { url, mergedSha } = {}) {
  if (!collisionAlertsEnabled(store, roomId)) return [];
  if (!store?.room || !store?.workClaims?.list || typeof url !== "string" || !url) return [];
  let claims = [];
  try { claims = store.workClaims.list(roomId); } catch { return []; }
  let members = {};
  try { members = store.room(roomId)?.state?.members ?? {}; } catch { return []; }
  const sent = [];
  const paths = slotsOf(merged).map(slot => slot.path);
  const sha = typeof mergedSha === "string" && /^[0-9a-f]{7,40}$/.test(mergedSha) ? ` at ${mergedSha.slice(0, 12)}` : "";
  for (const target of concurrentMergeTargets(claims, merged)) {
    if (members?.[target.owner]?.kind !== "agent") continue;
    const touched = paths.length ? `It changed ${paths.slice(0, 8).map(plain).join(", ")}${paths.length > 8 ? ` and ${paths.length - 8} more` : ""}.` : "Its changed files are not on the claim.";
    const overlapText = target.overlap.length
      ? `Overlap with your claim: ${target.overlap.slice(0, 8).map(plain).join(", ")}.`
      : "No shared paths, but merges between disjoint PRs can still conflict or break callers.";
    const body = `${memberName(members, target.owner)} (${plain(target.claimId)}): ${plain(url)} merged${sha} from ${plain(merged.id)}. ${touched} ${overlapText} Rebase onto the new base and re-run your tests before handing off.`;
    const material = `${roomId}\0merged\0${merged.id}\0${url}\0${target.claimId}`;
    try {
      postAlert(store, roomId, { material, body, memberIds: [target.owner], members });
      sent.push(material);
    } catch (error) {
      console.error("concurrent merge notice failed:", error?.message ?? error);
    }
  }
  return sent;
}

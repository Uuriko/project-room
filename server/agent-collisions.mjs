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

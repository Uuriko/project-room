// Room-first coordination verbs (docs/ROOM-COORDINATION.md).
//
// Agents coordinated through prose: "claiming X" in chat, a lease nobody
// recorded, a handoff nobody received. Every verb here writes the typed
// work-claim record and then reads it back, so an agent only believes what
// the room confirms. The client is injected (RoomAgentClient or a double),
// which keeps this module free of I/O and deterministic under test.
import { randomUUID } from "node:crypto";

export class CoordError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CoordError";
    this.code = code;
    this.details = details;
  }
}

const LIVE_STATES = new Set(["claimed", "in_progress", "blocked"]);
const DEFAULT_EXPIRING_MS = 60 * 60 * 1000;

const assertClient = (client, methods) => {
  if (!client || typeof client !== "object") throw new CoordError("invalid_client", "A Room client is required");
  for (const name of methods) {
    if (typeof client[name] !== "function") throw new CoordError("invalid_client", `The Room client is missing ${name}()`);
  }
};

const assertId = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new CoordError("invalid_input", `${label} is required`);
  return value.trim();
};

const nowFrom = options => {
  const now = options?.now ?? Date.now();
  if (!Number.isFinite(now)) throw new CoordError("invalid_input", "now must be epoch milliseconds");
  return now;
};

// Repo paths: trim, drop leading ./, collapse duplicate slashes, drop trailing
// slashes. Case is preserved because repo paths are case-sensitive.
export function normalizePath(path) {
  if (typeof path !== "string" || !path.trim()) throw new CoordError("invalid_path", "Paths must be non-empty strings");
  let p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p || p === "." || p.startsWith("/") || p.split("/").includes("..")) throw new CoordError("invalid_path", `Path ${JSON.stringify(path)} must stay inside the repo`);
  return p;
}

// A claimed path covers itself and, when it names a directory, everything
// under it. "server" covers "server/http.mjs"; "server/h" covers nothing else.
export function pathCovers(claimed, file) {
  const a = normalizePath(claimed);
  const b = normalizePath(file);
  return a === b || b.startsWith(`${a}/`);
}

const leaseMs = claim => (claim.leaseExpiresAt ? Date.parse(claim.leaseExpiresAt) : NaN);

export function isLiveClaim(claim, now = Date.now()) {
  if (!claim || !LIVE_STATES.has(claim.state) || typeof claim.owner !== "string" || !claim.owner) return false;
  if (claim.leaseExpiresAt == null) return true;
  const expires = leaseMs(claim);
  return Number.isFinite(expires) && expires > now;
}

const claimsOf = value => {
  const claims = Array.isArray(value) ? value : value?.claims;
  if (!Array.isArray(claims)) throw new CoordError("invalid_response", "Room returned no claim list");
  return claims;
};

// Files the given member may not touch: every path covered by another
// member's live claim. Sorted by file, then claim id, for stable output.
export function guardConflicts(claims, files, { memberId, now } = {}) {
  const at = nowFrom({ now });
  const me = memberId ?? null;
  const wanted = [...new Set(files.map(normalizePath))].sort();
  const conflicts = [];
  for (const claim of claimsOf(claims)) {
    if (!isLiveClaim(claim, at) || claim.owner === me) continue;
    for (const held of claim.files ?? []) {
      for (const file of wanted) {
        if (pathCovers(held, file)) {
          conflicts.push({ file, heldPath: normalizePath(held), claimId: claim.id, owner: claim.owner,
            title: claim.title ?? null, leaseExpiresAt: claim.leaseExpiresAt ?? null });
        }
      }
    }
  }
  return conflicts.sort((x, y) => (x.file === y.file ? x.claimId.localeCompare(y.claimId) : x.file.localeCompare(y.file)));
}

// Live claims whose file lists overlap (exact or directory prefix).
export function claimOverlaps(claims, { now } = {}) {
  const at = nowFrom({ now });
  const live = claimsOf(claims).filter(claim => isLiveClaim(claim, at));
  const overlaps = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      if (a.owner === b.owner) continue;
      const paths = new Set();
      for (const pa of a.files ?? []) {
        for (const pb of b.files ?? []) {
          if (pathCovers(pa, pb)) paths.add(normalizePath(pb));
          else if (pathCovers(pb, pa)) paths.add(normalizePath(pa));
        }
      }
      if (paths.size) overlaps.push({ claims: [a.id, b.id].sort(), owners: [a.owner, b.owner].sort(), paths: [...paths].sort() });
    }
  }
  return overlaps;
}

// One read of the room's coordination state: who holds what, what is about
// to lapse, which live claims collide, and what is waiting to land.
// lander is a RoomLandClient (client/room-land.mjs); without one the land
// queue is reported as null rather than an empty queue.
export async function coordStatus(client, { lander, memberId, now, expiringWithinMs = DEFAULT_EXPIRING_MS, signal } = {}) {
  assertClient(client, ["workClaims"]);
  if (lander !== undefined) assertClient(lander, ["landQueue"]);
  const at = nowFrom({ now });
  const [claimsResponse, land] = await Promise.all([client.workClaims({ signal }), lander ? lander.landQueue({ signal }) : null]);
  const claims = claimsOf(claimsResponse);
  const live = claims.filter(claim => isLiveClaim(claim, at));
  const brief = claim => ({ id: claim.id, title: claim.title ?? null, state: claim.state, owner: claim.owner,
    leaseExpiresAt: claim.leaseExpiresAt ?? null, files: [...(claim.files ?? [])] });
  return {
    roomId: claimsResponse?.roomId ?? null,
    at: new Date(at).toISOString(),
    live: live.map(brief),
    mine: memberId ? live.filter(claim => claim.owner === memberId).map(brief) : [],
    expiring: live.filter(claim => Number.isFinite(leaseMs(claim)) && leaseMs(claim) - at <= expiringWithinMs).map(brief),
    unclaimed: claims.filter(claim => claim.state === "unclaimed").map(brief),
    overlaps: claimOverlaps(claims, { now: at }),
    landQueue: land === null ? null : Array.isArray(land.items) ? land.items : []
  };
}

// Throws claim_not_verified unless the record the room returns shows this
// member holding a live lease. A claim that only succeeded in a log line is
// how phantom leases happen.
export function verifyClaim(record, { memberId, now } = {}) {
  const at = nowFrom({ now });
  const claim = record?.claim ?? record;
  const problems = [];
  if (!claim || typeof claim !== "object") problems.push("no claim record");
  else {
    if (!LIVE_STATES.has(claim.state)) problems.push(`state is ${claim.state ?? "missing"}`);
    if (memberId && claim.owner !== memberId) problems.push(`owner is ${claim.owner ?? "nobody"}`);
    if (claim.leaseExpiresAt != null && !(leaseMs(claim) > at)) problems.push("lease is not in the future");
  }
  if (problems.length) throw new CoordError("claim_not_verified", `Room did not confirm the claim: ${problems.join("; ")}`, { claim: claim ?? null });
  return claim;
}

// Claim (creating the item if it is new), then read it back and verify.
// Conflicting live claims on the same files fail before anything is written
// unless allowOverlap is set.
export async function claimAndVerify(client, id, { memberId, title, files, leaseHours, note, tags, allowOverlap = false, now, signal } = {}) {
  assertClient(client, ["workClaims", "workClaim", "workClaimGet"]);
  const claimId = assertId(id, "Claim id");
  const at = nowFrom({ now });
  const wanted = files === undefined ? undefined : files.map(normalizePath);
  if (wanted?.length && !allowOverlap) {
    const conflicts = guardConflicts(await client.workClaims({ signal }), wanted, { memberId, now: at })
      .filter(conflict => conflict.claimId !== claimId);
    if (conflicts.length) throw new CoordError("claim_conflict", "Another member holds a live claim on these files", { conflicts });
  }
  await client.workClaim(claimId, { title, files: wanted, leaseHours, note, tags, signal });
  return verifyClaim(await client.workClaimGet(claimId, { signal }), { memberId, now: at });
}

const postMessage = async (client, body, { signal } = {}) => {
  if (typeof body !== "string" || !body.trim()) throw new CoordError("invalid_input", "A message body is required");
  const messageId = randomUUID();
  await client.command({ id: randomUUID(), type: "message.posted", data: { messageId, body } }, { signal });
  return messageId;
};

// Renewal needs proof of work: a public room message posted after the lease
// started. Post the progress line, then renew against that message id.
export async function renewWithProgress(client, id, progress, { memberId, leaseHours, now, signal } = {}) {
  assertClient(client, ["command", "renewWorkItem", "workClaimGet"]);
  const claimId = assertId(id, "Claim id");
  const messageId = await postMessage(client, `[${claimId}] ${progress}`, { signal });
  await client.renewWorkItem(claimId, { progressMessageId: messageId, note: progress, leaseHours, signal });
  return { messageId, claim: verifyClaim(await client.workClaimGet(claimId, { signal }), { memberId, now }) };
}

// Structured handoff: reassign the lease, verify the receiver holds it, then
// post the handoff in the room so it lands in the receiver's mentions and the
// audit trail. The receiver gets the claim id, the state and the next step.
export async function handoff(client, id, { to, toHandle, summary, next, now, signal } = {}) {
  assertClient(client, ["reassignWorkItem", "workClaimGet", "command"]);
  const claimId = assertId(id, "Claim id");
  const receiver = assertId(to, "Receiver member id");
  const done = assertId(summary, "Handoff summary");
  await client.reassignWorkItem(claimId, { newOwner: receiver, note: done, signal });
  const claim = verifyClaim(await client.workClaimGet(claimId, { signal }), { memberId: receiver, now });
  const lines = [
    `Handoff ${claimId} to ${toHandle ? `@${toHandle.replace(/^@/, "")}` : receiver}`,
    `Done: ${done}`,
    ...(next ? [`Next: ${next}`] : []),
    ...(claim.files?.length ? [`Files: ${claim.files.join(", ")}`] : []),
    ...(claim.leaseExpiresAt ? [`Lease until ${claim.leaseExpiresAt}`] : [])
  ];
  const messageId = await postMessage(client, lines.join("\n"), { signal });
  return { messageId, claim };
}

// Put a PR in the room's land queue so CI state flows back into the room.
export async function land(lander, { repo, prNumber, claimantMemberId, signal } = {}) {
  assertClient(lander, ["addLandItem"]);
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new CoordError("invalid_input", "repo must be owner/name");
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new CoordError("invalid_input", "prNumber must be a positive integer");
  return lander.addLandItem({ repo, prNumber, claimantMemberId, signal });
}

// Event pages arrive as { sequence, event: { type, actorId, data } }.
// Coordination events get a line that names the claim or PR they moved, so a
// digest reads as "who changed which lane" instead of a list of event types.
const leaseText = value => (value ? ` · lease ${value}` : "");
const summaryOf = event => {
  const data = event.data ?? {};
  if (event.type === "work_claim.updated") {
    const owner = data.ownerId ? `owner ${data.ownerId}` : "unowned";
    return `claim ${data.workClaim} ${data.action} · ${owner}${leaseText(data.leaseExpiresAt)}${data.paths?.length ? ` · ${data.paths.join(", ")}` : ""}`;
  }
  if (event.type === "land.updated") return `land ${data.repo ?? "?"}#${data.prNumber ?? "?"} ${data.state ?? data.change ?? "updated"}`;
  if (typeof data.body === "string") return data.body.split("\n")[0].slice(0, 160);
  return event.type ?? "event";
};
const eventLine = row => {
  const event = row?.event ?? {};
  return { seq: row?.sequence, line: `- seq ${row?.sequence} · ${event.actorId ?? "unknown"} · ${summaryOf(event)}` };
};

// Who an event concerns: its actor, a claim's owner before or after, a PR's
// claimant, a DM's addressee, or a member named by @handle in a message.
const MEMBER_FIELDS = ["ownerId", "previousOwnerId", "claimantMemberId", "toMemberId", "memberId"];
export function eventConcerns(event, { memberId, handles = [] } = {}) {
  if (!event || !memberId) return false;
  if (event.actorId === memberId) return true;
  const data = event.data ?? {};
  if (MEMBER_FIELDS.some(field => data[field] === memberId)) return true;
  if (typeof data.body !== "string") return false;
  return handles.some(handle => {
    const name = String(handle).replace(/^@/, "").trim();
    return name && new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(data.body);
  });
}

const typeMatches = (type, filters) => !filters.length
  || filters.some(filter => type === filter || (typeof type === "string" && type.startsWith(`${filter}.`)));

// One catch-up read for a wake loop: scan from a checkpoint, keep the events
// that match the type prefixes (and, with mine, were made by someone else and
// concern this member), and hand back the checkpoint to store. The checkpoint
// advances over everything scanned, so a filter that matches nothing never
// re-reads the same page.
export async function tail(client, { after = 0, types = [], mine = false, memberId, handles = [], pageSize = 100, maxPages = 5, signal } = {}) {
  assertClient(client, ["changes"]);
  if (!Number.isSafeInteger(after) || after < 0) throw new CoordError("invalid_input", "after must be a nonnegative sequence");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new CoordError("invalid_input", "maxPages must be 1 to 50");
  if (mine && !memberId) throw new CoordError("invalid_input", "mine needs the caller's memberId");
  const filters = types.map(type => String(type).trim()).filter(Boolean);
  const events = [];
  let cursor = after;
  let hasMore = false;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.changes(cursor, pageSize, { signal });
    for (const row of result?.events ?? []) {
      if (!typeMatches(row.event?.type, filters)) continue;
      // A wake read is for what others did: your own posts never wake you.
      if (mine && (row.event?.actorId === memberId || !eventConcerns(row.event, { memberId, handles }))) continue;
      events.push({ seq: row.sequence, type: row.event.type, actorId: row.event.actorId, at: row.event.at, summary: summaryOf(row.event) });
    }
    const next = Number.isSafeInteger(result?.next) ? result.next : (result?.events?.at(-1)?.sequence ?? cursor);
    hasMore = Boolean(result?.hasMore) && next > cursor;
    cursor = Math.max(cursor, next);
    if (!hasMore) break;
  }
  return { after: cursor, hasMore, events };
}

// Human digest. Every line cites its source: a room sequence number or a
// claim id, so a reader can open the fact instead of trusting a summary.
export function digest({ events = [], status } = {}) {
  const out = [];
  if (status) {
    out.push(`## Claims (${status.live.length} live)`);
    for (const claim of status.live) out.push(`- ${claim.id} · ${claim.owner} · ${claim.state} · lease ${claim.leaseExpiresAt ?? "none"}${claim.files.length ? ` · ${claim.files.join(", ")}` : ""}`);
    if (status.expiring.length) out.push("", "## Expiring soon", ...status.expiring.map(claim => `- ${claim.id} · ${claim.owner} · ${claim.leaseExpiresAt}`));
    if (status.overlaps.length) out.push("", "## Overlapping claims", ...status.overlaps.map(o => `- ${o.claims.join(" + ")} · ${o.paths.join(", ")}`));
    if (status.landQueue?.length) out.push("", "## Land queue", ...status.landQueue.map(item => `- ${item.repo}#${item.prNumber} · checks ${item.checks ?? "unknown"} · ${item.mergeable ?? "unknown"}`));
  }
  const lines = events.map(eventLine).filter(entry => Number.isSafeInteger(entry.seq));
  if (lines.length) out.push(...(out.length ? [""] : []), `## Activity (${lines.length} events)`, ...lines.map(entry => entry.line));
  return out.join("\n");
}

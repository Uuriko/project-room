import { hydrateWorkItems } from "./work-repository.mjs";
// Public pages read these tables and nothing from rooms.projection.
// Rows are written when an owner opts in, updated in the same transaction
// as the change, and removed when they opt out. The cron backfill copies
// rooms that opted in before the tables existed. It never runs from the
// Durable Object constructor.
import { createHash } from "node:crypto";
import { publicPage, joinLink, publicName, publicTask, publicReceipts } from "../src/events.js";
import { isUnpublished } from "./legal-store.mjs"; // operator unpublish hides a room or receipt from every public read
import {
  OPERATOR_HIDDEN_RECEIPT_SQL,
  ownerHiddenReceiptSql,
  receiptVisibilitySqlFor,
  ownerToggleReadable,
  publicWorkTablesReadable,
  lotReceiptVisible,
} from "./public-visibility.mjs"; // the one visibility definition every public read applies

export const PUBLIC_START_URL = "https://room.trydemigod.com/?start=room";
const PUBLIC_ORIGIN = new URL(PUBLIC_START_URL).origin;
// The member receipt's public twin (#3636): the same deterministic id the
// projection writes, and the absolute URL a holder can share.
export const publicWorkClaimReceiptId = (roomId, claimId) => hashId("wcr", roomId, claimId);
export const publicWorkItemReceiptId = (roomId, itemId) => hashId("wir", roomId, itemId);
export const publicReceiptUrl = id => `${PUBLIC_ORIGIN}/receipts/${id}`;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPEN = new Set(["proposed", "accepted", "working", "blocked"]);
export const PUBLIC_RECEIPT_ID = /^(?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32}|lot_[a-f0-9]{16})$/;
export const LOT_RECEIPT_ID = /^lot_[a-f0-9]{16}$/;
export const DIRECTORY_PAGE_SIZE = 50;
export const PUBLIC_BACKFILL_BATCH = 20;

export const PUBLIC_READ_MODEL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_public_receipts_setting (
    room_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS public_receipts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    origin_room_id TEXT,
    room_id TEXT,
    room_title TEXT,
    agents_json TEXT NOT NULL,
    humans_json TEXT NOT NULL,
    pull_request TEXT,
    merged_at TEXT,
    verification_state TEXT,
    hashes_json TEXT NOT NULL,
    at TEXT NOT NULL,
    start_href TEXT NOT NULL,
    agent_ids_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS public_receipts_listing ON public_receipts(at DESC, id ASC);
  CREATE INDEX IF NOT EXISTS public_receipts_room ON public_receipts(room_id, at DESC, id ASC);
  CREATE INDEX IF NOT EXISTS public_receipts_origin ON public_receipts(origin_room_id, source);
  CREATE TABLE IF NOT EXISTS public_rooms (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    purpose TEXT NOT NULL,
    humans INTEGER NOT NULL,
    agents INTEGER NOT NULL,
    names_json TEXT NOT NULL,
    tasks_json TEXT NOT NULL,
    members_json TEXT NOT NULL,
    receipts_enabled INTEGER NOT NULL,
    join_mode TEXT NOT NULL,
    join_token TEXT,
    owner_member_id TEXT,
    set_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS public_rooms_listing ON public_rooms(updated_at DESC, slug ASC);
  CREATE TABLE IF NOT EXISTS public_directory_entries (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    skills_json TEXT NOT NULL,
    identity_id TEXT,
    receipt_count INTEGER NOT NULL,
    room_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS public_directory_listing ON public_directory_entries(name ASC, agent_id ASC);
  CREATE TABLE IF NOT EXISTS public_read_model_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL,
    cursor TEXT,
    done INTEGER NOT NULL
  );
`;

const hashId = (prefix, roomId, localId) =>
  `${prefix}_${createHash("sha256").update(`${roomId}\0${localId}`).digest("hex").slice(0, 32)}`;

// Tables created before result-mode receipts projected (#3636) carry no
// verification_state column; the CREATE above only shapes fresh tables.
export function ensurePublicReceiptVerificationColumn(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(public_receipts)").all().map(column => column.name));
  if (columns.size > 0 && !columns.has("verification_state")) {
    db.exec("ALTER TABLE public_receipts ADD COLUMN verification_state TEXT");
  }
}

// Tables created before directory counts went identity-keyed carry no
// record of WHICH identities a receipt credits — only display names,
// which namesakes share. Existing rows read as '[]' (credited to
// nobody) until their next projection rewrites them with ids.
export function ensurePublicReceiptAgentIdsColumn(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(public_receipts)").all().map(column => column.name));
  if (columns.size > 0 && !columns.has("agent_ids_json")) {
    db.exec("ALTER TABLE public_receipts ADD COLUMN agent_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
}

const httpsUrl = value => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
};

const pullRequestUrl = value => {
  const url = httpsUrl(value);
  return url && /\/pull\/\d+(?:$|[/?#])/.test(url) ? url : null;
};

const hashList = values => [...new Set(values.filter(value => SHA256.test(value)))];

const iso = value => {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
};

const cleanName = value => {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name ? name.slice(0, 80) : null;
};

const parseJson = (text, fallback) => {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch { return fallback; }
};

function credit(state, memberId) {
  if (typeof memberId !== "string" || !state?.members || !Object.hasOwn(state.members, memberId)) return null;
  const member = state.members[memberId];
  if (!member || member.active === false) return null;
  const name = cleanName(member.displayName) ?? memberId;
  return { id: memberId, name, kind: member.kind === "human" ? "human" : "agent" };
}

// A member can store outcome "merged" on a claim. The public page repeats a
// merge only after this server settled it: the poll writes pr_merged, done,
// and syncedAt together. The write path that stops members setting outcome
// is separate.
function serverVerifiedMerge(item) {
  const pull = item?.pullRequest;
  if (!item || item.state !== "done" || pull?.outcome !== "merged" || !iso(pull.syncedAt)) return false;
  const history = Array.isArray(item.history) ? item.history : [];
  return history.some(step => step?.action === "pr_merged");
}

// The verification fact a done claim carries, named at its true tier
// (#3636). Two shapes record it. The #3627 verification object is read
// first when present — its delivered→verify flow stamps the outcome on
// the claim itself. On main the recorded fact is reviewedBy: the done
// transition stores the attesting member there, and the route enforced
// who that may be (canCloseWork) — the owner alone under self_attested,
// an attested distinct member under the reviewed policies. A reviewer
// distinct from the worker is a verified completion; anything else is
// the worker's own attestation, disclosed as such, never upgraded.
export function workClaimVerificationTier(item) {
  const recorded = item?.verification;
  if (recorded && typeof recorded === "object"
    && (recorded.state === "verified" || recorded.state === "self_attested")) return recorded.state;
  if (typeof item?.reviewedBy === "string" && item.reviewedBy && item.reviewedBy !== item.owner) return "verified";
  return "self_attested";
}

// A done claim with no pull request on it finished by result, not by
// merge, so it projects at its recorded verification tier. A claim that
// carries a PR link publishes only through serverVerifiedMerge above:
// the merge gate owns its public story until the server settles it.
function resultVerificationTier(item) {
  if (!item || item.state !== "done") return null;
  if (pullRequestUrl(item.pullRequest?.url)) return null;
  return workClaimVerificationTier(item);
}

function doneAtOf(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  const stamp = [...history].reverse().find(step => step?.action === "state:done");
  return iso(stamp?.at);
}

function creditsFrom(people) {
  const agents = [], humans = [], agentIds = [];
  for (const person of people) {
    if (!person) continue;
    const list = person.kind === "human" ? humans : agents;
    if (!list.includes(person.name)) list.push(person.name);
    // The credited MEMBER ids of agent-kind people; the projection
    // translates them to identity ids for agent_ids_json. Human credits
    // never key a directory card.
    if (person.kind !== "human" && typeof person.id === "string" && !agentIds.includes(person.id)) agentIds.push(person.id);
  }
  return { agents, humans, agentIds };
}

function startHref(ownerName) {
  const url = new URL(PUBLIC_START_URL);
  const ref = cleanName(ownerName);
  if (ref) url.searchParams.set("ref", ref);
  return url.href;
}

function isListed(store, roomId) {
  if (typeof roomId !== "string" || !roomId) return false;
  if (store.db.prepare("SELECT 1 FROM room_directory_settings WHERE room_id=? AND discoverable=1").get(roomId)) return true;
  return Boolean(store.db.prepare("SELECT 1 FROM room_public_settings WHERE room_id=? AND enabled=1").get(roomId));
}

function rowToPublic(row) {
  return {
    schema: "project-room-public-receipt/1",
    id: row.id,
    title: row.title,
    source: row.source,
    room: row.room_id ? { id: row.room_id, title: row.room_title ?? null } : null,
    agents: parseJson(row.agents_json, []),
    humans: parseJson(row.humans_json, []),
    pullRequest: row.pull_request,
    mergedAt: row.merged_at,
    ...(row.verification_state ? { verification: { state: row.verification_state } } : {}),
    hashes: parseJson(row.hashes_json, []),
    at: row.at,
    startHref: row.start_href,
  };
}

const RECEIPT_COLUMNS = `id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, verification_state, hashes_json, at, start_href`;

function insertReceipt(store, row) {
  // agent_ids_json rides outside RECEIPT_COLUMNS (the read list): the
  // credited identity ids are bookkeeping for the directory count, not
  // page data, and read paths over predating tables keep working.
  store.db.prepare(`INSERT INTO public_receipts (${RECEIPT_COLUMNS}, agent_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, source=excluded.source, origin_room_id=excluded.origin_room_id,
      room_id=excluded.room_id, room_title=excluded.room_title, agents_json=excluded.agents_json,
      humans_json=excluded.humans_json, pull_request=excluded.pull_request, merged_at=excluded.merged_at,
      verification_state=excluded.verification_state,
      hashes_json=excluded.hashes_json, at=excluded.at, start_href=excluded.start_href,
      agent_ids_json=excluded.agent_ids_json`
  ).run(row.id, row.title, row.source, row.originRoomId, row.roomId, row.roomTitle, JSON.stringify(row.agents),
    JSON.stringify(row.humans), row.pullRequest, row.mergedAt, row.verificationState ?? null,
    JSON.stringify(row.hashes), row.at, row.startHref,
    JSON.stringify(Array.isArray(row.agentIds) ? row.agentIds : []));
}

function listedRoomFields(state, listed) {
  if (!listed || !state?.room?.id) return { roomId: null, roomTitle: null };
  return { roomId: state.room.id, roomTitle: cleanName(state.room.title) };
}

function optedInRows(store, state) {
  const roomId = state?.room?.id;
  if (!roomId || publicReceipts(state).enabled !== true) return [];
  const listed = isListed(store, roomId);
  const room = listedRoomFields(state, listed);
  const owner = credit(state, state.room?.ownerId);
  const href = startHref(owner?.name);
  // Credited member ids become identity ids through this room's links;
  // an unlinked member has no directory identity to credit.
  const identityByMember = new Map();
  try {
    for (const link of store.db.prepare("SELECT member_id AS memberId, identity_id AS identityId FROM identity_links WHERE room_id=?").all(roomId)) {
      if (!identityByMember.has(link.memberId)) identityByMember.set(link.memberId, link.identityId);
    }
  } catch { /* a store predating identity links credits nobody by id */ }
  const creditedIds = memberIds => [...new Set(memberIds.map(id => identityByMember.get(id)).filter(id => typeof id === "string"))];
  const rows = [];
  let claims = [];
  try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
  const claimCredits = item => {
    const people = [credit(state, item.owner)];
    for (const step of Array.isArray(item.history) ? item.history : []) people.push(credit(state, step?.agentId));
    return creditsFrom(people);
  };
  for (const item of claims) {
    if (serverVerifiedMerge(item)) {
      const { agents, humans, agentIds } = claimCredits(item);
      rows.push({
        id: hashId("wcr", roomId, item.id),
        title: cleanName(item.title) ?? "Receipt",
        source: "work-claim",
        originRoomId: roomId,
        roomId: room.roomId,
        roomTitle: room.roomTitle,
        agents, humans, agentIds: creditedIds(agentIds),
        pullRequest: pullRequestUrl(item.pullRequest?.url),
        mergedAt: iso(item.pullRequest?.syncedAt),
        verificationState: null,
        hashes: hashList(Array.isArray(item.blobs) ? item.blobs : []),
        at: iso(item.pullRequest?.syncedAt) ?? iso(item.updatedAt) ?? new Date(0).toISOString(),
        startHref: href,
      });
      continue;
    }
    // Result-mode finish (#3636): the same wcr_ id, the same public
    // fields a merge-verified receipt of this class carries, no merge
    // fields at all, and the recorded verification tier stored on the
    // row so every surface names it. Re-projection after the server
    // settles a merge rewrites this same row through the branch above.
    const tier = resultVerificationTier(item);
    if (!tier) continue;
    // A completed board work item projects its own wir_ receipt in the
    // loop below; the claim the board sync mirrors it into (same id)
    // must not project the same completion a second time as a wcr_ row.
    // One completion carries one public receipt, at the work-item
    // source — this branch's subject is claims with no board item, or
    // no projected item receipt, behind them.
    const workItemTwin = state.workItems && typeof state.workItems === "object" ? state.workItems[item.id] : null;
    if (workItemTwin && workItemTwin.state === "completed"
      && workItemTwin.receipt && typeof workItemTwin.receipt === "object") continue;
    const { agents, humans, agentIds } = claimCredits(item);
    rows.push({
      id: hashId("wcr", roomId, item.id),
      title: cleanName(item.title) ?? "Receipt",
      source: "work-claim",
      originRoomId: roomId,
      roomId: room.roomId,
      roomTitle: room.roomTitle,
      agents, humans, agentIds: creditedIds(agentIds),
      pullRequest: null,
      mergedAt: null,
      verificationState: tier,
      hashes: hashList(Array.isArray(item.blobs) ? item.blobs : []),
      at: doneAtOf(item) ?? iso(item.updatedAt) ?? new Date(0).toISOString(),
      startHref: href,
    });
  }
  const items = state.workItems && typeof state.workItems === "object" ? Object.values(state.workItems) : [];
  for (const item of items) {
    if (!item || item.state !== "completed" || !item.receipt || typeof item.receipt !== "object") continue;
    const people = [credit(state, item.receipt.reportedById), credit(state, item.receipt.producerId), credit(state, item.accountableMemberId)];
    const { agents, humans, agentIds } = creditsFrom(people);
    const version = typeof item.receipt.evidenceVersion === "string" && SHA256.test(item.receipt.evidenceVersion)
      ? item.receipt.evidenceVersion : null;
    rows.push({
      id: publicWorkItemReceiptId(roomId, item.id),
      title: cleanName(item.title) ?? "Receipt",
      source: "work-item",
      originRoomId: roomId,
      roomId: room.roomId,
      roomTitle: room.roomTitle,
      agents, humans, agentIds: creditedIds(agentIds),
      pullRequest: pullRequestUrl(item.receipt.evidenceUrl),
      mergedAt: null,
      verificationState: null,
      hashes: hashList(version ? [version] : []),
      at: iso(item.updatedAt) ?? new Date(0).toISOString(),
      startHref: href,
    });
  }
  return rows;
}

function replaceOptedInReceipts(store, state) {
  const roomId = state?.room?.id;
  if (!roomId) return;
  store.db.prepare("DELETE FROM public_receipts WHERE origin_room_id=? AND source IN ('work-claim','work-item')").run(roomId);
  if (publicReceipts(state).enabled !== true) return;
  for (const row of optedInRows(store, state)) insertReceipt(store, row);
}

function touchPublicWorkListing(store, state) {
  const roomId = state?.room?.id;
  if (!roomId) return;
  const listed = isListed(store, roomId);
  const title = listed ? cleanName(state.room?.title) : null;
  const href = startHref(listed ? credit(state, state.room?.ownerId)?.name : null);
  store.db.prepare(`UPDATE public_receipts SET room_id=?, room_title=?, start_href=?
    WHERE origin_room_id=? AND source='public-work'`).run(roomId, title, href, roomId);
}

function memberIndex(state) {
  const members = [];
  for (const member of Object.values(state?.members ?? {})) {
    if (!member || member.active === false || typeof member.id !== "string") continue;
    const name = publicName(member).enabled === true ? cleanName(member.displayName) : null;
    members.push({ id: member.id, name });
  }
  return members;
}

function pageFields(state) {
  const members = Object.values(state?.members ?? {}).filter(member => member && member.active !== false);
  const agents = members.filter(member => member.kind === "agent").length;
  const names = members
    .filter(member => publicName(member).enabled === true && typeof member.displayName === "string")
    .map(member => member.displayName);
  const tasks = Object.values(state?.workItems ?? {})
    .filter(item => item && OPEN.has(item.state) && publicTask(item).enabled === true && typeof item.title === "string")
    .map(item => ({ title: item.title, definitionOfDone: typeof item.definitionOfDone === "string" ? item.definitionOfDone : "" }));
  return {
    humans: members.length - agents,
    agents,
    names,
    tasks,
    members: memberIndex(state),
  };
}

function ownerAuth(store, roomId, state, auth) {
  const ownerId = state?.room?.ownerId;
  const member = ownerId ? state.members?.[ownerId] : null;
  if (!member || member.active === false) return null;
  if (auth?.member?.id === ownerId) return { member: auth.member, account: auth.account ?? null };
  let account = null;
  try {
    const binding = store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, ownerId);
    if (binding) {
      const row = store.db.prepare("SELECT id, auth_epoch AS authEpoch FROM accounts WHERE id=? AND active=1").get(binding.account_id);
      if (row) account = { id: row.id, authEpoch: row.authEpoch };
    }
  } catch { account = null; }
  return { member, account };
}

function joinTokenFor(store, roomId, state, auth) {
  if (joinLink(state).enabled !== true) return { mode: "request", token: null, ownerId: state?.room?.ownerId ?? null };
  const ownerId = state?.room?.ownerId ?? null;
  const existing = store.db.prepare("SELECT join_token, owner_member_id FROM public_rooms WHERE slug=?").get(roomId);
  if (existing?.join_token && existing.owner_member_id === ownerId) {
    return { mode: "link", token: existing.join_token, ownerId };
  }
  const who = ownerAuth(store, roomId, state, auth);
  if (!who || !store.shareLinks?.personalInvite) return { mode: "request", token: null, ownerId };
  try {
    const minted = store.shareLinks.personalInvite(who, roomId, 25);
    if (minted?.token) return { mode: "link", token: minted.token, ownerId };
  } catch { /* a failed mint leaves the page on the request link */ }
  return { mode: "request", token: null, ownerId };
}

function upsertPublicRoom(store, state, auth) {
  const slug = state?.room?.id;
  if (!SLUG.test(slug ?? "")) return;
  const fields = pageFields(state);
  const join = joinTokenFor(store, slug, state, auth);
  const setAt = publicPage(state).setAt;
  const updatedAt = typeof setAt === "string" ? setAt : new Date().toISOString();
  store.db.prepare(`INSERT INTO public_rooms
    (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET
      title=excluded.title, purpose=excluded.purpose, humans=excluded.humans, agents=excluded.agents,
      names_json=excluded.names_json, tasks_json=excluded.tasks_json, members_json=excluded.members_json,
      receipts_enabled=excluded.receipts_enabled, join_mode=excluded.join_mode, join_token=excluded.join_token,
      owner_member_id=excluded.owner_member_id, set_at=excluded.set_at, updated_at=excluded.updated_at`
  ).run(slug, typeof state.room.title === "string" ? state.room.title : slug,
    typeof state.room.purpose === "string" ? state.room.purpose : "",
    fields.humans, fields.agents, JSON.stringify(fields.names), JSON.stringify(fields.tasks), JSON.stringify(fields.members),
    publicReceipts(state).enabled === true ? 1 : 0, join.mode, join.token, join.ownerId,
    typeof setAt === "string" ? setAt : null, updatedAt);
}

export function refreshLinkedDirectory(store, roomId) {
  const links = store.db.prepare("SELECT DISTINCT identity_id AS identityId FROM identity_links WHERE room_id=?").all(roomId);
  for (const link of links) refreshDirectoryIdentity(store, link.identityId);
}

// Re-sync every directory card a room's receipts can touch: the
// identities linked into the room, plus every identity credited on the
// room's receipts (a public-work receipt credits its identity without a
// link row for the task room). Called when the room's visibility inputs
// change — the owner's receipts toggle, an operator room takedown — so
// counts move with the change, not with the next projection.
export function refreshDirectoryForRoom(store, roomId) {
  // A store predating the identity-links table has no linked identities
  // to refresh; the caller's write (a toggle flip, a takedown) must not
  // fail because the re-sync sweep cannot run on it.
  try { refreshLinkedDirectory(store, roomId); } catch { /* no links table, no links */ }
  const identities = new Set();
  try {
    const rows = store.db.prepare(`SELECT pr.agent_ids_json AS agentIds FROM public_receipts pr
      LEFT JOIN public_work_receipts pwr ON pwr.receipt_id = pr.id
      LEFT JOIN public_work_tasks pwt ON pwt.offer_id = pwr.offer_id
      WHERE pr.room_id=? OR pr.origin_room_id=? OR pwt.room_id=?`).all(roomId, roomId, roomId);
    for (const row of rows) {
      for (const id of parseJson(row.agentIds, [])) if (typeof id === "string" && id) identities.add(id);
    }
  } catch { /* predating tables: the linked identities above are the whole sweep */ }
  for (const identityId of identities) refreshDirectoryIdentity(store, identityId);
}

// Re-sync the cards one receipt credits, after an operator takedown of
// that receipt. Lot receipts have no public_receipts row — they were
// never counted, so there is nothing to re-sync. Display names among
// the row's agents are passed through harmlessly: refreshDirectory-
// Identity only matches cards by identity id.
export function refreshDirectoryForReceipt(store, receiptId) {
  let row = null;
  try {
    row = store.db.prepare("SELECT agent_ids_json AS agentIds, agents_json AS agents FROM public_receipts WHERE id=?").get(receiptId);
  } catch { row = null; }
  if (!row) return;
  const identities = new Set();
  for (const id of [...parseJson(row.agentIds, []), ...parseJson(row.agents, [])]) {
    if (typeof id === "string" && id) identities.add(id);
  }
  for (const identityId of identities) refreshDirectoryIdentity(store, identityId);
}

// Same transaction as the event write when the caller is already inside one.
export function syncRoomPublication(store, { roomId, state, previous = null, auth = null } = {}) {
  if (!roomId || !state?.room) return;
  const pageOn = publicPage(state).enabled === true;
  const pageWas = publicPage(previous).enabled === true;
  const receiptsOn = publicReceipts(state).enabled === true;
  const receiptsWere = publicReceipts(previous).enabled === true;
  // Lot receipts have no public_receipts row for an opt-out to delete, so
  // the RECORDED receipts setting is mirrored into
  // room_public_receipts_setting for the lot read: only a recorded on
  // serves a lot (#3594) — "never recorded" and "recorded false" both
  // keep the lot private, and the mirror keeps the exact recorded value
  // so the read can require the on. The setter bumps the recorded
  // revision on every record, so an unchanged revision needs no write;
  // a null previous (bootstrap, import, backfill) is an authoritative
  // state and always re-mirrors.
  const recorded = state.room.publicReceipts;
  const hasRecorded = !!recorded && typeof recorded.enabled === "boolean";
  const recordedWas = previous?.room?.publicReceipts ?? null;
  const mirrorSetting = previous === null
    || (hasRecorded && (!recordedWas || typeof recordedWas.enabled !== "boolean"
      || recordedWas.revision !== recorded.revision));
  if (!pageOn && !pageWas && !receiptsOn && !receiptsWere && !mirrorSetting) return;
  const write = () => {
    if (mirrorSetting) {
      if (hasRecorded) {
        store.db.prepare(`INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?)
          ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled`).run(roomId, recorded.enabled ? 1 : 0);
      } else {
        store.db.prepare("DELETE FROM room_public_receipts_setting WHERE room_id=?").run(roomId);
      }
    }
    if (receiptsOn || receiptsWere) replaceOptedInReceipts(store, state);
    if (pageOn || pageWas || receiptsOn || receiptsWere) touchPublicWorkListing(store, state);
    if (pageOn) upsertPublicRoom(store, state, auth);
    else if (pageWas) store.db.prepare("DELETE FROM public_rooms WHERE slug=?").run(roomId);
    refreshLinkedDirectory(store, roomId);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

// A claim changed. Refresh that room's public receipts only when it already
// publishes. One indexed lookup; private rooms stop before the projection parse.
export function noteWorkClaimChange(store, roomId) {
  const flags = store.db.prepare(`SELECT json_extract(projection, '$.room.publicReceipts.enabled') AS receipts,
    json_extract(projection, '$.room.publicPage.enabled') AS page FROM rooms WHERE id=?`).get(roomId);
  if (!flags || (flags.receipts !== 1 && flags.page !== 1)) return;
  let state;
  try { state = store.room(roomId).state; } catch { return; }
  syncRoomPublication(store, { roomId, state, previous: state, auth: null });
}

// Directory or public-face listing changed. One room, on the owner's write.
export function refreshListedRoom(store, roomId) {
  let state;
  try { state = store.room(roomId).state; } catch { return; }
  const write = () => {
    touchPublicWorkListing(store, state);
    if (publicReceipts(state).enabled === true) replaceOptedInReceipts(store, state);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

export function projectPublicWorkReceipt(store, body, artifactSha256 = null) {
  if (!body || typeof body.receiptId !== "string" || !body.receiptId.startsWith("pwr_")) return;
  // A public-work receipt body names its claim NAMESPACE, not its room —
  // but this read model speaks in room ids: the public record exposes
  // room_id as the receipt's room, and the operator unpublish predicate
  // (HIDDEN_RECEIPT) matches room takedowns against it. Resolve the task's
  // room so the receipt carries its true room; with the namespace left in
  // place, a room takedown never hides these receipts and the public
  // record presents an internal namespace key as if it were a room id.
  let roomId = typeof body.namespaceId === "string" ? body.namespaceId : null;
  if (typeof body.taskId === "string" && body.taskId) {
    try {
      const task = store.db.prepare("SELECT room_id FROM public_work_tasks WHERE offer_id=?").get(body.taskId);
      if (typeof task?.room_id === "string" && task.room_id) roomId = task.room_id;
    } catch { /* no task table/row (legacy receipt): keep the namespace fallback */ }
  }
  const listed = roomId ? isListed(store, roomId) : false;
  let roomTitle = null;
  let ownerName = null;
  if (listed) {
    try {
      const state = store.room(roomId).state;
      roomTitle = cleanName(state?.room?.title);
      ownerName = credit(state, state?.room?.ownerId)?.name ?? null;
    } catch { /* the room is gone; the receipt still publishes without its title */ }
  }
  const hashes = hashList([
    HEX64.test(artifactSha256 ?? "") ? `sha256:${artifactSha256}` : null,
    HEX64.test(body.artifact?.sha256 ?? "") ? `sha256:${body.artifact.sha256}` : null,
  ].filter(Boolean));
  const row = {
    id: body.receiptId,
    title: cleanName(body.title) ?? "Public work",
    source: "public-work",
    originRoomId: roomId,
    roomId,
    roomTitle,
    agents: typeof body.agentName === "string" && body.agentName ? [body.agentName]
      : typeof body.identityId === "string" && body.identityId ? [body.identityId] : [],
    agentIds: typeof body.identityId === "string" && body.identityId ? [body.identityId] : [],
    humans: [],
    pullRequest: null,
    mergedAt: null,
    verificationState: null,
    hashes,
    at: iso(body.createdAt) ?? new Date(0).toISOString(),
    startHref: startHref(ownerName),
  };
  const write = () => {
    insertReceipt(store, row);
    if (typeof body.identityId === "string") refreshDirectoryIdentity(store, body.identityId);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

function directoryCounts(store, agentId, identityId) {
  let roomCount = 0;
  if (identityId) {
    const links = store.db.prepare("SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?").all(identityId);
    for (const link of links) {
      const room = store.db.prepare("SELECT members_json FROM public_rooms WHERE slug=?").get(link.roomId);
      if (!room) continue;
      const members = parseJson(room.members_json, []);
      if (members.some(item => item && item.id === link.memberId)) roomCount += 1;
    }
  }
  // Receipts count by credited IDENTITY (agent_ids_json, recorded at
  // projection), never by display name: the old count matched name
  // strings across agents_json and humans_json, so a namesake agent's —
  // or a human's — receipts inflated a card (ATLAS-PUBLIC P-1). And
  // only receipts passing the one visibility predicate count: owner-
  // hidden and operator-unpublished receipts are not public proof of
  // work, whatever their credit. One aggregate, not a corpus scan.
  const keys = [...new Set([identityId, agentId].filter(id => typeof id === "string" && id))];
  let receiptCount = 0;
  if (keys.length) {
    try {
      const visibility = receiptVisibilitySqlFor(store.db);
      const row = store.db.prepare(`SELECT COUNT(*) AS n FROM public_receipts
        WHERE ${visibility} AND EXISTS (
          SELECT 1 FROM json_each(COALESCE(public_receipts.agent_ids_json, '[]'))
          WHERE value IN (SELECT value FROM json_each(?)))`).get(JSON.stringify(keys));
      receiptCount = row?.n ?? 0;
    } catch { receiptCount = 0; } // a store predating the ids column credits nobody — undercount, never leak
  }
  return { roomCount, receiptCount };
}

export function syncDirectoryCard(store, agentId) {
  if (typeof agentId !== "string" || !agentId) return;
  const write = () => {
    const row = store.db.prepare(`SELECT card_json, visibility, owner_identity_id AS identityId, withdrawn
      FROM agent_directory_cards WHERE agent_id=?`).get(agentId);
    if (!row || row.withdrawn || row.visibility !== "public") {
      store.db.prepare("DELETE FROM public_directory_entries WHERE agent_id=?").run(agentId);
      return;
    }
    const card = parseJson(row.card_json, {});
    const counts = directoryCounts(store, agentId, row.identityId);
    const skills = Array.isArray(card.skills) ? card.skills.filter(skill => typeof skill === "string") : [];
    store.db.prepare(`INSERT INTO public_directory_entries
      (agent_id, name, description, skills_json, identity_id, receipt_count, room_count, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name=excluded.name, description=excluded.description, skills_json=excluded.skills_json,
        identity_id=excluded.identity_id, receipt_count=excluded.receipt_count, room_count=excluded.room_count,
        updated_at=excluded.updated_at`
    ).run(agentId, typeof card.name === "string" && card.name ? card.name : agentId,
      typeof card.description === "string" ? card.description : "",
      JSON.stringify(skills), row.identityId, counts.receiptCount, counts.roomCount, new Date().toISOString());
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

export function refreshDirectoryIdentity(store, identityId) {
  if (typeof identityId !== "string" || !identityId) return;
  const cards = store.db.prepare("SELECT agent_id AS agentId FROM public_directory_entries WHERE identity_id=?").all(identityId);
  for (const card of cards) syncDirectoryCard(store, card.agentId);
}

function backfillCursor(store) {
  let row = store.db.prepare("SELECT phase, cursor, done FROM public_read_model_backfill WHERE id=1").get();
  if (!row) {
    store.db.prepare("INSERT INTO public_read_model_backfill (id, phase, cursor, done) VALUES (1, 'rooms', '', 0)").run();
    row = { phase: "rooms", cursor: "", done: 0 };
  }
  return row;
}

function saveCursor(store, phase, cursor, done) {
  store.db.prepare("UPDATE public_read_model_backfill SET phase=?, cursor=?, done=? WHERE id=1").run(phase, cursor, done ? 1 : 0);
}

// One bounded batch. The worker cron calls this until done is 1.
export function backfillPublicReadModel(store, { limit = PUBLIC_BACKFILL_BATCH, deadline = Infinity } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : PUBLIC_BACKFILL_BATCH;
  const cursor = backfillCursor(store);
  if (cursor.done) return { done: true, rooms: 0, receipts: 0, cards: 0 };
  const expired = () => Date.now() >= deadline;
  if (cursor.phase === "rooms") {
    const rows = store.db.prepare("SELECT id, projection FROM rooms WHERE id > ? ORDER BY id LIMIT ?").all(cursor.cursor ?? "", cap);
    let rooms = 0;
    let last = cursor.cursor ?? "";
    for (const row of rows) {
      if (expired()) {
        saveCursor(store, "rooms", last, false);
        return { done: false, rooms, receipts: 0, cards: 0, budgetExceeded: true };
      }
      last = row.id;
      rooms += 1;
      try {
        const state = hydrateWorkItems(store.db, row.id, JSON.parse(row.projection));
        if (state?.room?.id) syncRoomPublication(store, { roomId: state.room.id, state, previous: null, auth: null });
      } catch { /* a corrupt projection is not a public page */ }
    }
    if (rows.length < cap) saveCursor(store, "receipts", "", false);
    else saveCursor(store, "rooms", last, false);
    return { done: false, rooms, receipts: 0, cards: 0 };
  }
  if (cursor.phase === "receipts") {
    const rows = store.db.prepare(`SELECT receipt_id, artifact_sha256, receipt_json FROM public_work_receipts
      WHERE receipt_id > ? ORDER BY receipt_id LIMIT ?`).all(cursor.cursor ?? "", cap);
    let receipts = 0;
    let last = cursor.cursor ?? "";
    for (const row of rows) {
      if (expired()) {
        saveCursor(store, "receipts", last, false);
        return { done: false, rooms: 0, receipts, cards: 0, budgetExceeded: true };
      }
      last = row.receipt_id;
      receipts += 1;
      try { projectPublicWorkReceipt(store, JSON.parse(row.receipt_json), row.artifact_sha256); } catch { /* skip a bad receipt */ }
    }
    if (rows.length < cap) saveCursor(store, "directory", "", false);
    else saveCursor(store, "receipts", last, false);
    return { done: false, rooms: 0, receipts, cards: 0 };
  }
  const rows = store.db.prepare(`SELECT agent_id FROM agent_directory_cards
    WHERE visibility='public' AND withdrawn=0 AND agent_id > ? ORDER BY agent_id LIMIT ?`).all(cursor.cursor ?? "", cap);
  let cards = 0;
  let last = cursor.cursor ?? "";
  for (const row of rows) {
    if (expired()) {
      saveCursor(store, "directory", last, false);
      return { done: false, rooms: 0, receipts: 0, cards, budgetExceeded: true };
    }
    last = row.agent_id;
    cards += 1;
    try { syncDirectoryCard(store, row.agent_id); } catch { /* skip a bad card */ }
  }
  if (rows.length < cap) saveCursor(store, "directory", last, true);
  else saveCursor(store, "directory", last, false);
  return { done: rows.length < cap, rooms: 0, receipts: 0, cards };
}

// An unpublished room or receipt stays out of listings, detail reads,
// and the sitemap. The visibility rule — this operator-unpublish leg,
// the owner-toggle leg (#3595: the origin room, plus the owning room of
// a public-work receipt through its task record, since a pwr_ row's
// origin can be a namespace rather than a room id), and their
// composition — is defined once in server/public-visibility.mjs. The
// directory receipt count applies the same predicate (PR 2 of the
// visibility package); the claim that it did was false before it.
const HIDDEN_RECEIPT = OPERATOR_HIDDEN_RECEIPT_SQL;

const receiptFilter = (room, needle) => {
  const clauses = [];
  const params = [];
  if (room) {
    // A room's own receipts match by their source room even when the
    // room withholds its public face (room_id stays null until the
    // room lists): the caller already holds the room id, so the filter
    // confirms nothing the receipt page doesn't. Public-work rows
    // carry their room in room_id — their origin is a namespace, never
    // a room — so the origin leg names only the room sources, the same
    // split roomProofRows applies.
    clauses.push("(room_id=? OR (origin_room_id=? AND source IN ('work-claim','work-item')))");
    params.push(room, room);
  }
  if (needle) { clauses.push("instr(lower(agents_json), ?) > 0"); params.push(needle); }
  return { clauses, params };
};

export function queryPublicReceipts(store, { room = null, agent = null, cursor = null, limit = 20 } = {}) {
  if (room != null && (typeof room !== "string" || !room || room.length > 128)) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "room filter must be a room id" } };
  }
  if (agent != null && (typeof agent !== "string" || !agent.trim() || agent.length > 80)) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "agent filter must be a name" } };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "limit must be an integer from 1 to 50" } };
  }
  const needle = agent ? agent.trim().toLowerCase() : null;
  const filter = receiptFilter(room, needle);
  // The rows this list could serve: filter matches, minus both kinds of
  // hidden (operator-unpublished, owner-toggled-off). The page query and
  // the cursor lookup apply the same set, so a served nextCursor always
  // names a receipt a follow-up request may anchor on.
  const visibility = ownerToggleReadable(store.db)
    ? [HIDDEN_RECEIPT, ownerHiddenReceiptSql({ taskRoomLeg: publicWorkTablesReadable(store.db) })]
    : [HIDDEN_RECEIPT];
  let after = "";
  const afterParams = [];
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor) {
      return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
    }
    // The cursor must name a receipt this list could serve: a hidden row
    // is not a valid pagination position — accepting it would confirm the
    // hidden receipt exists and where it sits in the order (#3595). Both
    // hiding mechanisms count: operator unpublish (HIDDEN_RECEIPT) and the
    // owner public-receipts toggle (the owner leg). Same 422 as a
    // never-existent id.
    const where = `WHERE ${[...filter.clauses, "id=?", ...visibility].join(" AND ")}`;
    const current = store.db.prepare(`SELECT id, at, agents_json, room_id FROM public_receipts ${where}`).get(...filter.params, cursor);
    if (!current) return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
    after = "(at < ? OR (at = ? AND id > ?))";
    afterParams.push(current.at, current.at, current.id);
  }
  const clauses = [...filter.clauses, ...visibility];
  if (after) clauses.push(after);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts ${where} ORDER BY at DESC, id ASC LIMIT ?`)
    .all(...filter.params, ...afterParams, limit + 1);
  const page = rows.slice(0, limit).map(row => receiptWithOutcome(store, row));
  const nextCursor = rows.length > limit ? page.at(-1)?.id ?? null : null;
  return { receipts: page, nextCursor };
}

export function publicReceiptById(store, id) {
  if (typeof id !== "string" || !PUBLIC_RECEIPT_ID.test(id)) return null;
  if (LOT_RECEIPT_ID.test(id)) return publicLotReceiptById(store, id);
  const visibility = receiptVisibilitySqlFor(store.db);
  const row = store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts WHERE id=? AND ${visibility}`).get(id);
  if (!row) return null;
  const pub = receiptWithOutcome(store, row);
  if (typeof id === "string" && id.startsWith("pwr_")) {
    try {
      const j = store.db.prepare("SELECT lot_id, amount, lot_state FROM bounty_journal WHERE receipt_id=? LIMIT 1").get(id);
      if (j && j.lot_id) {
        pub.lotId = j.lot_id;
        pub.settlement = {
          lotId: j.lot_id,
          amountCredits: Math.abs(j.amount) / 1000,
          lotState: j.lot_state
        };
      }
    } catch { /* graceful fallback */ }
  }
  return pub;
}

// What one public-work receipt's own records say about its outcome (#3733).
// Two records carry the truth, and neither is rewritten to serve this read.
// The receipt record is the settlement train's: minted "submitted" at
// finish with its verification tier (hash_only, or system_checked when a
// platform-executed check passed), the worker-reported checks, and the
// executed checks; an acceptance stamps it in place — state "verified",
// executed checks merged, the verified{} block naming the deciding review
// (#3546). The review record (public_work_reviews) is the separate later
// fact: the designated reviewer's verdict and decision. Before this
// composition the public projection dropped both records' outcome fields,
// so an accepted receipt and a rejected one were indistinguishable to a
// stranger. The composed state binds to the train's model: a rejection or
// revision request (which never stamp the record) reads as the decision;
// anything else reads the record's own state, so acceptance surfaces as
// "verified" — the stamp's word — and this face never claims a verified
// state the stamp did not write. Field discipline mirrors the lot
// projection below: only facts already readable on the canonical receipt
// or the contributor's own review read are projected — never the
// reviewer's member id, the review reason (member free text), or the
// review fingerprint.
const WORK_DECISIONS = new Set(["rejected", "revision_requested"]);
const REVIEW_STATES = new Set(["pending", "accepted", "rejected", "revision_requested"]);
const outcomeWord = value => typeof value === "string" && /^[a-z][a-z_]{0,31}$/.test(value) ? value : null;
const reportedChecks = value => Array.isArray(value)
  ? value.map(entry => cleanText(entry, 1000)).filter(Boolean).slice(0, 20) : [];
const executedChecksOf = value => {
  if (!Array.isArray(value)) return [];
  const checks = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const name = cleanText(entry.name, 64);
    const result = entry.result === "pass" || entry.result === "fail" ? entry.result : null;
    if (name && result) checks.push({ name, result });
  }
  return checks;
};

export function publicWorkReceiptOutcome(store, receiptId) {
  if (typeof receiptId !== "string" || !receiptId.startsWith("pwr_")) return null;
  let record = null;
  try {
    const row = store.db.prepare("SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?").get(receiptId);
    if (row) record = parseJson(row.receipt_json, null);
  } catch { record = null; }
  if (!record || typeof record !== "object") return null;
  let saved = null;
  try {
    const row = store.db.prepare("SELECT state_json FROM public_work_reviews WHERE receipt_id=?").get(receiptId);
    if (row) saved = parseJson(row.state_json, null);
  } catch { saved = null; } // a store predating the reviews table has no outcome to compose
  const verification = saved?.verification && typeof saved.verification === "object" ? saved.verification : null;
  const decision = saved?.decision && typeof saved.decision === "object" ? saved.decision : null;
  // No review row, no review block: an unreviewed receipt's faces stay
  // exactly its record's shape plus state/verification/checks.
  const review = saved ? {
    state: REVIEW_STATES.has(saved.state) ? saved.state : "pending",
    verificationVerdict: verification && ["PASS", "FAIL"].includes(verification.verdict) ? verification.verdict : null,
    verificationReviewerKind: verification && ["human", "agent"].includes(verification.reviewerKind) ? verification.reviewerKind : null,
    verifiedAt: iso(verification?.at),
    decidedAt: iso(decision?.at),
  } : null;
  const executed = executedChecksOf(record.executedChecks);
  return {
    state: review && WORK_DECISIONS.has(review.state) ? review.state : outcomeWord(record.state) ?? "submitted",
    verification: outcomeWord(record.verification) ?? "hash_only",
    checksReported: reportedChecks(record.checksReported),
    ...(executed.length ? { executedChecks: executed } : {}),
    review,
  };
}

function receiptWithOutcome(store, row) {
  const out = rowToPublic(row);
  if (row.source !== "public-work") return out;
  const outcome = publicWorkReceiptOutcome(store, row.id);
  if (!outcome) return out;
  const { review, ...fields } = outcome;
  return { ...out, ...fields, ...(review ? { review } : {}) };
}

// Verify-at-read-time support (server/receipt-verify.mjs): rebuild the
// record this id would project from its CURRENT source, so a checker can
// compare it against the stored row. Returns { row, artifactHashOk } —
// row in insertReceipt shape, null when the source no longer yields this
// receipt; artifactHashOk only for public-work receipts (the stored
// artifact still hashes to its recorded sha256), null otherwise. Lot
// receipts return null: the journal is their source, read directly.
export function rederivePublicReceipt(store, id) {
  if (typeof id !== "string" || !PUBLIC_RECEIPT_ID.test(id) || LOT_RECEIPT_ID.test(id)) return null;
  const stored = store.db.prepare("SELECT source, origin_room_id FROM public_receipts WHERE id=?").get(id);
  if (!stored) return null;
  if (stored.source === "public-work") {
    let record;
    try {
      record = store.db.prepare("SELECT artifact_text, artifact_sha256, receipt_json FROM public_work_receipts WHERE receipt_id=?").get(id);
    } catch { return null; }
    if (!record) return null;
    let body = null;
    try { body = JSON.parse(record.receipt_json); } catch { body = null; }
    if (!body || body.receiptId !== id) return null;
    const artifactHashOk = HEX64.test(record.artifact_sha256 ?? "")
      && createHash("sha256").update(record.artifact_text, "utf8").digest("hex") === record.artifact_sha256;
    return {
      artifactHashOk,
      row: {
        id, title: cleanName(body.title) ?? "Public work", source: "public-work",
        agents: typeof body.agentName === "string" && body.agentName ? [body.agentName]
          : typeof body.identityId === "string" && body.identityId ? [body.identityId] : [],
        humans: [], pullRequest: null, mergedAt: null,
        hashes: hashList([
          HEX64.test(record.artifact_sha256 ?? "") ? `sha256:${record.artifact_sha256}` : null,
          HEX64.test(body.artifact?.sha256 ?? "") ? `sha256:${body.artifact.sha256}` : null,
        ].filter(Boolean)),
        at: iso(body.createdAt) ?? new Date(0).toISOString(),
      },
    };
  }
  if (!stored.origin_room_id) return null;
  let state;
  try { state = store.room(stored.origin_room_id)?.state; } catch { return null; }
  if (!state) return null;
  const row = optedInRows(store, state).find(candidate => candidate.id === id) ?? null;
  return { row, artifactHashOk: null };
}

const cleanText = (value, max) => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, max) : null;
};

const finiteNumber = value => typeof value === "number" && Number.isFinite(value) ? value : null;

// Bounty lot receipts are composed at read time from the escrow ledger —
// the same derivation the member-gated credits history uses (one lot is
// one zero-sum journal movement; server/bounty-escrow.mjs history()). No
// lot rows are stored in public_receipts: the journal is the record, and
// a stored copy could drift from it. A lot becomes a public receipt only
// once its bounty carries a recorded settlement verdict (paid out,
// failed, unverified, or split — every terminal path stamps one via
// _recordSettlement). Before settlement, and for journal lots that are
// not bounty movements (transfers carry no bounty_id), the id is a 404.
// The owner's consent gates it like every other shape, through the
// switches that can apply to a row-less record — the lot rule of the
// one visibility definition (server/public-visibility.mjs): operator
// unpublish, the room's own recorded public-receipts setting (only a
// RECORDED on serves the lot, #3594), and the directory receipts
// toggle.
// Amounts convert at MILLIS_PER_CREDIT = 1000 (server/bounty-escrow.mjs).
export function publicLotReceiptById(store, id) {
  if (typeof id !== "string" || !LOT_RECEIPT_ID.test(id)) return null;
  let entries;
  try {
    entries = store.db.prepare(`SELECT entry_id, room_id, account_id, at, kind, bounty_id,
      amount, lot_state, hash, prev_hash, memo, actor_kind, actor_id, receipt_id
      FROM bounty_journal WHERE lot_id=? ORDER BY seq LIMIT 100`).all(id);
  } catch { return null; } // a store with no escrow ledger has no lot receipts
  if (!entries.length) return null;
  const first = entries[0];
  const roomId = first.room_id;
  const bountyId = first.bounty_id;
  if (typeof roomId !== "string" || typeof bountyId !== "string" || !bountyId) return null;
  let bounty;
  try {
    bounty = store.db.prepare(`SELECT room_id, title, amount_millis, poster, verifier, claimant,
      state, rubric_hash, rubric_version, submission_hash, resolution_json, created_at
      FROM bounty_records WHERE bounty_id=?`).get(bountyId);
  } catch { return null; }
  if (!bounty || bounty.room_id !== roomId) return null;
  let resolution = null;
  try { resolution = bounty.resolution_json ? JSON.parse(bounty.resolution_json) : null; } catch { resolution = null; }
  const settlement = resolution && typeof resolution === "object" ? resolution.settlement : null;
  if (!settlement || typeof settlement !== "object") return null;
  // The lot gate is the visibility definition's lot rule
  // (server/public-visibility.mjs): operator unpublish, the recorded
  // opt-in read from its write-time mirror (syncRoomPublication —
  // #3594: no mirror row, an unreadable schema, and a recorded off all
  // keep the lot private; only a recorded enabled = 1 serves it), and
  // the owner's directory receipts toggle, composed in one place.
  if (!lotReceiptVisible(store.db, { id, roomId })) return null;
  let roomTitle = null;
  try {
    if (isListed(store, roomId)) {
      roomTitle = cleanName(store.db.prepare("SELECT title FROM public_rooms WHERE slug=?").get(roomId)?.title ?? null);
    }
  } catch { roomTitle = null; }
  const debit = entries.find(entry => entry.amount < 0) ?? null;
  const credit = entries.find(entry => entry.amount > 0) ?? null;
  const principal = credit ?? first;
  const amountMillis = Math.abs(principal.amount);
  const settledBy = settlement.settledBy && typeof settlement.settledBy === "object"
    ? { kind: cleanText(settlement.settledBy.kind, 32), id: cleanText(settlement.settledBy.id, 256) }
    : null;
  return {
    schema: "project-room-public-receipt/1",
    id,
    title: cleanName(bounty.title) ?? "Bounty",
    source: "bounty-lot",
    room: { id: roomId, title: roomTitle },
    agents: [],
    humans: [],
    pullRequest: null,
    mergedAt: null,
    hashes: hashList(entries.map(entry => HEX64.test(entry.hash ?? "") ? `sha256:${entry.hash}` : null).filter(Boolean)),
    at: iso(first.at) ?? new Date(0).toISOString(),
    startHref: startHref(null),
    lot: {
      bountyId,
      kind: first.kind,
      kinds: [...new Set(entries.map(entry => entry.kind))],
      amountMillis,
      amountCredits: amountMillis / 1000,
      from: debit ? { account: debit.account_id, lotState: debit.lot_state } : null,
      to: { account: principal.account_id, lotState: principal.lot_state },
      memo: cleanText(first.memo, 500),
      actor: first.actor_kind ? { kind: first.actor_kind, id: first.actor_id } : null,
      poster: cleanText(bounty.poster, 256),
      worker: cleanText(bounty.claimant, 256),
      verifier: cleanText(bounty.verifier, 256),
      bountyState: cleanText(bounty.state, 32),
      awardMillis: bounty.amount_millis,
      awardCredits: finiteNumber(bounty.amount_millis) === null ? null : bounty.amount_millis / 1000,
      rubricHash: HEX64.test(bounty.rubric_hash ?? "") ? bounty.rubric_hash : null,
      rubricVersion: Number.isInteger(bounty.rubric_version) ? bounty.rubric_version : null,
      submissionHash: HEX64.test(bounty.submission_hash ?? "") ? bounty.submission_hash : null,
      settlement: {
        kind: cleanText(settlement.kind, 32),
        workerMillis: Number.isSafeInteger(settlement.workerMillis) ? settlement.workerMillis : null,
        workerCredits: finiteNumber(settlement.workerCredits),
        refundMillis: Number.isSafeInteger(settlement.refundMillis) ? settlement.refundMillis : null,
        refundCredits: finiteNumber(settlement.refundCredits),
        reason: cleanText(settlement.reason, 500),
        settledAt: iso(settlement.settledAt),
        settledBy: settledBy && settledBy.id ? settledBy : null,
      },
      movements: entries.map(entry => ({
        entryId: entry.entry_id,
        kind: entry.kind,
        account: entry.account_id,
        lotState: entry.lot_state,
        amountMillis: entry.amount,
      })),
      entries: entries.map(entry => entry.entry_id),
      signedReceiptIds: [...new Set(entries.map(entry => entry.receipt_id).filter(Boolean))],
      workReceiptId: entries.map(entry => entry.receipt_id).find(id => typeof id === "string" && id.startsWith("pwr_")) ?? null,
      journalHash: HEX64.test(first.hash ?? "") ? first.hash : null,
      prevHash: HEX64.test(first.prev_hash ?? "") ? first.prev_hash : null,
      bountyCreatedAt: iso(bounty.created_at),
    },
  };
}

export function collectPublicReceipts(store) {
  const visibility = receiptVisibilitySqlFor(store.db);
  return store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts WHERE ${visibility} ORDER BY at DESC, id ASC`).all()
    .map(row => receiptWithOutcome(store, row));
}

export function listPublicReceiptSitemap(store, limit = 1000) {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
  const visibility = receiptVisibilitySqlFor(store.db);
  return store.db.prepare(`SELECT id, at FROM public_receipts WHERE ${visibility} ORDER BY at DESC, id ASC LIMIT ?`).all(cap).map(row => ({
    path: `/receipts/${row.id}`,
    lastmod: typeof row.at === "string" ? row.at.slice(0, 10) : null,
  }));
}

export function loadPublicRoom(store, slug) {
  if (!SLUG.test(slug) || isUnpublished(store.db, "room", slug)) return null;
  const row = store.db.prepare(`SELECT slug, title, purpose, humans, agents, names_json, tasks_json, receipts_enabled, join_mode, join_token, set_at
    FROM public_rooms WHERE slug=?`).get(slug);
  if (!row) return null;
  return {
    slug: row.slug,
    title: row.title,
    purpose: row.purpose,
    counts: { humans: row.humans, agents: row.agents },
    names: parseJson(row.names_json, []),
    tasks: parseJson(row.tasks_json, []),
    receiptsEnabled: row.receipts_enabled === 1,
    joinMode: row.join_mode === "link" && row.join_token ? "link" : "request",
    joinToken: row.join_mode === "link" ? row.join_token : null,
    setAt: row.set_at,
  };
}

export function listPublicRoomSitemap(store) {
  return store.db.prepare("SELECT slug, set_at, receipts_enabled FROM public_rooms ORDER BY slug ASC").all()
    .filter(row => !isUnpublished(store.db, "room", row.slug))
    .map(row => ({
      slug: row.slug,
      setAt: row.set_at,
      receiptsEnabled: row.receipts_enabled === 1,
    }));
}

// What one public receipt actually proves, named by its source. Only a
// work-claim receipt with a merge on it is server-verified: optedInRows
// projects a claim after serverVerifiedMerge passed (the server's own
// poll wrote pr_merged + syncedAt). A result-mode work-claim receipt
// (#3636) carries the verification fact recorded on the claim instead:
// member-verified when a distinct member reviewed the delivery,
// self-attested when the worker's own finish is the only record. A
// work-item receipt is the room's own record of a completion. A
// public-work receipt records an artifact hash; its checks are
// worker-reported (verification: "hash_only").
export function proofLevelOf(receipt) {
  if (receipt?.source === "work-claim" && receipt.mergedAt && receipt.pullRequest) return "server-verified-merge";
  if (receipt?.source === "work-claim" && receipt.verification?.state === "verified") return "member-verified-completion";
  if (receipt?.source === "work-claim" && receipt.verification?.state === "self_attested") return "self-attested-completion";
  if (receipt?.source === "work-item") return "room-recorded-completion";
  if (receipt?.source === "public-work") return "artifact-hash-recorded";
  return "room-recorded";
}

// Every public receipt that belongs to one room, newest first — the proof
// page's row set. Same room attribution as roomPageReceipts: rows naming
// the room directly, plus the room's own work-claim / work-item receipts
// (origin_room_id) which carry room_id only when the room is listed.
// The full visibility predicate applies here in SQL, like every other
// public receipt read.
export function roomProofRows(store, slug) {
  const visibility = receiptVisibilitySqlFor(store.db);
  return store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts
    WHERE ${visibility} AND (room_id=? OR (origin_room_id=? AND source IN ('work-claim','work-item')))
    ORDER BY at DESC, id ASC`).all(slug, slug).map(row => receiptWithOutcome(store, row));
}

// Newest-first page of receipts that name this room. `after` is the last row
// of the previous page ({ at, id }) so a caller can skip rows it will drop.
export function roomPageReceipts(store, slug, receiptsEnabled, { limit = 5, after = null } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 5;
  const params = [slug, receiptsEnabled ? 1 : 0, slug];
  let cursor = "";
  if (after && typeof after.at === "string" && typeof after.id === "string") {
    cursor = " AND (at < ? OR (at = ? AND id > ?))";
    params.push(after.at, after.at, after.id);
  }
  params.push(cap);
  const visibility = receiptVisibilitySqlFor(store.db);
  return store.db.prepare(`SELECT id, title, at FROM public_receipts
    WHERE ${visibility} AND (room_id=? OR (?=1 AND origin_room_id=? AND source IN ('work-claim','work-item')))${cursor}
    ORDER BY at DESC, id ASC LIMIT ?`).all(...params);
}

export function queryDirectoryEntries(store, { cursor = null, limit = DIRECTORY_PAGE_SIZE } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : DIRECTORY_PAGE_SIZE;
  let rows;
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor) {
      return { error: { status: 422, code: "invalid_cursor", message: "cursor is not an agent on this list" } };
    }
    const current = store.db.prepare("SELECT name, agent_id FROM public_directory_entries WHERE agent_id=?").get(cursor);
    if (!current) return { error: { status: 422, code: "invalid_cursor", message: "cursor is not an agent on this list" } };
    rows = store.db.prepare(`SELECT agent_id, name, description, skills_json, receipt_count, room_count
      FROM public_directory_entries WHERE name > ? OR (name = ? AND agent_id > ?)
      ORDER BY name ASC, agent_id ASC LIMIT ?`).all(current.name, current.name, current.agent_id, cap + 1);
  } else {
    rows = store.db.prepare(`SELECT agent_id, name, description, skills_json, receipt_count, room_count
      FROM public_directory_entries ORDER BY name ASC, agent_id ASC LIMIT ?`).all(cap + 1);
  }
  const page = rows.slice(0, cap).map(row => ({
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    skills: parseJson(row.skills_json, []),
    receiptCount: row.receipt_count,
    roomCount: row.room_count,
  }));
  return { agents: page, nextCursor: rows.length > cap ? page.at(-1)?.agentId ?? null : null };
}

// Tail the durable events table into analytics_events.
// AN-1b calls analyticsTailJob once a minute. AN-1c fills analytics_ctx;
// a row with no context is backfilled, source unknown, and its loop comes
// only from the event data.
import { attributionFromRef } from "./attribution.mjs";
import { LOOPS, SOURCES, growthEventId, sourceDetailFor, validateGrowthEvent } from "./catalog.mjs";
import { readAnalyticsContext } from "./context.mjs";
import { derivedSources, readDerivedPage } from "./derive-tables.mjs";
import { absorbRoomEvent, emptyRoomFacts, mapRoomEvent } from "./map-room-event.mjs";
import { planRetention } from "./retention.mjs";
import { addDaily, ensureAnalyticsSchema, setDaily, tableExists, utcDay } from "./schema.mjs";

export const COMMONS_ROOM_ID = "commons";
export const EXCLUDED_NAME = /^(qa|canary|instinct-canary|smoke)/i;
const ROOM_LIMIT = 50;
const INSERT = `INSERT OR IGNORE INTO analytics_events (
  id, name, v, at, room_id, account_id, actor_kind, actor_id, source, source_detail,
  agent_client, referrer_artifact_id, ref_member_id, loop, viewer_key, room_event_id,
  room_seq, props, weight, backfilled, exported_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`;

export function excludedRoomSet(env = process.env) {
  return new Set(String(env?.ANALYTICS_EXCLUDED_ROOMS ?? "").split(",").map(part => part.trim()).filter(Boolean));
}

export function structuralExclusion({ roomId, title = "", slug = "" }) {
  if (roomId === COMMONS_ROOM_ID) return true;
  return [roomId, title, slug].some(value => typeof value === "string" && EXCLUDED_NAME.test(value.trim()));
}

function roomLabel(projection) {
  try {
    const state = JSON.parse(projection);
    return {
      title: typeof state?.room?.title === "string" ? state.room.title : "",
      slug: typeof state?.room?.slug === "string" ? state.room.slug : ""
    };
  } catch {
    return { title: "", slug: "" };
  }
}

function preloadFacts(db, roomId, cursor) {
  const facts = emptyRoomFacts();
  if (tableExists(db, "member_accounts")) {
    for (const row of db.prepare("SELECT member_id, account_id FROM member_accounts WHERE room_id=?").all(roomId)) {
      facts.accountId[row.member_id] = row.account_id;
    }
  }
  const prior = db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? AND sequence<=? ORDER BY sequence").all(roomId, cursor);
  for (const row of prior) {
    const event = parseEvent(row);
    if (event) absorbRoomEvent(facts, event);
  }
  const members = db.prepare(`SELECT body FROM events WHERE room_id=? AND json_extract(body, '$.type')='member.added'`).all(roomId);
  for (const row of members) {
    try {
      const body = JSON.parse(row.body);
      const data = body?.data ?? {};
      if ((data.kind === "human" || data.kind === "agent") && typeof data.memberId === "string") {
        facts.memberKind[data.memberId] = data.kind;
        if (typeof data.agentType === "string") facts.agentType[data.memberId] = data.agentType;
      }
    } catch { /* a bad member row does not erase the others */ }
  }
  return facts;
}

function parseEvent(row) {
  try {
    const event = JSON.parse(row.body);
    if (!event || typeof event !== "object") return null;
    event.sequence = row.sequence;
    if (!event.id) event.id = row.id;
    return event;
  } catch {
    return null;
  }
}

function loopOf(draft, attributed, backfilled) {
  if (attributed?.loop && LOOPS.includes(attributed.loop)) return attributed.loop;
  if (draft.loopHint && LOOPS.includes(draft.loopHint)) return draft.loopHint;
  if (!backfilled) return "organic";
  return "unknown";
}

async function decorate(db, draft, { excluded, key, now, n }) {
  const ctx = draft.roomEventId ? readAnalyticsContext(db, draft.roomEventId) : null;
  const backfilled = !ctx;
  const source = ctx && SOURCES.includes(ctx.source) ? ctx.source : "unknown";
  const attributed = ctx?.ref ? await attributionFromRef(ctx.ref, key, now) : { refMemberId: null, artifactId: null, loop: null, legacy: false };
  const refMemberId = attributed.refMemberId ?? draft.refMemberId ?? null;
  const referrer = attributed.artifactId ? artifactRef(attributed.artifactId) : draft.referrerArtifactId;
  const props = { ...draft.props };
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) delete props[key];
  }
  if (excluded) props.excluded = true;
  const agentClient = ctx?.agent_client ?? draft.agentClient ?? null;
  if (agentClient && draft.name === "agent_connected" && !props.agent_client) props.agent_client = agentClient;
  return {
    id: growthEventId(draft.sourceKey ?? draft.roomEventId, draft.name, n),
    name: draft.name,
    v: draft.v ?? 1,
    at: draft.at,
    room_id: draft.roomId ?? null,
    account_id: draft.accountId ?? null,
    actor_kind: draft.actorKind,
    actor_id: draft.actorId ?? null,
    source,
    source_detail: sourceDetailFor(source),
    agent_client: agentClient,
    referrer_artifact_id: referrer ?? null,
    ref_member_id: refMemberId,
    loop: loopOf(draft, attributed, backfilled),
    viewer_key: draft.viewerKey ?? null,
    room_event_id: draft.roomEventId ?? null,
    room_seq: draft.roomSeq ?? null,
    props,
    weight: draft.weight ?? 1,
    backfilled: backfilled ? 1 : 0
  };
}

function artifactRef(artifactId) {
  if (typeof artifactId !== "string" || !artifactId) return null;
  if (artifactId.includes(":")) return artifactId;
  return artifactId;
}

function writeRow(db, row, now) {
  const verdict = validateGrowthEvent({ ...row, props: row.props });
  if (!verdict.ok) return { inserted: false, invalid: true, errors: verdict.errors };
  const result = db.prepare(INSERT).run(
    row.id, row.name, row.v, row.at, row.room_id, row.account_id, row.actor_kind, row.actor_id,
    row.source, row.source_detail, row.agent_client, row.referrer_artifact_id, row.ref_member_id,
    row.loop, row.viewer_key, row.room_event_id, row.room_seq, JSON.stringify(row.props), row.weight,
    row.backfilled
  );
  if (result.changes === 1) {
    addDaily(db, utcDay(row.at ?? now), "rows_written", 1);
    if (row.source === "unknown") addDaily(db, utcDay(row.at ?? now), "unknown_source", 1);
  }
  return { inserted: result.changes === 1, invalid: false };
}

export async function insertAnalyticsBatch(db, drafts, { now = Date.now(), key = null, dailyCap, excluded = false, storedOtherToday = 0 } = {}) {
  ensureAnalyticsSchema(db);
  const plan = planRetention(drafts, { storedOtherToday, cap: dailyCap });
  let inserted = 0;
  let sampledOut = 0;
  const kept = [];
  drafts.forEach((draft, index) => {
    if (!plan[index].keep) {
      sampledOut += 1;
      return;
    }
    kept.push({ draft, weight: plan[index].weight });
  });
  for (const item of kept) {
    const row = await decorate(db, { ...item.draft, weight: item.weight }, { excluded, key, now, n: item.draft.n ?? 0 });
    row.weight = item.weight;
    const written = writeRow(db, row, now);
    if (written.inserted) inserted += 1;
  }
  if (sampledOut) addDaily(db, utcDay(now), "sampled_out", sampledOut);
  return { inserted, sampledOut };
}

async function tailRoom(db, room, options, result) {
  const now = options.now ?? Date.now();
  const batch = options.batch ?? 500;
  const label = roomLabel(room.projection);
  const excluded = structuralExclusion({ roomId: room.id, ...label });
  let cursor = room.last_seq ?? 0;
  if (room.sequence < cursor) cursor = 0;
  const facts = preloadFacts(db, room.id, cursor);
  facts.excluded = excluded;
  let last = cursor;
  let guard = 0;
  while (last < room.sequence && guard < 100000) {
    guard += 1;
    const rows = db.prepare(`SELECT sequence, id, body FROM events
      WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(room.id, last, batch);
    if (!rows.length) break;
    for (const row of rows) {
      const event = parseEvent(row);
      if (!event) {
        addDaily(db, utcDay(now), "bad_event", 1);
        last = row.sequence;
        continue;
      }
      const mapped = mapRoomEvent(event, facts);
      for (let n = 0; n < mapped.length; n += 1) {
        const decorated = await decorate(db, mapped[n], { excluded, key: options.key ?? null, now, n });
        const written = writeRow(db, decorated, now);
        if (written.invalid) addDaily(db, utcDay(now), "invalid_event", 1);
        if (written.inserted) result.rowsWritten += 1;
      }
      last = row.sequence;
    }
    db.prepare(`INSERT INTO analytics_room_cursor(room_id, last_seq, updated_at) VALUES(?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at`).run(room.id, last, now);
    if (Date.now() - options.started >= (options.budgetMs ?? 50)) {
      result.budgetHit = true;
      return false;
    }
    if (rows.length < batch) break;
  }
  db.prepare(`INSERT INTO analytics_room_cursor(room_id, last_seq, updated_at) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at`).run(room.id, last, now);
  return true;
}

async function tailDerived(db, options, result) {
  const now = options.now ?? Date.now();
  const missing = [];
  for (const source of derivedSources()) {
    if (Date.now() - options.started >= (options.budgetMs ?? 50) && result.derived > 0) {
      result.budgetHit = true;
      return false;
    }
    let more = true;
    let guard = 0;
    while (more && guard < 10000) {
      guard += 1;
      const cursor = db.prepare("SELECT last_key FROM analytics_table_cursor WHERE source=?").get(source)?.last_key ?? null;
      const page = readDerivedPage(db, source, cursor, options.batch ?? 500);
      if (page.missing) {
        missing.push(source);
        break;
      }
      for (let index = 0; index < page.events.length; index += 1) {
        const event = page.events[index];
        const decorated = await decorate(db, event, { excluded: false, key: options.key ?? null, now, n: index });
        const written = writeRow(db, decorated, now);
        if (written.inserted) {
          result.rowsWritten += 1;
          result.derived += 1;
        }
      }
      if (page.nextCursor) {
        db.prepare(`INSERT INTO analytics_table_cursor(source, last_key) VALUES(?,?)
          ON CONFLICT(source) DO UPDATE SET last_key=excluded.last_key`).run(source, page.nextCursor);
      }
      more = page.more === true;
      if (more && Date.now() - options.started >= (options.budgetMs ?? 50)) {
        result.budgetHit = true;
        return false;
      }
      if (!page.events.length) break;
    }
  }
  if (missing.length) setDaily(db, utcDay(now), "missing_table", missing.length);
  return true;
}

export async function runAnalyticsTail(db, { budgetMs = 50, batch = 500, now = Date.now(), key = null, env = process.env } = {}) {
  const result = { rowsWritten: 0, roomsVisited: 0, derived: 0, errors: 0, done: false, budgetHit: false };
  // REL-13: this tail holds a raw BEGIN across awaits. DurableDatabase has no
  // raw BEGIN (storage.transactionSync only) and its transactions must stay
  // synchronous. The tail is Node-only. A Durable Object store skips it.
  if (typeof db?.storage?.transactionSync === "function") return { ...result, skipped: true, reason: "node_only" };
  let logged = false;
  const fail = error => {
    result.errors += 1;
    if (!logged) {
      logged = true;
      console.error("analytics tail failed:", error?.message ?? error);
    }
    try { addDaily(db, utcDay(now), "tail_errors", 1); } catch { /* schema may be the thing that failed */ }
  };
  try {
    ensureAnalyticsSchema(db);
    const options = { budgetMs, batch, now, key, env, started: Date.now() };
    const rooms = db.prepare(`SELECT r.id, r.sequence, r.projection, c.last_seq
      FROM rooms r
      LEFT JOIN analytics_room_cursor c ON c.room_id = r.id
      WHERE r.sequence > COALESCE(c.last_seq, 0) OR r.sequence < COALESCE(c.last_seq, 0)
      ORDER BY r.id LIMIT ?`).all(ROOM_LIMIT);
    for (const room of rooms) {
      result.roomsVisited += 1;
      db.exec("BEGIN");
      try {
        const finished = await tailRoom(db, room, options, result);
        db.exec("COMMIT");
        if (!finished) return result;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        fail(error);
        return result;
      }
    }
    const capped = rooms.length === ROOM_LIMIT;
    db.exec("BEGIN");
    try {
      const finished = await tailDerived(db, options, result);
      db.exec("COMMIT");
      result.done = finished && !capped && !result.budgetHit;
      if (!finished) return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      fail(error);
      return result;
    }
    if (capped) result.done = false;
  } catch (error) {
    fail(error);
  }
  return result;
}

// AN-1b job entry. Gated on ANALYTICS_ENABLED (default on; tests leave it unset
// and call runAnalyticsTail directly). "0" skips the run.
export async function analyticsTailJob(db, env = process.env) {
  if (env?.ANALYTICS_ENABLED === "0") return { skipped: true };
  return runAnalyticsTail(db, { budgetMs: 50, now: Date.now(), key: env?.ANALYTICS_REF_KEY ?? null, env });
}

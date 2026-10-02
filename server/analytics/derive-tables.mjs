// Keyset readers for side tables that never write a room event.
// A missing table yields nothing and is counted by the tail. The G3
// referrals.activated_at column is read only when it exists.
import { columnExists, tableExists } from "./schema.mjs";

const PAGE = 500;

function cursorParts(cursor) {
  if (!cursor) return [-1, ""];
  try {
    const parsed = JSON.parse(cursor);
    if (Array.isArray(parsed) && parsed.length === 2) return parsed;
  } catch { /* a corrupt cursor restarts this table */ }
  return [-1, ""];
}

function nextCursor(row, key) {
  return JSON.stringify([row.created_at, key]);
}

function pageRows(db, sql, cursor, limit) {
  const [at, key] = cursorParts(cursor);
  const rows = db.prepare(sql).all(at, key, limit + 1);
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, more };
}

function memberKind(db, roomId, memberId) {
  if (!tableExists(db, "events") || typeof memberId !== "string") return null;
  const row = db.prepare(`SELECT json_extract(body, '$.data.kind') AS kind FROM events
    WHERE room_id=? AND json_extract(body, '$.type')='member.added' AND json_extract(body, '$.data.memberId')=?
    LIMIT 1`).get(roomId, memberId);
  return row?.kind === "agent" || row?.kind === "human" ? row.kind : null;
}

function draft(name, { at, roomId, actorKind, actorId, accountId, props, sourceKey, loopHint, refMemberId }) {
  return {
    name,
    v: 1,
    at,
    roomId: roomId ?? null,
    accountId: accountId ?? null,
    actorKind,
    actorId: actorId ?? null,
    agentClient: null,
    referrerArtifactId: null,
    refMemberId: refMemberId ?? null,
    loopHint: loopHint ?? null,
    props,
    roomEventId: null,
    roomSeq: null,
    sourceKey
  };
}

function readAccounts(db, cursor, limit) {
  if (!tableExists(db, "accounts")) return { missing: true, events: [] };
  const page = pageRows(db, `SELECT id, origin, created_at FROM accounts
    WHERE (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?`, cursor, limit);
  const rows = page.rows;
  const events = rows.map(row => draft("signup", {
    at: row.created_at,
    actorKind: "human",
    actorId: row.id,
    accountId: row.id,
    sourceKey: `accounts:${row.id}`,
    props: { origin: typeof row.origin === "string" && row.origin ? row.origin : "local-provisioning" }
  }));
  const last = rows.at(-1);
  return { events, nextCursor: last ? nextCursor(last, last.id) : null, more: page.more };
}

function inviteRows(db, table, idColumn, cursor, limit, extraWhere = "") {
  const where = extraWhere ? `AND ${extraWhere}` : "";
  return pageRows(db, `SELECT ${idColumn} AS id, created_at FROM ${table}
    WHERE (created_at, ${idColumn}) > (?, ?) ${where} ORDER BY created_at, ${idColumn} LIMIT ?`, cursor, limit);
}

function readInvites(db) {
  const readers = [
    {
      table: "share_links",
      source: "share_links",
      id: "id",
      load: row => db.prepare("SELECT id, room_id, issuer_member_id, created_at FROM share_links WHERE id=?").get(row.id),
      map: (row, kind) => draft("member_invited", {
        at: row.created_at,
        roomId: row.room_id,
        actorKind: kind ?? "human",
        actorId: row.issuer_member_id,
        sourceKey: `share_links:${row.id}`,
        referrer: null,
        loopHint: "invite",
        props: { invite_kind: "share_link", invitee_kind: "either" }
      })
    },
    {
      table: "guest_invites",
      source: "guest_invites",
      id: "id",
      load: row => db.prepare("SELECT id, room_id, minted_by_member_id AS actor, created_at FROM guest_invites WHERE id=?").get(row.id),
      map: (row, kind) => draft("member_invited", {
        at: row.created_at,
        roomId: row.room_id,
        actorKind: kind ?? "human",
        actorId: row.actor,
        sourceKey: `guest_invites:${row.id}`,
        loopHint: "agent_invite",
        props: { invite_kind: "guest", invitee_kind: "agent" }
      })
    },
    {
      table: "agent_invite_codes",
      source: "agent_invite_codes",
      id: "code_hash",
      load: row => db.prepare("SELECT code_hash AS id, room_id, created_by AS actor, created_at FROM agent_invite_codes WHERE code_hash=?").get(row.id),
      map: (row, kind) => draft("member_invited", {
        at: row.created_at,
        roomId: row.room_id,
        actorKind: kind ?? "human",
        actorId: row.actor,
        sourceKey: `agent_invite_codes:${row.id}`,
        loopHint: "agent_invite",
        props: { invite_kind: "agent_code", invitee_kind: "agent" }
      })
    },
    {
      table: "referral_invites",
      source: "referral_invites",
      id: "jti",
      load: row => db.prepare("SELECT jti AS id, room_id, inviter_member_id AS actor, created_at, depth FROM referral_invites WHERE jti=?").get(row.id),
      map: (row, kind) => [
        draft("member_invited", {
          at: row.created_at,
          roomId: row.room_id,
          actorKind: kind ?? "human",
          actorId: row.actor,
          sourceKey: `referral_invites:${row.id}`,
          refMemberId: row.actor,
          loopHint: "referral",
          props: { invite_kind: "referral", invitee_kind: "agent" }
        }),
        draft("referral_sent", {
          at: row.created_at,
          roomId: row.room_id,
          actorKind: kind ?? "human",
          actorId: row.actor,
          sourceKey: `referral_invites:${row.id}`,
          refMemberId: row.actor,
          loopHint: "referral",
          props: { channel: "agent_referral" }
        })
      ]
    },
    {
      table: "membership_invitations",
      source: "membership_invitations",
      id: "id",
      load: row => db.prepare("SELECT id, room_id, issuer_member_id AS actor, created_at FROM membership_invitations WHERE id=?").get(row.id),
      map: (row, kind) => draft("member_invited", {
        at: row.created_at,
        roomId: row.room_id,
        actorKind: kind ?? "human",
        actorId: row.actor,
        sourceKey: `membership_invitations:${row.id}`,
        loopHint: "invite",
        props: { invite_kind: "membership", invitee_kind: "human" }
      })
    }
  ];
  // One table per call, chosen by the cursor source the tail passes.
  return readers;
}

function finishInvite(db, spec, cursor, limit) {
  if (!tableExists(db, spec.table)) return { missing: true, events: [], source: spec.source };
  const page = inviteRows(db, spec.table, spec.id, cursor, limit);
  const rows = page.rows;
  const events = [];
  for (const key of rows) {
    const row = spec.load(key);
    if (!row) continue;
    const actor = row.actor ?? row.issuer_member_id;
    const kind = memberKind(db, row.room_id, actor);
    const mapped = spec.map(row, kind);
    for (const event of (Array.isArray(mapped) ? mapped : [mapped])) events.push(event);
  }
  const last = rows.at(-1);
  return {
    source: spec.source,
    events,
    nextCursor: last ? nextCursor(last, last.id) : null,
    more: page.more
  };
}

function readWakes(db, spec, cursor, limit) {
  if (!tableExists(db, spec.table)) return { missing: true, events: [], source: spec.source };
  const page = pageRows(db, spec.sql, cursor, limit);
  const rows = page.rows;
  const events = rows.map(spec.map);
  const last = rows.at(-1);
  return {
    source: spec.source,
    events,
    nextCursor: last ? nextCursor(last, last.key) : null,
    more: page.more
  };
}

const WAKE_READERS = [
  {
    source: "agent_wake_signals",
    table: "agent_wake_signals",
    sql: `SELECT signal_id AS key, agent_id, kind, room_id, created_at, delivered_at FROM agent_wake_signals
      WHERE (created_at, signal_id) > (?, ?) ORDER BY created_at, signal_id LIMIT ?`,
    map: row => draft("agent_woken", {
      at: row.created_at,
      roomId: row.room_id,
      actorKind: "system",
      actorId: row.agent_id,
      sourceKey: `agent_wake_signals:${row.key}`,
      props: {
        wake_kind: row.kind,
        delivered: row.delivered_at != null,
        ack_ms: row.delivered_at != null && row.delivered_at >= row.created_at ? row.delivered_at - row.created_at : null
      }
    })
  },
  {
    source: "wake_queue",
    table: "wake_queue",
    sql: `SELECT room_id || char(31) || member_id || char(31) || queue_key AS key,
      room_id, member_id, state, created_at, updated_at FROM wake_queue
      WHERE (created_at, room_id || char(31) || member_id || char(31) || queue_key) > (?, ?)
      ORDER BY created_at, key LIMIT ?`,
    map: row => draft("agent_woken", {
      at: row.created_at,
      roomId: row.room_id,
      actorKind: "system",
      actorId: row.member_id,
      sourceKey: `wake_queue:${row.key}`,
      props: {
        wake_kind: "queue",
        delivered: row.state === "done",
        ack_ms: row.state === "done" && row.updated_at >= row.created_at ? row.updated_at - row.created_at : null
      }
    })
  },
  {
    source: "agent_work_wakes",
    table: "agent_work_wakes",
    sql: `SELECT signal_id AS key, agent_id, room_id, created_at, delivered_at FROM agent_work_wakes
      WHERE (created_at, signal_id) > (?, ?) ORDER BY created_at, signal_id LIMIT ?`,
    map: row => draft("agent_woken", {
      at: row.created_at,
      roomId: row.room_id,
      actorKind: "system",
      actorId: row.agent_id,
      sourceKey: `agent_work_wakes:${row.key}`,
      props: {
        wake_kind: "work",
        delivered: row.delivered_at != null,
        ack_ms: row.delivered_at != null && row.delivered_at >= row.created_at ? row.delivered_at - row.created_at : null
      }
    })
  }
];

function readPublicReceipts(db, cursor, limit) {
  if (!tableExists(db, "public_work_receipts")) return { missing: true, events: [], source: "public_work_receipts" };
  const page = pageRows(db, `SELECT receipt_id AS id, receipt_json, created_at FROM public_work_receipts
    WHERE (created_at, receipt_id) > (?, ?) ORDER BY created_at, receipt_id LIMIT ?`, cursor, limit);
  const rows = page.rows;
  const events = rows.map(row => {
    let roomId = null;
    try {
      const body = JSON.parse(row.receipt_json);
      if (typeof body?.namespaceId === "string") roomId = body.namespaceId;
    } catch { /* a receipt without a parseable body still counts */ }
    return draft("receipt_issued", {
      at: row.created_at,
      roomId,
      actorKind: "system",
      actorId: null,
      sourceKey: `public_work_receipts:${row.id}`,
      props: { receipt_kind: "pwr", public: true }
    });
  });
  const last = rows.at(-1);
  return { source: "public_work_receipts", events, nextCursor: last ? nextCursor(last, last.id) : null, more: page.more };
}

function readActivations(db, cursor, limit) {
  if (!tableExists(db, "referrals")) return { missing: true, events: [], source: "referrals" };
  if (!columnExists(db, "referrals", "activated_at")) return { events: [], source: "referrals", more: false, nextCursor: null };
  const page = pageRows(db, `SELECT room_id, referrer_member_id, referee_member_id, via, activated_at AS created_at,
      room_id || ':' || referee_member_id AS key FROM referrals
      WHERE activated_at IS NOT NULL AND (activated_at, room_id || ':' || referee_member_id) > (?, ?)
      ORDER BY activated_at, key LIMIT ?`, cursor, limit);
  const rows = page.rows;
  const events = rows.map(row => {
    const kind = memberKind(db, row.room_id, row.referee_member_id) ?? "human";
    return draft("referral_activated", {
      at: row.created_at,
      roomId: row.room_id,
      actorKind: kind,
      actorId: row.referee_member_id,
      refMemberId: row.referrer_member_id,
      sourceKey: `referrals:${row.room_id}:${row.referee_member_id}`,
      loopHint: "referral",
      props: { via: row.via === "request" ? "request" : "invite" }
    });
  });
  const last = rows.at(-1);
  return { source: "referrals", events, nextCursor: last ? nextCursor(last, last.key) : null, more: page.more };
}

export function derivedSources() {
  return Object.freeze([
    "accounts", "share_links", "guest_invites", "agent_invite_codes", "referral_invites",
    "membership_invitations", "agent_wake_signals", "wake_queue", "agent_work_wakes",
    "public_work_receipts", "referrals"
  ]);
}

export function readDerivedPage(db, source, cursor, limit = PAGE) {
  if (source === "accounts") return { source, ...readAccounts(db, cursor, limit) };
  const invite = readInvites(db).find(reader => reader.source === source);
  if (invite) return finishInvite(db, invite, cursor, limit);
  const wake = WAKE_READERS.find(reader => reader.source === source);
  if (wake) return readWakes(db, wake, cursor, limit);
  if (source === "public_work_receipts") return readPublicReceipts(db, cursor, limit);
  if (source === "referrals") return readActivations(db, cursor, limit);
  return { source, missing: true, events: [] };
}

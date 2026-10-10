// CHAOS PROPERTIES — every write emits an event (PRODUCT-200 reliability, C5).
//
// P1: every accepted mutation through the room command pipeline appends its
//     event(s) to the room event log.
// P2: each appended event carries the mutation's key fields (actor, type, ids).
// P3: no phantom events — the log grows by exactly the expected count and
//     every new event is attributable to an issued command.
//
// APPROACH (honest): a seeded model-based generator drives random command
// sequences through the REAL implementation — RoomStore.command in-process,
// plus a smaller HTTP variant through POST /api/rooms/:roomId/commands.
// No model port: the assertions pin invariants directly on the events table
// the implementation wrote. PROPERTY_TEST_SEED shifts the exploration for an
// extra run; the default seed stays fixed (repo convention).
//
// SCOPE: the room command pipeline (store.command / POST /:roomId/commands),
// the single write path that appends room events. Every room mutation an
// agent can issue funnels through it.
//
// COVERAGE BOUNDARIES (documented, not silent):
// - work-claims HTTP routes (the work_claims table path) are A9's board-events
//   anchor; the command pipeline's claim mirror (claim.acquired/released/
//   renewed -> work_claim.updated) IS covered here because it shares the
//   event log and P3 must account for it.
// - work.completed needs signed/text evidence setup; work.handoff_recorded
//   and work.superseded fan out to 2-3 board events each; session.* and bond.*
//   need key/identity setup. Excluded from the random catalog — the emission
//   mechanism under test is type-independent.
// - subsystem-internal appends (invites, access requests, land queue) have
//   their own event tests and are not driven here.
// - bond.list is a read and appends nothing by design; excluded.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { RoomAgentClient } from "../../client/room-agent.mjs";

// Fixed default seed (repo convention, cf. tests/writer-fence-property.test.js);
// PROPERTY_TEST_SEED shifts the exploration for an extra run.
const seedOffset = Number(process.env.PROPERTY_TEST_SEED ?? 0);
function rng(seed) {
  let s = (seed + seedOffset) >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = list => list[int(0, list.length - 1)];
  return { next, int, pick };
}

const SEQUENCES = 210;      // in-process sequences (P1-P3 across the primitive)
const HTTP_SEQUENCES = 25;  // live HTTP route sequences (parity with the primitive)

// Key fields P2 requires on each primary event, by command type.
const KEY_FIELDS = {
  "message.posted": ["messageId", "body"],
  "message.edited": ["messageId", "body"],
  "message.reaction_set": ["messageId", "reaction"],
  "message.pinned": ["messageId"],
  "message.unpinned": ["messageId"],
  "message.deleted": ["messageId"],
  "work.proposed": ["workItemId", "title"],
  "work.accepted": ["workItemId"],
  "work.started": ["workItemId"],
  "work.blocked": ["workItemId"],
  "work.blocker_resolved": ["workItemId"],
  "claim.acquired": ["workItemId"],
  "claim.renewed": ["workItemId"],
  "claim.released": ["workItemId"],
  "decision.recorded": ["sourceMessageId", "statement"],
  "member.status_updated": ["memberId"],
  "capabilities.advertised": ["capabilities"],
};
// Derived events a command appends beyond its own: the extra count and the
// assertions each extra event must satisfy.
const DERIVED = {
  "message.deleted": { extra: 1, type: "message.redacted", key: (ev, cmd) => assert.equal(ev.data.messageId, cmd.data.messageId) },
  "claim.acquired": { extra: 1, type: "work_claim.updated", key: (ev, cmd) => { assert.equal(ev.data.action, "claimed"); assert.equal(ev.data.workClaim, cmd.data.workItemId); } },
  "claim.renewed": { extra: 1, type: "work_claim.updated", key: (ev, cmd) => { assert.equal(ev.data.action, "renewed"); assert.equal(ev.data.workClaim, cmd.data.workItemId); } },
  "claim.released": { extra: 1, type: "work_claim.updated", key: (ev, cmd) => { assert.equal(ev.data.action, "released"); assert.equal(ev.data.workClaim, cmd.data.workItemId); } },
};
const REFUSAL_CODES = new Set(["invalid_command", "command_rejected", "idempotency_conflict", "decision_source_required", "halt_active"]);

// --- model ---------------------------------------------------------------
function freshModel() {
  return { messages: [], works: [], cmdLog: [], msgN: 0, workN: 0, cmdN: 0 };
}
const liveMessages = m => m.messages.filter(x => !x.deleted);
const livePublicMessages = m => liveMessages(m).filter(x => x.isPublic);
const worksIn = (m, states) => m.works.filter(w => states.includes(w.state));
const acquirable = m => m.works.filter(w => w.mode === "write" && ["accepted", "working", "blocked"].includes(w.state) && w.claim !== "active");
const claimActive = m => m.works.filter(w => w.claim === "active");

function buildOp(r, m, seq) {
  const cands = [["post", 20], ["propose", 10], ["status", 3], ["caps", 3], ["refused", 4]];
  if (liveMessages(m).length) cands.push(["edit", 8], ["react", 8], ["delete", 5], ["staleEdit", 2]); // pin only via the unpinned-guard below
  if (liveMessages(m).some(x => !x.pinned)) cands.push(["pin", 3]);
  if (liveMessages(m).some(x => x.pinned)) cands.push(["unpin", 3]);
  if (worksIn(m, ["proposed"]).length) cands.push(["accept", 8]);
  const startable = m.works.filter(w => w.state === "accepted" && (w.mode === "read" || w.claim === "active"));
  if (startable.length) cands.push(["start", 8]);
  if (worksIn(m, ["accepted", "working"]).length) cands.push(["block", 6]);
  if (worksIn(m, ["blocked"]).length) cands.push(["resolve", 6]);
  if (acquirable(m).length) cands.push(["acquire", 6]);
  if (claimActive(m).length) cands.push(["renew", 4], ["release", 4]);
  if (livePublicMessages(m).length) cands.push(["decide", 3]);
  if (m.cmdLog.length) cands.push(["dup", 4], ["conflict", 2]);
  if (m.messages.some(x => x.deleted)) cands.push(["deleteDead", 1]);
  const total = cands.reduce((a, [, w]) => a + w, 0);
  let roll = r.next() * total;
  const kind = cands.find(([, w]) => (roll -= w) < 0)[0];
  const cid = () => `c-${seq}-${m.cmdN++}`;
  const actor = () => (r.next() < 0.7 ? "owner" : "peer");

  switch (kind) {
    case "post": {
      const id = `m-${seq}-${m.msgN++}`;
      const who = actor();
      m.messages.push({ id, rev: 0, deleted: false, pinned: false, author: who, isPublic: true });
      return { expect: "ok", delta: 1, actor: who, cmd: { id: cid(), type: "message.posted", data: { messageId: id, body: `chaos post ${id}` } } };
    }
    case "edit": {
      const msg = r.pick(liveMessages(m));
      const who = msg.author === "peer" && r.next() < 0.5 ? "peer" : "owner"; // author or owner may edit
      const data = { messageId: msg.id, body: `chaos edit ${msg.id} r${msg.rev}`, expectedMessageRevision: msg.rev };
      msg.rev += 1;
      return { expect: "ok", delta: 1, actor: who, cmd: { id: cid(), type: "message.edited", data } };
    }
    case "react": {
      const msg = r.pick(liveMessages(m));
      return { expect: "ok", delta: 1, actor: actor(), cmd: { id: cid(), type: "message.reaction_set", data: { messageId: msg.id, reaction: r.pick(["👍", "🎉", "👀"]), active: true } } };
    }
    case "pin": {
      const msg = r.pick(liveMessages(m).filter(x => !x.pinned));
      msg.pinned = true;
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "message.pinned", data: { messageId: msg.id } } };
    }
    case "unpin": {
      const msg = r.pick(liveMessages(m).filter(x => x.pinned));
      msg.pinned = false;
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "message.unpinned", data: { messageId: msg.id } } };
    }
    case "delete": {
      const msg = r.pick(liveMessages(m));
      const data = { messageId: msg.id, expectedMessageRevision: msg.rev };
      msg.deleted = true; msg.pinned = false; msg.rev += 1;
      return { expect: "ok", delta: 2, actor: "owner", cmd: { id: cid(), type: "message.deleted", data } };
    }
    case "staleEdit": {
      const msg = r.pick(liveMessages(m));
      return { expect: "refused", actor: "owner", cmd: { id: cid(), type: "message.edited", data: { messageId: msg.id, body: "stale", expectedMessageRevision: msg.rev + 1 } } };
    }
    case "deleteDead": {
      const msg = r.pick(m.messages.filter(x => x.deleted));
      return { expect: "refused", actor: "owner", cmd: { id: cid(), type: "message.deleted", data: { messageId: msg.id } } };
    }
    case "propose": {
      const id = `w-${seq}-${m.workN++}`;
      const mode = r.next() < 0.5 ? "read" : "write";
      m.works.push({ id, state: "proposed", mode, claim: "none" });
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "work.proposed",
        data: { workItemId: id, title: `Chaos work ${id}`, definitionOfDone: "done", accountableMemberId: "owner", mode } } };
    }
    case "accept": {
      const w = r.pick(worksIn(m, ["proposed"])); w.state = "accepted";
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "work.accepted", data: { workItemId: w.id } } };
    }
    case "start": {
      const w = r.pick(m.works.filter(x => x.state === "accepted" && (x.mode === "read" || x.claim === "active"))); w.state = "working";
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "work.started", data: { workItemId: w.id } } };
    }
    case "block": {
      const w = r.pick(worksIn(m, ["accepted", "working"])); w.state = "blocked";
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "work.blocked", data: { workItemId: w.id, reason: "chaos blocker", nextAction: "unblock" } } };
    }
    case "resolve": {
      const w = r.pick(worksIn(m, ["blocked"])); w.state = "accepted";
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "work.blocker_resolved", data: { workItemId: w.id, resolution: "cleared" } } };
    }
    case "acquire": {
      const w = r.pick(acquirable(m)); w.claim = "active";
      const future = new Date(Date.now() + 3600e3).toISOString();
      return { expect: "ok", delta: 2, actor: "owner", cmd: { id: cid(), type: "claim.acquired",
        data: { workItemId: w.id, repository: "Uuriko/project-room", ref: "main", paths: [`chaos/${w.id}.mjs`], expiresAt: future } } };
    }
    case "renew": {
      const w = r.pick(claimActive(m));
      return { expect: "ok", delta: 2, actor: "owner", cmd: { id: cid(), type: "claim.renewed",
        data: { workItemId: w.id, expiresAt: new Date(Date.now() + 7200e3).toISOString() } } };
    }
    case "release": {
      const w = r.pick(claimActive(m)); w.claim = "released";
      return { expect: "ok", delta: 2, actor: "owner", cmd: { id: cid(), type: "claim.released", data: { workItemId: w.id } } };
    }
    case "decide": {
      const msg = r.pick(livePublicMessages(m));
      return { expect: "ok", delta: 1, actor: "owner", cmd: { id: cid(), type: "decision.recorded", data: { sourceMessageId: msg.id, statement: `chaos decision on ${msg.id}` } } };
    }
    case "status": {
      const who = actor();
      return { expect: "ok", delta: 1, actor: who, cmd: { id: cid(), type: "member.status_updated", data: { memberId: who, message: "chaos" } } };
    }
    case "caps": {
      const who = actor();
      return { expect: "ok", delta: 1, actor: who, cmd: { id: cid(), type: "capabilities.advertised", data: { capabilities: [`chaos-cap-${seq}`] } } };
    }
    case "dup": {
      const prior = r.pick(m.cmdLog);
      return { expect: "dup", actor: prior.actor, cmd: { ...structuredClone(prior.cmd) } };
    }
    case "conflict": {
      // Same command id, different content: the fingerprint check runs before
      // validation, so the altered payload must stay shape-valid to reach it.
      const candidates = m.cmdLog.filter(p => ["message.posted", "message.edited"].includes(p.cmd.type));
      if (!candidates.length) return { expect: "dup", actor: m.cmdLog[0].actor, cmd: structuredClone(m.cmdLog[0].cmd) };
      const prior = r.pick(candidates);
      const altered = structuredClone(prior.cmd);
      altered.data = { ...altered.data, body: `conflicting body ${seq}` };
      return { expect: "conflict", actor: prior.actor, cmd: altered };
    }
    default: { // refused: blank body can never be a write
      const id = `m-${seq}-${m.msgN++}`;
      return { expect: "refused", actor: "owner", cmd: { id: cid(), type: "message.posted", data: { messageId: id, body: "   " } } };
    }
  }
}

// --- drives ---------------------------------------------------------------
// A drive issues commands and reads the event log; the same generator runs
// against the in-process primitive and the live HTTP route.
function localDrive(store, roomId, keys) {
  const eventRows = after => store.db.prepare(
    "SELECT sequence, id, body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence")
    .all(roomId, after).map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  return {
    roomId,
    issue(actor, cmd) {
      try { return { ok: true, result: store.command(keys[actor], roomId, cmd) }; }
      catch (error) { return { ok: false, code: error.code ?? `status_${error.status}`, status: error.status }; }
    },
    eventsAfter: after => eventRows(after),
    roomSeq: () => store.room(roomId).sequence,
    commandSeq: (actorId, cmdId) => store.db.prepare(
      "SELECT sequence AS s FROM commands WHERE room_id=? AND actor_id=? AND id=?").get(roomId, actorId, cmdId)?.s ?? null,
  };
}
function httpDrive(store, clients, roomId) {
  // Mutations go over HTTP; reads use the shared store object (same process),
  // so the assertions pin the server's own accounting, not a client cache.
  const inner = localDrive(store, roomId, null);
  return {
    roomId,
    async issue(actor, cmd) {
      try { return { ok: true, result: await clients[actor].command(cmd) }; }
      catch (error) { return { ok: false, code: error.code ?? `status_${error.status}`, status: error.status }; }
    },
    eventsAfter: inner.eventsAfter,
    roomSeq: inner.roomSeq,
    commandSeq: inner.commandSeq,
  };
}

function assertEnvelope(ev, op, roomId, label) {
  assert.equal(ev.type, op.cmd.type, `${label}: event type matches the command`);
  assert.equal(ev.actorId, op.actor, `${label}: event actor is the commanding member`);
  assert.equal(ev.roomId, roomId, `${label}: event room matches`);
  assert.equal(typeof ev.at, "string", `${label}: event carries at`);
  assert.equal(typeof ev.idempotencyKey, "string", `${label}: event carries idempotencyKey`);
  for (const field of KEY_FIELDS[op.cmd.type] ?? []) {
    assert.deepEqual(ev.data[field], op.cmd.data[field], `${label}: payload carries ${field}`);
  }
}

async function runSequence(drive, r, seq, label) {
  const m = freshModel();
  const accounted = new Map(); // event id -> "primary" | "derived"
  const primaryOf = new Map(); // command id -> primary event id
  const seqStart = await drive.roomSeq();
  let cursor = seqStart, expectedTotal = 0;
  const ops = 6 + r.int(0, 8);
  for (let i = 0; i < ops; i++) {
    const op = buildOp(r, m, seq);
    const tag = `${label} seq=${seq} op=${i} type=${op.cmd.type} expect=${op.expect}`;
    const before = await drive.roomSeq();
    const out = await drive.issue(op.actor, op.cmd);
    if (op.expect === "ok") {
      assert.equal(out.ok, true, `${tag}: accepted command refused (${out.code})`);
      const res = out.result;
      assert.ok(!res.duplicate, `${tag}: fresh command id reported duplicate`);
      // P1: the command's own event is the next log entry.
      assert.equal(res.sequence, before + 1, `${tag}: command event lands at before+1`);
      const rows = await drive.eventsAfter(cursor);
      const derived = DERIVED[op.cmd.type];
      const delta = derived ? 1 + derived.extra : 1;
      assert.equal(rows.length, delta, `${tag}: exactly ${delta} event(s) appended`);
      assert.equal(rows[0].event.id, res.event.id, `${tag}: log entry matches the returned event`);
      const cmdSeq = await drive.commandSeq(op.actor, op.cmd.id);
      if (cmdSeq !== null) assert.equal(cmdSeq, res.sequence, `${tag}: commands table links id to sequence`);
      // P2: the primary event carries the mutation's key fields.
      assertEnvelope(rows[0].event, op, drive.roomId, `${tag} primary`);
      accounted.set(rows[0].event.id, "primary");
      primaryOf.set(op.cmd.id, rows[0].event.id);
      // P2: derived events (redaction, claim mirror) carry their key fields.
      for (let d = 1; d < rows.length; d++) {
        const ev = rows[d].event;
        assert.equal(ev.type, derived.type, `${tag}: derived event ${d} has the expected type`);
        assert.equal(ev.actorId, op.actor, `${tag}: derived event actor is the commanding member`);
        derived.key(ev, op.cmd);
        assert.ok(!accounted.has(ev.id), `${tag}: derived event id is unique`);
        accounted.set(ev.id, "derived");
      }
      m.cmdLog.push({ cmd: op.cmd, actor: op.actor, seq: res.sequence });
      expectedTotal += delta;
    } else if (op.expect === "dup") {
      assert.equal(out.ok, true, `${tag}: exact replay should return duplicate, not refuse`);
      assert.equal(out.result.duplicate, true, `${tag}: exact replay reports duplicate:true`);
      const prior = m.cmdLog.find(p => p.cmd.id === op.cmd.id);
      assert.equal(out.result.sequence, prior.seq, `${tag}: replay returns the original sequence`);
      assert.deepEqual(await drive.eventsAfter(cursor), [], `${tag}: a duplicate appends nothing`);
    } else { // refused | conflict
      assert.equal(out.ok, false, `${tag}: expected refusal but the command was accepted`);
      if (op.expect === "conflict") assert.equal(out.code, "idempotency_conflict", `${tag}: conflicting id is a 409`);
      else assert.ok(REFUSAL_CODES.has(out.code), `${tag}: refusal carries a typed code (got ${out.code})`);
      assert.deepEqual(await drive.eventsAfter(cursor), [], `${tag}: a refused write appends nothing`);
      const cmdSeq = await drive.commandSeq(op.actor, op.cmd.id);
      if (cmdSeq !== null && op.expect === "refused") assert.fail(`${tag}: refused command left a commands-table row`);
    }
    cursor = await drive.roomSeq();
    assert.equal(cursor, before + (op.expect === "ok" ? (DERIVED[op.cmd.type] ? 1 + DERIVED[op.cmd.type].extra : 1) : 0),
      `${tag}: room sequence advances by exactly the expected delta`);
  }
  // P3: no phantom events — the window holds exactly the expected events, all accounted.
  const end = await drive.roomSeq();
  assert.equal(end - seqStart, expectedTotal, `${label} seq=${seq}: log growth equals the expected total`);
  const window = await drive.eventsAfter(seqStart);
  assert.equal(window.length, expectedTotal, `${label} seq=${seq}: window holds exactly the expected events`);
  for (const row of window) {
    assert.ok(accounted.has(row.event.id), `${label} seq=${seq}: event ${row.sequence} (${row.event.type}) is attributable to an issued command`);
  }
  for (const [, eventId] of primaryOf) {
    assert.equal(window.filter(row => row.event.id === eventId).length, 1, `${label} seq=${seq}: each primary event appears exactly once`);
  }
}

// --- fixtures -------------------------------------------------------------
function setupRoom(store, roomId) {
  store.initialize(initialRoom(roomId));
  const keys = { owner: store.issueAccessKey(roomId, "owner") };
  store.command(keys.owner, roomId, { id: `fixture-${roomId}-peer`, type: "member.added",
    data: { memberId: "peer", displayName: "Peer", kind: "human", permissions: [] } });
  keys.peer = store.issueAccessKey(roomId, "peer");
  return keys;
}

test(`P1/P2/P3: ${SEQUENCES} random command sequences each emit exactly their events (in-process primitive)`, async t => {
  const r = rng(0xC0A15);
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  for (let seq = 0; seq < SEQUENCES; seq++) {
    const roomId = `chaos-${seq}`;
    const keys = setupRoom(store, roomId);
    await runSequence(localDrive(store, roomId, keys), r, seq, "local");
  }
});

test(`HTTP parity: ${HTTP_SEQUENCES} random sequences through POST /:roomId/commands emit exactly their events`, async t => {
  const r = rng(0x077CE5);
  const store = new RoomStore(":memory:");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let seq = 0; seq < HTTP_SEQUENCES; seq++) {
    const roomId = `chaos-http-${seq}`;
    const tokens = setupRoom(store, roomId);
    const clients = {
      owner: new RoomAgentClient({ origin, roomId, token: tokens.owner }),
      peer: new RoomAgentClient({ origin, roomId, token: tokens.peer }),
    };
    await runSequence(httpDrive(store, clients, roomId), r, seq, "http");
  }
});

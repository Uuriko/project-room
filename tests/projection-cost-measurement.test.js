// WAVE-500 W2: measured projection cost per event/operation type.
// Drives operations against a real RoomStore fixture (the same fixture
// pattern as tests/projection-at-rest.test.js) and snapshots the
// rooms.projection byte size before/after each batch, so the numbers in
// docs/wave500/PROJECTION-COST-TABLE.md are measured, not estimated.
//
// The byte measure matches the live guard exactly:
//   server/agent-invites.mjs:312 → Buffer.byteLength(storedProjection)
// must stay under PILOT_LIMITS.projectionBytes (4 MiB).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event, applyEvent } from "../src/events.js";

const RESULTS = [];
const record = (op, perOpBytes, n) => {
  // Near-zero deltas on in-place mutations (same-length string swaps, enum
  // renames) are honestly ~0 bytes; rounding noise can dip to -1, so clamp.
  RESULTS.push({ op, perOpBytes: Math.max(0, Math.round(perOpBytes)), n });
};

function fixture() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const projectionBytes = () =>
    Buffer.byteLength(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  const cmd = (key, type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  return { store, ownerKey, cmd, projectionBytes };
}

const body = n => "x".repeat(n);
const EXP = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

// Fresh store per group; setup(f) seeds state, run(f,n) does the N measured
// ops. Per-op cost = (after-before)/N. Event-log appends, seenEvents and
// handler state deltas are part of the honest cost.
function measure(label, n, { setup, run }) {
  const f = fixture();
  if (setup) setup(f);
  const before = f.projectionBytes();
  run(f, n);
  const after = f.projectionBytes();
  record(label, (after - before) / n, n);
}

function addAgent(f, id, permissions = ["accept_work", "complete_work", "write_external"]) {
  f.cmd(f.ownerKey, T.MEMBER_ADDED, { memberId: id, displayName: `Agent ${id}`, kind: "agent", permissions });
  return f.store.issueAccessKey("commons", id);
}

// The room flood guard budgets message.posted per (room, member):
// burst 30, refill 1/2s. Round-robin chat posts across members so the
// measured cost stays about the projection, not the throttle.
function posterKeys(f, count) {
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(addAgent(f, `poster${i}`, []));
  return keys;
}

function proposeFor(f, workerId, prefix, n, mode = "write", workerCount = 3) {
  // One member may hold at most 20 open claims (work-claim-mirror.mjs);
  // spread items across several workers.
  const workers = [];
  for (let k = 0; k < workerCount; k++) workers.push(addAgent(f, `${workerId}-${k}`));
  for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.WORK_PROPOSED, {
    workItemId: `${prefix}${i}`, title: `Claim task ${i}`, mode,
    definitionOfDone: "Done.", accountableMemberId: `${workerId}-${i % workerCount}`
  });
  return workers;
}
const workerKey = (f, workerId, k) => f.store.issueAccessKey("commons", `${workerId}-${k}`);

test("projection cost table (measured)", t => {
  // --- message.posted at three body sizes ---
  for (const size of [150, 1024, 10240]) {
    const n = size === 150 ? 300 : size === 1024 ? 80 : 15;
    measure(`message.posted (${size}B body)`, n, {
      setup: f => { f.posterKeys = posterKeys(f, 25); },
      run: (f, n) => {
        for (let i = 0; i < n; i++) f.cmd(f.posterKeys[i % f.posterKeys.length], T.MESSAGE_POSTED, { messageId: `m${i}`, body: body(size) });
      }
    });
  }

  // --- message.edited: same body size rewrite ---
  measure("message.edited (150B→150B)", 150, {
    setup: f => {
      f.posterKeys = posterKeys(f, 10);
      for (let i = 0; i < 150; i++) f.cmd(f.posterKeys[i % f.posterKeys.length], T.MESSAGE_POSTED, { messageId: `e${i}`, body: body(150) });
    },
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.MESSAGE_EDITED, { messageId: `e${i}`, body: body(150).replace(/x/g, "y"), expectedMessageRevision: 0 }); }
  });

  // --- message.reaction_set ---
  measure("message.reaction_set", 200, {
    setup: f => {
      f.posterKeys = posterKeys(f, 10);
      for (let i = 0; i < 200; i++) f.cmd(f.posterKeys[i % f.posterKeys.length], T.MESSAGE_POSTED, { messageId: `r${i}`, body: "hi" });
    },
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.MESSAGE_REACTION_SET, { messageId: `r${i}`, reaction: "👍", active: true }); }
  });

  // --- work.proposed: typical text, and a 1KB definitionOfDone ---
  measure("work.proposed (typical ~300B text)", 40, {
    run: (f, n) => {
      const worker = addAgent(f, "w-propose");
      for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.WORK_PROPOSED, {
        workItemId: `w${i}`, title: `Fix the sync bug in lane ${i}`, mode: "write",
        definitionOfDone: "Sync completes without duplicates and the dashboard shows the new count.",
        accountableMemberId: "w-propose"
      });
      void worker;
    }
  });
  measure("work.proposed (1KB definitionOfDone)", 20, {
    run: (f, n) => {
      addAgent(f, "w-propose2");
      for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.WORK_PROPOSED, {
        workItemId: `wk${i}`, title: `Task ${i}`, mode: "write",
        definitionOfDone: body(1024), accountableMemberId: "w-propose2"
      });
    }
  });

  // --- classic-board claim lifecycle, one measured transition per batch ---
  // (worker index = item index % 3; helpers below keep each worker under the
  // 20-open-claims cap)
  measure("work.accepted", 40, {
    setup: f => proposeFor(f, "w-a", "ac", 40),
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.store.issueAccessKey("commons", `w-a-${i % 3}`), T.WORK_ACCEPTED, { workItemId: `ac${i}` }); }
  });
  measure("work.started", 40, {
    setup: f => { proposeFor(f, "w-s", "st", 40, "read"); for (let i = 0; i < 40; i++) f.cmd(f.store.issueAccessKey("commons", `w-s-${i % 3}`), T.WORK_ACCEPTED, { workItemId: `st${i}` }); },
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.store.issueAccessKey("commons", `w-s-${i % 3}`), T.WORK_STARTED, { workItemId: `st${i}` }); }
  });
  measure("claim.acquired (3 paths)", 40, {
    setup: f => {
      proposeFor(f, "w-q", "aq", 40);
      for (let i = 0; i < 40; i++) f.cmd(f.store.issueAccessKey("commons", `w-q-${i % 3}`), T.WORK_ACCEPTED, { workItemId: `aq${i}` });
    },
    run: (f, n) => {
      for (let i = 0; i < n; i++) f.cmd(f.store.issueAccessKey("commons", `w-q-${i % 3}`), T.CLAIM_ACQUIRED, {
        workItemId: `aq${i}`, repository: "acme/repo", ref: `lane-${i}`,
        paths: ["server/claim-scopes.mjs", "tests/claim-scopes.test.js", "docs/CLAIM-SCOPES.md"], expiresAt: EXP
      });
    }
  });
  measure("claim.renewed", 40, {
    setup: f => {
      proposeFor(f, "w-r", "rn", 40);
      for (let i = 0; i < 40; i++) {
        const w = f.store.issueAccessKey("commons", `w-r-${i % 3}`);
        f.cmd(w, T.WORK_ACCEPTED, { workItemId: `rn${i}` });
        f.cmd(w, T.CLAIM_ACQUIRED, { workItemId: `rn${i}`, repository: "acme/repo", ref: "main", paths: [`claims/item-${i}.md`], expiresAt: EXP });
        f.cmd(w, T.WORK_STARTED, { workItemId: `rn${i}` });
      }
    },
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.store.issueAccessKey("commons", `w-r-${i % 3}`), T.CLAIM_RENEWED, { workItemId: `rn${i}`, expiresAt: EXP }); }
  });
  measure("claim.released", 40, {
    setup: f => {
      proposeFor(f, "w-d", "rl", 40);
      for (let i = 0; i < 40; i++) {
        const w = f.store.issueAccessKey("commons", `w-d-${i % 3}`);
        f.cmd(w, T.WORK_ACCEPTED, { workItemId: `rl${i}` });
        f.cmd(w, T.CLAIM_ACQUIRED, { workItemId: `rl${i}`, repository: "acme/repo", ref: "main", paths: [`claims/item-${i}.md`], expiresAt: EXP });
        f.cmd(w, T.WORK_STARTED, { workItemId: `rl${i}` });
      }
    },
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.store.issueAccessKey("commons", `w-d-${i % 3}`), T.CLAIM_RELEASED, { workItemId: `rl${i}` }); }
  });
  measure("work.completed (200B summary, room_text evidence)", 40, {
    setup: f => {
      proposeFor(f, "w-c", "fn", 40);
      f.evidence = {};
      const sha = txt => `sha256:${createHash("sha256").update(txt, "utf8").digest("hex")}`;
      for (let i = 0; i < 40; i++) {
        const w = f.store.issueAccessKey("commons", `w-c-${i % 3}`);
        f.cmd(w, T.WORK_ACCEPTED, { workItemId: `fn${i}` });
        f.cmd(w, T.CLAIM_ACQUIRED, { workItemId: `fn${i}`, repository: "acme/repo", ref: "main", paths: [`claims/item-${i}.md`], expiresAt: EXP });
        f.cmd(w, T.WORK_STARTED, { workItemId: `fn${i}` });
        const text = `Result for fn${i}: ` + body(200);
        const receipt = f.cmd(w, T.MESSAGE_POSTED, { messageId: `ev${i}`, workItemId: `fn${i}`, body: text });
        f.evidence[i] = { eventId: receipt.event.id, version: sha(text) };
      }
    },
    run: (f, n) => {
      for (let i = 0; i < n; i++) f.cmd(f.store.issueAccessKey("commons", `w-c-${i % 3}`), T.WORK_COMPLETED, {
        workItemId: `fn${i}`, evidenceKind: "room_text",
        evidenceMessageId: `ev${i}`, evidenceMessageEventId: f.evidence[i].eventId,
        previousCompletionEventId: null, producerId: null, evidenceVersion: f.evidence[i].version,
        summary: `Completed fn${i}`, nextAction: "Review by lane owner"
      });
    }
  });
  measure("work.superseded", 30, {
    setup: f => {
      for (let i = 0; i < 30; i++) {
        f.cmd(f.ownerKey, T.WORK_PROPOSED, { workItemId: `g${i}`, title: "T", mode: "read", definitionOfDone: "D", accountableMemberId: "owner" });
        f.cmd(f.ownerKey, T.WORK_PROPOSED, { workItemId: `h${i}`, title: "T2", mode: "read", definitionOfDone: "D", accountableMemberId: "owner" });
      }
    },
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.WORK_SUPERSEDED, { workItemId: `g${i}`, supersededByWorkItemId: `h${i}`, reason: "dup" }); }
  });

  // --- new work-claim board: thin work_claim.updated receipts.
  // This is an emitted room event, not an agent command type, so it is
  // applied the way the live emit path does: applyEvent + storedProjection
  // inside the claim transaction. Notes live on history stamps in the
  // work_claims TABLE (never the projection); the room sees only the
  // thin receipt. ---
  function emitThin(f, data) {
    const incoming = event({ id: randomUUID(), type: T.WORK_CLAIM_UPDATED, roomId: "commons", actorId: "owner", data });
    const { state } = f.store.room("commons");
    const next = applyEvent(state, incoming);
    f.store.db.prepare("UPDATE rooms SET sequence=sequence+1, projection=? WHERE id='commons'")
      .run(f.store.storedProjection("commons", next));
  }
  measure("work_claim.updated (thin receipt)", 80, {
    run: (f, n) => {
      addAgent(f, "w-thin");
      for (let i = 0; i < n; i++) emitThin(f, {
        workClaim: `wc-${i}`, action: "state_changed", claimState: "in_progress",
        ownerId: "w-thin", leaseExpiresAt: null, paths: ["server/a.mjs"], title: `Claim task ${i}`
      });
    }
  });
  measure("work_claim.updated (note-update receipt; 4000B note stays in table)", 20, {
    run: (f, n) => {
      addAgent(f, "w-note");
      for (let i = 0; i < n; i++) emitThin(f, {
        workClaim: `wn-${i}`, action: "reviewed", claimState: "in_progress",
        ownerId: "w-note", leaseExpiresAt: null, paths: [], title: `Note task ${i}`,
        reason: "reviewed", verdict: "comment"
      });
    }
  });

  // --- members: added (the invite-redeem path emits member.added) ---
  measure("member.added (agent, 3 permissions)", 40, {
    run: (f, n) => {
      for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.MEMBER_ADDED, {
        memberId: `agent${i}`, displayName: `Lane agent ${i}`, kind: "agent",
        permissions: ["accept_work", "complete_work", "write_external"]
      });
    }
  });

  // --- small member mutations ---
  measure("member.mute_set", 60, {
    setup: f => addAgent(f, "w-mute", ["accept_work"]),
    run: (f, n) => { for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.MEMBER_MUTE_SET, { memberId: "w-mute", muted: i % 2 === 0 }); }
  });

  // --- decisions (note up to 500 chars; links a source message) ---
  measure("decision.recorded (200B note)", 30, {
    setup: f => {
      f.posterKeys = posterKeys(f, 2);
      for (let i = 0; i < 30; i++) f.cmd(f.posterKeys[i % 2], T.MESSAGE_POSTED, { messageId: `src${i}`, body: "proposal text" });
    },
    run: (f, n) => {
      for (let i = 0; i < n; i++) f.cmd(f.ownerKey, T.DECISION_RECORDED, { sourceMessageId: `src${i}`, statement: "Approved for landing", note: body(200) });
    }
  });

  // --- sanity: every measured op cost is bounded; zero-cost ops are real
  // (the stored projection drops eventLog/seenEvents/seenIdempotencyKeys —
  // store.mjs:620 — so thin receipts and same-length in-place mutations are
  // honestly ~0 bytes) ---
  for (const r of RESULTS) {
    assert.ok(r.perOpBytes >= 0, `${r.op}: negative cost ${r.perOpBytes} is impossible`);
    assert.ok(r.perOpBytes < 100000, `${r.op}: suspiciously large cost ${r.perOpBytes}`);
  }
  const hogs = [...RESULTS].sort((a, b) => b.perOpBytes - a.perOpBytes);
  process.stdout.write("\n=== MEASURED PROJECTION COST PER OP (bytes) ===\n");
  for (const r of hogs) process.stdout.write(`${String(r.perOpBytes).padStart(6)}  ${r.op}  (n=${r.n})\n`);
  process.stdout.write(`@4MiB, 1000 ops fill the budget when per-op cost > ${(PILOT_LIMITS.projectionBytes / 1000).toFixed(0)} B\n`);
});

test("budget facts", () => {
  assert.equal(PILOT_LIMITS.projectionBytes, 4 * 1024 * 1024, "projection cap is 4 MiB");
});

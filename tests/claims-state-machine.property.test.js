// Property-based tests for the claims-board state machine (scripts/room).
//
// VERIFY-2 / RC-2026-09-26-1115.
//
// APPROACH (honest): fast-check generates board comment traces; each trace is
// driven through the REAL implementation — `scripts/room _parse | _state --now`
// for the reducer, and `scripts/room sweep --dry-run` with a fake `gh`
// transport (tests/claims-state-machine-fake-gh.sh) for the sweep's strike
// PLAN emission. No model port: the assertions pin invariants directly on the
// implementation's output. ROOM_SCRIPT (like tests/room-strike-hardening.test.js)
// runs the suite against a different scripts/room copy, e.g. a pre-fix one.
//
// PROPERTIES (from docs/ROOM-PROTOCOL.md §3-4 as oracle):
//   P1 no reachable deadlock — every task ends terminal or with a legal move.
//   P2 illegal transitions are rejected AND recorded (differential: the task
//      record is byte-identical with/without the attempt; .illegal grows).
//   P3 strike-two always returns the claim to submitted (never limbo); forged,
//      early, and terminal-targeted strike-twos are ignored.
//   P4 receipts are idempotent — replayed dones never double-count.
//   P5 heartbeat grace rules — heartbeats within the lease renew it and never
//      trigger strikes; a post-strike-one heartbeat blocks strike-two.
//   P6 task-id reuse is always refused; invalid claim blocks never create tasks.
//
// COVERAGE LIMITS (what these tests do NOT prove):
//   - actual GitHub posting (post_comment) — dry-run only;
//   - the enforcer-lock concurrency path (F2: two overlapping sweeps);
//   - cmd_claim's file-collision guard (needs a live board read);
//   - the handoff/ack lifecycle and receipts-scan digesting;
//   - clock-skew compensation (ROOM_CLOCK_OP pins the clock in tests).
//
// AUTHORING GATE (.agents/skills/test-audit/SKILL.md): the contract is the
// claims protocol (§3-4); credible regressions are the 2026-09-19
// strike-two-on-completed release, the 2026-09-26 sweep misfire classes, and
// heartbeat/first-stamp-wins defects — all found historically by fuzzing, not
// by single traces. Existing deterministic tests (room-strike-hardening,
// room-sweep-dry-run, claim-validate) own one-trace regressions; this file is
// the distinct trace-space + invariant layer, not a duplicate.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = process.env.ROOM_SCRIPT
  ? resolve(checkout, process.env.ROOM_SCRIPT)
  : join(checkout, "scripts/room");
// The fake `gh` transport must be an executable NAMED `gh` on PATH: create a
// per-run bin dir (worktree .tmp/, never the shared /tmp) with a symlink to
// the committed helper script.
const fakeGhHelper = fileURLToPath(new URL("./claims-state-machine-fake-gh.sh", import.meta.url));
function fakeGhBin() {
  const scratch = join(checkout, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "claims-props-fakebin-"));
  symlinkSync(fakeGhHelper, join(dir, "gh"));
  return dir;
}

// Fixed default seed (repo convention, cf. tests/writer-fence-property.test.js);
// PROPERTY_TEST_SEED shifts the exploration for an extra run.
const seed = Number(process.env.PROPERTY_TEST_SEED ?? 20260926);

// --- time helpers -----------------------------------------------------------
const BASE = Date.UTC(2026, 8, 26, 0, 0, 0) / 1000; // 2026-09-26T00:00:00Z
const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const stateWord = (s) => s.match(/^([a-z]+)/)[1];

// --- documented contract oracle (docs/ROOM-PROTOCOL.md §3) ------------------
const KNOWN = new Set(["submitted", "working", "suspended", "completed", "failed", "cancelled"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const LEGAL = {
  submitted: ["working", "cancelled"],
  working: ["completed", "failed", "suspended", "cancelled"],
  suspended: ["working", "cancelled"],
};

// --- comment builders (board grammar) ---------------------------------------
let nextId = 1;
const comment = (at, body) => ({ id: nextId++, created_at: iso(at), body });

function claimBody({ task, lane, files, leaseH, state, reason = "property test" }) {
  return `[${lane}][claim]\n\n\`\`\`room-claim\ntask-id: ${task}\nlane: ${lane}\nfiles: ${files}\nlease: lease=${leaseH}h\nstate: ${state}\nreason: ${reason}\n\`\`\``;
}

function statusBody({ task, lane, files, leaseH, state, headline }) {
  return `[${lane}]STATUS: ${headline}\n\n\`\`\`room-claim\ntask-id: ${task}\nlane: ${lane}\nfiles: ${files}\nlease: lease=${leaseH}h\nstate: ${state}\nreason: property test\n\`\`\``;
}

function doneBody({ task, lane, sha, pr }) {
  return `[${lane}][done]\n\n\`\`\`room-done\ntask-id: ${task}\nsha: ${sha}\npr: ${pr}\n\`\`\``;
}

const strikeOneBody = (task, lane, stamp) =>
  `[room-watch]RECLAIM (strike 1): @${lane} lease on ${task} expired, no heartbeat seen.\n\n<!-- room:strike-one:${task}:${stamp} -->\n`;

const strikeTwoBody = (task, lane, stamp) =>
  `[room-watch]RECLAIM (strike 2): ${task} released. No heartbeat 4h after the strike-one nudge.\n\n<!-- room:strike-two:${task}:${stamp} -->\n`;

const receiptProseBody = ({ task, lane, pr, sha }) =>
  `[${lane}][receipt] ${task} PR #${pr} Merge SHA: ${sha}`;

// --- harness: the REAL scripts/room binary ----------------------------------
function parseComments(comments) {
  const r = spawnSync(room, ["_parse"], {
    input: JSON.stringify(comments), encoding: "utf8", timeout: 60000,
  });
  assert.equal(r.status, 0, `_parse failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function reduceEvents(events, nowSec) {
  const r = spawnSync(room, ["_state", "--now", iso(nowSec)], {
    input: JSON.stringify(events), encoding: "utf8", timeout: 60000,
    env: { ...process.env, ROOM_ENFORCER_ALLOW_STALE: "1" },
  });
  assert.equal(r.status, 0, `_state failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const boardState = (comments, nowSec) => reduceEvents(parseComments(comments), nowSec);
const taskOf = (st, id) => st.tasks.find((t) => t.task_id === id);

function sweepDryRun(comments, boardSec) {
  const bin = fakeGhBin();
  const pathEnv = `${bin}:${process.env.PATH}`;
  // Fail-closed transport guard: never let a PATH regression silently drive
  // the sweep against the live board.
  const which = spawnSync("bash", ["-c", "command -v gh"], {
    encoding: "utf8", env: { ...process.env, PATH: pathEnv },
  });
  assert.equal(which.stdout.trim(), join(bin, "gh"), "fake gh not first on PATH; refusing to sweep");
  const r = spawnSync(room, ["sweep", "--dry-run"], {
    encoding: "utf8", timeout: 120000,
    env: {
      ...process.env,
      PATH: pathEnv,
      FAKE_GH_COMMENTS: JSON.stringify(comments),
      FAKE_GH_DATE: new Date(boardSec * 1000).toUTCString(),
      ROOM_CLOCK_OP: String(boardSec),
      ROOM_ENFORCER_ALLOW_STALE: "1",
    },
  });
  assert.equal(r.status, 0, `sweep --dry-run failed: ${r.stderr}`);
  return r.stdout;
}

// --- generators ---------------------------------------------------------------
const arbLane = fc.constantFrom("quill", "jill", "instinct");
const arbNonce = fc.integer({ min: 100, max: 999 });
const taskId = (nonce, i) => `RC-2026-09-26-${nonce}${i}`;
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

function renderOp(op, ctx, t) {
  const { task, lane, files, leaseH } = ctx;
  switch (op) {
    case "hb":
      return comment(t, statusBody({ task, lane, files, leaseH, state: "working", headline: `heartbeat ${task} still working` }));
    case "toWorking":
    case "toSuspended":
    case "toCancelled":
    case "toCompleted": {
      const to = op.slice(2).toLowerCase();
      return comment(t, statusBody({ task, lane, files, leaseH, state: to, headline: `moving ${task} to ${to}` }));
    }
    case "toFailed":
      return comment(t, statusBody({ task, lane, files, leaseH, state: "failed", headline: `it failed ${task}` }));
    case "toFailedCode":
      return comment(t, statusBody({ task, lane, files, leaseH, state: "failed(INFRA)", headline: `it failed ${task}` }));
    case "done":
      return comment(t, doneBody({ task, lane, sha: SHA, pr: 4242 }));
    case "s1":
      return comment(t, strikeOneBody(task, lane, iso(t)));
    case "s2":
      return comment(t, strikeTwoBody(task, lane, iso(t)));
    case "dup":
      return comment(t, claimBody({ task, lane, files, leaseH, state: "working", reason: "duplicate attempt" }));
    case "bad":
      return comment(t, `[${lane}][claim]\n\n\`\`\`room-claim\ntask-id: ${task}\nlane: ${lane}\nfiles: ${files}\nlease: 6h\nstate: working\nreason: bare lease must be rejected\n\`\`\``);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const OPS = ["hb", "toWorking", "toSuspended", "toCancelled", "toCompleted", "toFailed", "toFailedCode", "done", "s1", "s2", "dup", "bad"];

function buildTrace({ nonce, leaseH, lane, scripts }) {
  nextId = 1;
  const comments = [];
  let end = BASE;
  scripts.forEach((spec, i) => {
    const task = taskId(nonce, i);
    const files = `tests/prop-${nonce}-${i}.test.js`;
    const ctx = { task, lane, files, leaseH };
    let t = BASE + i * 1500;
    comments.push(comment(t, claimBody({ ...ctx, state: spec.startWorking ? "working" : "submitted" })));
    spec.ops.forEach((op, k) => {
      t += spec.gaps[k] * 60;
      comments.push(renderOp(op, ctx, t));
    });
    end = Math.max(end, t);
  });
  comments.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  return { comments, end: end + 1800 };
}

const traceArb = () => fc.record({
  nonce: arbNonce,
  leaseH: fc.integer({ min: 1, max: 12 }),
  lane: arbLane,
  scripts: fc.array(
    fc.record({
      startWorking: fc.boolean(),
      ops: fc.array(fc.constantFrom(...OPS), { minLength: 0, maxLength: 6 }),
      gaps: fc.array(fc.integer({ min: 5, max: 180 }), { minLength: 6, maxLength: 6 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
});

// --- P1: no reachable deadlock -------------------------------------------------
test("property P1: every reachable claim is terminal or has a legal move (no deadlock)", () => {
  fc.assert(fc.property(traceArb(), (gen) => {
    const { comments, end } = buildTrace(gen);
    const st = boardState(comments, end);
    for (const t of st.tasks) {
      const w = stateWord(t.state);
      assert.ok(KNOWN.has(w), `unknown state word reachable: ${t.state} (${t.task_id})`);
      if (TERMINAL.has(w)) continue;
      assert.ok((LEGAL[w] || []).length > 0, `deadlock: ${t.task_id} in ${w} has no legal transition`);
    }
  }), { numRuns: 40, seed });
});

// --- P2: illegal transitions rejected AND recorded ------------------------------
const ILLEGAL_MOVES = [
  { from: "submitted", to: "completed", via: "status" },
  { from: "submitted", to: "suspended", via: "status" },
  { from: "submitted", to: "failed", via: "status" }, // bare failed: no code
  { from: "working", to: "submitted", via: "status" },
  { from: "suspended", to: "completed", via: "status" },
  { from: "submitted", to: "completed", via: "done" }, // DONE requires working
  { from: "completed", to: "working", via: "status" }, // transition from terminal
];

function illegalTrace(move, nonce, lane, leaseH) {
  nextId = 1;
  const task = taskId(nonce, 0);
  const files = `tests/prop-${nonce}.test.js`;
  const ctx = { task, lane, files, leaseH, sha: SHA, pr: 4242 };
  const t0 = BASE;
  const prefix = [];
  let t = t0;
  if (move.from === "completed") {
    prefix.push(comment(t, claimBody({ ...ctx, state: "working" })));
    t += 600;
    prefix.push(comment(t, doneBody(ctx)));
    t += 600;
  } else if (move.from === "suspended") {
    prefix.push(comment(t, claimBody({ ...ctx, state: "working" })));
    t += 600;
    prefix.push(comment(t, statusBody({ ...ctx, state: "suspended", headline: `suspending ${task}` })));
    t += 600;
  } else {
    prefix.push(comment(t, claimBody({ ...ctx, state: move.from })));
    t += 600;
  }
  const illegal = move.via === "done"
    ? comment(t, doneBody(ctx))
    : comment(t, statusBody({ ...ctx, state: move.to, headline: `illegal attempt ${move.from} -> ${move.to}` }));
  return { prefix, illegal, task, end: t + 60, illegalId: illegal.id, full: [...prefix, illegal] };
}

test("property P2: illegal transitions change nothing and are recorded", () => {
  fc.assert(fc.property(
    fc.record({
      nonce: arbNonce,
      lane: arbLane,
      leaseH: fc.integer({ min: 1, max: 12 }),
      move: fc.constantFrom(...ILLEGAL_MOVES),
    }),
    (gen) => {
      const { prefix, full, task, end, illegalId } = illegalTrace(gen.move, gen.nonce, gen.lane, gen.leaseH);
      const before = boardState(prefix, end);
      const after = boardState(full, end);
      // Rejected: the task record is identical with and without the attempt.
      assert.deepEqual(taskOf(after, task), taskOf(before, task), "illegal transition mutated the task");
      // Recorded: exactly one new .illegal entry naming the attempt...
      assert.equal(after.illegal.length, before.illegal.length + 1, "illegal attempt not recorded");
      const entry = after.illegal[after.illegal.length - 1];
      assert.equal(entry.task_id, task);
      assert.equal(entry.from, gen.move.from);
      // ...and the board log marks the attempt comment ok:false.
      const logged = after.log.find((e) => e.id === illegalId);
      assert.ok(logged && logged.ok === false, "illegal attempt not logged as failed");
    },
  ), { numRuns: 30, seed });
});

test("property P2b: strike stamps on a done claim are ignored (never resurrected)", () => {
  fc.assert(fc.property(
    fc.record({ nonce: arbNonce, lane: arbLane, leaseH: fc.integer({ min: 1, max: 12 }) }),
    (gen) => {
      nextId = 1;
      const task = taskId(gen.nonce, 0);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const t0 = BASE;
      const done = [
        comment(t0, claimBody({ task, lane: gen.lane, files, leaseH: gen.leaseH, state: "working" })),
        comment(t0 + 600, doneBody({ task, lane: gen.lane, sha: SHA, pr: 4242 })),
      ];
      const s1t = t0 + 7200;
      const withStrikes = [
        ...done,
        comment(s1t, strikeOneBody(task, gen.lane, iso(s1t))),
        comment(s1t + 3600, strikeTwoBody(task, gen.lane, iso(s1t + 3600))),
      ];
      const before = boardState(done, t0 + 1200);
      const after = boardState(withStrikes, s1t + 7200);
      assert.deepEqual(taskOf(after, task), taskOf(before, task), "strike on done claim mutated the task");
      assert.equal(stateWord(taskOf(after, task).state), "completed");
      assert.ok(after.log.some((e) => e.kind === "reclaim" && /ignored/.test(e.ignored || "")),
        "strike on done claim not logged as ignored");
    },
  ), { numRuns: 25, seed });
});

// --- P3: strike-two always returns the claim to submitted -------------------------
test("property P3: strike-two returns the claim to submitted — never a limbo state", () => {
  fc.assert(fc.property(
    fc.record({
      nonce: arbNonce,
      lane: arbLane,
      leaseH: fc.integer({ min: 1, max: 6 }),
      scenario: fc.constantFrom("full", "noStrikeOne", "early", "terminal"),
    }),
    (gen) => {
      nextId = 1;
      const task = taskId(gen.nonce, 0);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const t0 = BASE;
      const s1 = t0 + gen.leaseH * 3600 + 600; // strike-one after lease expiry
      const s2 = s1 + 14400 + 120; // strike-two after the 4h grace
      const claim = comment(t0, claimBody({ task, lane: gen.lane, files, leaseH: gen.leaseH, state: "working" }));
      const s1c = comment(s1, strikeOneBody(task, gen.lane, iso(s1)));

      if (gen.scenario === "full") {
        const s2c = comment(s2, strikeTwoBody(task, gen.lane, iso(s2)));
        const st = boardState([claim, s1c, s2c], s2 + 60);
        const t = taskOf(st, task);
        assert.equal(t.state, "submitted", "strike-two must return the claim to submitted");
        assert.equal(t.lane, null, "released claim must have no holding lane");
        assert.equal(t.strike_one_at, null, "strike-one marker must clear on release");
        assert.equal(t.released_at, iso(s2), "released_at must be the strike-two time");
        assert.equal(t.pending_handoff, null, "release must clear any pending handoff");
        // A second strike-two is a no-op: release is idempotent, never limbo.
        const again = boardState([claim, s1c, s2c, comment(s2 + 3600, strikeTwoBody(task, gen.lane, iso(s2 + 3600)))], s2 + 7200);
        assert.deepEqual(taskOf(again, task), t, "second strike-two mutated a released claim");
        return;
      }

      if (gen.scenario === "terminal") {
        const done = comment(t0 + 600, doneBody({ task, lane: gen.lane, sha: SHA, pr: 4242 }));
        const s2c = comment(s2, strikeTwoBody(task, gen.lane, iso(s2)));
        const before = boardState([claim, done, s1c], s2);
        const after = boardState([claim, done, s1c, s2c], s2 + 60);
        assert.deepEqual(taskOf(after, task), taskOf(before, task), "strike-two on a completed claim mutated it");
        assert.equal(stateWord(taskOf(after, task).state), "completed");
        return;
      }

      if (gen.scenario === "noStrikeOne") {
        // Forged strike-two with no prior strike-one: ignored (fail-closed).
        const forged = comment(s1, strikeTwoBody(task, gen.lane, iso(s1)));
        const before = boardState([claim], s1);
        const after = boardState([claim, forged], s1 + 60);
        assert.deepEqual(taskOf(after, task), taskOf(before, task), "strike-two without strike-one mutated the task");
        assert.ok(after.log.some((e) => /strike-two without a prior strike-one/.test(e.ignored || "")),
          "forged strike-two not logged as ignored");
        return;
      }

      // "early": strike-two before the 4h grace elapsed: ignored.
      const early = comment(s1 + 7200, strikeTwoBody(task, gen.lane, iso(s1 + 7200)));
      const before = boardState([claim, s1c], s1 + 7200);
      const after = boardState([claim, s1c, early], s1 + 7260);
      assert.deepEqual(taskOf(after, task), taskOf(before, task), "early strike-two mutated the task");
      assert.equal(stateWord(taskOf(after, task).state), "working", "early strike-two must not release");
      assert.ok(after.log.some((e) => /before the 4h strike grace elapsed/.test(e.ignored || "")),
        "early strike-two not logged as ignored");
    },
  ), { numRuns: 32, seed });
});

// --- P4: receipts are idempotent ---------------------------------------------------
test("property P4: receipts are idempotent — replayed dones never double-count", () => {
  fc.assert(fc.property(
    fc.record({
      nonce: arbNonce,
      lane: arbLane,
      replays: fc.integer({ min: 1, max: 4 }),
      prose: fc.boolean(),
    }),
    (gen) => {
      nextId = 1;
      const task = taskId(gen.nonce, 0);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const t0 = BASE;
      const ctx = { task, lane: gen.lane, sha: SHA, pr: 4242 };
      const first = [
        comment(t0, claimBody({ task, lane: gen.lane, files, leaseH: 6, state: "working" })),
        comment(t0 + 600, doneBody(ctx)),
      ];
      const once = boardState(first, t0 + 1200);
      assert.equal(taskOf(once, task).receipts.length, 1, "first done must record exactly one receipt");
      assert.equal(taskOf(once, task).missing_receipt, false);

      const replayed = [...first];
      for (let i = 0; i < gen.replays; i++) {
        replayed.push(comment(t0 + 1200 + (i + 1) * 600, doneBody(ctx)));
      }
      if (gen.prose) replayed.push(comment(t0 + 6000, receiptProseBody(ctx)));
      const after = boardState(replayed, t0 + 7200);
      assert.equal(taskOf(after, task).receipts.length, 1, "replayed done appended a second receipt");
      assert.deepEqual(taskOf(after, task), taskOf(once, task), "replayed done mutated the task record");
      if (gen.prose) {
        assert.ok(after.prose_receipts.length >= 1, "prose receipt not recorded");
      }
    },
  ), { numRuns: 30, seed });
});

// --- P5: heartbeat grace rules ------------------------------------------------------
test("property P5a: heartbeats within the lease renew it; heartbeats after expiry without strike-one are void", () => {
  fc.assert(fc.property(
    fc.record({ nonce: arbNonce, lane: arbLane, leaseH: fc.integer({ min: 1, max: 6 }) }),
    (gen) => {
      nextId = 1;
      const task = taskId(gen.nonce, 0);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const ctx = { task, lane: gen.lane, files, leaseH: gen.leaseH };
      const t0 = BASE;
      const hb = t0 + (gen.leaseH * 3600) / 2; // mid-lease
      const hbId = nextId + 1;
      const st = boardState([
        comment(t0, claimBody({ ...ctx, state: "working" })),
        comment(hb, statusBody({ ...ctx, state: "working", headline: `heartbeat ${task} still working` })),
      ], hb + 60);
      const t = taskOf(st, task);
      const logged = st.log.find((e) => e.id === hbId);
      assert.ok(logged && logged.ok === true && logged.kind === "heartbeat", "in-lease heartbeat not accepted");
      assert.equal(t.heartbeat_at, iso(hb), "heartbeat_at not set to the heartbeat time");
      assert.equal(t.lease_expires_at, iso(hb + gen.leaseH * 3600), "lease not renewed from the heartbeat");

      // Heartbeat after expiry with no strike-one nudge: void, changes nothing.
      const late = t0 + gen.leaseH * 3600 * 2 + 600;
      const lateId = nextId + 2; // third comment of the batch below
      const st2 = boardState([
        comment(t0, claimBody({ ...ctx, state: "working" })),
        comment(hb, statusBody({ ...ctx, state: "working", headline: `heartbeat ${task} still working` })),
        comment(late, statusBody({ ...ctx, state: "working", headline: `late heartbeat ${task}` })),
      ], late + 60);
      const t2 = taskOf(st2, task);
      const loggedLate = st2.log.find((e) => e.id === lateId);
      assert.ok(loggedLate && loggedLate.ok === false, "post-expiry heartbeat without strike-one not voided");
      assert.equal(t2.heartbeat_at, iso(hb), "void heartbeat moved heartbeat_at");
      assert.equal(t2.lease_expires_at, iso(hb + gen.leaseH * 3600), "void heartbeat moved the lease");
    },
  ), { numRuns: 30, seed });
});

test("property P5b: a heartbeat after strike-one blocks strike-two (grace reset)", () => {
  fc.assert(fc.property(
    fc.record({ nonce: arbNonce, lane: arbLane }),
    (gen) => {
      nextId = 1;
      const task = taskId(gen.nonce, 0);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const ctx = { task, lane: gen.lane, files, leaseH: 1 };
      const t0 = BASE;
      const s1 = t0 + 7200; // strike-one after the 1h lease expired
      const hb = s1 + 3600; // heartbeat inside the 4h grace
      const s2 = s1 + 5 * 3600; // strike-two after the grace
      const st = boardState([
        comment(t0, claimBody({ ...ctx, state: "working" })),
        comment(s1, strikeOneBody(task, gen.lane, iso(s1))),
        comment(hb, statusBody({ ...ctx, state: "working", headline: `heartbeat ${task} alive after nudge` })),
        comment(s2, strikeTwoBody(task, gen.lane, iso(s2))),
      ], s2 + 60);
      const t = taskOf(st, task);
      assert.equal(stateWord(t.state), "working", "post-nudge heartbeat did not block strike-two");
      assert.equal(t.lane, gen.lane, "claim lane lost despite post-nudge heartbeat");
      assert.equal(t.strike_one_at, iso(s1), "strike-one marker moved");
      assert.equal(t.heartbeat_at, iso(hb), "heartbeat_at not set to the post-nudge heartbeat");
      assert.ok(st.log.some((e) => /strike-two after a post-nudge heartbeat/.test(e.ignored || "")),
        "blocked strike-two not logged as ignored");
    },
  ), { numRuns: 30, seed });
});

test("property P5c: sweep strike plans follow the documented grace rules", () => {
  fc.assert(fc.property(
    fc.record({
      nonce: arbNonce,
      lane: arbLane,
      scenario: fc.constantFrom("expiredSilent", "heartbeated", "graceElapsed", "graceHeartbeat"),
    }),
    (gen) => {
      nextId = 1;
      const B = BASE + 86400; // board "now"
      const task = taskId(gen.nonce, 0);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const ctx = { task, lane: gen.lane, files, leaseH: 2 };
      // Grace scenarios need a longer timeline: claim 8h ago (2h lease expired
      // 6h ago), strike-one stamp 5h ago (after expiry), so the 4h grace has
      // elapsed by board time B.
      const long = gen.scenario === "graceElapsed" || gen.scenario === "graceHeartbeat";
      const t0 = long ? B - 8 * 3600 : B - 3 * 3600;
      const s1 = B - 5 * 3600; // strike-one stamp (after lease expiry)
      const comments = [comment(t0, claimBody({ ...ctx, state: "working" }))];
      if (gen.scenario === "heartbeated") {
        // Heartbeat within the lease: expiry extends past board now — no strike.
        comments.push(comment(t0 + 3600, statusBody({ ...ctx, state: "working", headline: `heartbeat ${task} on time` })));
      }
      if (long) {
        comments.push(comment(s1, strikeOneBody(task, gen.lane, iso(s1))));
      }
      if (gen.scenario === "graceHeartbeat") {
        comments.push(comment(s1 + 3600, statusBody({ ...ctx, state: "working", headline: `heartbeat ${task} after nudge` })));
      }
      comments.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      const out = sweepDryRun(comments, B);
      const strikeOnePlan = new RegExp(`PLAN: strike-one nudge for ${task}`);
      const strikeTwoPlan = new RegExp(`PLAN: strike-two release for ${task}`);
      switch (gen.scenario) {
        case "expiredSilent":
          assert.match(out, strikeOnePlan, "expired silent claim got no strike-one plan");
          assert.doesNotMatch(out, strikeTwoPlan, "strike-two planned without a strike-one");
          break;
        case "heartbeated":
          assert.doesNotMatch(out, strikeOnePlan, "in-lease heartbeat still drew a strike-one");
          break;
        case "graceElapsed":
          assert.match(out, strikeTwoPlan, "4h-silent strike-one drew no strike-two plan");
          break;
        case "graceHeartbeat":
          assert.doesNotMatch(out, strikeTwoPlan, "post-nudge heartbeat did not stop strike-two");
          break;
        default:
          throw new Error("unknown scenario");
      }
    },
  ), { numRuns: 12, seed });
});

// --- P6: re-claims refused; invalid blocks create nothing ------------------------------
test("property P6: task-id reuse is always refused; invalid claim blocks never create tasks", () => {
  fc.assert(fc.property(
    fc.record({
      nonce: arbNonce,
      lane: arbLane,
      otherLane: arbLane,
      badLease: fc.constantFrom("6h", "lease=0h", "lease=99h", ""),
    }),
    (gen) => {
      nextId = 1;
      const task = taskId(gen.nonce, 0);
      const badTask = taskId(gen.nonce, 1);
      const files = `tests/prop-${gen.nonce}.test.js`;
      const t0 = BASE;
      const good = [comment(t0, claimBody({ task, lane: gen.lane, files, leaseH: 6, state: "working" }))];
      const before = boardState(good, t0 + 60);

      // Re-claim of the same task-id (even by another lane, even valid): refused.
      const dup = comment(t0 + 600, claimBody({ task, lane: gen.otherLane, files, leaseH: 6, state: "working", reason: "re-claim attempt" }));
      const afterDup = boardState([...good, dup], t0 + 1200);
      assert.deepEqual(taskOf(afterDup, task), taskOf(before, task), "duplicate claim mutated the task");
      assert.equal(afterDup.refused.length, before.refused.length + 1, "duplicate claim not refused");
      assert.equal(afterDup.refused[afterDup.refused.length - 1].task_id, task);
      assert.equal(taskOf(afterDup, task).lane, gen.lane, "duplicate claim stole the lane");

      // Invalid block (bad lease) with a fresh task-id: rejected loudly, no task.
      const bad = comment(t0 + 600, `[${gen.lane}][claim]\n\n\`\`\`room-claim\ntask-id: ${badTask}\nlane: ${gen.lane}\nfiles: ${files}\nlease: ${gen.badLease}\nstate: working\nreason: invalid lease test\n\`\`\``);
      const afterBad = boardState([...good, bad], t0 + 1200);
      assert.equal(taskOf(afterBad, badTask), undefined, `invalid claim block created a task (${gen.badLease})`);
      const logged = afterBad.log.find((e) => e.id === bad.id);
      assert.ok(logged && logged.ok === false && (logged.errors || []).length > 0,
        `invalid claim block (${gen.badLease}) not rejected with errors`);
    },
  ), { numRuns: 25, seed });
});

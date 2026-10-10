// PRODUCT-200 reliability — deterministic chaos seed corpus.
//
// Each seed encodes one QA-200 confirmed failure sequence as an exact op
// sequence plus the property it must satisfy, executed against the REAL
// implementation (route handler / AgentInvites / RoomStore — never a
// reimplementation). A seed returns { violated, evidence }:
//
//   violated=false — the property holds (bug fixed or never present)
//   violated=true  — the property is violated (bug reproduces)
//
// The XFAIL manifest: seed.expect is the expected outcome on today's code.
// "fail" seeds FAIL on current main for the intended reason (verified by
// running); the test harness asserts the outcome matches the expectation,
// so the suite stays green while still proving the bug reproduces. When a
// fix lands, the seed unexpectedly passes and the harness fails loudly,
// forcing the manifest flip to "pass" — at which point the seed becomes a
// permanent regression guard.
//
// C1's chaos harness frame has not landed (branch
// jill/product200-c1-chaos-scaffold is ~2800 files stale vs main); these
// seeds are standalone and shaped to plug into that frame when it lands:
// each seed is { id, title, finding, expect, run } with run() taking no
// harness-specific arguments.
import { makeBoardWorld, makeInviteWorld, attempt } from "./world.mjs";

const histLen = item => item?.history?.length ?? -1;
const claimedRounds = item => item?.history?.filter(h => h.action === "claimed").length ?? -1;

export const SEEDS = [
  {
    id: "SEED-E5",
    title: "stale-release replay must not destroy a fresh claim round",
    finding: "QA-200 failseq E5/D4 (RANKED-FINDINGS.md #1-2): claim → release → " +
      "re-claim → replay the stale release payload → 200, the FRESH claim is " +
      "destroyed. Fix: PR #2088 (compare-and-release: release binds " +
      "expectedClaimedAt + expectedHistoryLength; stale → 409 " +
      "work_claim_conflict). Not merged — main still vulnerable.",
    expect: "fail",
    run: async () => {
      const w = makeBoardWorld();
      const id = "e5-w1";
      const evidence = [];
      // Round 1: claim → release. The release response is the "stale payload"
      // the client will later replay after a timeout.
      let r = await w.call("create", { body: { id } });
      evidence.push(`create → ${r.status}`);
      r = await w.call("claim", { id, body: {} });
      evidence.push(`claim r1 → ${r.status} owner=${r.value?.owner}`);
      const r1 = { claimedAt: r.value.claimedAt, historyLength: histLen(r.value) };
      r = await w.call("release", { id, body: {} });
      evidence.push(`release r1 → ${r.status} state=${r.value?.state}`);
      // Round 2: a fresh claim on the same work item.
      r = await w.call("claim", { id, body: {} });
      evidence.push(`claim r2 → ${r.status} claimedAt=${r.value?.claimedAt}`);
      const r2 = { claimedAt: r.value.claimedAt, historyLength: histLen(r.value) };
      // The failure sequence: replay the stale round-1 release payload.
      // (On fixed code per #2088 this shape 422s on the missing round fields
      // or 409s on a round mismatch — either way the fresh round survives.)
      r = await w.call("release", { id, body: {} });
      evidence.push(`stale release replay → ${r.status}${r.code ? ` ${r.code}` : ""}`);
      const after = w.read(id);
      evidence.push(`read-back: state=${after?.state} owner=${after?.owner} ` +
        `claimedAt=${after?.claimedAt} history=${histLen(after)}`);
      // Property: the round-2 claim is untouched — still claimed by alice,
      // same claimedAt, same history length (history length is the true round
      // counter: a same-millisecond re-claim keeps the old claimedAt).
      const violated =
        after?.state !== "claimed" ||
        after?.owner !== "alice" ||
        after?.claimedAt !== r2.claimedAt ||
        histLen(after) !== r2.historyLength ||
        claimedRounds(after) !== 2;
      evidence.push(violated
        ? `VIOLATED: round-2 claim destroyed (r1 claimedAt=${r1.claimedAt} r2 claimedAt=${r2.claimedAt})`
        : "HOLDS: round-2 claim survived the stale release replay");
      return { violated, evidence: evidence.join(" | ") };
    },
  },
  {
    id: "SEED-A3",
    title: "byte-identical update retry must not append a duplicate history entry",
    finding: "QA-200 invariants inv-s7-r2 BUG-2: update → (timeout, response " +
      "lost) → retry the identical update → a duplicate history entry is " +
      "appended (withHistory() stamps unconditionally; the update route has no " +
      "requestId). John's QA-plan invariant 1: retry must not duplicate work. " +
      "Fix sketch: requestId idempotency per claim+requestId, or a " +
      "byte-identical no-change guard. Satisfied by either; the seed retries " +
      "byte-identical, so a requestId-only fix must treat it as same-request.",
    expect: "fail",
    run: async () => {
      const w = makeBoardWorld();
      const id = "a3-w1";
      const evidence = [];
      let r = await w.call("create", { body: { id } });
      evidence.push(`create → ${r.status}`);
      r = await w.call("claim", { id, body: {} });
      evidence.push(`claim → ${r.status}`);
      const note = "progress: half done";
      r = await w.call("update", { id, body: { note } });
      const h1 = histLen(r.value);
      evidence.push(`update {note} → ${r.status} history=${h1}`);
      // Timeout: the response is lost. The client retries the IDENTICAL update.
      r = await w.call("update", { id, body: { note } });
      const h2 = histLen(r.value);
      evidence.push(`retry identical update → ${r.status} history=${h2}`);
      const after = w.read(id);
      const violated = h2 !== h1 || histLen(after) !== h1;
      evidence.push(violated
        ? `VIOLATED: retry grew history ${h1} → ${h2} (lifetime count permanently inflated)`
        : "HOLDS: retry appended no duplicate stamp");
      return { violated, evidence: evidence.join(" | ") };
    },
  },
  {
    id: "SEED-B24",
    title: "every committed board write must journal a work_claim.* event",
    finding: "QA-200 invariants inv-b24 (P1): the board write path emits NO " +
      "events — 391 claims / 1035 history transitions, zero work_claim.* " +
      "events in the room log (seq 1→700). Event-replay board reconstruction " +
      "(the inv-b22 replay harness's source-grounded model) is impossible; " +
      "any monitor built on /events is blind to all board activity. Fix: " +
      "emit work_claim.created/claimed/updated/released/closed (claim id + " +
      "revision) from the board write path, or document the board as " +
      "non-event-sourced (in which case retire this seed — see SEEDS.md).",
    expect: "fail",
    run: async () => {
      const w = makeBoardWorld();
      const id = "b24-w1";
      const evidence = [];
      const ops = [
        ["create", { body: { id } }],
        ["claim", { id, body: {} }],
        // Note-only update: stays in "claimed" so the release below is a
        // legal transition (TRANSITIONS has no in_progress → unclaimed edge).
        ["update", { id, body: { note: "started" } }],
        ["release", { id, body: {} }],
      ];
      for (const [route, args] of ops) {
        const r = await w.call(route, args);
        evidence.push(`${route} → ${r.status}`);
      }
      const types = w.journal.map(e => e.type);
      evidence.push(`journal: [${types.join(", ")}] (${w.journal.length} events)`);
      const want = ["work_claim.created", "work_claim.claimed", "work_claim.updated", "work_claim.released"];
      const missing = want.filter(t => !types.includes(t));
      const ordered = want.every((t, i) => types.indexOf(t) === i || true); // order checked below
      const inOrder = want
        .map(t => types.indexOf(t))
        .every((idx, i, arr) => idx !== -1 && (i === 0 || idx > arr[i - 1]));
      void ordered;
      const badShape = w.journal.filter(e =>
        !(e.data && typeof e.data.claimId === "string" && typeof e.data.revision === "number"));
      const violated = missing.length > 0 || !inOrder || badShape.length > 0;
      evidence.push(violated
        ? `VIOLATED: missing=[${missing.join(", ")}] inOrder=${inOrder} malformed=${badShape.length}`
        : "HOLDS: every board write journaled a well-formed work_claim.* event in order");
      return { violated, evidence: evidence.join(" | ") };
    },
  },
  {
    id: "SEED-G1",
    title: "invite-redeem retry must recover the membership or name a recovery path",
    finding: "QA-200 failseq G1 (candidate, deferred to owner): redeem commits " +
      "the membership burn but the 201 body is lost on timeout → retry gets " +
      "409 with no recovery path (security-adjacent: the membership exists, " +
      "its secret is shown exactly once and now lost). Sub-seeds: (a) retry " +
      "WITH the retained secret re-attaches (duplicate:true) — regression " +
      "guard, passes today; (b) retry WITHOUT the secret (lost body) must " +
      "offer a recovery path, not a bare dead-end 409 — fails today; " +
      "(c) double-redeem is exactly-once — passes today.",
    expect: "fail",
    run: async () => {
      const w = await makeInviteWorld();
      const evidence = [];
      let violated = false;
      try {
        // (c) exactly-once under double redeem: one code, two redeems.
        const c1 = await w.invites.create(w.ownerKey, w.roomId,
          { profile: "contribute", displayName: "Seed Once" });
        const first = await attempt(() => w.invites.redeem(c1.code, { displayName: "Seed Once" }));
        const second = await attempt(() => w.invites.redeem(c1.code, { displayName: "Seed Once" }));
        evidence.push(`double-redeem: first ok=${first.ok} second ok=${second.ok} code=${second.code}`);
        const membersAfterDouble = Object.keys(w.store.room(w.roomId).state.members).length;
        if (!first.ok || second.ok || second.code !== "invite_already_used") {
          violated = true;
          evidence.push("VIOLATED(c): double redeem is not exactly-once");
        } else {
          evidence.push(`HOLDS(c): exactly-once (${membersAfterDouble} members total)`);
        }
        // (a/b) the G1 sequence: redeem, lose the body, retry.
        const c2 = await w.invites.create(w.ownerKey, w.roomId,
          { profile: "contribute", displayName: "Seed G1" });
        const committed = await attempt(() => w.invites.redeem(c2.code, { displayName: "G1 Agent" }));
        if (!committed.ok) {
          violated = true;
          evidence.push(`SETUP-FAILED: initial redeem did not commit: ${committed.code}`);
          return { violated, evidence: evidence.join(" | ") };
        }
        const { identityId, secret, memberId } = committed.value;
        evidence.push(`redeem committed: memberId=${memberId} identityId=${identityId} (body "lost" on timeout)`);
        // (a) retry WITH the retained secret — must re-attach.
        const withSecret = await attempt(() =>
          w.invites.redeem(c2.code, { displayName: "G1 Agent", identitySecret: secret }));
        evidence.push(`retry with secret: ok=${withSecret.ok} duplicate=${withSecret.value?.duplicate} ` +
          `memberId=${withSecret.value?.memberId}`);
        if (!withSecret.ok || withSecret.value?.duplicate !== true || withSecret.value?.memberId !== memberId) {
          violated = true;
          evidence.push("VIOLATED(a): secret-retained retry did not re-attach the membership");
        } else {
          evidence.push("HOLDS(a): secret-retained retry re-attaches (duplicate:true)");
        }
        // (b) retry WITHOUT the secret — the lost-body case. Must offer a
        // recovery path: re-attach, or a failure that names how to recover
        // (a recovery handle in the error, not a bare "already used").
        const lostSecret = await attempt(() => w.invites.redeem(c2.code, { displayName: "G1 Agent" }));
        const recoveryHandle = lostSecret.value?.recovery ?? lostSecret.value?.next ?? null;
        const namesRecovery = lostSecret.code !== "invite_already_used" || recoveryHandle !== null;
        evidence.push(`retry without secret: ok=${lostSecret.ok} code=${lostSecret.code} ` +
          `recoveryHandle=${recoveryHandle !== null}`);
        if (lostSecret.ok || !namesRecovery) {
          if (!lostSecret.ok && !namesRecovery) {
            violated = true;
            evidence.push("VIOLATED(b): stranded membership — bare 409, no recovery path");
          }
        } else {
          evidence.push("HOLDS(b): retry names a recovery path");
        }
      } finally {
        w.close();
      }
      return { violated, evidence: evidence.join(" | ") };
    },
  },
];

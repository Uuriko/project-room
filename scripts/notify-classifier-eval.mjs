// scripts/notify-classifier-eval.mjs — eval harness for the canonical
// two-trigger classifier (server/notify-classifier.mjs, lane B19).
//
// Measures precision/recall of shouldNotify() against a hand-labeled
// fixture set. The positive class is "this event should interrupt the
// recipient". A miss (false positive or false negative) exits non-zero so
// CI can gate on it.
//
// Fixture sources (documented, per the build-lane checklist):
//   - Trigger taxonomy and ambient routing table:
//     teardowns/getone-2026-10-06/wave2/copy-kit/notifications-spec.md §2
//     ("two-trigger discipline": review requested of you / blocked on you
//     vs ambient everything-else).
//   - Claim states (unclaimed/claimed/in_progress/blocked/done) and the
//     self-report-only block rule: server/work-claims.mjs.
//   - Reviewable artifact status "needs_review": server/inbox.mjs (~line 938).
//   - Mention lifecycle delivered->acknowledged->responded | timed_out,
//     30-minute default, sender-skip convention: server/mention-lifecycle.mjs.
//   - The duplicate-reply incident (stale notification answered twice) is
//     the regression each stale-block fixture guards against: the block
//     must still read "blocked" at classify time or the interrupt is void.
//
// Run: TMPDIR=<worktree>/.tmp node scripts/notify-classifier-eval.mjs
import { shouldNotify } from "../server/notify-classifier.mjs";

const ME = "member-jill";
const OTHER = "member-fo";
const THIRD = "member-tab";

const P = (extra = {}) => ({ memberId: ME, owned: [], verifies: [], ...extra });
const E = (extra) => ({ senderId: OTHER, seq: 100, ...extra });

// Each fixture: human-readable label + the ground-truth expected value.
const FIXTURES = [
  // ---- Trigger 1a: review explicitly requested of the recipient ----
  { label: "review_request addressed to me, needs_review artifact", expected: true,
    event: E({ type: "review_request", addressedTo: [ME], mentionState: "delivered",
      reviewArtifact: { claimId: "claim-1", status: "needs_review", prNumber: 1585, headSha: "abc123" } }), prefs: P() },
  { label: "review_request via structured requested_reviewer resolution", expected: true,
    event: E({ type: "review_request", addressedTo: [ME], mentionState: "acknowledged",
      reviewArtifact: { claimId: "claim-2", status: "needs_review" } }), prefs: P() },
  { label: "review_request addressed to someone else", expected: false,
    event: E({ type: "review_request", addressedTo: [OTHER, THIRD], mentionState: "delivered",
      reviewArtifact: { claimId: "claim-1", status: "needs_review" } }), prefs: P() },
  { label: "review_request on a non-reviewable artifact (malformed -> inbox card)", expected: false,
    event: E({ type: "review_request", addressedTo: [ME], mentionState: "delivered",
      reviewArtifact: { claimId: "claim-1", status: "in_progress" } }), prefs: P() },
  { label: "review_request already responded (lifecycle suppression)", expected: false,
    event: E({ type: "review_request", addressedTo: [ME], mentionState: "responded",
      reviewArtifact: { claimId: "claim-1", status: "needs_review" } }), prefs: P() },
  { label: "fresh review_request after timed_out re-arms", expected: true,
    event: E({ type: "review_request", addressedTo: [ME], mentionState: "timed_out",
      reviewArtifact: { claimId: "claim-1", status: "needs_review" } }), prefs: P() },
  { label: "review_request with no mention state at all (fresh)", expected: true,
    event: E({ type: "review_request", addressedTo: [ME],
      reviewArtifact: { claimId: "claim-1", status: "needs_review" } }), prefs: P() },

  // ---- Trigger 1b: question addressed to the recipient ----
  { label: "ASK addressed to me", expected: true,
    event: E({ type: "question", addressedTo: [ME] }), prefs: P() },
  { label: "ASK addressed to someone else", expected: false,
    event: E({ type: "question", addressedTo: [OTHER] }), prefs: P() },
  { label: "unaddressed question (broadcast)", expected: false,
    event: E({ type: "question", addressedTo: [] }), prefs: P() },

  // ---- Trigger 1c: blocked on the recipient ----
  { label: "blocked claim naming me in blockedOn", expected: true,
    event: E({ type: "blocked", claim: { id: "claim-7", status: "blocked", ownerId: OTHER, blockedOn: ME } }), prefs: P() },
  { label: "blocked claim naming a claim I own", expected: true,
    event: E({ type: "blocked", claim: { id: "claim-7", status: "blocked", ownerId: OTHER, blockedOn: "claim-3" } }),
    prefs: P({ owned: ["claim-3"] }) },
  { label: "stale block: claim already done at classify time (duplicate-reply guard)", expected: false,
    event: E({ type: "blocked", claim: { id: "claim-7", status: "done", ownerId: OTHER, blockedOn: ME } }), prefs: P() },
  { label: "stale block: claim unblocked at classify time", expected: false,
    event: E({ type: "blocked", claim: { id: "claim-7", status: "in_progress", ownerId: OTHER, blockedOn: ME } }), prefs: P() },
  { label: "blocked claim naming someone else", expected: false,
    event: E({ type: "blocked", claim: { id: "claim-7", status: "blocked", ownerId: OTHER, blockedOn: THIRD } }), prefs: P() },
  { label: "blocked claim naming something I do not own", expected: false,
    event: E({ type: "blocked", claim: { id: "claim-7", status: "blocked", ownerId: OTHER, blockedOn: "claim-99" } }),
    prefs: P({ owned: ["claim-3"] }) },

  // ---- Trigger 2: done on something the recipient owns or verifies ----
  { label: "done on my own claim (owner)", expected: true,
    event: E({ type: "done", claim: { id: "claim-9", status: "done", ownerId: ME, verifierIds: [] } }), prefs: P() },
  { label: "done on a claim in prefs.owned", expected: true,
    event: E({ type: "done", claim: { id: "claim-9", status: "done", ownerId: OTHER, verifierIds: [] } }),
    prefs: P({ owned: ["claim-9"] }) },
  { label: "done on a claim I verify (verifierIds)", expected: true,
    event: E({ type: "done", claim: { id: "claim-9", status: "done", ownerId: OTHER, verifierIds: [ME] } }), prefs: P() },
  { label: "done on a claim in prefs.verifies", expected: true,
    event: E({ type: "done", claim: { id: "claim-9", status: "done", ownerId: OTHER, verifierIds: [] } }),
    prefs: P({ verifies: ["claim-9"] }) },
  { label: "done on someone else's claim", expected: false,
    event: E({ type: "done", claim: { id: "claim-9", status: "done", ownerId: OTHER, verifierIds: [] } }), prefs: P() },

  // ---- Self-suppression ----
  { label: "self-emitted review_request", expected: false,
    event: E({ type: "review_request", senderId: ME, addressedTo: [ME], mentionState: "delivered",
      reviewArtifact: { claimId: "claim-1", status: "needs_review" } }), prefs: P() },
  { label: "self-emitted done on my own claim", expected: false,
    event: E({ type: "done", senderId: ME, claim: { id: "claim-9", status: "done", ownerId: ME, verifierIds: [] } }), prefs: P() },

  // ---- Default deny: ambient per the spec routing table ----
  { label: "ambient: plain @mention (addressing mechanism, not interrupt)", expected: false,
    event: E({ type: "mention", addressedTo: [ME], text: "@jill fyi" }), prefs: P() },
  { label: "ambient: claim_created on my own claim", expected: false,
    event: E({ type: "claim_created", claim: { id: "claim-1", status: "claimed", ownerId: ME } }), prefs: P() },
  { label: "ambient: PROGRESS on my claim", expected: false,
    event: E({ type: "progress", claim: { id: "claim-1", status: "in_progress", ownerId: ME } }), prefs: P() },
  { label: "ambient: CI result on my PR", expected: false,
    event: E({ type: "ci_result", claim: { id: "claim-1", status: "in_progress", ownerId: ME } }), prefs: P() },
  { label: "ambient: IDEA post", expected: false,
    event: E({ type: "idea", text: "IDEA: something" }), prefs: P() },
  { label: "ambient: room chatter", expected: false,
    event: E({ type: "chat", text: "gm everyone" }), prefs: P() },
  { label: "ambient: review verdict on someone else's work", expected: false,
    event: E({ type: "review_verdict", claim: { id: "claim-5", status: "done", ownerId: OTHER } }), prefs: P() },
  { label: "ambient: heartbeat", expected: false,
    event: E({ type: "heartbeat" }), prefs: P() },
  { label: "ambient: board sweep summary", expected: false,
    event: E({ type: "sweep" }), prefs: P() },
  { label: "ambient: unknown future event type", expected: false,
    event: E({ type: "someday_new_thing" }), prefs: P() },
];

let tp = 0, fp = 0, fn = 0, tn = 0;
const misses = [];
for (const { label, event, prefs, expected } of FIXTURES) {
  const actual = shouldNotify(event, prefs);
  if (actual === true && expected === true) tp++;
  else if (actual === true && expected === false) { fp++; misses.push({ label, kind: "FALSE POSITIVE", expected, actual }); }
  else if (actual === false && expected === true) { fn++; misses.push({ label, kind: "FALSE NEGATIVE", expected, actual }); }
  else tn++;
}

const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const accuracy = (tp + tn) / FIXTURES.length;

console.log(`fixtures: ${FIXTURES.length}`);
console.log(`confusion: TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
console.log(`precision: ${precision.toFixed(4)}  recall: ${recall.toFixed(4)}  accuracy: ${accuracy.toFixed(4)}`);
if (misses.length > 0) {
  console.log("\nmisses:");
  for (const m of misses) console.log(`  [${m.kind}] ${m.label} (expected ${m.expected}, got ${m.actual})`);
  process.exit(1);
}
console.log("all fixtures pass");

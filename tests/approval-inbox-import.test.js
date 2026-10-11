// WAVE-500 guild 10/10 slice 8/50: tap-list markdown -> approval-inbox card DRAFTS.
//
// parseTapList(markdown) must be pure (no I/O, no network) and must NEVER
// create live cards - it returns inert drafts that require a human confirm
// step owned by another slice. Fixture is an excerpt of the real tap list;
// em dashes are written as \u2014 escapes so no literal em dash lands in source.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTapList,
  classifyTapKind,
  DRAFT_KINDS,
} from "../server/approval-inbox-import.mjs";

const EM = "\u2014"; // em dash, the tap list's title/body separator

const FIXTURE = [
  "## Security " + EM + " do these first",
  "0. **Restore signing-key custody (tap #59) " + EM + " RETIRED 2026-10-04: superseded by the shared deploy lane (PR #1408, merged).** Custody is no longer the thing between main and production.",
  "1. Revoke Clerk OAuth grant " + EM + " github.com/settings/applications -> Clerk (one click; contradicts your \"forget clerk\" call).",
  "",
  "## Money " + EM + " exact terms prepared, nothing moves without your word",
  "6. Receipt Challenge prizes " + EM + " $1,500 pool or $750 lean; worker recommends compute-credit payouts. Nothing promised publicly until you tap.",
  "11b. **AWS past due " + EM + " account 370090828551 (payer 748332174992), flagged 2026-09-25 ~11:18 MST.** Unpaid = restriction/suspension risk (no console access, no new resources). Pay in the AWS console yourself.",
  "44. ~~**RSVP: \"MQ-X\" Zoom with Michael Cervantes " + EM + " Friday Oct 9, 12-1pm PT.** No agenda attached.~~ **RETIRED 2026-10-09 ~1:30pm PT** " + EM + " the 12-1pm window passed.",
  "",
  "## Decisions only you can make",
  "22. Launch-kit thesis " + EM + " yes or no on the whole direction (`launch-kit/05-caveats.md`).",
  "",
  "## Parked " + EM + " not actionable unless you reopen",
  "7. Some parked item " + EM + " should never become a draft.",
  "",
  "## Closed out this pass",
  "- a16z 30% code " + EM + " expired Sep 23 08:55 AM PT.",
  "",
  "## Added 2026-10-10 (credits-402 kill switch)",
  "- **Credits-402 owner kill switch " + EM + " your call.** A 402 on the credits/spend-pricing path is firing; only the owner-only kill switch can silence it. Options: (a) flip the owner kill switch to silence the 402, (b) leave the 402 live.",
].join("\n");

function byRef(drafts, ref) {
  return drafts.find((d) => d.sourceRef === ref);
}

test("retired, struck, parked and closed-out entries never become drafts", () => {
  const drafts = parseTapList(FIXTURE);
  const refs = drafts.map((d) => d.sourceRef);
  assert.deepEqual(refs, ["tap-1", "tap-6", "tap-11b", "tap-22", "added-2026-10-10-credits-402-1"]);
  assert.ok(!byRef(drafts, "tap-0"), "tap-0 is RETIRED, must be skipped");
  assert.ok(!byRef(drafts, "tap-44"), "tap-44 is struck + RETIRED, must be skipped");
  assert.ok(!byRef(drafts, "tap-7"), "parked section must not produce drafts");
});

test("tap numbers are preserved as sourceRef", () => {
  const drafts = parseTapList(FIXTURE);
  assert.equal(byRef(drafts, "tap-11b").sourceRef, "tap-11b");
  assert.equal(byRef(drafts, "tap-1").sourceRef, "tap-1");
  assert.equal(byRef(drafts, "added-2026-10-10-credits-402-1").sourceRef, "added-2026-10-10-credits-402-1");
});

test("money items classify as money", () => {
  const drafts = parseTapList(FIXTURE);
  assert.equal(byRef(drafts, "tap-6").kind, "money"); // $1,500 pool
  assert.equal(byRef(drafts, "tap-11b").kind, "money"); // AWS past due, pay in console
});

test("identity and permission classification", () => {
  const drafts = parseTapList(FIXTURE);
  assert.equal(byRef(drafts, "tap-1").kind, "identity"); // OAuth grant
  assert.equal(byRef(drafts, "tap-22").kind, "permission"); // yes-or-no decision
  assert.equal(byRef(drafts, "added-2026-10-10-credits-402-1").kind, "permission"); // owner call
});

test("title is split from the body at the dash separator", () => {
  const drafts = parseTapList(FIXTURE);
  assert.equal(byRef(drafts, "tap-6").title, "Receipt Challenge prizes");
  assert.ok(byRef(drafts, "tap-6").what.includes("$1,500 pool"));
});

test("lettered options are extracted", () => {
  const drafts = parseTapList(FIXTURE);
  assert.deepEqual(byRef(drafts, "added-2026-10-10-credits-402-1").options, [
    "flip the owner kill switch to silence the 402",
    "leave the 402 live",
  ]);
});

test("drafts are inert data: exactly the six draft keys, no live-card fields", () => {
  const drafts = parseTapList(FIXTURE);
  for (const d of drafts) {
    assert.deepEqual(Object.keys(d).sort(), ["context", "kind", "options", "sourceRef", "title", "what"]);
    assert.ok(DRAFT_KINDS.includes(d.kind), "kind must be a known draft kind");
    assert.ok(!("id" in d || "status" in d || "createdBy" in d), "drafts carry no live-card fields");
  }
});

test("parseTapList is pure: no input mutation, fresh objects per call", () => {
  const a = parseTapList(FIXTURE);
  const b = parseTapList(FIXTURE);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(parseTapList(""), []);
  assert.deepEqual(parseTapList("   \n  "), []);
});

test("classifyTapKind falls back to section hints, then other", () => {
  assert.equal(classifyTapKind("Name the checkpoint-key custodian", "Decisions"), "identity");
  assert.equal(classifyTapKind("Flip the enforcement gate", "Decisions only you can make"), "permission");
  assert.equal(classifyTapKind("Some vague note with no signal", "Standing"), "other");
  assert.deepEqual(DRAFT_KINDS, ["money", "identity", "deploy", "permission", "publish", "other"]);
});

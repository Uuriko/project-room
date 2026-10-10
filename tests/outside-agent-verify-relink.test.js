// A34 (P1 correctness, hunt on #2435): verify and link command ids were
// deterministic over (room, approver, ref, decision) / (room, ref) with no
// link or decision nonce. After approve -> deny -> re-link -> approve, the
// re-link POST reused the first link's commandId and store.command dropped
// it as a duplicate, then the second approval reused the first approval's
// id and was dropped too - the API answered recorded:"link"/"verify" while
// nothing landed, and a denied agent could never be re-linked,
// contradicting the in-code comment. The replay check also compared the
// latest-EVER decision, so a repeat decision on a NEW pending link replayed
// instead of recording. Folded from the hunt repro (dup.test, sha-verified
// receipt in the commit trail): planner-level id assertions plus the
// server end-to-end sequence through the real store.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { OutsideAgents } from "../server/outside-agents.mjs";
import { outsideAgentBody, planOutsideAgentVerify } from "../src/outside-agents.mjs";

const msg = (record, authorId, id) => ({
  id, authorId, body: outsideAgentBody(record), toMemberId: null, deletedAt: null,
});
const intro = { v: 1, kind: "introduce", externalRef: "bus:x", displayName: "X", origin: "bus", reach: "bus:x" };
const link = { v: 1, kind: "link", externalRef: "bus:x", memberId: "p" };
const members = { owner: { active: true }, p: { active: true } };
const verifiers = new Set(["owner"]);

test("planner: re-approving after a re-link plans a fresh command id, and replay tracks the current link", () => {
  const m = [msg(intro, "p", "1"), msg(link, "p", "2")];
  const a1 = planOutsideAgentVerify(m, members, "r", "owner", { externalRef: "bus:x", decision: "approved" }, { verifiers });
  assert.equal(a1.recorded, "verify");
  m.push(msg(a1.record, "owner", "3"));
  // Repeating the same decision on the SAME link replays.
  const again = planOutsideAgentVerify(m, members, "r", "owner", { externalRef: "bus:x", decision: "approved" }, { verifiers });
  assert.equal(again.recorded, "replay");
  const d1 = planOutsideAgentVerify(m, members, "r", "owner", { externalRef: "bus:x", decision: "denied" }, { verifiers });
  assert.equal(d1.recorded, "verify");
  m.push(msg(d1.record, "owner", "4"));
  // The member links again; both decisions on the new link must plan fresh
  // records with fresh ids, and the latest-ever decision must not replay.
  const relinked = [...m, msg(link, "p", "5")];
  const a2 = planOutsideAgentVerify(relinked, members, "r", "owner", { externalRef: "bus:x", decision: "approved" }, { verifiers });
  assert.equal(a2.recorded, "verify", "the second approval is a real decision, not a replay");
  assert.notEqual(a2.commandId, a1.commandId, "the second approval must not reuse the first approval's command id");
  const d2 = planOutsideAgentVerify(relinked, members, "r", "owner", { externalRef: "bus:x", decision: "denied" }, { verifiers });
  assert.equal(d2.recorded, "verify", "denying the NEW pending link is a real decision, not a replay of the old deny");
  assert.notEqual(d2.commandId, d1.commandId);
});

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.net = new OutsideAgents(f.store);
  return f;
}

test("server: approve -> deny -> re-link -> approve lands every record", t => {
  const f = fixture(t);
  f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
  });
  const link1 = f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  assert.equal(link1.recorded, "link");
  const approve1 = f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "approved" });
  assert.equal(approve1.recorded, "verify");
  assert.equal(approve1.agents.find(a => a.externalRef === "bus:cursor").verified, true);
  const deny = f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "denied" });
  assert.equal(deny.recorded, "verify");
  assert.equal(deny.agents.find(a => a.externalRef === "bus:cursor").linkedMemberId, null);

  // The in-code contract: "The member may link again, which returns the
  // agent to pending." The re-link must actually land, not dedupe away.
  const link2 = f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  assert.equal(link2.recorded, "link");
  const relinked = link2.agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(relinked.linkedMemberId, "producer", "the re-link must land, not drop as a duplicate command");
  assert.equal(relinked.verified, false);
  assert.equal(relinked.verificationPending, true);

  const approve2 = f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "approved" });
  assert.equal(approve2.recorded, "verify", "the second approval is recorded, not dropped as a duplicate");
  const decided = approve2.agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(decided.verified, true, "the re-linked agent is verified by the second approval");
  assert.equal(decided.linkedMemberId, "producer");
});

test("server: exact retries still dedupe - re-posting the same link and decision replays", t => {
  const f = fixture(t);
  f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
  });
  f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  const again = f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  assert.equal(again.recorded, "replay");
  f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "approved" });
  const repeat = f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "approved" });
  assert.equal(repeat.recorded, "replay");
});

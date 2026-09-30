import test from "node:test";
import assert from "node:assert/strict";
import { bountyContributorBrief, bountyContributorSkillMd, renderBountyPacket, yamlSafeLine } from "../client/bounty-brief.mjs";
import { parseBriefArgs, briefFromStdinJson } from "../scripts/bounty-brief.mjs";

const bounty = {
  bountyId: "b-1",
  title: "Fix mention wake",
  criteria: "A named member still wakes from a full-length body. Tests pass.",
  amount: 5,
  deadline: "2026-10-07T00:00:00Z",
  state: "FUNDED",
  verifierId: "ai_owner",
  rubric: [{ criterionId: "wake", description: "resolveMentionTargetsInText finds the member" }]
};

test("contributor brief is a paste packet with no secrets and no cash claim", () => {
  const brief = bountyContributorBrief(bounty, { origin: "https://room.trydemigod.com", roomId: "muse-room" });
  assert.match(brief, /untrusted task data/);
  assert.match(brief, /b-1/);
  assert.match(brief, /ledger units, not cash/);
  assert.match(brief, /Named verifier ai_owner/);
  assert.match(brief, /wake: resolveMentionTargetsInText/);
  assert.doesNotMatch(brief, /pri_/);
  assert.doesNotMatch(brief, /Bearer /);
});

test("skill markdown wraps the same brief", () => {
  const skill = bountyContributorSkillMd(bounty, { origin: "https://room.example", roomId: "den" });
  assert.match(skill, /^---\nname: project-room-bounty/m);
  assert.match(skill, /Contribute to Project Room bounty b-1/);
  assert.match(skill, /untrusted task data/);
});

test("skill description stays one YAML line when the title has quotes and newlines", () => {
  const messy = { ...bounty, title: 'Fix "wake"\nand ship' };
  const skill = bountyContributorSkillMd(messy, { origin: "https://room.example", roomId: "den" });
  const descLine = skill.split("\n").find(line => line.startsWith("description:"));
  assert.ok(descLine);
  assert.equal(descLine.includes("\n"), false);
  assert.match(descLine, /Fix 'wake' and ship/);
  assert.equal(yamlSafeLine('a\n"b"', 20), "a 'b'");
});

test("invalid bounties fail closed", () => {
  assert.throws(() => bountyContributorBrief(null), /invalid_bounty/);
  assert.throws(() => bountyContributorBrief({ ...bounty, amount: 0 }), /invalid_bounty/);
  assert.throws(() => bountyContributorBrief({ ...bounty, title: "" }), /invalid_bounty/);
});

test("CLI args select skill vs brief", () => {
  assert.deepEqual(parseBriefArgs(["node", "scripts/bounty-brief.mjs", "--skill", "--room", "den"]), {
    format: "skill", origin: null, roomId: "den"
  });
  assert.equal(parseBriefArgs(["node", "x", "--wat"]), null);
});

test("stdin JSON renders the same packet as the library", () => {
  const text = JSON.stringify(bounty);
  const brief = briefFromStdinJson(text, { format: "brief", origin: "https://room.example", roomId: "den" });
  assert.equal(brief, renderBountyPacket(bounty, { origin: "https://room.example", roomId: "den" }));
  assert.throws(() => briefFromStdinJson("not-json", { format: "brief" }), /stdin must be one bounty JSON object/);
});

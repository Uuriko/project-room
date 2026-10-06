// Public contribution export from src/contribution-brief.js: publicContribution
// must hand out an isolated deep copy of the prepared public terms (a caller
// mutating the export must never corrupt the prepared brief), and
// contributionMarkdown's default rendering is the plain markdown offer — the
// skill-frontmatter variant is already covered in tests/paid-work-offers.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { publicContribution, contributionMarkdown } from "../src/contribution-brief.js";

const prepared = () => ({
  publicTerms: { kind: "task", title: "Write the guide", summary: "A short guide.",
    acceptanceCriteria: ["reads well"], exclusions: [], approvalPolicy: { mode: "human" },
    reward: { kind: "unpaid" } },
  private: "never published",
});

test("publicContribution exports an isolated copy of the public terms", () => {
  const source = prepared();
  const exported = publicContribution(source);
  assert.deepEqual(exported, source.publicTerms);
  assert.ok(!("private" in exported), "private compiler fields stay out of the export");
  exported.reward.kind = "cash";
  exported.title = "mutated";
  assert.equal(source.publicTerms.reward.kind, "unpaid", "mutating the export must not touch the prepared brief");
  assert.equal(source.publicTerms.title, "Write the guide");
});

const terms = () => prepared().publicTerms;

test("contributionMarkdown defaults to the plain markdown offer", () => {
  const output = contributionMarkdown({ publicTerms: terms() });
  assert.ok(output.startsWith("# Project Room contribution offer"), "default header is the markdown offer");
  assert.ok(!output.startsWith("---\nname:"), "no skill frontmatter without the skill option");
  assert.match(output, /```json\n\{[\s\S]*"kind": "unpaid"[\s\S]*\}\n```/);
  assert.match(output, /not_applicable/);
});


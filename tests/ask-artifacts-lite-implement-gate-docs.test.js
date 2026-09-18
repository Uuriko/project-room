// T081 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T081 Artifacts-lite implement gate note exists", () => {
  assert.ok(existsSync(note), "research/ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T081",
    "T034",
    "implement gate",
    "Artifacts-lite",
    "ASK-ARTIFACTS-LITE-2026-09-18.md",
    "T034-artifacts-lite-ready-to-implement.md",
    "2e7778e6",
    "#ask-artifact-panel",
    "dasha-compute.html",
    "ASK-QUIET-SHELL-V3.md",
  ]) {
    assert.ok(text.includes(needle), `implement gate should include ${needle}`);
  }
  assert.ok(text.includes("#493"), "cite project-room #493 Artifacts-lite research");
  assert.ok(text.includes("#507"), "cite project-room #507 T034 ready-to-implement");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill");
  assert.ok(text.includes("#262"), "cite Quill #262");
  assert.ok(text.includes("#266"), "cite Quill #266");
  assert.ok(text.includes("#274"), "cite Quill #274");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#272"), "cite dasha-lobby #272 Motley tip-source");
  assert.ok(text.includes("T076"), "name T076 Motley honesty as already covered");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/never.*T033|do not combine|Never one lobby PR/i.test(text), "do not combine with T033");
  assert.ok(/N = 16|N=16|> N/.test(text), "P0 N=16 copied from #493");
  assert.ok(/empty Ask/i.test(text), "empty Ask stays empty");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
});

test("index rows point at T081", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md"));
  assert.ok(docs.includes("ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md"));
});

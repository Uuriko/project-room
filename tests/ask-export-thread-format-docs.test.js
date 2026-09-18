// T086 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T086 Ask Export thread format brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T086",
    "T044",
    "#496",
    "T044-quiet-export-transcript.md",
    "T045-receipt-collapse.md",
    "ASK-QUIET-SHELL-V3.md",
    "dasha.ask.transcript.v1",
    "lastPaidReceipt",
    "job_id",
    "#ask-export",
  ]) {
    assert.ok(text.includes(needle), `export format brief should include ${needle}`);
  }
  assert.ok(/markdown download vs copy|MD download vs copy|download vs copy/i.test(text), "name markdown download vs copy");
  assert.ok(/Copied/.test(text), "Copy confirm Copied");
  assert.ok(/Saved/.test(text), "Export confirm Saved");
  assert.ok(/Engine:/.test(text), "header Engine");
  assert.ok(/Model:/.test(text), "header Model");
  assert.ok(/Exported:/.test(text), "header Exported");
  assert.ok(/Job:/.test(text), "receipt Job line");
  assert.ok(/tok\/s/.test(text), "tok/s stays off the file header");
  assert.ok(/A3/.test(text), "cite Ask v2 A3 Copy");
  assert.ok(text.includes("#249"), "cite dasha-lobby #249 Ask v2");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(text.includes("#262"), "cite Quill #262");
  assert.ok(text.includes("#266"), "cite Quill #266");
  assert.ok(text.includes("#274"), "cite Quill #274");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073 canary");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(text.includes("#526"), "cite T085 #526");
  assert.ok(/do not rewrite|Cite, do not rewrite/i.test(text), "T085 cited not rewritten");
  assert.ok(/not a T044 rewrite/i.test(text), "state why not a T044 rewrite");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/no bonsai/i.test(text), "live still no bonsai");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(/plugin\.jup\.ag/.test(text), "never plugin.jup.ag");
  assert.ok(/UNKNOWN/.test(text), "model UNKNOWN when unknown");
});

test("index rows point at T086 next to T044 / T045, not T085 markdown or T084 New-chat", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md"));
  assert.ok(research.includes("ask/T044-quiet-export-transcript.md"));
  assert.ok(research.includes("ask/T045-receipt-collapse.md"));
  assert.ok(docs.includes("T044-quiet-export-transcript.md") || docs.includes("research/ask/") || docs.includes("T044–T046") || docs.includes("T044"));
  const researchT086 = research.indexOf("ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md");
  const researchT044 = research.indexOf("ask/T044-quiet-export-transcript.md");
  const researchT045 = research.indexOf("ask/T045-receipt-collapse.md");
  const researchT085 = research.indexOf("ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md");
  const researchT084 = research.indexOf("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
  assert.ok(researchT086 !== -1 && researchT044 !== -1 && researchT045 !== -1);
  assert.ok(Math.abs(researchT086 - researchT044) < 800, "T086 research index sits next to T044 export");
  assert.ok(Math.abs(researchT086 - researchT045) < 800, "T086 research index sits next to T045 receipt");
  if (researchT085 !== -1) {
    assert.ok(
      Math.abs(researchT086 - researchT044) < Math.abs(researchT086 - researchT085),
      "T086 closer to T044 than to T085 markdown",
    );
  }
  if (researchT084 !== -1) {
    assert.ok(
      Math.abs(researchT086 - researchT044) < Math.abs(researchT086 - researchT084),
      "T086 closer to T044 than to T084 New-chat",
    );
  }
});

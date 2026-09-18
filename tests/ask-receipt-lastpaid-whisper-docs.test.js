// T087 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T087 Ask receipt / lastPaidReceipt whisper brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T087",
    "T045",
    "#496",
    "T045-receipt-collapse.md",
    "ASK-QUIET-SHELL-V3.md",
    "lastPaidReceipt",
    "job_id",
    "#ask-receipt",
    "honestyFieldsFrom",
  ]) {
    assert.ok(text.includes(needle), `receipt whisper brief should include ${needle}`);
  }
  assert.ok(/when.*#ask-receipt.*Job|shows Job id|Job whisper/i.test(text), "name when #ask-receipt shows Job id");
  assert.ok(/never a capacity dash|Never a capacity dash/i.test(text), "never a capacity dash");
  assert.ok(/capacity dash|capacity dashboard/i.test(text), "name capacity dash ban");
  assert.ok(/expand-only|only on\nexpand|expanded/i.test(text), "Job is expand-only");
  assert.ok(/Job: null/.test(text), "forbid Job: null");
  assert.ok(/omit/i.test(text), "omit Job when lastPaidReceipt has no id");
  assert.ok(/not a T045 rewrite/i.test(text), "state why not a T045 rewrite");
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
  assert.ok(text.includes("#527"), "cite T086 #527 merge separately");
  assert.ok(/merge separately/i.test(text), "T086 merges separately");
  assert.ok(text.includes("#526"), "cite T085 #526");
  assert.ok(/do not rewrite|Cite, do not rewrite/i.test(text), "T085 cited not rewritten");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/no bonsai/i.test(text), "live still no bonsai");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(/plugin\.jup\.ag/.test(text), "never plugin.jup.ag");
  assert.ok(/T072|honesty-panel|#honesty-panel/.test(text), "T072 network line is not this chip");
  assert.ok(/T074/.test(text), "cite T074 Ask vs Provide dash ban");
  assert.ok(/T046/.test(text), "cite T046 no mid-stream Job");
  assert.ok(/T044/.test(text), "cite T044 export job_id is a file field");
});

test("index rows point at T087 next to T045 receipt, not T085 markdown or T084 New-chat", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md"));
  assert.ok(research.includes("ask/T045-receipt-collapse.md"));
  assert.ok(docs.includes("T045-receipt-collapse.md") || docs.includes("research/ask/") || docs.includes("T044–T046") || docs.includes("T045"));
  const researchT087 = research.indexOf("ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md");
  const researchT045 = research.indexOf("ask/T045-receipt-collapse.md");
  const researchT085 = research.indexOf("ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md");
  const researchT084 = research.indexOf("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
  assert.ok(researchT087 !== -1 && researchT045 !== -1);
  assert.ok(Math.abs(researchT087 - researchT045) < 800, "T087 research index sits next to T045 receipt");
  if (researchT085 !== -1) {
    assert.ok(
      Math.abs(researchT087 - researchT045) < Math.abs(researchT087 - researchT085),
      "T087 closer to T045 than to T085 markdown",
    );
  }
  if (researchT084 !== -1) {
    assert.ok(
      Math.abs(researchT087 - researchT045) < Math.abs(researchT087 - researchT084),
      "T087 closer to T045 than to T084 New-chat",
    );
  }
});

// T085 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T085 Ask markdown render scope brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T085",
    "T041",
    "#ask-thread",
    "renderAskMarkdown",
    "askBlockMd",
    "askInlineBits",
    "fillAskSaid",
    "dasha-compute-ask-markdown-render-canary.test.mjs",
    "ASK-QUIET-SHELL-V3.md",
    "ASK-ARTIFACTS-LITE-2026-09-18.md",
    "ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md",
  ]) {
    assert.ok(text.includes(needle), `markdown scope brief should include ${needle}`);
  }
  assert.ok(text.includes("#269"), "cite T041 tip canary dasha-lobby #269");
  assert.ok(/T041/.test(text), "name T041");
  assert.ok(/fences/i.test(text), "name fences");
  assert.ok(/lists/i.test(text), "name lists");
  assert.ok(/links/i.test(text), "name links");
  assert.ok(/escape-only|stays plain|stay plain/i.test(text), "links stay plain / escape-only");
  assert.ok(/no invented <a>|no invented `<a>`|No invented `<a>`/.test(text), "no invented <a>");
  assert.ok(/autolink/i.test(text), "raw URLs not autolinked");
  assert.ok(/data-open/.test(text), "stream-open fence data-open");
  assert.ok(/textContent/.test(text), "user turns stay textContent");
  assert.ok(text.includes("#249"), "cite Ask v2 #249 stream-safe MD");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(text.includes("#262"), "cite Quill #262");
  assert.ok(text.includes("#266"), "cite Quill #266");
  assert.ok(text.includes("#274"), "cite Quill #274");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073 canary");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(text.includes("#525"), "cite T084 #525 merge separately");
  assert.ok(/merge separately/i.test(text), "T084 merges separately");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/no bonsai/i.test(text), "live still no bonsai");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(/plugin\.jup\.ag/.test(text), "never plugin.jup.ag");
  assert.ok(/not a T041|not a T041 rewrite/i.test(text), "state why not a T041 rewrite");
});

test("index rows point at T085 next to Artifacts-lite / T081, not New-chat or battery", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md"));
  assert.ok(research.includes("ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md"));
  assert.ok(docs.includes("ASK-ARTIFACTS-LITE-2026-09-18.md"));
  const researchT085 = research.indexOf("ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md");
  const researchArtifacts = research.indexOf("ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md");
  const researchBattery = research.indexOf("ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md");
  const researchKeys = research.indexOf("ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md");
  assert.ok(researchT085 !== -1 && researchArtifacts !== -1);
  assert.ok(Math.abs(researchT085 - researchArtifacts) < 800, "T085 research index sits next to T081 Artifacts-lite");
  if (researchBattery !== -1) {
    assert.ok(
      Math.abs(researchT085 - researchArtifacts) < Math.abs(researchT085 - researchBattery),
      "T085 closer to T081 than to T083 battery",
    );
  }
  if (researchKeys !== -1) {
    assert.ok(
      Math.abs(researchT085 - researchArtifacts) < Math.abs(researchT085 - researchKeys),
      "T085 closer to T081 than to T082 keys / T084 New-chat neighborhood",
    );
  }
});

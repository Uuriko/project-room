// T084 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T084 Ask New chat / Clear thread UX brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T084",
    "New chat",
    "Clear thread",
    "clearConversation",
    "#clear-chat",
    "ASK-QUIET-SHELL-V3.md",
    "ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md",
    "T044-quiet-export-transcript.md",
    "dasha-compute-ask-chat-ux-v2.test.mjs",
  ]) {
    assert.ok(text.includes(needle), `New chat brief should include ${needle}`);
  }
  assert.ok(text.includes("#249"), "cite dasha-lobby #249 Ask v2");
  assert.ok(/Ask v2|ask chat UX v2/i.test(text), "cite Ask v2");
  assert.ok(/A7/.test(text), "cite Ask v2 A7 New");
  assert.ok(/quiet confirm|Quiet confirm/.test(text), "quiet confirm");
  assert.ok(/New chat\?/.test(text), "confirm copy New chat?");
  assert.ok(/Clear\./.test(text), "confirm action Clear.");
  assert.ok(/Never wipe without Esc|never wipe without/i.test(text), "never wipe without Esc/cancel");
  assert.ok(/Esc/.test(text), "Esc cancels");
  assert.ok(/has-chat|turns exist|thread has turns/.test(text), "confirm if thread has turns");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(text.includes("#262"), "cite Quill #262");
  assert.ok(text.includes("#266"), "cite Quill #266");
  assert.ok(text.includes("#274"), "cite Quill #274");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073 canary");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(text.includes("#524"), "cite T083 #524 merge separately");
  assert.ok(/merge separately/i.test(text), "T083 merges separately");
  assert.ok(text.includes("T082"), "cite T082 no letter for New");
  assert.ok(/no letter/.test(text), "New has no letter");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/no bonsai/i.test(text), "live still no bonsai");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(/empty canvas/i.test(text), "no confirm on empty canvas");
  assert.ok(/window\.confirm|Not a `window.confirm/.test(text) || /not a modal/i.test(text), "no window.confirm modal");
});

test("index rows point at T084 next to T082 / quiet-shell, not battery-only", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md"));
  assert.ok(research.includes("ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-QUIET-SHELL-V3.md"));
  const researchT082 = research.indexOf("ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md");
  const researchT084 = research.indexOf("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
  const researchBattery = research.indexOf("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md");
  const researchArtifacts = research.indexOf("ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md");
  assert.ok(researchT082 !== -1 && researchT084 !== -1);
  assert.ok(Math.abs(researchT084 - researchT082) < 800, "T084 research index sits next to T082");
  if (researchBattery !== -1) {
    assert.ok(
      Math.abs(researchT084 - researchT082) < Math.abs(researchT084 - researchBattery),
      "T084 closer to T082 than to T068/T069 battery"
    );
  }
  if (researchArtifacts !== -1) {
    assert.ok(
      Math.abs(researchT084 - researchT082) < Math.abs(researchT084 - researchArtifacts),
      "T084 closer to T082 than to T081"
    );
  }
});

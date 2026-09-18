// T082 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T082 Ask Stop/Regen/Copy/Edit keyboard shortcuts brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T082",
    "Stop",
    "Regen",
    "Copy",
    "Edit",
    "keyboard",
    "ASK-QUIET-SHELL-V3.md",
    "ASK-MODEL-CMDK-SPEC-2026-09-17.md",
    "ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md",
    "ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md",
    "stopAskRun",
    "regenerateLastAsk",
    "copyAskText",
    "editLastUserAsk",
    "dasha-compute-ask-chat-ux-v2.test.mjs",
    "dasha-compute-ask-quiet-chrome-canary.test.mjs",
  ]) {
    assert.ok(text.includes(needle), `shortcuts brief should include ${needle}`);
  }
  assert.ok(text.includes("#249"), "cite dasha-lobby #249 Ask v2");
  assert.ok(/Ask v2|ask chat UX v2/i.test(text), "cite Ask v2");
  assert.ok(/§3\.4|quiet-shell/.test(text), "cite quiet-shell §3.4");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(text.includes("#262"), "cite Quill #262");
  assert.ok(text.includes("#266"), "cite Quill #266");
  assert.ok(text.includes("#274"), "cite Quill #274");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073 canary");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(text.includes("T030"), "name T030 hover canary");
  assert.ok(text.includes("#270"), "cite dasha-lobby #270 T030");
  assert.ok(text.includes("T032"), "picker keys stay T032");
  assert.ok(text.includes("T042"), "cite T042 hover Regen with…");
  assert.ok(text.includes("T043"), "cite T043 hover Continue");
  assert.ok(/not an overlap|does not name|not a T032/i.test(text), "state why not an overlap");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/empty canvas/i.test(text), "no shortcut dump on empty canvas");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(text.includes("#521"), "cite T081 #521 merge separately");
  assert.ok(/Esc/.test(text), "Esc stops while busy");
});

test("index rows point at T082 next to T042/T043, not Artifacts-lite-only", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md"));
  assert.ok(docs.includes("ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md"));
});

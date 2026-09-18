// T083 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md");
const parent = join(root, "research", "ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T083 Provide soft-battery UX copy brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T083",
    "T068",
    "T069",
    "On battery · paused",
    "Low Power · paused",
    "Prefer AC.",
    "no blocking Ask",
    "ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md",
    "ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md",
  ]) {
    assert.ok(text.includes(needle), `soft-battery UX brief should include ${needle}`);
  }
  assert.ok(text.includes("#515"), "cite Room #515 T068/T069");
  assert.ok(/no lecture|No lecture/.test(text), "no lecture");
  assert.ok(/no blocking Ask|No blocking Ask|never blocked/.test(text), "no blocking Ask");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(text.includes("#262"), "cite Quill #262");
  assert.ok(text.includes("#266"), "cite Quill #266");
  assert.ok(text.includes("#274"), "cite Quill #274");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073 canary");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(text.includes("#523"), "cite T082 #523 merge separately");
  assert.ok(/merge separately/i.test(text), "T082 merges separately");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(/Typeform/i.test(text), "live still Typeform");
  assert.ok(/no bonsai/i.test(text), "live still no bonsai");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(/#ask-model/.test(text), "Ask model pill gets no battery chip");
  assert.ok(/T047|empty Ask/.test(text), "empty Ask stays empty");
});

test("T068/T069 parent still exists and T083 points at it", () => {
  assert.ok(existsSync(parent), "research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md");
  const parentText = readFileSync(parent, "utf8");
  assert.ok(parentText.includes("T068"));
  assert.ok(parentText.includes("T069"));
  assert.ok(parentText.includes("Prefer AC."));
  const text = readFileSync(note, "utf8");
  assert.ok(text.includes("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md"));
  assert.ok(/not a T068|not a T068 \/ T069|does \\*\\*not\\*\\* name|does not name/i.test(text) || text.includes("Why this is not a T068"), "state why not a T068/T069 rewrite");
});

test("index rows point at T083 next to T068/T069, not Artifacts-only", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md"));
  assert.ok(docs.includes("ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md"));
  assert.ok(research.includes("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md"));
  assert.ok(docs.includes("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md"));
  const researchBattery = research.indexOf("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md");
  const researchT083 = research.indexOf("ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md");
  const researchArtifacts = research.indexOf("ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md");
  assert.ok(researchBattery !== -1 && researchT083 !== -1);
  assert.ok(Math.abs(researchT083 - researchBattery) < 800, "T083 research index sits next to T068/T069");
  if (researchArtifacts !== -1) {
    assert.ok(Math.abs(researchT083 - researchBattery) < Math.abs(researchT083 - researchArtifacts), "T083 closer to T068/T069 than to T081");
  }
});

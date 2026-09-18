// T068/T069 (+ T064) no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const battery = join(root, "research", "ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md");
const idMap = join(root, "research", "ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T068/T069 battery + Prefer AC note exists", () => {
  assert.ok(existsSync(battery), "research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md");
  const text = readFileSync(battery, "utf8");
  for (const needle of [
    "T068",
    "T069",
    "pause-on-battery",
    "Prefer AC.",
    "soft",
    "advertise",
    "ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md",
    "ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md",
  ]) {
    assert.ok(text.includes(needle), `battery note should include ${needle}`);
  }
  assert.ok(text.includes("never fails solely") || text.includes("not a doctor hard-fail") || text.includes("Not a doctor hard-fail") || text.includes("not a hard-fail"), "T068 stays soft");
  assert.ok(text.includes("Prefer MLX"), "T069 hangs off the live Prefer MLX row");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not edited|not undrafted/i.test(text), "must not undraft #258");
});

test("T064 PrismML Bonsai id map exists", () => {
  assert.ok(existsSync(idMap), "research/ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md");
  const text = readFileSync(idMap, "utf8");
  for (const needle of [
    "T064",
    "ternary-bonsai-2-27b",
    "prism-ml/Ternary-Bonsai-2-27B-gguf",
    "Ternary-Bonsai-2-27B-PQ2_0.gguf",
    "prism-ml/Ternary-Bonsai-2-27B-mlx-2bit",
    "DASHA_MODEL_MAP",
  ]) {
    assert.ok(text.includes(needle), `id map should include ${needle}`);
  }
  assert.ok(!text.includes("needle-3` → Bonsai") && text.includes("Do not map"), "id map refuses Needle alias");
});

test("index rows point at T068/T069 and T064", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md"));
  assert.ok(research.includes("ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md"));
  assert.ok(docs.includes("ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md"));
  assert.ok(docs.includes("ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md"));
});

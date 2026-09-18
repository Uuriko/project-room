// Demigod / DIE matching desk docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "DEMIGOD-E2E-AUTOMATION-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("Demigod E2E automation research note exists", () => {
  assert.ok(existsSync(note), "research/DEMIGOD-E2E-AUTOMATION-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "die-packet-brief-status",
    "observe",
    "packet",
    "brief",
    "queue",
    "consent",
    "intro",
    "trial",
    "invoice",
    "send ticket",
    "both-sides intro",
    "invoice send",
    "company-OS",
    "Lightfield",
    "Now",
    "Next",
    "Later",
    "Anti-patterns",
    "people-data",
    "auto-DM",
    "salary history",
    "EOR",
    "W-2",
    "1099",
    "Shipped ≠ Measured",
    "recommend-into-queue",
    "cheap talk",
    "scorecard",
    "citations",
    "blocklist",
    "company-only",
  ]) {
    assert.ok(text.includes(needle), `E2E note should include ${needle}`);
  }
  assert.ok(
    /observe\s*→\s*packet\s*→\s*brief\s*→\s*queue\s*→\s*consent\s*→\s*intro\s*→\s*trial\s*→\s*invoice/.test(text),
    "stage machine order"
  );
  assert.ok(/Steal|steal/.test(text) && /Reject|reject/.test(text), "steal/reject table");
  assert.ok(/one Lightfield hire/i.test(text), "measure one Lightfield hire first");
  assert.ok(/blocked sends|sends stay \*\*blocked\*\*|outbound sends \*\*blocked\*\*/i.test(text), "blocked sends");
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not undraft|stays draft/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#260"), "cite Quill #260");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill");
  assert.ok(/no wrangler|No wrangler|not.*wrangler|Hands-off.*wrangler/i.test(text), "no wrangler");
  assert.ok(/dasha-lobby HTML/i.test(text), "hands-off dasha-lobby HTML");
  assert.ok(/Never Genie|never Genie/.test(text), "Second, never Genie");
  assert.ok(/Compute ≠ Room/.test(text), "Compute ≠ Room");
});

test("primary URLs are cited", () => {
  const text = readFileSync(note, "utf8");
  for (const url of [
    "https://support.greenhouse.io/hc/en-us/articles/360039539772-Structured-hiring-guide",
    "http://john-joseph-horton.com/papers/employer_search.pdf",
    "https://www.trydemigod.com/faq",
    "https://www.producttalk.org/opportunity-solution-trees/",
    "https://amplitude.com/docs/wave/opportunities",
    "https://www.ashbyhq.com/ai",
    "https://www.humanlayer.dev/blog/12-factor-agents",
    "https://docs.factory.ai/enterprise/llm-safety-and-agent-controls",
    "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=432.3.",
  ]) {
    assert.ok(text.includes(url), `should cite ${url}`);
  }
});

test("index rows sit in a Demigod / DIE matching section, not Ask-only", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("DEMIGOD-E2E-AUTOMATION-2026-09-18.md"));
  assert.ok(docs.includes("DEMIGOD-E2E-AUTOMATION-2026-09-18.md"));
  assert.match(research, /Demigod\s*\/\s*DIE matching/i);
  assert.match(docs, /Demigod\s*\/\s*DIE matching/i);
  const file = "DEMIGOD-E2E-AUTOMATION-2026-09-18.md";
  const researchDie = research.search(/Demigod\s*\/\s*DIE matching/i);
  const researchNote = research.indexOf(file);
  const researchAsk = research.indexOf("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
  assert.ok(researchDie !== -1 && researchNote !== -1);
  assert.ok(
    Math.abs(researchNote - researchDie) < 800,
    "research index row sits next to the Demigod / DIE heading"
  );
  if (researchAsk !== -1) {
    assert.ok(
      Math.abs(researchNote - researchDie) < Math.abs(researchNote - researchAsk),
      "research row closer to DIE/matching than to Ask T084"
    );
  }
  const docsDie = docs.search(/Demigod\s*\/\s*DIE matching/i);
  const docsNote = docs.indexOf(file);
  const docsAsk = docs.indexOf("ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md");
  assert.ok(docsDie !== -1 && docsNote !== -1);
  assert.ok(
    Math.abs(docsNote - docsDie) < 800,
    "docs index row sits next to the Demigod / DIE heading"
  );
  if (docsAsk !== -1) {
    assert.ok(
      Math.abs(docsNote - docsDie) < Math.abs(docsNote - docsAsk),
      "docs row closer to DIE/matching than to Ask T084"
    );
  }
});

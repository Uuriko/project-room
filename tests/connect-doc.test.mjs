import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("CONNECT.md is the single connect guide with three sections", () => {
  const doc = read("docs/CONNECT.md");
  for (const h of ["## 1. Connect", "## 2. Receive events", "## 3. Wake and pull"]) assert.ok(doc.includes(h), h);
  for (const link of ["JOINING.md", "JOIN-ANY-AGENT.md", "AGENT-QUICKSTART.md"]) assert.ok(doc.includes(link), link);
});

test("old connect guides are short redirects to CONNECT.md", () => {
  for (const [file, anchor] of [["CONNECT-AGENT-QUICKSTART.md", "#1-connect"], ["CONNECT-RECEIVE.md", "#2-receive-events"], ["CONNECT-WAKE.md", "#3-wake-and-pull"]]) {
    const doc = read(`docs/${file}`);
    assert.ok(doc.includes(`CONNECT.md${anchor}`), file);
    assert.ok(doc.split("\n").length <= 5, `${file} stays a stub`);
  }
});

test("docs index points at CONNECT.md, not the old guides", () => {
  const index = read("docs/INDEX.md");
  assert.ok(index.includes("CONNECT.md"));
  assert.ok(!/CONNECT-(AGENT-QUICKSTART|RECEIVE|WAKE)\.md/.test(index));
});

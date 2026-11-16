// The files an agent reads first must send it to the Room it was given
// (<ROOM_URL>), not to the original hosted service's address.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const HOSTED = /room\.trydemigod\.com/;

test("AGENTS.md opens with a short start-here block that uses <ROOM_URL>", () => {
  const text = read("AGENTS.md");
  const start = text.indexOf("## Start here");
  assert.ok(start > 0, "AGENTS.md lost its start-here block");
  const next = text.indexOf("\n## ", start + 4);
  const block = text.slice(start, next);
  assert.ok(block.trimEnd().split("\n").length <= 25, "start-here block must stay short");
  for (const path of ["/join.txt", "/docs/agents", "/llms.txt", "/mcp"]) {
    assert.ok(block.includes(`<ROOM_URL>${path}`), `start-here block must name <ROOM_URL>${path}`);
  }
  assert.match(block, /room_check_access/);
  assert.doesNotMatch(block, HOSTED, "start-here block must not name the hosted origin");
});

test("agent entry docs carry no hosted origin except the production-only receipt rehearsal", () => {
  assert.doesNotMatch(read("AGENTS.md"), HOSTED);
  assert.doesNotMatch(read("docs/CONNECT-AGENT-QUICKSTART.md"), HOSTED);
  assert.doesNotMatch(read("docs/JOINING.md"), HOSTED);
  const startHere = read("docs/AGENT-START-HERE.md");
  const mentions = startHere.split("\n").filter(line => HOSTED.test(line));
  for (const line of mentions) {
    assert.match(line, /production|self-hosted|public-work\/receipts\/pwr_/i, `unexpected hosted origin: ${line}`);
  }
});

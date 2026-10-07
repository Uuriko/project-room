// Lane 5 funnel hardening, item 4: one canonical skill.md for agents.
// Contract: skills/ProjectRoom/SKILL.md is THE entry point a cold agent reads
// first. It declares itself canonical, routes to exactly one next skill per
// situation (every routed path must resolve to a real file), never hard-pins
// the anonymous MCP tool count (the live tools/list wins — the catalog grows),
// and names the canonical MCP URL. Regression history: the file previously
// said "six tools" with no live-list hedge and pointed at a stale getdasha
// MCP URL, so a cold agent following it learned a frozen, wrong catalog.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = join(ROOT, "skills/ProjectRoom/SKILL.md");
const read = (p) => readFileSync(p, "utf8");

test("canonical skill.md exists and declares itself the entry point", () => {
  assert.ok(existsSync(SKILL), "skills/ProjectRoom/SKILL.md must exist");
  const md = read(SKILL);
  assert.match(md, /^---\nname: [a-z0-9-]+\n/m, "skill frontmatter with a name");
  assert.ok(/canonical/i.test(md), "must declare itself the canonical skill.md");
});

test("canonical skill routes to exactly one next skill per situation, all resolving", () => {
  const md = read(SKILL);
  const dir = dirname(SKILL);
  // Every relative skills/ path the canonical file offers must resolve.
  const links = [...md.matchAll(/`(\.\.\/[a-z0-9-]+\/SKILL\.md)`/g)].map((m) => m[1]);
  assert.ok(links.length >= 3, `expected >=3 routed skill links, got ${links.length}`);
  for (const link of links) {
    const target = resolve(dir, link);
    assert.ok(existsSync(target), `routed skill link must resolve: ${link}`);
  }
  for (const name of [
    "project-room-host-router",
    "project-room-onboarding",
    "project-room",
    "room-connector",
  ]) {
    assert.ok(
      md.includes(`../${name}/SKILL.md`),
      `canonical skill must route to ../${name}/SKILL.md`,
    );
  }
});

test("canonical skill never hard-pins the anonymous MCP tool count", () => {
  const md = read(SKILL);
  // The anonymous catalog grows (lane 1 added room_identity_mint as the 7th
  // tool); a frozen count rots. The file must hedge with the live list.
  assert.ok(!/six tools/i.test(md), "must not freeze the old six-tool count");
  assert.ok(
    /live list wins|tools\/list/i.test(md),
    "must point at the live tools/list as source of truth",
  );
});

test("canonical skill names the canonical MCP URL, not the stale one", () => {
  const md = read(SKILL);
  assert.ok(
    md.includes("https://room.trydemigod.com/mcp"),
    "must name the canonical hosted MCP URL",
  );
  assert.ok(
    !md.includes("getdasha.com/room/mcp"),
    "must not point at the stale getdasha MCP URL",
  );
});

test("canonical skill carries the 60-second curl path and the safety rules", () => {
  const md = read(SKILL);
  assert.ok(
    md.includes("POST https://room.trydemigod.com/api/agent-identities") ||
      md.includes("POST /api/agent-identities"),
    "must show the identity-mint call so a curl-capable agent needs no second file",
  );
  assert.ok(/never (post|print|paste|share).{0,40}secret/i.test(md), "secret-safety rule");
  assert.ok(/one identity|single identity|never mint a second/i.test(md), "one-identity rule");
});

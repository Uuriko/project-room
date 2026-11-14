// self-leave-docs.test.js — T-10 / R-59 (wave-3400 cohort 05, lane-07).
//
// The self-leave path exists in server code (DELETE
// /api/rooms/{roomId}/members/{memberId}, server/http.mjs
// "member-deactivate"; behaviour covered by
// tests/member-deactivate.test.js) but, at main before this change, no
// surface an agent reads named it: not the full agent packet, not the
// served skill, not the paste guide's removal section, not the repo
// skill's tool reference. P12's exit task failed twice on exactly that
// discoverability gap. These assertions pin the documentation, so the
// path cannot silently become undiscoverable again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { llmsFullTxt, skillMd } from "../server/agent-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(join(root, rel), "utf8");

const LEAVE_CALL = /DELETE \/api\/rooms\/\{roomId\}\/members\/\{memberId\}/;

test("the full agent packet names the exact self-leave call", () => {
  const packet = llmsFullTxt();
  assert.match(packet, LEAVE_CALL, "llms-full.txt must name DELETE /api/rooms/{roomId}/members/{memberId}");
  assert.match(packet, /owner_cannot_deactivate/, "packet must name the owner refusal");
  assert.match(packet, /only deactivate your own|your own membership/i, "packet must state the own-membership rule");
});

test("the served skill names the exact self-leave call", () => {
  const skill = skillMd();
  assert.match(skill, LEAVE_CALL, "SKILL.md must name DELETE /api/rooms/{roomId}/members/{memberId}");
  assert.match(skill, /owner/i, "skill must state the owner rule");
});

test("the paste guide's removal section names self-leave", () => {
  const paste = read("docs/agents/paste.md");
  const section = paste.slice(paste.indexOf("## Pause or remove an agent"));
  assert.match(section, LEAVE_CALL, "paste.md removal section must name the DELETE self-leave call");
});

test("the repo skill's tool reference names self-leave as HTTP-only", () => {
  const tools = read("skills/project-room/references/tools.md");
  assert.match(tools, LEAVE_CALL, "tools.md must name the DELETE self-leave call");
  assert.match(tools, /no MCP tool/i, "tools.md must not imply an MCP leave tool exists");
});

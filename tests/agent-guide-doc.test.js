// The agent developer guide was consolidated into docs/SWARM-PLUG-IN.md
// (Part 1: plug-in; Part 2: folded working guides). This test pins the
// canonical guide's core sections and its accurate MCP surface.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "docs", "SWARM-PLUG-IN.md");
const content = readFileSync(path, "utf8");

test("SWARM-PLUG-IN.md exists with core sections", () => {
  assert.ok(existsSync(path), "docs/SWARM-PLUG-IN.md should exist");
  for (const section of ["## Owner-linked enrollment: an alternative to shared invitations", "## The MCP tool surface",
      "### Inbox commands", "### Best practices"]) {
    assert.ok(content.includes(section), `Guide should include ${section}`);
  }
});
test("SWARM-PLUG-IN.md documents the real MCP surface", () => {
  for (const tool of ["room_read_result", "room_check_access", "room_list_work",
      "room_read_board", "room_read_work", "room_post_draft"]) {
    assert.ok(content.includes(tool), `Guide should document real tool ${tool}`);
  }
  for (const bit of ["`read`", "`act`", "`emit_receipt`", "`invite_member`"]) {
    assert.ok(content.includes(bit), `Guide should document capability bit ${bit}`);
  }
  for (const wrong of ["room.read", "room.post", "work.list", "work.create", "work.update",
      "`chat` —", "`work` —", "/work create", "/poll "]) {
    assert.ok(!content.includes(wrong), `Guide must not contain wrong claim ${wrong}`);
  }
});

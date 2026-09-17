// O003: agent developer guide exists with expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("AGENT-DEVELOPER-GUIDE.md exists with core sections", () => {
  const path = join(root, "docs", "AGENT-DEVELOPER-GUIDE.md");
  assert.ok(existsSync(path), "docs/AGENT-DEVELOPER-GUIDE.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## Enrollment", "## MCP Interface", "## Inbox Commands",
      "## Best Practices"]) {
    assert.ok(content.includes(section), `Guide should include ${section}`);
  }
});
test("AGENT-DEVELOPER-GUIDE.md documents the real MCP surface", () => {
  const path = join(root, "docs", "AGENT-DEVELOPER-GUIDE.md");
  const content = readFileSync(path, "utf8");
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

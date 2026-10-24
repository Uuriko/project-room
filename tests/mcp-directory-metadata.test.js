// Directory requirements (Claude connector directory, ChatGPT apps): every
// tool on /mcp and /mcp/chatgpt has a title, explicit readOnlyHint and
// destructiveHint, and a name of 64 characters or fewer.
import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools, livePublicMcpTools } from "../server/mcp-discovery.mjs";
import { chatgptAppTools } from "../server/chatgpt-app.mjs";

test("every listed tool has a title, read-only and destructive hints, and a short name", () => {
  const lists = [
    ...["core", "lean", "full"].map(profile => listedMcpTools(profile)),
    listedMcpTools("core", false, { memberships: [] }),
    livePublicMcpTools(),
    chatgptAppTools(),
  ];
  for (const tool of lists.flat()) {
    assert.ok(typeof tool.title === "string" && tool.title.length > 0, `${tool.name} title`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.ok(tool.name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(tool.name), `${tool.name} name`);
  }
});

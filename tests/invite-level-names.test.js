// Invite levels: Member is the default and Owner the full level (#5384).
// Docs, schemas and errors name those; the older chat/contribute/review/
// collaborate names stay accepted as aliases with unchanged permissions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

import { execFileSync } from "node:child_process";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import { agentAccessProfiles } from "../server/agent-connections.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-levels-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}
const mint = (origin, ownerKey, body) => fetch(`${origin}/api/rooms/commons/agent-invites`, { method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` }, body: JSON.stringify(body) })
  .then(async res => ({ status: res.status, json: await res.json() }));

test("a bad profile names the canonical levels", async t => {
  const { origin, ownerKey } = await serve(t);
  const bad = await mint(origin, ownerKey, { profile: "editor" });
  assert.equal(bad.status, 422);
  assert.match(bad.json.error.message, /^profile must be member \(the default\), guest, or owner/);
});

test("old profile names are still accepted, with the same permissions", async t => {
  const { origin, ownerKey } = await serve(t);
  for (const profile of ["chat", "contribute", "review", "collaborate", "member", "guest"]) {
    const created = await mint(origin, ownerKey, { profile });
    assert.equal(created.status, 201, `${profile}: ${JSON.stringify(created.json)}`);
  }
  assert.deepEqual(agentAccessProfiles.collaborate, ["steer", "accept_work", "complete_work", "verify"]);
  assert.deepEqual(agentAccessProfiles.contribute, ["accept_work", "complete_work"]);
});

test("the MCP invite tool accepts the canonical levels and the aliases", () => {
  const tool = hostedMcpToolDefs.find(def => def.name === "room_create_agent_invite");
  const profile = (tool.inputSchema ?? tool.input_schema ?? tool.schema).properties.profile;
  for (const name of ["member", "guest", "owner", "chat", "contribute", "review", "collaborate"]) assert.ok(profile.enum.includes(name), name);
  assert.match(tool.description, /member, the default/);
});

test("docs and errors stop listing only the old names", () => {
  let hits = "";
  try { hits = execFileSync("git", ["grep", "-l", "-e", "chat|contribute|review|collaborate", "-e", "needs a contribute, review, or collaborate",
    "--", "server", "src", "client", "scripts", "skills", "plugins", "spec", "docs/WORK-CLAIMS.md", "docs/SWARM-PLUG-IN.md", "docs/openapi.yaml"],
    { encoding: "utf8", cwd: join(import.meta.dirname, "..") }).trim(); }
  catch (error) { if (error.status !== 1) throw error; } // 1 = no match
  assert.equal(hits, "");
});

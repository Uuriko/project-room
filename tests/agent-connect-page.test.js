// GET /a/<code> is the agent-readable invite. The contract is the HTTP page:
// agents receive markdown they can follow, browsers receive a short HTML
// handoff, and a dead code answers with one line that does not say whether
// a room exists. Redeem keeps the chosen display name and adds connect steps.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { connectFields } from "../server/routes/agent-connect.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-connect-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function send(origin, path, { method = "GET", token, headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* page or plain text */ }
  return { status: res.status, text, json, headers: res.headers };
}

function parseCurl(command) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(command))) tokens.push(match[1] ?? match[2] ?? match[3]);
  let method = "GET";
  const headers = {};
  let data = null;
  let url = null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-sS" || token === "-s") continue;
    if (token === "-X") { method = tokens[++i]; continue; }
    if (token === "-H") {
      const header = tokens[++i];
      const split = header.indexOf(":");
      headers[header.slice(0, split).trim()] = header.slice(split + 1).trim();
      continue;
    }
    if (token === "-d") { data = tokens[++i]; continue; }
    if (token === "-A") { i++; continue; }
    if (!token.startsWith("-")) url = token;
  }
  return { method, url, headers, data };
}

function curlsIn(markdown) {
  return markdown.split("\n").filter(line => line.trimStart().startsWith("curl ")).map(line => parseCurl(line.trim()));
}

test("agents get a short markdown invite and browsers get the handoff page", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await send(origin, "/api/rooms/commons/agent-invites", {
    method: "POST", token: ownerKey, body: { profile: "contribute", expiresInMinutes: 30 },
  });
  assert.equal(minted.status, 201, minted.text);
  const code = minted.json.code;
  const agent = await send(origin, `/a/${code}`, { headers: { Accept: "*/*" } });
  assert.equal(agent.status, 200, agent.text);
  assert.match(agent.headers.get("content-type"), /^text\/markdown/);
  assert.ok(agent.text.length <= 3072, `markdown is ${agent.text.length} bytes`);
  assert.match(agent.text, /You've been invited to a Project Room as an agent\./);
  assert.match(agent.text, /Project Room Commons/);
  assert.match(agent.text, /A shared place to hang out, think, and make things together\./);
  assert.match(agent.text, /You can take tasks\./);
  assert.match(agent.text, /expires in \d+ minutes/);
  assert.equal(agent.text.includes("Room owner"), false);
  assert.equal(agent.text.includes("pri_"), false);
  assert.equal(agent.text.includes("rak_"), false);
  assert.ok(agent.text.includes(connectFields(origin).claude));
  assert.equal(agent.text.includes("room_orient"), false);
  const browser = await send(origin, `/a/${code}`, { headers: { Accept: "text/html" } });
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get("content-type"), /^text\/html/);
  assert.match(browser.text, /This link is for your AI agent\. Paste it into Claude Code, Codex, Cursor or any agent with web access\./);
  assert.match(browser.text, /id="copy"/);
  assert.match(browser.text, /noindex/);
  assert.match(browser.headers.get("content-security-policy"), /sha256-/);
  assert.equal(browser.text.includes("pri_"), false);
  assert.equal(browser.text.includes("Room owner"), false);
  const forced = await send(origin, `/a/${code}?format=md`, { headers: { Accept: "text/html" } });
  assert.match(forced.headers.get("content-type"), /^text\/markdown/);
});

test("a redeemed agent follows the page through orient and a finished starter", { timeout: 60000 }, async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await send(origin, "/api/rooms/commons/agent-invites", {
    method: "POST", token: ownerKey, body: { profile: "contribute", expiresInMinutes: 30 },
  });
  assert.equal(minted.status, 201, minted.text);
  const opened = await send(origin, "/api/rooms/commons/work-claims", {
    method: "POST", token: ownerKey, body: { id: "starter", title: "Starter task", tags: ["starter"] },
  });
  assert.equal(opened.status, 201, opened.text);
  const proposed = await send(origin, "/api/rooms/commons/commands", {
    method: "POST", token: ownerKey,
    body: { id: randomUUID(), type: "work.proposed", data: { workItemId: "starter-item", title: "Starter task", definitionOfDone: "The starter is done", accountableMemberId: "owner" } },
  });
  assert.equal(proposed.status, 201, proposed.text);
  const page = await send(origin, `/a/${minted.json.code}`, { headers: { Accept: "*/*" } });
  assert.equal(page.status, 200, page.text);
  const steps = curlsIn(page.text);
  const redeem = steps.find(step => step.url.endsWith("/api/agent-invites/redeem"));
  assert.ok(redeem, page.text);
  let calls = 0;
  const redeemed = await fetch(redeem.url, {
    method: redeem.method,
    headers: redeem.headers,
    body: redeem.data.replace("<your name>", "Probe Agent"),
  });
  calls += 1;
  assert.equal(redeemed.status, 201);
  const joined = await redeemed.json();
  assert.match(joined.secret, /^pri_/);
  assert.equal(joined.displayName, "Probe Agent");
  assert.equal(joined.connect.mcpUrl, connectFields().mcpUrl);
  assert.equal(joined.connect.claude, connectFields().claude);
  assert.equal(JSON.stringify(joined.connect).includes(joined.secret), false);
  assert.equal(joined.starter.claimId, "starter");
  assert.equal(joined.starter.title, "Starter task");
  const listed = await send(origin, "/mcp", {
    method: "POST", token: joined.secret, body: { jsonrpc: "2.0", id: "1", method: "tools/list" },
  });
  calls += 1;
  assert.equal(listed.status, 200, listed.text);
  assert.ok(Array.isArray(listed.json.result?.tools) && listed.json.result.tools.length > 0);
  const orientCurl = steps.find(step => step.url.endsWith("/orient"));
  const oriented = await fetch(orientCurl.url, {
    headers: { authorization: orientCurl.headers.authorization.replace("$PROJECT_ROOM_SECRET", joined.secret) },
  });
  calls += 1;
  assert.equal(oriented.status, 200);
  const orient = await oriented.json();
  assert.equal(orient.member.handle, "Probe Agent");
  assert.ok(orient.work.some(item => item.title === "Starter task"));
  const board = steps.filter(step => step.url.includes("/work-claims/starter/"));
  assert.equal(board.length, 3, page.text);
  let done = null;
  for (const step of board) {
    const response = await fetch(step.url, {
      method: step.method,
      headers: { ...step.headers, authorization: step.headers.authorization.replace("$PROJECT_ROOM_SECRET", joined.secret) },
      body: step.data,
    });
    calls += 1;
    done = await response.json();
    assert.ok(response.status < 300, JSON.stringify(done));
  }
  assert.equal(done.state, "done");
  assert.ok(calls <= 6, `agent used ${calls} calls after the page`);
});

test("expired, used, and unknown invite pages say to ask for a new link", { timeout: 60000 }, async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await send(origin, "/api/rooms/commons/agent-invites", {
    method: "POST", token: ownerKey, body: { profile: "chat", expiresInMinutes: 30 },
  });
  const line = "Ask the room owner for a new link.\n";
  const unknown = await send(origin, "/a/RM-0123456789ABCDEF");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, line);
  store.db.prepare("UPDATE agent_invite_codes SET expires_at=? WHERE room_id=?").run(0, "commons");
  const expired = await send(origin, `/a/${minted.json.code}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.text, line);
  store.db.prepare("UPDATE agent_invite_codes SET expires_at=? WHERE room_id=?").run(Date.now() + 60 * 60 * 1000, "commons");
  const redeemed = await send(origin, "/api/agent-invites/redeem", {
    method: "POST", body: { code: minted.json.code, displayName: "Used Agent" },
  });
  assert.equal(redeemed.status, 201, redeemed.text);
  const used = await send(origin, `/a/${minted.json.code}`);
  assert.equal(used.status, 410);
  assert.equal(used.text, line);
});

test("the invite page allows 30 reads a minute from one address", async t => {
  const { origin } = await serve(t);
  let last = null;
  for (let i = 0; i < 30; i++) last = await send(origin, "/a/not-a-code");
  assert.equal(last.status, 404);
  const blocked = await send(origin, "/a/not-a-code");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, "rate_limited");
});

test("redeem keeps the chosen display name and returns a suggestion when the guard refuses", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await send(origin, "/api/rooms/commons/agent-invites", {
    method: "POST", token: ownerKey, body: { profile: "chat", expiresInMinutes: 30 },
  });
  const refused = await send(origin, "/api/agent-invites/redeem", {
    method: "POST", body: { code: minted.json.code, displayName: "Room owner" },
  });
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.json.error.code, "display_name_unavailable");
  assert.equal(typeof refused.json.displayNameReason, "string");
  assert.ok(refused.json.displayNameReason.length > 0);
  assert.equal(typeof refused.json.displayName, "string");
  assert.notEqual(refused.json.displayName, "Room owner");
  assert.deepEqual(Object.keys(store.room("commons").state.members), ["owner"]);
  const again = await send(origin, "/api/agent-invites/redeem", {
    method: "POST", body: { code: minted.json.code, displayName: "Kept Name" },
  });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.json.displayName, "Kept Name");
  assert.equal(store.room("commons").state.members[again.json.memberId].displayName, "Kept Name");
});

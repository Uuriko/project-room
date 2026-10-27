// One link per agent invite. The create response carries the /a/<code> link,
// and /join/<code> (the link the web app shares) gives a non-browser agent
// the same plain-text steps instead of a page that needs JavaScript.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOIN_PAGE_AGENT_LINE, joinPathAgentCode } from "../server/routes/agent-connect.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-link-"));
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
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
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

async function mint(origin, ownerKey) {
  const minted = await send(origin, "/api/rooms/commons/agent-invites", {
    method: "POST", token: ownerKey, body: { profile: "contribute", expiresInMinutes: 30 },
  });
  assert.equal(minted.status, 201, minted.text);
  return minted.json;
}

test("creating an invite returns the one link to send", async t => {
  const { origin, ownerKey } = await serve(t);
  const created = await mint(origin, ownerKey);
  assert.equal(created.url, `${origin}/a/${created.code}`);
  assert.deepEqual(created.next.map(n => n.action), ["share-code", "preview-invite", "list-invites"]);
  assert.equal(created.next[0].url, created.url);
  assert.ok(created.next[0].description.startsWith(`Send the invitee this link: ${created.url}`));
  const page = await send(origin, new URL(created.url).pathname, { headers: { Accept: "*/*" } });
  assert.equal(page.status, 200, page.text);
  assert.match(page.headers.get("content-type"), /^text\/markdown/);
});

test("/join/<code> gives a non-browser agent the invite steps", async t => {
  const { origin, ownerKey } = await serve(t);
  const { code } = await mint(origin, ownerKey);
  const direct = await send(origin, `/a/${code}`, { headers: { Accept: "*/*" } });
  for (const path of [`/join/${code}`, `/room/join/${code}`]) {
    for (const accept of ["*/*", "text/markdown", "text/plain"]) {
      const agent = await send(origin, path, { headers: { Accept: accept } });
      assert.equal(agent.status, 200, `${path} ${accept}: ${agent.text}`);
      assert.match(agent.headers.get("content-type"), /^text\/markdown/, `${path} ${accept}`);
      assert.equal(agent.text, direct.text, `${path} ${accept} matches /a/`);
    }
  }
});

test("/join/<code> in a browser keeps the join page and points agents at /a/", async t => {
  const { origin, ownerKey } = await serve(t);
  const { code } = await mint(origin, ownerKey);
  const browser = await send(origin, `/join/${code}`, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get("content-type"), /^text\/html/);
  assert.ok(browser.text.includes(`<code>/a/${code}</code>`), "agent line names this invite's /a/ page");
  assert.ok(browser.text.indexOf(`/a/${code}`) < browser.text.indexOf("/llms.txt"), "/a/ comes before the packet");
  const dead = await send(origin, "/join/RM-ZZZZ9999", { headers: { Accept: "text/html" } });
  assert.ok(dead.text.includes(JOIN_PAGE_AGENT_LINE) && !dead.text.includes("/a/RM-"), "a dead code keeps the generic line");
  const plain = await send(origin, "/join", { headers: { Accept: "text/html" } });
  assert.ok(plain.text.includes(JOIN_PAGE_AGENT_LINE), "/join with no code keeps the packet line");
});

test("only agent invite codes are rerouted; other /join paths stay the page", async t => {
  const { origin } = await serve(t);
  assert.equal(joinPathAgentCode("/join/not-a-code"), null);
  assert.equal(joinPathAgentCode("/join/RM-ABCD1234"), "RM-ABCD1234");
  assert.equal(joinPathAgentCode("/room/join/RM-ABCD1234/"), "RM-ABCD1234");
  assert.equal(joinPathAgentCode("/join/%E0%A4%A"), null);
  const other = await send(origin, "/join/not-a-code", { headers: { Accept: "*/*" } });
  assert.equal(other.status, 200);
  assert.match(other.headers.get("content-type"), /^text\/html/);
  const unknown = await send(origin, "/join/RM-ZZZZ9999", { headers: { Accept: "*/*" } });
  assert.equal(unknown.status, 200, "a dead code keeps the page, whose client shows the error screen");
  assert.match(unknown.headers.get("content-type"), /^text\/html/);
  assert.ok(!/commons/.test(unknown.text), "a dead code does not say whether a room exists");
});

test("join.html still carries the agent line this route rewrites", () => {
  const page = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  assert.ok(page.includes(JOIN_PAGE_AGENT_LINE),
    "if this copy changes, update JOIN_PAGE_AGENT_LINE in server/routes/agent-connect.mjs");
});

// WAVE-500 G2 friction landing: the join guide (/about) must give an outside
// agent an entry path, not just human marketing copy.
//
// The landing hero links /about as the "Join guide" for every stranger. An
// outside agent following it used to find zero instructions addressed to
// itself — one buried sentence about "connect a supported host". John's
// 2-minute goal (find the room, start working, get empowered) needs the
// guide to name the agent entry points explicitly.
//
// Authoring gate (test-audit SKILL.md):
//  1. Contract: the about.html join guide links the three machine entry
//     points (/SKILL.md onboarding skill, /llms.txt agent packet,
//     /agents.json entry card), and each served target answers 200. This is
//     the independent guard for the outside-agent first-contact path.
//  2. Credible regression: a copy edit drops the agent section; the /SKILL.md
//     route regresses; /agents.json stops serving.
//  3. Existing coverage: landing-hero.test.mjs asserts the / hero and its
//     link targets (/about, /llms.txt) — nothing asserts about.html's
//     content, /SKILL.md, or /agents.json. docs-relative-links.test.js only
//     covers docs/*.md.
//  4. No production seam: about.html is static marketing served by the edge,
//     so its assertions read the file from disk (same as
//     docs-relative-links.test.js); the entry points are app-server routes,
//     asserted over real HTTP with the landing-hero serve() pattern.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aboutHtml = readFileSync(join(repoRoot, "about.html"), "utf8");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-about-agent-entry-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return origin;
}

test("join guide names the agent entry points", () => {
  // An agent section addressed to the agent itself, not the human operator.
  assert.ok(/ai agent/i.test(aboutHtml), "about.html speaks to AI agents directly");
  for (const href of ['href="/SKILL.md"', 'href="/llms.txt"', 'href="/agents.json"']) {
    assert.ok(aboutHtml.includes(href), `about.html links ${href}`);
  }
});

test("agent entry targets serve", async t => {
  const origin = await serve(t);
  const skill = await fetch(`${origin}/SKILL.md`);
  assert.equal(skill.status, 200, "/SKILL.md serves 200");
  assert.match(await skill.text(), /work-in-project-room/, "/SKILL.md is the onboarding skill");
  const card = await fetch(`${origin}/agents.json`);
  assert.equal(card.status, 200, "/agents.json serves 200");
  const body = await card.json();
  assert.ok(Array.isArray(body.flows) && body.flows.length > 0, "/agents.json carries flows");
});

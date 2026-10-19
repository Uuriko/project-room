import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectSkillMd, CONNECT_SKILL_PATH, CONNECT_SKILL_ROUTES, serveConnectSkill } from "../server/routes/connect-skill.mjs";
import { ROUTES, assertRouteRow } from "../server/routes/table.mjs";
import { ROOM_ORIGIN } from "../server/agent-discovery.mjs";

const openapi = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");

function fakeRes() {
  const out = { headers: {}, status: 0, body: undefined };
  return { out, setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    writeHead: (status, headers = {}) => { out.status = status; for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v; },
    end: body => { out.body = body; } };
}

test("connect skill is a GET/HEAD route-table row at the well-known path", () => {
  for (const method of ["GET", "HEAD"]) {
    const row = ROUTES.find(r => r.method === method && r.path === CONNECT_SKILL_PATH);
    assert.ok(row, `${method} row registered`);
    assert.equal(row.auth, "none");
    assertRouteRow(row);
  }
  assert.equal(CONNECT_SKILL_ROUTES.length, 2);
});

test("serves markdown on GET and headers only on HEAD", () => {
  const get = fakeRes();
  serveConnectSkill({ req: { method: "GET" }, res: get });
  assert.equal(get.out.status, 200);
  assert.match(get.out.headers["content-type"], /^text\/markdown/);
  assert.equal(get.out.body.toString(), connectSkillMd(ROOM_ORIGIN));
  assert.match(get.out.body.toString(), /^---\nname: connect-to-project-room\n/);
  const head = fakeRes();
  serveConnectSkill({ req: { method: "HEAD" }, res: head });
  assert.equal(head.out.body, undefined);
  assert.equal(head.out.headers["content-length"], get.out.body.length);
});

test("every route the skill tells an agent to call exists in the OpenAPI contract", () => {
  const body = connectSkillMd("https://room.example");
  const routes = [...body.matchAll(/(?:GET|POST) https:\/\/room\.example(\/api\/[^\s?`]+)/g)]
    .map(m => m[1].replace("<roomId>", "{roomId}"));
  assert.ok(routes.length >= 5, `found ${routes.join(", ")}`);
  for (const route of new Set(routes)) {
    assert.ok(openapi.includes(`\n  ${route}:`), `${route} is in docs/openapi.yaml`);
  }
});

test("skill never carries a credential and states the listening bar", () => {
  const body = connectSkillMd(ROOM_ORIGIN);
  assert.doesNotMatch(body, /\b(pri|rak|oat|rat)_[A-Za-z0-9_-]{8,}/);
  assert.match(body, /Never print it/);
  assert.match(body, /Connected, not listening/);
  assert.ok(Buffer.byteLength(body) < 6000, "stays short enough to read in one fetch");
});

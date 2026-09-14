import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeDocsDrift, templateKey } from "../scripts/route-docs-check.mjs";

// Re-audit 2026-09-14, M4: docs/openapi.yaml describes every /api route
// template server/http.mjs serves. The npm run check gate runs the same
// comparison; these tests pin its two failure directions and the template
// normalisation so the gate itself cannot silently go blind.
const http = readFileSync("server/http.mjs", "utf8");
const openapi = readFileSync("docs/openapi.yaml", "utf8");

test("parameter spellings compare equal", () => {
  assert.equal(templateKey("/api/rooms/{roomId}/messages/{messageId}/thread"), "/api/rooms/{}/messages/{}/thread");
  assert.equal(templateKey("/api/rooms/{id}/agent-invites"), templateKey("/api/rooms/{roomId}/agent-invites"));
  assert.equal(templateKey("/api/rooms/:roomId"), templateKey("/api/rooms/{roomId}"));
});

test("the served route templates and the documented paths agree", () => {
  const result = routeDocsDrift({ http, openapi });
  assert.deepEqual(result.failures, []);
  assert.ok(result.served >= 60, `served ${result.served}`);
  assert.equal(result.documented, result.served);
});

test("a served route missing from the spec fails, naming the template", () => {
  const withRoute = http.replace('"/api/health"', '"/api/health" + "/api/not-yet-documented"');
  const { failures } = routeDocsDrift({ http: withRoute, openapi });
  assert.deepEqual(failures, ["served but not documented in docs/openapi.yaml: /api/not-yet-documented"]);
});

test("a documented path the server no longer serves fails", () => {
  const stale = openapi.replace("  /api/rooms/{roomId}/charter:\n", "  /api/rooms/{roomId}/charter-archive:\n");
  const { failures } = routeDocsDrift({ http, openapi: stale });
  assert.deepEqual(failures, [
    "served but not documented in docs/openapi.yaml: /api/rooms/{id}/charter",
    "documented in docs/openapi.yaml but not served by server/http.mjs: /api/rooms/{roomId}/charter-archive",
  ]);
});

test("account routes must declare their scheme instead of inheriting the room default", () => {
  const inherited = openapi.replace("  /api/account-rooms:\n    get:\n      summary: Rooms the signed-in account belongs to\n      description: >-\n        Account-session read (`account_session` cookie plus\n        `X-Session-Binding`). Lists up to 50 rooms the account has an active\n        membership in, with `nextCursor` for the next page (`?after=<roomId>`).\n        Rooms the account can no longer open are skipped, not disclosed.\n      security:\n        - accountSession: []\n",
    "  /api/account-rooms:\n    get:\n      summary: Rooms the signed-in account belongs to\n");
  assert.notEqual(inherited, openapi, "fixture edit applied");
  const { failures } = routeDocsDrift({ http, openapi: inherited });
  assert.deepEqual(failures, ["GET /api/account-rooms inherits the room-credential default; account routes must declare accountSession or security: []"]);
});

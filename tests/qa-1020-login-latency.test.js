// QA 2026-10-20: post-login connect latency. Three serial waits were removed:
// the workspace module waterfall (now preloaded while the form is in use),
// a second GET /api/account-session after the login response, and the room
// list refresh blocking the first room open.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountClient } from "../src/account-client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => readFileSync(join(root, path), "utf8");

function workspaceGraph() {
  const seen = new Set(), queue = ["src/app.js", "src/request-access.js"];
  const pattern = /^\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|^\s*import\s+["'](\.[^"']+)["']/gm;
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(join(root, file))) continue;
    seen.add(file);
    for (const match of read(file).matchAll(pattern)) queue.push(normalize(join(dirname(file), match[1] ?? match[2])));
  }
  return [...seen].map(file => relative("src", file)).sort();
}

test("WORKSPACE_MODULES lists exactly the workspace module graph", () => {
  const source = read("src/signin-entry.js");
  const block = source.match(/export const WORKSPACE_MODULES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "signin-entry.js declares WORKSPACE_MODULES");
  const listed = [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(listed, workspaceGraph(), "regenerate WORKSPACE_MODULES from the app.js import graph");
});

test("the sign-in entry warms the workspace modules and adopts the login view", () => {
  const source = read("src/signin-entry.js");
  assert.match(source, /link\.rel = "modulepreload"/);
  assert.match(source, /on\(\$\("#auth-signin-ui"\), "focusin", \(\) => warmWorkspaceModules\(\)\)/);
  assert.match(source, /if \(value\) warmWorkspaceModules\(\);/);
  assert.match(source, /const session = accountClient\.adopt\(signedIn\) \?\? await restore\(\);/);
});

test("AccountClient.adopt takes only a complete authenticated session view", () => {
  const client = new AccountClient({ fetcher: async () => { throw new Error("adopt must not fetch"); } });
  const view = { authenticated: true, account: { id: "acct", revision: 1, authEpoch: 0 }, csrf: "c", sessionBinding: "b", sessionRevision: 2, expiresAt: 1, authenticatedUntil: null, terms: { required: false } };
  const before = client.generation;
  assert.equal(client.adopt(view), view);
  assert.equal(client.session, view);
  assert.equal(client.generation, before + 1);
  for (const partial of [null, { ...view, authenticated: false }, { ...view, terms: undefined }, { ...view, csrf: undefined }, { ...view, sessionRevision: "2" }, { ...view, account: null }]) {
    const other = new AccountClient({ fetcher: async () => ({}) });
    assert.equal(other.adopt(partial), null);
    assert.equal(other.session, null);
  }
});

test("in-workspace sign-in confirms the session before unfencing; the room opens without waiting on the list", () => {
  const app = read("src/app.js");
  // Invitation/re-auth sign-in must not adopt: a failed account-session read keeps private state fenced.
  assert.match(app, /onSignedIn: async \(\) => \{\n    const restoration = accountClient\.restore\(\);/);
  assert.doesNotMatch(app, /accountClient\.adopt\(/);
  assert.match(app, /if \(body\?\.room\?\.id\) loadAccountRooms\(\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(app, /if \(body\?\.room\?\.id\) await loadAccountRooms\(\);/);
});

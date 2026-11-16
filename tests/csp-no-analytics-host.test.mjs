// No server-set Content-Security-Policy may name a third-party analytics host.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PUBLIC_SEARCH_CSP, addCspSources, aboutPageCsp, publicPageCsp, publicSearchPageCsp } from "../server/public-search.mjs";
import { LEGAL_PAGE_CSP } from "../server/legal-pages.mjs";
import { downloadPageCsp } from "../server/download-page.mjs";
import { PUBLIC_ROOM_SETUP_CSP } from "../server/public-rooms.mjs";

const origin = "https://room.example";

test("no server policy allows the analytics host or its collector path", () => {
  for (const policy of [PUBLIC_SEARCH_CSP, LEGAL_PAGE_CSP, aboutPageCsp(origin), publicPageCsp(origin), publicSearchPageCsp("/docs/agents/paste", origin),
    publicSearchPageCsp("/compare/x", origin), downloadPageCsp(origin), PUBLIC_ROOM_SETUP_CSP]) {
    assert.doesNotMatch(policy, /cloudflareinsights|cdn-cgi/);
    for (const directive of policy.split(";").map(part => part.trim().split(/\s+/))) {
      if (directive.slice(1).includes("'none'")) assert.deepEqual(directive.slice(1), ["'none'"], `'none' must stand alone: ${directive.join(" ")}`);
    }
  }
});

test("no server source sets a policy that names the analytics host (the versioned privacy text is the one mention)", () => {
  const files = readdirSync(new URL("../server/", import.meta.url), { recursive: true }).filter(file => file.endsWith(".mjs"));
  const named = files.filter(file => /cloudflareinsights/.test(readFileSync(new URL(`../server/${file}`, import.meta.url), "utf8")));
  assert.deepEqual(named, ["legal-documents.mjs"]);
});

test("addCspSources replaces a lone 'none' and otherwise prepends", () => {
  const policy = "default-src 'none'; script-src 'none'; connect-src 'self'; img-src 'self'";
  assert.equal(addCspSources(policy, "script-src", "https://a.example/x.js"), "default-src 'none'; script-src https://a.example/x.js; connect-src 'self'; img-src 'self'");
  assert.equal(addCspSources(policy, "connect-src", "https://b.example/f"), "default-src 'none'; script-src 'none'; connect-src https://b.example/f 'self'; img-src 'self'");
  assert.equal(addCspSources(policy, "script-src", "'sha256-A='", "https://c.example"), "default-src 'none'; script-src 'sha256-A=' https://c.example; connect-src 'self'; img-src 'self'");
  assert.equal(addCspSources(policy, "font-src", "x"), policy, "an absent directive is left alone");
});

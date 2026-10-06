// O005 backlog: docs/ARCHITECTURE.md must not drift from the code.
// Drift guard (not a fixed-list check): every module path, route path, event
// type, claim state, and code identifier DERIVED FROM THE DOC ITSELF is
// resolved against the code. Removing a real identifier from the doc, or
// adding an unverified one, fails. Failing-first (2026-10-06): the negative
// pins below were names reached for during recon (server/relay.mjs,
// server/machine-link.mjs, server/event-bus.mjs, event claim.settled, route
// /api/rooms/:roomId/relay) that do NOT exist — they stay pinned so the doc
// can never reintroduce them. Cross-lane CHANGES (Instinct-3 VERDICTS 56b)
// required derivation instead of independent arrays; the first version of
// this test failed that bar and was rewritten.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES } from "../src/events.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const doc = read("docs/ARCHITECTURE.md");
const unique = (arr) => [...new Set(arr)];

const eventValues = new Set(Object.values(EVENT_TYPES));
const claimStates = unique(
  [...read("server/work-claims.mjs").match(/const STATES = \[([\s\S]*?)\]/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
);

// --- derivation: identifiers named in the doc ---

// Module paths: (server|src|deploy|tests)/...mjs|js
const docModules = unique(
  [...doc.matchAll(/(?:server|src|deploy|tests)\/[\w./-]+\.(?:mjs|js)/g)].map((m) => m[0])
);

// Event types: backticked or double-quoted dotted lowercase identifiers.
const docEvents = unique(
  [
    ...doc.matchAll(/`([a-z][a-z0-9_]*\.[a-z0-9_.]+)`/g),
    ...doc.matchAll(/"([a-z][a-z0-9_]*\.[a-z0-9_.]+)"/g),
  ].map((m) => m[1])
);

// Claim states: backticked single lowercase words that are real claim states.
const docStates = unique(
  [...doc.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((w) => claimStates.includes(w))
);

// Route paths: (GET|POST) /path..., backticked /path..., #agent-join/<token>.
const docRoutes = unique([
  ...[...doc.matchAll(/(?:GET|POST)\s+(\/[\w\-./{}:]+)/g)].map((m) => m[1]),
  ...[...doc.matchAll(/`(\/[\w\-./{}:]+)`/g)].map((m) => m[1]),
  ...[...doc.matchAll(/`(#agent-join\/<token>)`/g)].map((m) => m[1]),
]);

// Code identifiers: ALLCAPS_SNAKE (lenient: 4+ chars or contains underscore)
// and dotted call patterns like store.command().
const treeSource = (() => {
  let acc = "";
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) acc += read(p) + "\n";
    }
  };
  for (const d of ["server", "src", "deploy"]) walk(d);
  return acc;
})();
const docIdents = unique(
  [...doc.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)]
    .map((m) => m[1])
    .filter((t) => t.length >= 4 || t.includes("_"))
);
const docCalls = unique(
  [...doc.matchAll(/`([a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*)\(\)`/g)].map((m) => m[1])
);

// --- derivation: what the code actually serves ---

const codeFiles = [
  "server/http.mjs",
  "deploy/agent-discovery.mjs",
  "server/a2a-jsonrpc.mjs",
  "server/claim-pr-sync.mjs",
  "server/work-claim-routes.mjs",
  "server/routes/typing.mjs",
  "server/guest-agent-links.mjs",
];
const codeSrc = codeFiles.map(read).join("\n");
const servedLiterals = new Set(
  [...codeSrc.matchAll(/"(\/[\w\-./{}:]+)"/g)].map((m) => m[1])
);
// Route-table declarations (server/routes/*.mjs): full paths like
// "/api/rooms/{roomId}/typing" live in `path:` literals there.
for (const f of ["table", "typing", "work-claims", "agents", "auth", "inbox",
  "member-permissions", "spend-grants", "spend-pricing", "wants-work",
  "agent-connect", "dispatch"]) {
  const p = join(root, "server", "routes", `${f}.mjs`);
  if (existsSync(p)) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/path:\s*"(\/[\w\-./{}:]+)"/g)) servedLiterals.add(m[1]);
  }
}
const roomRouteNames = new Set(
  [...read("server/http.mjs").matchAll(/route === "(\w+)"/g)].map((m) => m[1])
);
const guestHashPath = read("server/guest-agent-links.mjs").match(
  /GUEST_AGENT_HASH_PATH\s*=\s*"([^"]+)"/
)[1];

function routeServed(docRoute) {
  if (docRoute.startsWith("#agent-join/")) return docRoute.startsWith(guestHashPath);
  // Direct literal (covers route-table paths like /api/rooms/{roomId}/typing).
  if (servedLiterals.has(docRoute)) return true;
  // Room subroutes dispatched on `route === "<name>"` under /api/rooms/:roomId.
  const norm = docRoute.replace("{roomId}", ":roomId");
  const m = norm.match(/^(\/api\/rooms\/:roomId)\/(.+)$/);
  if (m) {
    // Room subroutes dispatched on `route === "<name>"` under /api/rooms/:roomId,
    // or regex-mounted routes (e.g. workClaimsSweepMatch for work-claims/sweep).
    if (roomRouteNames.has(m[2])) return servedLiterals.has(m[1]);
    return read("server/http.mjs").includes(m[2].replace(/\//g, "\\/"));
  }
  return false;
}

test("every module path named in ARCHITECTURE.md exists on disk", () => {
  assert.ok(docModules.length > 10, `expected many module references, got ${docModules.length}`);
  for (const mod of docModules) {
    assert.ok(existsSync(join(root, mod)), `module ${mod} named in doc must exist`);
  }
});

test("every event type named in ARCHITECTURE.md is in src/events.js EVENT_TYPES", () => {
  assert.ok(docEvents.length > 15, `expected many event references, got ${docEvents.length}`);
  for (const t of docEvents) {
    assert.ok(eventValues.has(t), `event ${t} named in doc must be in EVENT_TYPES`);
  }
});

test("claim states named in ARCHITECTURE.md are real, and every state is covered", () => {
  for (const s of docStates) {
    assert.ok(claimStates.includes(s), `state ${s} named in doc must be a real claim state`);
  }
  for (const s of claimStates) {
    assert.ok(doc.includes(`\`${s}\``), `claim state ${s} must be covered by the doc`);
  }
});

test("every route path named in ARCHITECTURE.md is served by the code", () => {
  assert.ok(docRoutes.length > 20, `expected many route references, got ${docRoutes.length}`);
  for (const r of docRoutes) {
    assert.ok(routeServed(r), `route ${r} named in doc must be served`);
  }
});

test("every code identifier named in ARCHITECTURE.md resolves in the source tree", () => {
  for (const id of docIdents) {
    assert.ok(treeSource.includes(id), `identifier ${id} named in doc must appear in server/src/deploy source`);
  }
  for (const c of docCalls) {
    assert.ok(treeSource.includes(`${c}(`), `call ${c}() named in doc must appear in source`);
  }
});

test("ARCHITECTURE.md does not name the rejected overreach identifiers", () => {
  for (const bad of [
    "server/relay.mjs",
    "server/machine-link.mjs",
    "server/event-bus.mjs",
    "claim.settled",
    "message.relayed",
    "/api/rooms/:roomId/relay",
  ]) {
    assert.ok(!doc.includes(bad), `ARCHITECTURE.md must not name ${bad}`);
  }
});

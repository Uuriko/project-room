// Conformance census for #3676 (idempotency replay matrix) + #3677
// (mutation-walk property test) — PR-0 of the harness family.
//
// One pass over the three inventory sources whose disagreement is the
// finding, plus the MCP catalog snapshot:
//
//   1. the declarative route table (server/routes/*.mjs, via table.mjs)
//   2. the legacy dispatch chain (server/http.mjs + sibling route modules,
//      extracted by scripts/routes-inventory.mjs, the same extractor the
//      route-contract census uses)
//   3. the served contract (docs/openapi.yaml operations)
//   4. MCP tools (tests/fixtures/mcp-catalog.snapshot.json, the pinned
//      catalog; annotations carry readOnlyHint / idempotentHint)
//
// Emits ONE JSON inventory. Every row carries BOTH issues' columns:
//
//   idempotency (#3676, PREP-3676-3677 §A.3):
//     { method, path/tool, module, keyPlacement, scopeDerivation,
//       actorBinding, journalStore, runOnceClass, moneyFlag, existingTest }
//   walk (#3677, §B.1):
//     { surface, module, cursorShape, scopeBinding, capBehaviour,
//       ackSemantics, signer }
//
// Columns that cannot be derived mechanically are recorded as
// "undeclared" — that value IS the census finding (scope derivation is
// hand-derived per surface today); the census never guesses a value it
// cannot point at source text for. File-level facts (which server module
// mentions an idempotency-key surface, imports run-once, mentions
// nextCursor, defines cursor encode/decode, imports read-cursor) are
// emitted alongside the rows so later harnesses (PR-1 / PR-2) can refine
// a row without re-running a grep census by hand.
//
// Usage:
//   node scripts/conformance-census.mjs                 -> summary (stdout)
//   node scripts/conformance-census.mjs --json <file>   -> write inventory
//
// The registry test (tests/conformance-registry.test.js) builds the
// inventory live and asserts completeness only: a surface missing from
// the inventory fails the test. Behavioural conformance is PR-1 / PR-2.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { extractLegacyRoutes, loadRouteSources, templateKey } from "./routes-inventory.mjs";
import { openapiOperations } from "./open-routes.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { UNIFY_R_STREAMS } from "../server/read-cursor.mjs";

export const MUTATING_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);
const mutating = method => MUTATING_METHODS.includes(method);

const KEY_HEADER = /Idempotency-Key/;
const KEY_BODY = /idempotencyKey|idempotency_key/;
const KEY_REQUEST_ID = /requestId|request_id/;
const MONEY = /bounty|escrow|spend|payment|charge|signoff|sign-off|payout|grant/i;

// ---------------------------------------------------------------------------
// Source-text facts

function listServerFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) out.push(relative(root, full));
    }
  };
  walk(join(root, "server"));
  return out.sort();
}

export function serverFileFacts(root) {
  return listServerFiles(root).map(path => {
    const text = readFileSync(join(root, path), "utf8");
    return {
      module: path,
      mentionsIdempotency: /idempot/i.test(text),
      mentionsKeySurface: KEY_HEADER.test(text) || KEY_BODY.test(text),
      mentionsRequestId: KEY_REQUEST_ID.test(text),
      // A real import statement only — comment mentions of run-once.mjs
      // (writer-fence.mjs registers its table in a comment) are not adoption.
      importsRunOnce: /import\s+[^;]*?from\s+["'][^"']*run-once\.mjs["']/.test(text),
      mentionsRequestReplays: /request_replays/.test(text),
      mentionsNextCursor: /nextCursor/.test(text),
      definesCursorCodec: /function\s+(?:encode|decode)Cursor|const\s+(?:encode|decode)Cursor/.test(text),
      importsReadCursor: /read-cursor\.mjs/.test(text),
    };
  });
}

function testCorpus(root) {
  const dir = join(root, "tests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".test.js"))
    .map(name => ({ file: `tests/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

function findExistingTest(corpus, needles) {
  for (const needle of needles) {
    if (!needle || needle.length < 5) continue;
    const hit = corpus.find(entry => entry.text.includes(needle));
    if (hit) return hit.file;
  }
  return null;
}

function keyPlacementOf(text) {
  if (!text) return "none-declared";
  const placements = [];
  if (KEY_HEADER.test(text)) placements.push("header:Idempotency-Key");
  if (KEY_BODY.test(text)) placements.push("body:idempotencyKey");
  if (KEY_REQUEST_ID.test(text)) placements.push("body:requestId");
  return placements.length ? placements.join("+") : "none-declared";
}

// Map route-table row id -> the routes/*.mjs module that defines it, by
// importing each routes module and collecting its exported row arrays.
async function routeModuleById(root) {
  const byId = new Map();
  const dir = join(root, "server", "routes");
  for (const name of readdirSync(dir).filter(n => n.endsWith(".mjs") && n !== "table.mjs" && n !== "dispatch.mjs")) {
    let mod;
    try { mod = await import(join(dir, name)); } catch { continue; }
    for (const value of Object.values(mod)) {
      if (!Array.isArray(value)) continue;
      for (const row of value) {
        if (row && typeof row === "object" && typeof row.id === "string" && typeof row.method === "string" && typeof row.path === "string") {
          if (!byId.has(row.id)) byId.set(row.id, `server/routes/${name}`);
        }
      }
    }
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Inventory

export async function buildConformanceInventory(root) {
  const facts = serverFileFacts(root);
  const factByModule = new Map(facts.map(f => [f.module, f]));
  const corpus = testCorpus(root);
  const moduleText = path => {
    try { return readFileSync(join(root, path), "utf8"); } catch { return ""; }
  };

  const rows = new Map();
  const rowKey = (kind, method, pathOrName) => kind === "mcp-tool" ? `mcp:${pathOrName}` : `${method} ${templateKey(pathOrName)}`;
  const blankWalk = () => ({
    cursorShape: "none-declared", scopeBinding: "undeclared",
    capBehaviour: "undeclared", ackSemantics: "undeclared", signer: "none-declared",
  });
  const blankIdem = () => ({
    keyPlacement: "none-declared", scopeDerivation: "undeclared",
    actorBinding: "undeclared", journalStore: "undeclared",
    runOnceClass: "none", moneyFlag: false, existingTest: null,
  });
  const ensure = (kind, method, pathOrName, source) => {
    const key = rowKey(kind, method, pathOrName);
    if (!rows.has(key)) {
      rows.set(key, {
        surface: kind === "mcp-tool" ? `mcp:${pathOrName}` : `${method} ${pathOrName}`,
        kind, method: kind === "mcp-tool" ? null : method,
        path: kind === "mcp-tool" ? null : pathOrName,
        tool: kind === "mcp-tool" ? pathOrName : null,
        routeId: null, module: null, sources: [],
        mutating: kind === "mcp-tool" ? null : mutating(method),
        idempotency: blankIdem(), walk: blankWalk(),
      });
    }
    const row = rows.get(key);
    if (!row.sources.includes(source)) row.sources.push(source);
    return row;
  };

  // Source 1: route table.
  const moduleById = await routeModuleById(root);
  for (const route of ROUTES) {
    const row = ensure("http", route.method, route.path, "route-table");
    row.routeId = route.id;
    row.module = moduleById.get(route.id) ?? "server/routes/table.mjs";
    row.idempotency.actorBinding = route.auth ?? "undeclared";
    row.walk.scopeBinding = route.scope ?? "undeclared";
  }

  // Source 2: legacy dispatch.
  const legacy = extractLegacyRoutes(loadRouteSources(root));
  for (const route of legacy) ensure("http", route.method, route.path, "legacy-http");

  // Source 3: served contract.
  const docOps = openapiOperations(readFileSync(join(root, "docs", "openapi.yaml"), "utf8"));
  for (const op of docOps) {
    const row = ensure("http", op.method, op.path, "openapi");
    if (row.idempotency.actorBinding === "undeclared") {
      row.idempotency.actorBinding = op.security === null ? "inherit" : op.security.length === 0 ? "open" : op.security.join("+");
    }
  }

  // Source 4: MCP tools from the pinned catalog snapshot (union of profiles).
  const snapshot = JSON.parse(readFileSync(join(root, "tests", "fixtures", "mcp-catalog.snapshot.json"), "utf8"));
  const mcpAnnotations = new Map();
  for (const profile of Object.values(snapshot)) {
    for (const [name, entry] of Object.entries(profile)) {
      if (!mcpAnnotations.has(name)) mcpAnnotations.set(name, entry.annotations ?? null);
    }
  }
  for (const [name, annotations] of mcpAnnotations) {
    const row = ensure("mcp-tool", null, name, "mcp-catalog");
    row.mutating = annotations ? annotations.readOnlyHint === false : null;
    row.module = null;
    row.idempotency.keyPlacement = "none-declared";
    row.idempotency.runOnceClass = "none";
    if (annotations && annotations.idempotentHint === false) row.idempotency.scopeDerivation = "undeclared";
    row.mcpAnnotations = annotations;
  }

  // UNIFY-R streams (#3677 foundation rows; flag-gated, see read-cursor.mjs).
  for (const stream of UNIFY_R_STREAMS) {
    const row = ensure("stream", null, stream, "read-cursor");
    row.surface = `stream:${stream}`;
    row.kind = "stream";
    row.tool = null; row.path = null; row.method = null; row.mutating = false;
    row.module = "server/read-cursor.mjs";
    row.walk = {
      cursorShape: "scalar-seq", scopeBinding: "room+member+stream+thread (cursorKey)",
      capBehaviour: "n/a — no page cap at this layer", ackSemantics: "explicit-ack advance-only MAX",
      signer: "none-declared",
    };
  }

  // Per-row derivation from the defining module's source text (HTTP rows).
  for (const row of rows.values()) {
    if (row.kind !== "http") continue;
    if (!row.module) row.module = row.sources.includes("legacy-http") ? "server/http.mjs" : null;
    const text = row.module ? moduleText(row.module) : "";
    const fact = row.module ? factByModule.get(row.module) : null;
    row.idempotency.keyPlacement = keyPlacementOf(text);
    row.idempotency.runOnceClass = fact?.importsRunOnce
      ? "adopter-executeOnce"
      : row.idempotency.keyPlacement !== "none-declared" ? "hand-rolled" : "none";
    row.idempotency.journalStore = fact?.mentionsRequestReplays ? "request_replays" : "undeclared";
    row.idempotency.scopeDerivation = row.idempotency.runOnceClass === "adopter-executeOnce"
      ? "runOnce(scope, requestId)" : "undeclared";
    row.idempotency.moneyFlag = MONEY.test(`${row.path} ${row.routeId ?? ""} ${row.module ?? ""}`);
    // existingTest lookup is O(corpus) per needle; run it only where a
    // hit is plausible and load-bearing (table rows carry stable ids).
    row.idempotency.existingTest = row.routeId ? findExistingTest(corpus, [row.routeId, row.path]) : null;
    if (fact?.mentionsNextCursor) {
      row.walk.cursorShape = fact.definesCursorCodec ? "compound-opaque (module codec)" : "declared-in-module (nextCursor)";
      row.walk.signer = /signer|encodeCursor.*sign|signed/.test(text) ? "signed (module-declared)" : "none-declared";
    }
  }
  const walkFiles = facts.filter(f => f.mentionsNextCursor || f.definesCursorCodec || f.importsReadCursor)
    .map(f => ({
      surface: `walk-file:${f.module}`, module: f.module,
      cursorShape: f.definesCursorCodec ? "compound-opaque (encode/decodeCursor)" : "declared-in-module (nextCursor)",
      scopeBinding: "undeclared", capBehaviour: "undeclared",
      ackSemantics: f.importsReadCursor ? "explicit-ack advance-only MAX (read-cursor)" : "undeclared",
      signer: "none-declared", importsReadCursor: f.importsReadCursor, definesCursorCodec: f.definesCursorCodec,
    }));

  const sorted = [...rows.values()].sort((a, b) => a.surface.localeCompare(b.surface));
  return {
    version: 1,
    generatedBy: "scripts/conformance-census.mjs",
    issues: [3676, 3677],
    sources: {
      routeTableRows: ROUTES.length,
      legacyRoutes: legacy.length,
      openapiOperations: docOps.length,
      mcpTools: mcpAnnotations.size,
      unifyRStreams: UNIFY_R_STREAMS.length,
    },
    counts: {
      rows: sorted.length,
      httpRows: sorted.filter(r => r.kind === "http").length,
      mutatingHttpRows: sorted.filter(r => r.kind === "http" && r.mutating).length,
      mcpToolRows: sorted.filter(r => r.kind === "mcp-tool").length,
      mutatingMcpToolRows: sorted.filter(r => r.kind === "mcp-tool" && r.mutating === true).length,
      streamRows: sorted.filter(r => r.kind === "stream").length,
      walkFiles: walkFiles.length,
      runOnceAdopters: facts.filter(f => f.importsRunOnce).map(f => f.module),
      keySurfaceFiles: facts.filter(f => f.mentionsKeySurface).length,
      nextCursorFiles: facts.filter(f => f.mentionsNextCursor).length,
    },
    rows: sorted,
    walkFiles,
    serverFileFacts: facts,
  };
}

// ---------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const inventory = await buildConformanceInventory(root);
  if (process.argv.includes("--stdout-json")) {
    console.log(JSON.stringify(inventory, null, 2));
    process.exit(0);
  }
  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(`conformance-census: wrote ${inventory.counts.rows} rows to ${process.argv[jsonIdx + 1]}`);
  } else {
    console.log(JSON.stringify({ sources: inventory.sources, counts: inventory.counts }, null, 2));
  }
}

// PRODUCT-200 A6: fail-first drift guard for skills/project-room/references/errors-catalog.md.
//
// The catalog is the doc agents read when a command fails. It must name every
// error.code the server can emit (QA-200 found "Unknown error '<code>'"
// fallthroughs and codes documented nowhere). These tests re-extract the live
// emit sites from server/ and fail when:
//   1. a server-emitted code is missing from the catalog (undocumented code), or
//   2. the catalog names a code the server no longer emits (stale row), or
//   3. a pinned doc statement no longer matches live behavior.
//
// Regenerate the catalog after server error changes:
//   node ~/workspace/project-room-qa/product200-docs/skill/A6/gen-docs.mjs
// (sources: resolve-final.mjs extraction + catalog.tsv evidence).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentErrorAx, ERROR_REGISTRY, errorRegistryAx } from "../src/agent-error.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server");
const CATALOG = join(ROOT, "skills/project-room/references/errors-catalog.md");

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".mjs")) yield p;
  }
}

// Compact mirror of the extraction in resolve-final.mjs: every literal code
// handed to fail()/reject()/ServiceError/AgentPluginError, plus typed-error
// fail("code") sites. Variable-passed codes are resolved separately below.
function liveCodes() {
  const codes = new Set();
  const callRe = /(?:fail|reject)\(\s*(?:"([a-z][a-z0-9_]*)"|'([a-z][a-z0-9_]*)'|(\d{3}))\s*(?:,\s*(?:"([a-z][a-z0-9_]*)"|'([a-z][a-z0-9_]*)'|(\d{3})))?/g;
  // Match `new ServiceError(...)` in ANY context, not only `throw new ...`:
  // sites that construct the error in a variable first (then attach detail
  // and throw it later), pass it to a reject callback, or return it are live
  // emit sites too — a throw-only pattern made them invisible to this guard
  // (#2897: transfer_ownership_required, github_rate_limited, aborted).
  const svcRe = /new ServiceError\(\s*(\d{3})\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
  const apRe = /new AgentPluginError\(\s*(\d{3})\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
  const adhocRe = /error:\s*\{\s*code:\s*"([a-z][a-z0-9_]*)"/g;
  // #3658: status-first ad-hoc objects — `{ error: { status: 422, code: … } }`
  // (server/proof-page.mjs, server/public-read-model.mjs). The code-first
  // extractor above cannot see this shape, which is how invalid_proof_query
  // shipped with no catalog row and no guard failure.
  const statusFirstRe = /error:\s*\{\s*status:\s*\d{3}\s*,\s*code:\s*"([a-z][a-z0-9_]*)"/g;
  for (const f of walk(SERVER)) {
    const t = readFileSync(f, "utf8");
    const addGroups = (re, idxs) => {
      let m; re.lastIndex = 0;
      while ((m = re.exec(t))) for (const i of idxs) if (m[i]) codes.add(m[i]);
    };
    addGroups(callRe, [1, 2, 4, 5]);
    addGroups(svcRe, [2]);
    addGroups(apRe, [2]);
    addGroups(adhocRe, [1]);
    addGroups(statusFirstRe, [1]);
  }
  return codes;
}

// Codes passed via variables (not greppable as literals) — resolved by hand
// against the live definitions. If one of these definitions changes, this
// test's list must change too, which is the point.
const VARIABLE_CODES = new Map([
  ["trust_off", /TRUST_OFF_CODE = "trust_off"/],                    // src/events.js
  ["rate_limited", /limitCode = "rate_limited"/],                    // server/agent-identities.mjs default
  ["invalid_signing_input", /"invalid_signing_input"/],              // agent-plugin-routes signingCode
  ["invalid_card_signature", /"invalid_card_signature"/],
  ["invalid_password", /code: "invalid_password"/],                  // src/password-auth.mjs policy
  ["password_too_short", /code: "password_too_short"/],
  ["password_too_long", /code: "password_too_long"/],
  ["outside_agent_unlinked", /"outside_agent_unlinked"/],          // src/outside-agents.mjs planner literal (src/ is outside the server/ walk)
]);

function catalogSection() {
  const md = readFileSync(CATALOG, "utf8");
  const i = md.indexOf("## Full code index");
  assert.ok(i > 0, "catalog is missing the '## Full code index' section");
  return md.slice(i);
}

function catalogRows() {
  const md = catalogSection();
  const rows = new Map(); // code -> [{status, retry}]
  for (const m of md.matchAll(/^\| `([a-z][a-z0-9_]*)` \| (\S+) \|/gm)) {
    const code = m[1];
    if (!rows.has(code)) rows.set(code, []);
    rows.get(code).push({ status: m[2] });
  }
  return rows;
}

function catalogRetry(code) {
  const md = catalogSection();
  // Pipes inside cell text are escaped as \| (no surrounding spaces), so a
  // plain " | " split is safe.
  const line = md.split("\n").find(l => l.startsWith(`| \`${code}\` |`));
  if (!line) return null;
  const cells = line.split(" | ");
  return cells[3] ? cells[3].trim() : null;
}

test("catalog exists and is linked from the skill", () => {
  assert.ok(readFileSync(CATALOG, "utf8").length > 10000, "catalog doc is unexpectedly small");
  const skill = readFileSync(join(ROOT, "skills/project-room/SKILL.md"), "utf8");
  assert.match(skill, /references\/errors-catalog\.md/, "SKILL.md must link the catalog");
  const errors = readFileSync(join(ROOT, "skills/project-room/references/errors.md"), "utf8");
  assert.match(errors, /references\/errors-catalog\.md/, "errors.md must point at the catalog");
});

test("every server-emitted code is in the catalog", () => {
  const live = liveCodes();
  const rows = catalogRows();
  const missing = [...live].filter(c => !rows.has(c));
  assert.deepEqual(missing, [], `codes emitted by the server but missing from the catalog: ${missing.join(", ")}`);
});

test("status-first emit shapes are extracted (#3658)", () => {
  // Regression pin: these codes are emitted ONLY as status-first objects
  // (`{ error: { status: 422, code: … } }`) in server/proof-page.mjs and
  // server/public-read-model.mjs. A code-first-only extractor misses all
  // three, so they must be asserted directly against the extraction.
  const live = liveCodes();
  for (const code of ["invalid_proof_query", "invalid_receipt_query", "invalid_cursor"]) {
    assert.ok(live.has(code), `status-first code '${code}' was not extracted from server/`);
  }
});

test("ServiceError codes constructed before throwing are extracted (#2897)", () => {
  // Regression pin: these sites do NOT write `throw new ServiceError(...)`
  // in one expression — they construct the error in a variable (or hand it
  // to a reject callback) and throw/emit it separately. A throw-only
  // extractor misses all three, so they must be asserted directly against
  // the extraction, not only against the catalog.
  const live = liveCodes();
  for (const code of ["transfer_ownership_required", "github_rate_limited", "aborted"]) {
    assert.ok(live.has(code), `construct-then-throw code '${code}' was not extracted from server/`);
  }
});

test("variable-passed codes resolve to live definitions and are catalogued", () => {
  const rows = catalogRows();
  const events = readFileSync(join(ROOT, "src/events.js"), "utf8");
  const identities = readFileSync(join(SERVER, "agent-identities.mjs"), "utf8");
  const pluginRoutes = readFileSync(join(SERVER, "agent-plugin-routes.mjs"), "utf8");
  const passwordAuth = readFileSync(join(ROOT, "src/password-auth.mjs"), "utf8");
  const outsideAgents = readFileSync(join(ROOT, "src/outside-agents.mjs"), "utf8");
  const sources = { "src/events.js": events, "server/agent-identities.mjs": identities, "server/agent-plugin-routes.mjs": pluginRoutes, "src/password-auth.mjs": passwordAuth, "src/outside-agents.mjs": outsideAgents };
  for (const [code, pattern] of VARIABLE_CODES) {
    const found = Object.values(sources).some(t => pattern.test(t));
    assert.ok(found, `variable-passed code '${code}' no longer resolves to a live definition`);
    assert.ok(rows.has(code), `variable-passed code '${code}' missing from the catalog`);
  }
});

test("pinned doc statements: retry semantics match the catalog", () => {
  // already_* family: reconcile, never retry (src/agent-error.mjs).
  assert.equal(catalogRetry("already_claimed"), "no");
  assert.equal(catalogRetry("already_member"), "no");
  // 429 family: wait for Retry-After.
  assert.equal(catalogRetry("rate_limited"), "wait");
  // Operator-only gaps: do not retry the send.
  assert.equal(catalogRetry("mail_not_configured"), "no");
  // Retired surface: named recovery, no retry.
  assert.equal(catalogRetry("board_v2_retired"), "no");
  const rows = catalogRows();
  assert.ok(rows.get("board_v2_retired")?.some(r => r.status === "410"), "board_v2_retired must be documented as HTTP 410");
});

test("pinned doc statements: family recovery rules are present", () => {
  const md = readFileSync(CATALOG, "utf8");
  assert.match(md, /Keep the same command id if the earlier send was uncertain/, "input_refused family rule");
  assert.match(md, /Do not mint a new identity to fix access/, "401 family rule");
  assert.match(md, /Do not guess ids/, "404 family rule");
  assert.match(md, /errorId.*fingerprint|fingerprint.*errorId/, "5xx trace rule");
  assert.match(md, /Unknown error '<code>'/, "fallthrough explanation");
});

test("no JSON-RPC numeric code section is empty", () => {
  const md = readFileSync(CATALOG, "utf8");
  for (const code of ["-32700", "-32600", "-32601", "-32602", "-32603", "-32001", "-32003"]) {
    assert.ok(md.includes(`\`${code}\``), `JSON-RPC code ${code} missing from the catalog`);
  }
});

// #3055 recurrence guard: the catalog-presence checks above never verified
// that agentErrorAx() actually maps a code. 287 catalogued codes fell
// through to the "Unknown error '<code>' … this code has no known recovery"
// hint even though their server messages name a concrete recovery. Run the
// real agentErrorAx() over every catalogued server-emittable row — the
// audit method from #3055 — and fail if any row hits that fallthrough.
//
// Scope notes, mirroring the audit:
//   - Only rows with a numeric HTTP status reach the wire as an AX error
//     envelope; `internal` / status-0 rows are excluded, except
//     file_lease_conflict (catalogued at 0, but server/work-claim-routes.mjs
//     builds agentErrorBody({ httpStatus: 409, code: "file_lease_conflict" })
//     and returns it to the client), which is checked explicitly at 409.
//   - agent_not_registered was excluded while #3021 / PR #3044 owned it.
//     Both resolved (fix landed via PR #3026; #3044 closed as superseded),
//     and the code is registry-owned now (E4-REG) — the exclusion is
//     retired so the guard covers it like every other code.
//   - room_event_budget_low is excluded for the same structural reason
//     file_lease_conflict is checked explicitly below: its emit site
//     (server/work-claim-integrity.mjs assertBoardEventBudget) builds the
//     response body itself, carrying its own hint/next, so it never flows
//     through agentErrorAx. Its catalog row is pinned against the body's
//     hint by the #3658 test at the bottom of this file.
const AX_COVERAGE_EXCLUDED = new Set(["room_event_budget_low"]);

function catalogAxRows() {
  const rows = [];
  for (const line of catalogSection().split("\n")) {
    const m = /^\| `([a-z][a-z0-9_]*)` \| (\S+) \|/.exec(line);
    if (!m || !/^\d+$/.test(m[2]) || m[2] === "0") continue;
    // Same " | " split as catalogRetry(): pipes inside cells are escaped.
    const cells = line.split(" | ");
    rows.push({ code: m[1], httpStatus: Number(m[2]), message: cells[2] ? cells[2].trim() : "" });
  }
  return rows;
}

test("every catalogued server-emittable code has an AX recovery (#3055)", () => {
  const rows = catalogAxRows();
  assert.ok(rows.length > 800, `expected the full catalogued code set, got ${rows.length} numeric rows`);
  rows.push({ code: "file_lease_conflict", httpStatus: 409, message: "file_lease_conflict is AX-routed at 409 (see scope note above)" });
  const unmapped = [];
  for (const { code, httpStatus, message } of rows) {
    if (AX_COVERAGE_EXCLUDED.has(code)) continue;
    const ax = agentErrorAx({ httpStatus, code, message });
    if (ax.hint.startsWith("Unknown error")) unmapped.push(`${code} (${httpStatus})`);
  }
  assert.deepEqual(unmapped, [], `catalogued codes with no agentErrorAx() mapping or family coverage (Unknown fallthrough): ${unmapped.join(", ")}`);
});

// ---------------------------------------------------------------------------
// E4-REG (decision #19c): joining-path codes migrated into ERROR_REGISTRY
// (src/agent-error.mjs) are pinned in both directions — the shipped envelope
// must equal the registry resolution for the real surface inputs, and the
// catalog row must carry the registry's declared HTTP/Retry/Recovery, so
// catalog copy and shipped copy cannot diverge again for migrated codes
// (the #3246/#3249 failure shape).
// ---------------------------------------------------------------------------

function catalogRowFor(code, http) {
  for (const line of catalogSection().split("\n")) {
    const m = /^\| `([a-z][a-z0-9_]*)` \| (\S+) \|/.exec(line);
    if (!m || m[1] !== code || Number(m[2]) !== http) continue;
    const cells = line.split(" | ");
    return {
      retry: cells[3] ? cells[3].trim() : null,
      recovery: cells[4] ? cells[4].replace(/\|\s*$/, "").trim() : null,
    };
  }
  return null;
}

const nextTextOf = ax => ax.next.map(s => s.command ?? s.path ?? `tool:${s.tool}`).join(" ; ");

const REGISTRY_FIXTURES = [
  ...["invalid_archive_request", "invalid_room_id", "invalid_keep_newest", "reason_required", "dry_run_required", "read_only", "archive_not_ready"].map(code => [code, { httpStatus: ERROR_REGISTRY[code].catalog.http }, ax => {
    assert.equal(ax.reason, code);
    assert.equal(ax.status, "action_required");
    assert.doesNotMatch(ax.hint, /^Unknown error/);
    assert.match(nextTextOf(ax), /.+/);
  }]),
  ["agent_not_registered", { httpStatus: 404, message: "No host has reported for this identity yet — POST /api/agent-heartbeats first, then poll." },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/agent-heartbeats" });
      assert.match(ax.hint, /agent-heartbeats/);
    }],
  ["invalid_wake_poll", { httpStatus: 422, message: "hostId must be 1-128 chars, [A-Za-z0-9._-] — one wake waiter per host" },
    ax => {
      assert.match(ax.hint, /hostId/);
      assert.match(ax.hint, /1-128/);
    }],
  ["invalid_wake_poll", { httpStatus: 422, message: "waitMs must be 0..55000 milliseconds" },
    ax => {
      assert.match(ax.hint, /waitMs/);
      assert.match(ax.hint, /55000/);
    }],
  // #3246: the public-work surface must ship public-work guidance — the
  // concrete task read that yields the current termsVersion — never the
  // room work-claims copy or /api/session (which 401s for this bearer).
  ["stale_public_work", { httpStatus: 409, message: "Task terms changed", workItemId: "task_9" },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/public-work/tasks/task_9" });
      assert.match(ax.hint, /termsVersion/);
      assert.doesNotMatch(`${ax.hint} ${nextTextOf(ax)}`, /\/api\/session|room_read_work|workContext/);
    }],
  ["stale_public_work", { httpStatus: 409, message: "Task terms changed" },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/public-work/tasks" });
    }],
  // #3249: the advice must be mechanically executable — a named path whose
  // read discloses the recorded receipt (claim.submittedReceiptId).
  ["public_work_already_submitted", { httpStatus: 409, message: "This task already has a submitted receipt", workItemId: "task_9" },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/public-work/tasks/task_9" });
      assert.match(nextTextOf(ax), /submittedReceiptId/);
      assert.match(ax.hint, /submitted receipt/);
    }],
  ["public_work_claim_conflict", { httpStatus: 409, message: "Task already claimed by alice (lease expires 2026-10-14T00:00:00.000Z)" },
    ax => {
      assert.match(ax.hint, /alice/);
      assert.match(ax.hint, /Wait for release or lease expiry/);
    }],
  ["public_work_claim_conflict", { httpStatus: 409, message: "Task already claimed by you (lease expires 2026-10-14T00:00:00.000Z)" },
    ax => {
      assert.match(ax.hint, /Renew/);
    }],
  ["stale_public_claim", { httpStatus: 409, message: "Claim generation changed (submitted 1, current 2)" },
    ax => {
      assert.match(ax.hint, /generation 2/);
      assert.match(nextTextOf(ax), /NOT saved/);
    }],
  ["stale_public_claim", { httpStatus: 409, message: "Claim expired: the lease lapsed or the claim was released (generation 1 is no longer held)" },
    ax => {
      assert.match(ax.hint, /expired/);
    }],
  // #3381: a stale signed CARD is a freshness failure, not a stale
  // revision — the advice must teach re-signing, never workContext /
  // expectedRevision / /api/session (unreachable pre-join anyway).
  ["stale_card", { httpStatus: 422, message: "The card signature is stale; sign a fresh joinRequest" },
    ax => {
      assert.match(ax.hint, /issuedAt/);
      assert.match(nextTextOf(ax), /fresh joinRequest/);
      assert.doesNotMatch(`${ax.hint} ${nextTextOf(ax)}`, /\/api\/session|room_read_work|workContext|expectedRevision/);
    }],
  ["guest_scope_denied", { httpStatus: 403, message: "Guest members cannot perform this action" },
    ax => {
      assert.equal(ax.reason, "guest_scope_denied");
      assert.match(ax.hint, /Guest/);
      assert.match(ax.hint, /full members/);
      assert.match(nextTextOf(ax), /full membership/);
    }],
  // #3432: everyone reaching the guest-invite owner gate IS the owner (or
  // their delegate) — the advice must address the owner, name the
  // account-session remedy and the Add-agent door, and never self-loop
  // with "Ask the owner to mint".
  ["guest_invite_account_session_required", { httpStatus: 403, message: "Guest invites are managed from the room owner's signed-in account session" },
    ax => {
      assert.equal(ax.reason, "guest_invite_account_session_required");
      assert.match(ax.hint, /signed-in account session/);
      assert.match(ax.hint, /owner delegate/);
      assert.match(nextTextOf(ax), /agent-invites/);
      assert.doesNotMatch(`${ax.hint} ${nextTextOf(ax)}`, /Ask the owner to mint/);
    }],
  ["proof_required", { httpStatus: 428, message: "Identity mint proof required" },
    ax => {
      assert.match(ax.hint, /SHA-256/);
      assert.match(nextTextOf(ax), /agent-invites\/redeem/);
    }],
];

test("registry-migrated codes: shipped envelope equals the registry resolution (E4-REG)", () => {
  assert.ok(ERROR_REGISTRY && typeof ERROR_REGISTRY === "object", "ERROR_REGISTRY must be exported from src/agent-error.mjs");
  assert.ok(typeof errorRegistryAx === "function", "errorRegistryAx must be exported from src/agent-error.mjs");
  const migrated = Object.keys(ERROR_REGISTRY);
  assert.deepEqual(migrated.sort(), ["agent_not_registered", "archive_not_ready", "dry_run_required", "guest_invite_account_session_required", "guest_scope_denied", "invalid_archive_request", "invalid_keep_newest", "invalid_room_id", "invalid_wake_poll", "proof_required",
    "public_work_already_submitted", "public_work_claim_conflict", "public_work_claim_limit", "public_work_deadline_passed", "public_work_renewal_limit", "read_only", "reason_required", "referral_invites_parked", "stale_card", "stale_public_claim", "stale_public_work"],
    "the migrated set is the joining-path set; growing it is a deliberate edit here too");
  for (const [code, ctx, check] of REGISTRY_FIXTURES) {
    const shipped = agentErrorAx({ code, ...ctx });
    const registered = errorRegistryAx(code, ctx);
    assert.ok(registered, `${code} must resolve through the registry`);
    assert.deepEqual(shipped, registered, `${code}: shipped envelope diverges from the registry`);
    assert.doesNotMatch(shipped.hint, /^Unknown error/, `${code} must not hit the Unknown fallthrough`);
    check(shipped);
  }
});

test("catalog rows for registry-migrated codes match the registry declaration (E4-REG)", () => {
  for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
    assert.ok(entry.catalog, `${code}: registry entry must declare its catalog row`);
    const row = catalogRowFor(code, entry.catalog.http);
    assert.ok(row, `${code}: no catalog row at HTTP ${entry.catalog.http}`);
    assert.equal(row.retry, entry.catalog.retry, `${code}: catalog Retry cell diverges from the registry`);
    assert.equal(row.recovery, entry.catalog.recovery, `${code}: catalog Recovery cell diverges from the registry`);
  }
});

// ---------------------------------------------------------------------------
// #3658 catalog self-validation: the catalog must be well-formed on its own
// terms, not only complete. At the #3658 census, 127 rows carried a Meaning
// cell containing pasted emit-site source (the generator's extractor broke
// on multi-line / helper-mediated emit sites) and 3 rows carried HTTP `0`
// (body-builder sites whose status lives at the return site). The 2026-10-24
// regeneration re-derived every such row from live source; these tests keep
// the whole defect class from returning. There is no grandfather list: a
// fragment or status-0 row fails, full stop.
// ---------------------------------------------------------------------------

function catalogFullRows() {
  const rows = [];
  for (const line of catalogSection().split("\n")) {
    const m = /^\| `([a-z][a-z0-9_]*)` \|/.exec(line);
    if (!m) continue;
    const cells = line.split(" | ");
    rows.push({
      code: m[1],
      status: cells[1] ? cells[1].trim() : "",
      meaning: cells[2] ? cells[2].trim() : "",
      recovery: cells[4] ? cells[4].replace(/\|\s*$/, "").trim() : "",
    });
  }
  return rows;
}

// Shapes that only occur when emit-site source was pasted where a message
// belongs. Plain messages — including ${placeholder} interpolations from
// the server's own message templates — match none of these.
const SOURCE_FRAGMENT_PATTERNS = [
  /\bfail\s*\(/,
  /\breject\s*\(/,
  /new ServiceError\(/,
  /new AgentPluginError\(/,
  /\bthrow new\b/,
  /\b(?:const|let|var)\s+[\w$]+\s*=/,
  /=>/,
  /\bexport\s+(?:function|const|default)\b/,
  /\bfunction\s+[\w$]+\s*\(/,
  /;\s*\}/,
  /;;/,
  /error:\s*\{\s*code:/,
  /\bthis\.[\w$]+/,
  /\.mjs\b/,
  /^[A-Z][\w$]*Error\(\d+\)$/,
  /\bcatch\s*\(/,
];

test("catalog self-validation: HTTP cells are real statuses or internal (#3658)", () => {
  const rows = catalogFullRows();
  assert.ok(rows.length > 800, `expected the full catalogued row set, got ${rows.length} rows`);
  const isRealStatus = s => s === "internal" || (/^\d{3}$/.test(s) && Number(s) >= 100 && Number(s) <= 599);
  const invalid = rows.filter(r => !isRealStatus(r.status)).map(r => `${r.code} (HTTP cell: ${JSON.stringify(r.status)})`);
  assert.deepEqual(invalid, [], `catalog rows whose HTTP cell is not a real status or 'internal': ${invalid.join(", ")}`);
});

test("catalog self-validation: Meaning cells carry no source fragments (#3658)", () => {
  const rows = catalogFullRows();
  const bad = rows.filter(r => SOURCE_FRAGMENT_PATTERNS.some(re => re.test(r.meaning))).map(r => `${r.code}|${r.status}`);
  assert.deepEqual(bad, [], `catalog Meaning cells containing pasted source fragments (write the message the server sends, not its emit-site code): ${bad.join(", ")}`);
});

test("catalog 'no mapped recovery' markers match live agentErrorAx (#3658)", () => {
  // The census found 196 rows claiming no mapped recovery while live
  // agentErrorAx returned a named or family recovery for the code at its
  // real status+message (bad_cursor was the verified example). Re-derive:
  // no row may carry the marker when AX maps the code. Rows whose emit body
  // carries its own hint/next (AX_COVERAGE_EXCLUDED) are pinned separately.
  const stale = [];
  for (const { code, status, meaning, recovery } of catalogFullRows()) {
    if (!/no mapped recovery/.test(recovery)) continue;
    if (!/^\d{3}$/.test(status) || AX_COVERAGE_EXCLUDED.has(code)) continue;
    const ax = agentErrorAx({ httpStatus: Number(status), code, message: meaning });
    if (!ax.hint.startsWith("Unknown error")) stale.push(`${code}|${status}`);
  }
  assert.deepEqual(stale, [], `catalog rows claiming 'no mapped recovery' that live agentErrorAx actually maps: ${stale.join(", ")}`);
});

test("room_event_budget_low: catalog row matches the emit body's own hint (#3658)", () => {
  // The emit body (server/work-claim-integrity.mjs) carries hint/next
  // itself; the catalog Recovery must be that hint, and the HTTP cell the
  // status the builder assigns (409), not the 0 the old generator wrote.
  const row = catalogFullRows().find(r => r.code === "room_event_budget_low");
  assert.ok(row, "room_event_budget_low must be catalogued");
  assert.equal(row.status, "409");
  assert.equal(row.recovery, "Ask the room owner to finish or archive work here, or continue in a new room.");
  const integrity = readFileSync(join(SERVER, "work-claim-integrity.mjs"), "utf8");
  assert.match(integrity, /error\.status = 409/, "emit site must assign status 409");
  assert.match(integrity, /Ask the room owner to finish or archive work here, or continue in a new room\./, "emit body hint must match the catalogued recovery");
});

test("flagship #3055 codes name their catalogued recovery, not 'no known recovery'", () => {
  const cases = [
    // [code, httpStatus, message, hint must match]
    ["bond_proposed_by_peer", 409, 'That agent already proposed a bond to you (bondId bond_1). Answer it with bond.accept { bondId: "bond_1" } or bond.decline, then propose again.', /bond\.accept/],
    ["file_lease_conflict", 409, 'Work "w1" overlaps files leased to alice (claim_1) until 2026-10-14T00:00:00.000Z: src/a.mjs', /leased to alice/],
    ["peer_not_found", 404, "That ID cannot resolve to an available agent peer in this room. Use get_room_context to find linked room members.", /get_room_context/],
    ["invite_unavailable", 404, "No invite was issued for this code. Ask the inviter for a fresh code", /fresh code/],
    ["credential_too_old", 410, "This credential is too old; ask the owner for a new invite.", /fresh|expired/i],
    ["discussion_reset_required", 409, "Discussion changed; discard retained discussion and restart a consistent read", /Discard all retained discussion text/],
    ["cursor_stale", 409, "The list changed; start again without a cursor", /without a cursor/],
    ["ndjson_required", 415, "Use application/x-ndjson", /NDJSON/],
    ["wake_dead", 409, "This wake is dead; requeue it explicitly.", /[Rr]equeue/],
    // #3658: the census's verified wrong marker — the catalog claimed no
    // mapped recovery while AX returns the named cursor recovery.
    ["bad_cursor", 400, "cursor must be the opaque nextCursor from a prior receipts response", /nextCursor/],
  ];
  for (const [code, httpStatus, message, recovery] of cases) {
    const ax = agentErrorAx({ httpStatus, code, message });
    assert.doesNotMatch(ax.hint, /^Unknown error/, `${code} must not hit the Unknown fallthrough`);
    assert.match(ax.hint, recovery, `${code} hint must name its catalogued recovery`);
  }
});

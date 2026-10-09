## OpenAPI audit

Worktree: `/home/hatch/workspace/pr-wave400-docs-tooling` @ `c5d1c313a639faa8d8d1d89cf0fa6086cec3f8be`. Read-only audit; nothing modified in the repo. One scratch file was created and deleted during the audit (gate-run log); the only write in the worktree is this report.

### Generation & gates

- **docs/openapi.yaml is HAND-MAINTAINED, not generated.** The header comment of scripts/openapi-gen.mjs:1–15 says byte-for-byte generation from `server/routes/table.mjs` only starts "when the allowlist is empty (RT-final)"; "Until then a rewrite would fight other open pull requests that still edit the document by hand." scripts/openapi-gen.mjs is therefore a *gate*, not a generator: `openApiGateProblems()` (scripts/openapi-gen.mjs:40–62) checks (a) the document parses with `yaml` strict mode (line 33–36), (b) template-level drift via `routeDocsDrift` (line 39), (c) the legacy allowlist file is readable and consistent (lines 41–46), (d) every documented operation is a row in `server/routes/table.mjs` or the legacy allowlist at the METHOD level (lines 47, and `methodCoverageProblems` lines 33–39 — including the documented-HEAD-covered-by-served-GET carve-out), and (e) nags that generation should replace hand-editing once the legacy chain is empty (line 49).
- **Method-accuracy gate (runtime):** scripts/openapi-method-accuracy.mjs boots a scratch `RoomStore` server (lines 96–113, TMPDIR-aware scratch parent, never /tmp) and probes every operation in the spec with its documented method: 405 on the documented method = `method_mismatch` FAIL; 404-not_found on documented method + alternate method also 404-not_found = `not_served` FAIL; 404-not_found with an alternate method that doesn't 404 = `ok` (resource miss inside the handler). Enforced by tests/openapi-method-accuracy.test.js ("every documented operation is served with its documented method"), which also pins `checked === servable` so the probe can't silently shrink coverage (test lines 45–55).
- **Served-spec coverage gate:** tests/openapi-served-coverage.test.js boots a real server and diffs the SERVED document — **not** docs/openapi.yaml — against served routes. `GET /openapi.json` is generated from `DISCOVERABILITY_ROUTES` in server/discoverability.mjs:115 (a hand-maintained inventory of in-scope machine surfaces, not the full route table). Rule: every /api path in the served spec must match a served route, and every served /api route template must be in the spec OR match an exclusion prefix in scripts/openapi-served-exclusions.json with a reason; stale exclusions (matching nothing) also fail.
- **Route-docs gate (CI):** `npm run check` (scripts/check.mjs:33–38) runs `node scripts/openapi-gen.mjs --check`, which fails the build on any gate problem. The shared template set lives in scripts/route-docs-check.mjs (`servedRouteTemplates`, lines 89–124): route candidates are extracted from **four** sources — `server/http.mjs` regexes/literals, `server/agent-plugin-routes.mjs`, `server/next-actions-routes.mjs`, `cloudflare/room.mjs` worker literals — plus rows from `server/routes/table.mjs` (lines 116–119). `routeDocsDrift` (lines 127–148) fails on served-but-not-documented, documented-but-not-served, and on `/api/inbox*` or `/api/account-*` ops inheriting the room-credential default without declaring `accountSession` or `security: []` (lines 144–145). Tests/tests/route-docs-check.test.js and tests/developer-contract.test.js pin the same extraction.
- **Security-surface single source:** docs/openapi.yaml is the single source for anonymous routes: `security: []` marks open routes; scripts/open-routes.mjs `--check` (wired in scripts/check.mjs:54–56) verifies docs/ROUTE-AUTH-TABLE.md and docs/INVITE-ONLY-CHECKLIST.md §1 name every open route.

### Spot-check results (15 paths)

All 15 paths were checked against the union of legacy-allowlist rows (879, parsed from `server/http.mjs` regexes by scripts/routes-inventory.mjs) and route-table rows (115). Methods shown are exactly what the spec documents. **All 15 match with the documented method — 15/15.**

| Spec path | Method | In code? | Notes |
|---|---|---|---|
| /api/rooms/{roomId}/work-claims-read | GET | ✓ | Route table (`work-claims-read`, server/routes/work-claims.mjs:102) |
| /api/rooms/{roomId}/work-claims | GET, POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/work-claims/{claimId}/claim | POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/work-claims/{claimId}/release | POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/work-claims/{claimId}/provenance | GET | ✓ | Route table (also HEAD; server/routes/work-claims.mjs:90–92). Note: the table maps POST to the sibling `premise-invalid` path in the same row generator — spec correctly documents POST separately (see next row). |
| /api/rooms/{roomId}/work-claims/{claimId}/premise-invalid | POST | ✓ | Route table (server/routes/work-claims.mjs:93) |
| /api/public-work/match | POST | ✓ | Legacy chain |
| /api/claims/validate | POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/matchmaking/openings | POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/matchmaking/match | POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/feedback | GET, POST | ✓ | Legacy chain |
| /api/rooms/{roomId}/feedback/{feedbackId}/triage | POST | ✓ | Legacy chain |
| /api/operator/unpublish | POST | ✓ | Legacy chain |
| /api/operator/export | GET, HEAD | ✓ | Legacy chain (HEAD is served as well) |
| /api/rooms/{roomId}/operator/agents/{memberId} | GET, PUT | ✓ | Legacy chain |

Global cross-checks at this HEAD (computed, not assumed):
- `routeDocsDrift` on the live sources: **415 served templates, 415 documented templates, 0 failures** → no template-level stale entries and no template-level gaps.
- Method-level coverage (replicated `methodCoverageProblems` from scripts/openapi-gen.mjs; the module itself could not run in this worktree because the `yaml` npm package is not installed — no node_modules — and npm install was forbidden): **0 problems across 515 documented operations** → every documented operation exists in the route table or legacy allowlist with its documented method (HEAD falls back to served-GET per the gate's carve-out).

### Baseline fixture

- **What it pins:** tests/fixtures/route-permission-baseline.json (244 lines, frozen 2026-10-06 by guard-sec-route-perms) freezes the set of mutating REST operations (POST/PUT/PATCH/DELETE) in docs/openapi.yaml that predate the `x-room-permission` requirement and still declare none. tests/route-permission-declared.test.js enforces three things: (1) any mutating op that is undeclared but NOT in the baseline fails CI (new ops must declare a permission like `owner`, `member`, `accept_work`, `public`); (2) the baseline may only shrink — any entry that has since gained a declaration or disappeared from the spec fails CI until removed from the file; (3) declared permissions match `/^[a-z][a-z_]*(\|[a-z][a-z_]*)*$/` and the list stays sorted and unique.
- **Still accurate?** Yes. A block-scoped re-audit of the spec found **239 undeclared mutating operations**; the baseline contains **239 entries**; set difference in both directions is **empty** (0 added, 0 stale), and the sorted+unique check holds. No entry has gained a declaration and no undeclared operation has been added since the freeze.

### Gaps & stale entries

No STALE or GAP flags to file at this HEAD: the repo's own template gate (`routeDocsDrift`: 415 served vs 415 documented, 0 failures) and method-level coverage (515 operations, 0 problems) both pass on the extracted sources, and the 15-path spot-check matched in all areas (work-claims, matchmaking, feedback, escrow-adjacent claims, operator).

Caveats for the coordinator:
- The `yaml` npm dependency is absent in this worktree (no node_modules), so scripts/openapi-gen.mjs's full gate (strict parse-error half) could not be executed here; I replicated its method-coverage logic with the repo's own line-based extractor and got 0 problems, but the strict-YAML-parse half was not run.
- The method-accuracy test boots a live server; it was not run here (a spot-level static check stood in). Its classifier and `concrete()` seeding logic were read, not executed.

### Suspected bugs

None found in the audited slice. The one near-miss during the audit was my own picking error (I guessed POST for `/provenance` and `/operator/export` and GET for `/public-work/match` — the spec documents GET, GET/HEAD, and POST respectively, all matching the code); no doc-vs-code contradiction exists there.

DONE: 15 paths checked, 0 stale, 0 gaps, 0 suspected bugs

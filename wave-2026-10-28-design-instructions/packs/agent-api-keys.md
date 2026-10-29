# Instruction Pack — API Keys & Agent Settings (agent-api-keys)

## 1. The piece

**What it is.** Two credential surfaces that today exist only as raw APIs and environment secrets, and the settings UI that should make them a product feature:

1. **Agent API keys** — scoped `rak_` keys an agent identity issues for itself (issue / list / rotate / revoke), plus the identity-secret lifecycle they hang off (rotate / revoke an identity cascades to its keys), plus the room MCP token issued at join.
2. **Operator tokens** — the three deployment-level bearer credentials that guard the operator, export, and restore doors. Today each is a single-value master key for its whole door: no sub-scoping, no expiry, no per-holder identity, no in-app revocation. Revocation means replacing or deleting the environment secret in an operator sitting.

**PAUSE STATUS — read first.** Token-hygiene **tranche 2 (T2) is PAUSED** (FOCUS-REVIEW, §PAUSE table: "Token-hygiene tranche 2 beyond detection-first acts"). Phase A below (agent-settings surface over APIs that already ship) is **not** T2 and may start now. Phase B is T2 proper: it is written executable-at-unpause and every step in it is marked **WAIT**. Do not start a Phase B step until Jill names the unpause in a settle/slate pass. Housekeeping's parked-by-name audit graded the T2 park **UNMEASURABLE** — "a park whose trigger cannot be measured is a park forever" (`wave-2026-10-27-housekeeping/SYNTHESIS.md` §B10) — so this pack attaches a concrete unpause trigger in §4 Phase B; naming/ratifying it is Jill's act at the next slate review.

**Tree read and verified.** Source verified by `git archive aaa749065a6451321a949ddcb923f3174504fe35` (main, per BRIEF) extracted into this lane's scratch and read directly. The shared clone `~/workspace/project-room` is stale (HEAD `eb824d57…`) and was **not** used as main. Target tree for all instructions: **main `aaa749065a`**. Production (`ca37fee4` per BRIEF) is a different, older build; nothing in this pack is verified against production except where an evidence file says so. No bound PR covers this piece: a bindings search of `landing-watch-bindings.json` (259 PRs) for api-key/operator-token terms returned only #5061 (mint-refusal truthfulness — adjacent, see §4 non-goals; do not duplicate it).

**Where it lives (all paths verified at `aaa749065a`):**

| Surface | Files / routes |
|---|---|
| Key logic (pure module) | `server/agent-api-keys.mjs` (195 lines: issue/verify/rotate/revoke, hash-only storage, `API_KEY_SCOPES`, prefix-wildcard grants) |
| Key persistence | `server/agent-plugin-store.mjs` — table `agent_api_keys` (schema ~line 54, issue/list/rotate/revoke ~lines 541–607, `revokeApiKeysForIdentity` cascade) |
| Key HTTP routes | `server/agent-plugin-routes.mjs` — `POST /api/agent-keys`, `GET /api/agent-keys`, `POST /api/agent-keys/{keyId}/{rotate\|revoke}` (dispatch ~lines 1078–1079, `KEY_ACTION_ROUTE` line 118); documented at `docs/openapi.yaml` `/api/agent-keys:` (~line 11272) |
| Key CLI | `scripts/agent-inbox.mjs` — `agent-keys create\|list\|rotate\|revoke` (per OpenAPI description) |
| Identity lifecycle | `server/agent-identities.mjs` — `revoke()` ~line 1191 and secret-rotate paths (~lines 1053–1211) both call `revokeApiKeysForIdentity`; follow-up auth with a revoked secret returns 401 |
| Default join key | `server/agent-plugin-store.mjs` ~line 439 — default scope set `[mcp:room:<id>, rooms:read, rooms:write, mcp:inbox, mcp:wake, heartbeats:report, heartbeats:read]`; room MCP token text states "It expires in 30 days" (`server/agent-rooms.mjs` ~line 99) |
| Operator auth | `server/operator-auth.mjs` (54 lines: one configured SHA-256 digest, `Authorization: Operator <token>`, wrong/missing → 404, no scope, no expiry) |
| Operator routes | `server/operator-routes.mjs` — 9 routes (`/api/operator/status`, `/drift`, `/actions`, purge plan/find/execute, archive, projection plan/execute), one shared token, rate 10/min/address |
| Export / restore doors | `cloudflare/room.mjs` `splitBackupTokens(env)` (~line 103); `server/room-export.mjs`; `server/restore-ndjson.mjs` ~line 565 (per-door token, unconfigured → 404) |
| Operator console | `operator.html` + `docs/OPERATOR.md` (token pasted per tab, `sessionStorage` only, Forget button) |
| Settings UI (target) | `index.html` — `#settings-dialog` (~line 372) and `#account-settings` / "Sign-in & security" (~lines 156–158, 64). **Neither contains any API-key section today** (grep of all top-level `*.html` for `agent-api-keys`/`API key`: no UI hits) |
| Tests on file | `tests/agent-plugin-api-keys.test.js`, `tests/agent-plugin-http.test.js`, `tests/agent-plugin-manifest.test.js`, `tests/operator-ui.test.js`, `tests/operator-purge.test.js`, `tests/operator-archive*.test.js` |

## 2. Current state

**Agent keys: the server feature exists and is unusually complete — the product surface does not.** Executed/verified at source (this lane, archive read above):

- Issue is owner-only (identity `pri_` secret; a scoped `rak_` key cannot mint keys), secret shown exactly once, only its SHA-256 stored, list/verify never return it; rotate replaces the secret and clears last-used telemetry; revoke is owner-checked (unknown-or-not-yours → 404, no cross-identity oracle); issue/action rate limit 20/min/address, list 120/min/identity. Identity revoke **and** identity-secret rotate both cascade-revoke every scoped key.
- **Expiry is optional with no default and no maximum.** `agent-api-keys.mjs` `validateIssue` accepts any positive-integer `expiresAt` or none; `issue()` defaults `expiresAt = null` (never expires). A careless caller mints a permanent key by doing nothing.
- **The scope vocabulary is split, and issuance is permissive.** `API_KEY_SCOPES` in `agent-api-keys.mjs` lists only 5 plug-in scopes (`directory:publish`, `webhooks:manage`, `heartbeats:report`, `heartbeats:read`, `skills:publish`), but enforcement elsewhere also honours `rooms:read` / `rooms:write` (room HTTP routes, `server/http.mjs` ~line 4109), `mcp:inbox`, `mcp:wake`, `mcp:room:<id>` (OpenAPI `/api/agent-keys` description; `agent-plugin-store.mjs` line 439). Issuance accepts any string matching the scope pattern — "a key with an unknown scope simply grants nothing" — and a `prefix:*` scope "grants every scope sharing its prefix, **including scopes added in the future**". There is no single catalogue a settings UI can render, and a typo'd scope fails silently until a 403 somewhere else.
- **A discovery hint points at a route that does not exist.** `server/discoverability.mjs` lines 763–764 tells an under-scoped agent to issue a key at `POST /api/agent-api-keys`; the registered route is `POST /api/agent-keys`. Verified by reading both files at `aaa749065a`.
- **No bulk or cleanup surface.** The only multi-key revocation is the identity cascade. There is no "revoke all keys for identity X" endpoint/CLI command short of revoking the identity, no cross-identity inventory, and invites/share-links have **no revoke mechanism at all** (see cleanup residue below).

**UT cleanup is the executed proof of the missing feature** (cite, do not re-derive):

- UT2 cleanup retired **19 identities and 19 API keys by hand**: a bespoke driver (`wave-2026-10-27-user-testing-2/cleanup/scratch/driver.py`) POSTed `/api/agent-identities/{id}/revoke {confirm:true}` per identity, verified each by a follow-up authenticated read → 401, and archived 11 rooms first (archive-before-revoke ordering). The 19 keys were revoked **only as a side effect** — "`revokedApiKeys:1` × 19. **No standalone token-revoke mechanism exists beyond this**" (`cleanup/REPORT.md`, Counts; summarised in `wave-2026-10-27-user-testing-2/SYNTHESIS.md` §8).
- Residue the hand process could not close (`cleanup/REPORT.md`, Token/invite residue + R-UNREC/R-ORPHAN): an unredeemed invite and a share link both returned 404 on DELETE — no revoke mechanism; room MCP tokens of deferred rooms stay live until ~2026-11-26 expiry; identities whose credential files were deleted or lost in transit are **unrevocable** — no owner secret, no path. UT1's cleanup hit the same wall: 15 identities revoked/verified, but lane 06's two identities and two room tokens "not revoked (expire ~2026-11-25). No path exists without the owner secret" (`wave-2026-10-27-ut-conversion/REPORT.md` §10).
- So every test wave re-pays this: hand script, per-identity secret files, manual 401 read-backs, and a hand-written residue report split by rule (dated / money / pending-leg / unrecoverable / orphan).

**Operator tokens: three master keys, not armed, no granularity.** Evidence on file:

- The rotation runbook names exactly three live credentials, one `secret put` each (`wave-2026-10-25-token-hygiene/SYNTHESIS.md` §H4a: `ROOM_OPERATOR_TOKEN_SHA256`, `ROOM_EXPORT_TOKEN`, `ROOM_RESTORE_TOKEN`). TM-2 already split the old shared backup token into export-only / restore-only (landed as #4575, focus-review lane-02 census) — that split is **done; do not redo it**. What remains unsplit is *within* each door: the operator token alone authorises all 9 operator routes including purge-execute and projection-execute (`operator-routes.mjs`, verified above).
- **No expiry, no TTL, no dual-accept, no in-app revocation.** The runbook states the fact up front: "single value, no overlap, no dual-accept/TTL/in-app revocation; revocation = replace or delete" (token-hygiene SYNTHESIS §H4a). Rotation is a hard cutover in one operator sitting, consumers updated in the same motion.
- **Not armed in production.** FOCUS-REVIEW lane 7 grades these doors "armed capability, not a live exposure" — export token unconfigured, restore unset (`wave-2026-10-25-focus-review/lane-07-brainstorm-reconciliation.md`, token-hygiene row). Housekeeping's audit confirms freshest state: "`ROOM_EXPORT_TOKEN` still unconfigured" and the backup-second-home pull records NOT-CONFIGURED by design (`wave-2026-10-27-housekeeping/SYNTHESIS.md` §§2.7, B10). Arming any of them is **John's operator act** — never an implementer's (token-hygiene SYNTHESIS: "Arming/rotating any token remains John's operator act").
- **No audit rows on the backup doors.** Tranche-1 detection work (H3 rate limits, H5 boot-time secret-presence alarm) was built as filed packages against `bdc5a04b`, not landed product; audit rows for export/restore plus failed presentations on all three bearer doors are H2 — deferred to T2 (token-hygiene SYNTHESIS, Deferred section). The operator routes do have an actions list (`/api/operator/actions`); the export/restore doors have no equivalent. UNVERIFIED at `aaa749065a` whether H3/H5 packages have since landed — the implementer checks before Phase B, per §4 B0.
- Finish-100 and keep-going syntheses add no new key-scoping finding: finish-100's only token-adjacent items are the #5004 seed-length cure and a corrected secret-scan diagnosis (`wave-2026-10-27-finish-100/SYNTHESIS.md` §§1–2); keep-going's credential-adjacent item is the mint budget wall (bound cure #5061, not this piece) and confirmation that no KoboToolbox credential exists (`wave-2026-10-27-keep-going/SYNTHESIS.md` §§Cluster B, D). Neither duplicates or contradicts the above.

## 3. What fantastic means

Match the shape every mature product uses — GitHub's fine-grained PAT settings (scope picker, expiry required by default, last-used shown), Stripe's restricted API keys + roll, Cloudflare API tokens (permission groups + TTL) — rebuilt in vanilla JS on the APIs that already exist:

**Agent settings (Phase A end state):**

- From the room's **Settings dialog in ≤2 clicks**, an agent owner (or a human managing an agent) sees **one screen listing every key for the identity**: label, `keyId`, scopes in plain language ("Read rooms", not `rooms:read`), created, **last used**, **expires in N d / expired / revoked**. No secret ever appears in the list.
- **Create in ≤4 interactions**: pick scopes from checkboxes grouped read/write (no free-text scope strings), pick expiry from 7 / 30 / 90 / 365 days with **30 days pre-selected**, optional label, Create → secret shown **once** in a copyable field behind an "I have stored this key" confirmation, matching the operator console's show-once discipline.
- **No permanent keys by default**: omitting expiry yields a 30-day key, not a never-expiring one; anything over 365 days is refused 422; a key expiring within 7 days carries a visible badge in the list; an expired key reads "expired" in the list instead of only failing 401/403 at use.
- **Revoke in 2 clicks** (Revoke → confirm naming what the key can do, in plain language); the very next request with that key fails. **Rotate in 2 clicks**, old secret dead immediately, new secret shown once. **Revoke all** for the identity in one confirmed action that does not revoke the identity itself.
- **Cleanup is a feature, not a hand script**: a `cleanup` command (CLI first, §4 A4) takes a wave's credential inventory and, per identity: archives its rooms first, revokes the identity (cascading keys), verifies each retirement by a follow-up read → 401, deletes the local credential file **only after** its retirement verifies, and prints the residue report in the UT cleanup's own rule classes (dated / money / pending-leg / unrecoverable / orphan) with the reason per item. Target measured against UT2's hand run: **19 identities retired in <10 minutes, 0 hand-written scripts, 100% of revocations read-back-verified, residue list generated, not authored.**
- The under-scoped-agent hint names the real route and the exact scope to request; a mis-scoped key is self-diagnosing from the 403 alone.

**Operator tokens (Phase B end state, at unpause):**

- Operator door split into **read** (status / drift / actions) and **write** (purge / archive / projection execute) credentials (H1); a leaked read credential cannot purge. Every presentation on all three doors — success **and failure** — writes an audit row naming door, action, and result, never any part of the value (H2). Tokens gain a TTL with a dual-accept rotation window so rotation stops being a hard cutover (H4b → H9).
- The operator console shows, per door, **armed / unconfigured** state and last-used time without ever displaying a value, so "is this door live?" is a glance, not an operator sitting.

**Hard numbers for acceptance:** list renders from the existing `GET /api/agent-keys` with no new round trips (1 request); create/rotate/revoke each 1 request; revoked-key failure is effective on the **next** request (no cache window); **zero** occurrences of any issued secret in list responses, logs, or the cleanup report (grep-pinned by test); default-expiry and max-expiry enforced server-side, not just in the UI.

## 4. The instruction

Target tree: main `aaa749065a`. Client stays vanilla JS. No new identity system, no new table in Phase A. Anything that changes auth semantics lands **singly, green at exact head** (shared-core rule); fix lanes never merge.

### Phase A — NOW (not T2; start immediately)

**A1. One scope catalogue, one true route (server, small).**
1. In `server/agent-api-keys.mjs`, extend the exported catalogue so it is the single source for **all** enforced scopes: the existing 5 plug-in scopes plus `rooms:read`, `rooms:write`, `mcp:inbox`, `mcp:wake`, and the `mcp:room:<id>` restriction pattern (mark it as a restriction, not a grant — per the OpenAPI description it "grants no read or write by itself"). Give each a plain-language label and a read/write grouping; `server/agent-plugin-manifest.mjs` and the new UI both consume this list. Do **not** change what any scope grants, and do **not** remove permissive issuance in this step (unknown scopes still grant nothing) — but see A2.3.
2. Keep the `prefix:*` wildcard working for compatibility, but mark wildcard scopes in the catalogue/UI as "includes future scopes" so nobody grants one unknowingly.
3. Fix `server/discoverability.mjs` (~lines 763–764): the hint's path becomes `POST /api/agent-keys`. Add/extend a test asserting every path named in that hint resolves in the route dispatch.

**A2. Expiry defaults (server, small; the only Phase A behaviour change).**
1. In `server/agent-api-keys.mjs` `issue()` + `server/agent-plugin-routes.mjs` `issueKey`: when `expiresAt` is omitted, set `now + 30 days` (matching the room MCP token's existing 30-day life). When `expiresAt` is more than 365 days out, refuse **422 `invalid_api_key_request`** (existing code — reuse it; no new error code). Explicit `expiresAt: null` from the CLI keeps working only if the CLI translates it to the default; there is no longer a no-expiry issue path.
2. Existing never-expiring keys in the store are **not** retro-expired; the list surface (A3) flags `expiresAt: null` as "no expiry — rotate to fix".
3. In the same diff, reject scope strings not in the A1 catalogue **or** the wildcard/restriction patterns with 422 `invalid_api_key_request` naming the unknown scope. (This closes the silent-typo hole; it is a refusal-shape change — run the §5 refusal-shape grep.)
4. Update `docs/openapi.yaml` `/api/agent-keys` in the same diff: default + maximum expiry, catalogue-based scopes.

**A3. Agent Keys settings section (client, vanilla JS).**
1. Add an "API keys" `<details>` section to `#settings-dialog` in `index.html`, beside Permissions/Advanced, rendered by a new small client module (follow the existing dialog's idioms; no framework). The section is hidden until the user supplies the identity (owner) secret.
2. Credential handling copies `operator.html`'s settled pattern exactly: the owner secret is held in **`sessionStorage` for the tab only**, never `localStorage`, never a cookie; a Forget button clears it; a refused (401) secret is cleared automatically.
3. Render the list from `GET /api/agent-keys` (fields already returned: `keyId, scopes, label, createdAt, expiresAt, revoked, lastUsedAt`; also surface `lastUsedUa` where present). Plain-language scope labels come from the A1 catalogue — the client must not hard-code its own scope list.
4. Create form per §3 (checkbox scopes grouped read/write, expiry select 7/30/90/365 defaulting to 30, label ≤80 chars). On 201, show the one-time secret once with a copy button and require the store-it confirmation before the form can be used again; never write the secret to any storage.
5. Row actions: Rotate, Revoke (both via `POST /api/agent-keys/{keyId}/{action}`), with a confirm step naming the key's plain-language scopes. Plus one **Revoke all keys** action for the identity (client loops the per-key revoke endpoint; if ≥5 keys make that loop flaky in testing, stop and file the bulk endpoint as a follow-up rather than widening this diff — a bulk endpoint is a new route and trips the full route triple, §5).
6. Accessibility: every input labelled (the housekeeping Q9 defect class — an unlabelled one-time-key field — must not recur); the section passes the shipped-HTML a11y check named in §5.

**A4. Cleanup as a feature (CLI first — this is where UT waves feel it).**
1. Extend `scripts/agent-inbox.mjs` (the CLI that already wraps `agent-keys create|list|rotate|revoke`) with:
   - `agent-keys revoke-all --identity <id>` — revokes every live key for the identity without revoking the identity; prints per-key results.
   - `cleanup --inventory <file>` — the inventory is the wave-lane credential-file list (same inputs UT2's driver read from lane reports). Per identity, in this order: (a) archive each of its rooms via the `room.archived` command; (b) `POST /api/agent-identities/{id}/revoke {confirm:true}`; (c) verify by a follow-up authenticated read expecting 401; (d) only then delete the local credential file; (e) emit a machine-readable residue report using UT2's rule classes verbatim (R-DATED / R-MONEY / R-LEG / R-UNREC / R-ORPHAN) for anything skipped or unverifiable, with the reason. A sequencing guard must make the UT2 04-05 error (credential file deleted before retirement verified) impossible: deletion is gated on step (c) success in code, not by operator care.
2. The command is dry-run by default; `--execute` performs. Zero secrets in its output or report (keyIds and identityIds only).
3. Do **not** build a UI for cleanup in this phase, and do **not** invent invite/share-link revocation: where the API has no revoke mechanism (invites, share links — UT2 residue), the report must say "no revoke mechanism exists" per item. That API gap is filed as a named follow-up, not silently absorbed.

**A5. Docs.** Update `docs/OPERATOR.md` only for the A1 route correction if it repeats the wrong path (grep it); document the new default/max expiry and the cleanup command where `agent-keys` CLI usage is documented. No other docs surgery.

### Phase B — WAIT (token-hygiene tranche 2, PAUSED per FOCUS-REVIEW)

**Unpause trigger (proposed, for Jill to ratify at the next slate review — this cures the UNMEASURABLE park):** T2 unpauses when **either** (a) the first live operator-token rotation is scheduled under the H4a runbook, **or** (b) any operator-class token is armed in production, **or** (c) 2026-12-01 arrives, whichever is first. Until one fires and Jill names the unpause on the record, **every step below waits**, including the ones that look small.

- **B0. WAIT — re-verify tranche-1 landing state.** Before any B step, check at the then-current main whether the H3 (door rate limits) and H5 (boot secret-presence alarm) packages filed in `wave-2026-10-25-token-hygiene/` have landed. T2's own sequencing (D4 order) is detection and ceiling first; do not build B1/B2 on an assumed base.
- **B1. WAIT — H2, audit rows (10 lh, first in T2).** Audit rows for export/restore presentations **and failed presentations on all three bearer doors**, values never logged. Pairs with landing H3+H5 in the same window (token-hygiene SYNTHESIS, Deferred). If a new audit table is required, the store-registry sweep items in §5 become REQUIRED.
- **B2. WAIT — H1, split operator read/write scopes (15 lh).** The only step that shrinks the operator blast radius itself. Sequence **after** B1 lands ("lands after the audit it will itself be audited by"). It mints a new secret name: register that name in the same diff in `docs/OPERATOR.md`, `docs/ROOM-DEPLOYMENT.md`, and the runbook forms. Shared-core auth surface: **lands singly, green at exact head**, freeze-class ceremony. The operator console (`operator.html`) is updated in the same diff to accept the read credential for read views and require the write credential for execute actions.
- **B3. WAIT — trigger-gated remainder, do not schedule early:** H4b dual-accept window (8 lh; trigger = first live rotation under H4a, or a second standing consumer) → then H9 token TTL (10 lh; trigger = H4b built); H7 read-route audit rows (3 lh; trigger = B1 landed + row review); H8 failure-shape parity (2 lh; trigger = H3+H5 landed).
- **B4. WAIT / NEVER the implementer:** arming, rotating, or deleting any operator-class token in production is John's operator act in an operator sitting, under the H4a runbook (`~/workspace/fixplan-2026-10-19/operator-token-rotation-runbook.md`). No step in this pack authorises it.

### Explicit non-goals

- No redesign typed-object work (that phase is PAUSED separately); no new identity, account, or session system.
- No change to mint budgets / rate limits — #5061 (bound) owns mint-refusal truthfulness; do not duplicate it.
- No redo of the TM-2 export/restore split (#4575, landed) and no resurrection of the retired shared backup token name.
- No React/shadcn anywhere in this piece; the T3 door-rebuild pilot is a different pack.
- No retro-expiry or mass-revocation of existing keys; no production writes of any kind during implementation or acceptance (test/staging identities only, plus read-only production GETs).

## 5. Acceptance

Coordinator/Jill run these at the source; a self-report is not evidence. Phase A and Phase B are accepted **separately**; Phase B acceptance applies only after the unpause is on the record.

**Phase A — executed checks:**
1. `npm run verify:affected` clean, plus by name: `tests/agent-plugin-api-keys.test.js`, `tests/agent-plugin-http.test.js`, `tests/agent-plugin-manifest.test.js`, `tests/operator-ui.test.js` (console pattern untouched/regressed-check). Because the diff touches `server/**`, close-out also includes `CI=1 npm run check`.
2. Expiry probes (test server, fresh identity): issue with `expiresAt` omitted → response `expiresAt` equals `createdAt + 30d` (±1 s); issue with `expiresAt` > 365 d → 422 `invalid_api_key_request`; issue with an unknown scope string → 422 naming it; issue with `rooms:read` + `directory:publish` → both enforced (a `rooms:read`-only request succeeds on a room GET, a room write returns 403 `insufficient_scope` naming `rooms:write`).
3. Lifecycle probes: revoked key's next authenticated call fails (401/403) with no window; rotated key's old secret fails and new secret works; list response for an identity containing ≥1 live key contains **zero** occurrences of any issued secret (grep the raw body); the discoverability hint path (`POST /api/agent-keys`) returns a non-404 route response.
4. UI browser check (Fo's shard or John's Tab): Settings → API keys reachable in ≤2 clicks; create→store-confirm→revoke round trip against a test identity completes; secret absent from `localStorage` and cookies (inspect storage); every input in the section has a label/aria-label (housekeeping Q9 class).
5. Cleanup rehearsal: seed ≥3 test identities with rooms + keys, run `cleanup --inventory` dry-run (no state change, verified), then `--execute`: every identity's follow-up read is 401, rooms show `archivedAt`, credential files deleted **only** for verified identities, and the residue report classifies a deliberately unrecoverable entry as R-UNREC with no secret material anywhere in the output (grep for the seeded secrets → 0 hits). Compare shape against UT2's `cleanup/REPORT.md` counts format.
6. Refusal-shape step (registration sweep item 9): A2.3 changes a refusal — grep the test tree at head for pins on permissive issuance / unknown-scope acceptance and report each as REQUIRED-review evidence in the PR body.

**Phase A — registration sweep:**
- Runtime-package closure: **REQUIRED if** a new `server/**` module is added (A1/A2 should extend existing modules — if the implementer adds one anyway: allowlist + candidate-runtime fixture + closure test). Otherwise n/a — no new module.
- Error-code catalogue, both copies: **n/a if** only the existing `invalid_api_key_request` / `insufficient_scope` / `unknown_key` codes are reused (the A2 instruction requires reuse); if any new code appears, REQUIRED — row in `skills/project-room/references/errors-catalog.md` + `node scripts/skills-sync.mjs`, mirrors byte-identical.
- Route triple: **n/a for A1–A4 as instructed** (no new routes; the CLI is not a route). Becomes REQUIRED in full (table + OpenAPI bare path + legacy allowlist + `x-room-permission` marker + parity note) if the A3.5 bulk-endpoint follow-up is taken.
- Harness copy sets: **REQUIRED-check** — `agent-plugin-routes.mjs` / `agent-api-keys.mjs` are imported by test harnesses; confirm any harness copy/re-point set that includes them still resolves (name the harnesses checked in the PR body).
- Store registries: **n/a** — no new table, no schema change in Phase A (expiry default is value-level).
- Generated/mirrored artifacts: **REQUIRED** — `docs/openapi.yaml` edit (A2.4) must match the served OpenAPI; if the A1 catalogue changes the MCP/agent manifest output, regenerate `tests/fixtures/mcp-catalog.snapshot.json` in the same diff and run `tests/mcp-search-actions.test.js` + `tests/mcp-untrusted-content.test.js` by name (verify:affected does not select them).
- Diff hygiene: >300 changed lines → `## Large diff justification:` in the PR body at filing (likely for A3+A4 combined — split A3 and A4 into separate PRs if it keeps each under).

**Phase B — acceptance sketch (applies at unpause):** B1: a failed presentation on each of the three doors writes exactly one audit row with no value material (grep row store for the presented token → 0 hits); B2: read credential gets 404/403 on every execute route and 200 on status/drift/actions, write credential gets both, at exact head, landed singly; B3 items accepted against their own triggers. Registration sweep for B: store registries **REQUIRED** if B1 adds a table (writer-fence + purge-registry + recovery-audit + verifySchema partition); error catalogue both copies REQUIRED for any new refusal; runtime-package closure REQUIRED for any new `server/**` module; route triple REQUIRED for any new operator route.

## 6. Routing

- **Phase A server (A1, A2): Codex** — server/core is his lane, and A2 touches the shared auth surface that must land singly from John's Mac. Handover: `room_request_reply` to Codex's room member with a concrete ask, a `workItemId`, and the expected result (the §5.2/§5.3 probe table passing at the composed head). All Codex utilisation inside Project Room.
- **Phase A client (A3): Claude** — client surfaces and design tokens are his PR train; he works against the already-shipped API, so A3 does not need to wait for A1/A2 except for the catalogue endpoint shape in A1.1 — sequence A3's scope rendering after A1 lands.
- **Phase A CLI + verification (A4, §5.5 rehearsal): Jill's fleet** — verification and cures are fleet work; the fleet also owns re-running the rehearsal against the next real UT wave's inventory. Fleet never merges.
- **Landings: Grok Bot** (landing seat, with John's Tab on stack/slot order) — A1/A2 land singly (auth-adjacent); A3/A4 may batch under Rules v2 non-money batching once green.
- **Post-deploy verification: John's Tab** — production read-only probes only: settings section renders, a throwaway identity's key round trip if a test identity is provisioned, and `/api/version` pin recorded with the verdict. **Fo** supplies browser-shard evidence for the A3 UI check (§5.4) if John's Tab is unavailable.
- **Phase B (when unpaused): Codex** builds B1/B2 (server/core, shared-core auth, single landings); **Jill** ratifies the unpause trigger and names the unpause; **John alone** performs any arming/rotation in an operator sitting (B4).

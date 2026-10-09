# Docs S–Z audit (WAVE-400, partition d3: routes/scripts/tooling)

Worktree: /home/hatch/workspace/pr-wave400-docs-tooling (read-only). 30 docs in range (case-insensitive S–Z).

## Docs S–Z audit

| Doc | Verdict | Notes |
|---|---|---|
| docs/SECRET-SCAN.md | accurate | detector, both gates, exit codes, allowlists, tests all verified in code |
| docs/SECRETS-ROTATION.md | accurate | all named files/endpoints exist; totp-2fa correctly reported absent |
| docs/SECURITY-MODEL.md | accurate | open-routes.mjs --check exists; route table + redaction modules exist |
| docs/SECURITY-REVIEW-2026-09-12.md | accurate (historical) | dated point-in-time review; claims are anchored to that date's code |
| docs/SECURITY-REVIEW-2026-09-14.md | accurate (historical) | dated review of six BUILD-01 PRs; scoped explicitly |
| docs/SECURITY-REVIEW-IDENTITIES-2026-09-12.md | accurate (historical) | IDENTITY_LIMIT=5000 verified live; the "owner-only" comment nit it records is still present in agent-identities.mjs |
| docs/SELF-HOSTING.md | accurate | provision/start scripts, port 4173 (server/deployment.mjs:23), backup scripts, history links all exist |
| docs/SERVICE.md | accurate | schema 38 (writer-fence.mjs:7), port 4173, all linked history docs exist; HTTP table spot-checked |
| docs/SESSION-ADAPTER.md | **stale** | status line overtaken: the "unlanded" code has landed (see stale flags) |
| docs/SESSION-API.md | **stale (2 flags)** | work-sessions/work-claims sections accurate; supervision pending marks correct; lease cap + build-lane label wrong |
| docs/SIGNED-AGENT-CARDS.md | accurate | all 8 exports present in agent-card-signing.mjs; publish route mounted in http.mjs via agent-plugin-routes.mjs:931 |
| docs/signed-evidence.md | accurate | all 8 rejection codes present in server/signed-evidence.mjs |
| docs/SOAK-TEST.md | accurate | all 4 named files exist |
| docs/SPEC.md | accurate | spec/README.md is "Version 0.1.0-draft" as cited |
| docs/SPEC-v0.md | accurate (historical) | 2026-09-05 product contract; all 7 doc links resolve |
| docs/SPEND-PRIMITIVE.md | accurate | PRICED_MCP_TOOLS = room_put_file:5, bounty_post:10, add_land_item:1; spend-grant/spend-pricing routes + tables present |
| docs/SQUADS.md | accurate | sq_+12hex, MAX_SQUAD_MEMBERS=12, squad_unknown 422, squadId threading in work-claims.mjs |
| docs/STAGING.md | accurate | project-room-stage env, ROOM_ORIGIN, staging.yml workflow all match |
| docs/SWARM-PLUG-IN.md | **stale (1 flag)** | onboarding path otherwise accurate (agent-inbox.mjs, 3-rooms/8h-refill budget, 24h/5m–30d invite TTL, wake poll defaults, webhook signature bytes all verified); the MCP tool-count claim is stale |
| docs/TERMS-OF-SERVICE-TEMPLATE.md | accurate | self-labeled draft requiring legal review; TERMS_VERSION="2026-10-02" matches server/legal-store.mjs:5 |
| docs/TROUBLESHOOTING.md | accurate | every sampled error code found in server/; docs-troubleshooting.test.js exists; 428 PoW and refresh-table claims match code |
| docs/USER-GUIDE.md | accurate | prose UI guide; few falsifiable claims; referenced FAQ.md exists |
| docs/video-walkthrough-script.md | accurate | sampled grounding citations resolve (join.html consent/secret ids, message-list, nav-inbox, room_read_inbox); shots test exists |
| docs/WEBHOOK-WAKEUPS.md | accurate | headers, canonical payload, 5-min clock-skew, 32-event cap, dead-letter/redrive/metrics routes all match code |
| docs/WEEKLY-LEARNINGS.md | accurate | trivial queue doc; consistent with weekly-learnings-cron.md |
| docs/weekly-learnings-cron.md | accurate | scripts/weekly-learnings.mjs + tests/weekly-learnings.test.js exist |
| docs/WIKI-API.md | accurate | all 12 named files exist; endpoints + wiki-build.mjs --check claim verified |
| docs/WORK-CLAIMS-READ.md | accurate | route registered in server/routes/work-claims.mjs; tests/work-claims-read.test.js pins the contract |
| docs/WORK-CLAIMS.md | accurate | state machine, error codes, caps (200/20), leases (0.25–168 via BOARD_LEASE_HOURS_MIN in work-claim-integrity.mjs) all match code |
| docs/WORK-CONTEXT.md | accurate | GET /api/rooms/{roomId}/work-context mounted in the http.mjs route regex; CLI flags exist |

### Stale flags

- `STALE docs/SESSION-ADAPTER.md:7 — "**Status: the code does not exist yet.**"` contradicts `server/session-adapter.mjs` (38KB, `InMemorySessionAdapter`, header: "Backends: InMemorySessionAdapter (this file)"), `server/session-adapter/herdr-bridge-adapter.mjs` (header: "HerdrBridgeAdapter (B4 lane)"), `server/session-adapter/pinned-herdr.json`, and `tests/session-adapter-contract.test.js` (all exist in tree). The code is landed but **unwired**: no production module imports it outside wiki seed text, `bridge/herdr-bridge.mjs` (B3) does not exist, and `server/supervision-routes.mjs` explicitly defers mounting. Correct statement: B2/B4 core contract landed and tested, unwired; B3/B5/B6 still pending.
- `STALE docs/SESSION-API.md:119 — "| `leaseHours` | no | Hours (default: room default else 24; max 720); `null` opts out of leases entirely |"` contradicts `server/work-claims.mjs:285` (`const MAX_LEASE_HOURS = 168;`). `docs/WORK-CLAIMS.md` ("0.25 to 168", via `BOARD_LEASE_HOURS_MIN` in `server/work-claim-integrity.mjs:27`) is the correct figure.
- `STALE docs/SESSION-API.md:7 — "see `docs/SESSION-ADAPTER.md` (pending — lane B12)."` contradicts `docs/SESSION-ADAPTER.md` itself (header: references "marked `(pending B<n>)`"; §1 "defined in `server/session-adapter.mjs` (pending B2)") and `server/session-adapter/herdr-bridge-adapter.mjs` header ("(B4 lane)"). There is no "lane B12" anywhere in the seam design; the correct lanes are B2/B4.
- `STALE docs/SWARM-PLUG-IN.md:372 — "Verified: initialize → 35 tools → `room_check_access` → `credential_accepted` with an identity secret."` contradicts `tests/runtime-package.test.js:62-70` (the tool-count ladder: `room_close_work_claim` present → 44) and `tests/agent-work-search.test.js:132` (`assert.equal(tools.length, 44)`). `room_close_work_claim` exists in both `client/mcp-stdio.mjs` and `server/mcp-full-profile.mjs`. Current MCP surface count is 44, not 35.
- `STALE docs/SECRET-SCAN.md:11-12` — "Same detector, same line allowlist, same scope policy — the two gates never disagree about a line." False: `scripts/secret-scan-diff.mjs:4-5` applies the shared line allowlist PLUS a path-based allowlist (`.github/secret-scan-allowlist.txt`); `scripts/scan-secrets.mjs` only honors the line-level `secrets-allowlist` marker. A finding in a path-allowlisted file is flagged by the tree scan but not the diff gate — the gates can disagree.
- `STALE docs/SESSION-API.md:191` — "the v1 hold is client-held (`src/triage-ui.js`)" — `src/triage-ui.js` does not exist. The adjacent section (line 198) correctly marks the UI surface "pending — lane B7", but line 191 states the v1 design in present tense against a non-existent file.

### Accurate & valuable

- `docs/WEBHOOK-WAKEUPS.md` — byte-exact two-signature spec; the canonical-payload integer-vs-ISO distinction is verified in server/webhook-dispatch.mjs.
- `docs/SIGNED-AGENT-CARDS.md` — matches exports, route, and 422 codes exactly; best crypto-doc in the slice.
- `docs/signed-evidence.md` — all eight rejection codes and the number-ban rule verified in server/signed-evidence.mjs.
- `docs/TROUBLESHOOTING.md` — grounded by tests/docs-troubleshooting.test.js; the 428 proof-of-work recipe and refresh table match code.
- `docs/SPEND-PRIMITIVE.md` — prices, charge-then-forward, kill switch, and honesty sections all verified against server/spend-grants.mjs.
- `docs/SQUADS.md` — schema, caps, and error codes match server/squads.mjs exactly.
- `docs/WORK-CLAIMS.md` — accurate API reference; states/caps/leases verified.
- `docs/SECRET-SCAN.md` / `docs/SECRETS-ROTATION.md` — file paths, exit codes, allowlist semantics verified.
- `docs/SERVICE.md` — dense but honest: schema version, port, and history links verified; carefully labels pilot limits and gates.
- `docs/STAGING.md` / `docs/WIKI-API.md` — deployment and wiki-plane claims verified.

Abandoned docs: none in this slice. The three SECURITY-REVIEW-* docs and SPEC-v0.md are dated historical records, explicitly scoped to a date/PR set — accurate as records, not abandoned.

Suspected bugs in code: none found (no BUG? flags).

Caveats: SERVICE.md and TROUBLESHOOTING.md are very long; verification was deep on claims but not exhaustive line-by-line. SESSION-API.md's pending herdr/supervision sections were verified absent-but-expected (not mounted), which is correct per its own (pending) marks. Runtime `muse.exec` had two transient metadata timeouts; all checks were retried to completion.

DONE: 30 docs checked, 6 stale flags, 0 suspected bugs

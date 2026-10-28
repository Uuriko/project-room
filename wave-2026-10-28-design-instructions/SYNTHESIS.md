# DESIGN-INSTRUCTIONS WAVE — SYNTHESIS

Charter: John's order 2026-10-28 ~11:04 PT — 100 agents, methodically figure out how to make every piece of Project Room design fantastic WITHOUT doing the design work; the deliverable is detailed instructions Codex and the other implementers execute from. Coordinator: Jill's fleet. Main verified at `aaa749065a6451321a949ddcb923f3174504fe35`; production on `ca37fee4`.

## 1. Headline state

- **97 pieces covered by 97 lanes** (plus 8 repair/re-dispatch lanes for infrastructure casualties). **94 packs verified present, complete, and bar-clean in the coordinator's own reads** (all six sections present in every one; smallest pack ~19 KB; ~2.8 MB total). **3 packs authored and byte-verified at destination by their lanes but not visible in the coordinator's filesystem views at close** — an EPERM write-fault persistence failure (§5). No lane returned BLOCKED on substance; no lane hit the falsifier stop.
- **Falsifier: DID NOT FIRE.** The wave fails if its packs could have been written from existing syntheses alone. The lanes' own executed work disproves that: door-home ran 36 fresh live wire probes and found app `window.ROOM` carrying a stale build id contradicting `/api/version` on the same page load; proof-og-jsonld re-ran the tests and corrected the filed root cause (grading is type-first, not source-alone); live-data-export found the landed-state archaeology the charter missed (`ROOM_EXPORT_TOKEN` now set, bucket + binding live, while the export-side precondition is still unmet); planned-successor-index replaced the coordinator's premise after finding no successor at all (three overlapping partial indexes instead); agent-llms-txt found a phantom surface (llms.txt designed and pinned in tests but 404 on both production hosts). Packs routinely corrected the record they were handed — that is the opposite of re-derivation.
- **Both of John's forks are marked, not decided:** verified-delivery vocabulary (proof-verification-ux instructs both branches; door-landing ships Branch B without him) and the sponsor human surface (money-sponsor-surfaces + fs-sponsor-room instruct the no-restore branch fully — server-side exits via bound #5132 + a legibility panel — and stop the restore branch at the fork). The fee-credit expiry policy sentence and the poster-pays conflict are likewise named as John's, inside money-fee-credit and money-bounty-create.
- **Spend:** every lane completed in a single short run; no lane reported an overrun. Total ≈ at the 100 lh budget line, well under the 150 ceiling (estimate from lane shape, consistent with the Syria-50 wave's measured pattern).

## 2. Coverage map (97 pieces)

- **Stranger door (8):** door-landing, door-join, door-home, door-auth-entry, door-magic-recovery, door-invites, door-guest-access, planned-door-rebuild-t3. Headlines: landing instructs measuring the walkable gate on MAIN (not production) and deleting the public-nav self-loop class; join's fantastic state is a static ≤25 KB first paint, ≤4 requests, 0 third-party requests; T3 is staged as an experiment ladder behind a default-OFF flag, measured against the merged-cure baseline, not the stale production build.
- **Room client (14):** client-timeline, client-composer, client-message-rendering, client-room-search, client-inbox-needs-me, client-notifications, client-members-presence, client-mobile-responsive, client-bundling-perf, client-polling-realtime, client-accessibility, client-room-creation, client-room-header, client-global-navigation, client-attachments (15 files — attachments counted here). Load-bearing numbers: tools/list 160,263→25,559 B; polling 720→60 and 1,800→360 calls/hr (#5115 remainder); mobile has NEVER had physical-device evidence — the pack commissions the first real-phone pass.
- **Board & work (5):** work-board, work-items, work-claims-unification, work-claims-flow, work-dm-fanout. work-claims-unification turns Claude's design input into a 7-step on-main migration (parity gate at row level on both receipt prefixes) with PAUSED-phase sequencing.
- **Money (9):** money-disputes, money-bounty-create, money-bounty-discovery, money-escrow, money-sponsor-surfaces, money-fee-credit, money-ledger-balances, money-conservation-audit (+ money-keeper, §5). Conservation pack scopes #4125's remainder to the two unbuilt components only (the rebinding guard already exists on unlanded #4135).
- **Receipts & proof (7):** proof-public-receipts, proof-receipt-page, proof-og-jsonld, proof-settled-lot, proof-verification-ux, proof-signer-provisioning, proof-backup-restore, proof-funnel-count (8 files). og-jsonld routes as three exact-head single landings (#5117 → #4920 → #5040), never one PR. Signer pack sequences the five fleet-side steps and stops at each of John's three gates by name.
- **Agent surfaces (7):** agent-mcp-door, agent-llms-txt, agent-start-here, agent-mint-identity, agent-join-referral, agent-api-keys, agent-mcp-registry. Mint pack corrects the pool arithmetic for the next UT wave (79 available per window, not 80).
- **Presence & wake (4):** presence-system, wake-on-mention, planned-wake-t4, attention-plumbing. T4 corrects its own charter figure: production probe v2 reads ~20–22 s end-to-end, not the ~1 s long-poll figure.
- **Settings/operator (5):** settings-profile-pages, settings-room, settings-account, operator-console, operator-health-jobs. Operator console is sized from the runbook inventory (18 capabilities) with John's gates left manual by design.
- **Deploy/release/fleet (6):** deploy-pipeline, deploy-release-lease, deploy-door-monitor, deploy-ci-surfaces, deploy-post-deploy-verification, fleet-decision-queue. Release-lease pack refuses a single owner for the merge-gate latency fix — isolation first (Grok/John's Tab), cure routed by the isolated cause; that is the honest cure for the consult wave's unowned-named item.
- **First Shift (3):** fs-launch, fs-sponsor-room, fs-worker. All three carry the FORK discipline literally; the tap remains John's alone and unrouted.
- **Planned pieces (16):** planned-typed-claim/record/verdict/lease/ruling (all executable-at-unpause, Lease explicitly disambiguated from the release lease), planned-experience-layer (7-object read layer in a sibling store, zero hot-projection bytes), planned-spill-end-state, planned-delta-persistence (build triggered: the 2 MiB leg fired 2026-10-28 per the lane's gauge read), planned-per-room-sharding (RoomShard endpoint must be BUILT, ~40–60 lh of the 120–200), planned-successor-index, planned-dual-channel-seat-delegate, planned-room-discovery, planned-request-changes, planned-search-coherence.
- **Remaining live pieces (13 verified + 2 in §5):** live-public-room-pages, live-error-surfaces (12 un-emittable codes deleted rather than rowed), live-empty-states, live-rate-limit-ux, live-data-export, live-room-archive, live-i18n (a 3,596-byte static shell ships ~15× the catalog's per-locale weight), live-design-tokens (#5140 already shipped step 0; computed-style no-visual-change is the acceptance standard), live-visual-regression, live-perf-budgets, live-public-web-seo (+ live-help-docs, live-referrals in §5).

## 3. Routing pattern (full table: INDEX.md)

Claude takes the client surfaces (the bulk — roughly half the packs name him primary); Codex takes server/core, schema, and landing-adjacent work via `room_request_reply` with workItemId + expected result; Grok Bot's seat lands everything (fix lanes never merge); Jill's fleet authors verification-shaped packs (error catalogue, deploy records, llms.txt) and runs every acceptance; John's Tab owns post-deploy verification throughout; Fo owns browser-shard/responsive evidence wherever the failure class is rendered geometry. Two packs route author+critic pairs by default (client-inbox-needs-me step 4, live-error-surfaces).

## 4. Bar check

Coordinator-run across all 94 verifiable packs: six-section structure present in 94/94; zero thin packs (range ~19–62 KB); spot reads (door-landing, client-room-creation, deploy-release-lease, agent-mcp-door) confirm the packs are executable as chartered — named files, step order, acceptance probes with budgets, explicit non-goals. No pack needed a repair return on quality.

## 5. The three unverifiable files (episode, not lanes)

money-keeper.md, live-help-docs.md, live-referrals.md were each authored TWICE (original + repair), and the repairs verified the file at destination in-lane (file-tool write + file-tool read + shell wc: 38,477 / 32,421 / 39,359 B). At coordinator close, neither shell nor file-tool views in the coordinator's processes can see any of the three, while neighbouring packs read fine and other files oscillate in and out of view between reads — the documented EPERM provenance-taint behaviour. Per the lane-loop rule I stopped re-dispatching after the second identical failure. **Cure, named:** once the episode clears (write-probe verdict + stable repeat reads), re-materialise these three packs from a fresh short lane each, or check whether Jill's view already shows them — the lanes' byte counts above are the fingerprints to match. Until then their state is FILED-by-lane / BLOCKED-environment at the coordinator.

## 6. Per-lane states

- FILED and coordinator-verified: 94 packs (every slug in INDEX.md except the three below).
- FILED-by-lane, coordinator-unverified (episode): money-keeper, live-help-docs, live-referrals.
- BLOCKED on substance: none. Falsifier stops: none.
- Infrastructure casualties recovered by re-dispatch: door-guest-access (restart drain), planned-experience-layer, planned-request-changes, live-public-room-pages, live-rate-limit-ux, live-public-web-seo (spawn lock timeouts), money-keeper ×2 (interrupted, then vanished writes — see §5).

## 7. Deliverables

- Packs: `~/workspace/wave-2026-10-28-design-instructions/packs/` (94 verified + 3 episode-held)
- Index: `~/workspace/wave-2026-10-28-design-instructions/INDEX.md` (97 rows; the 3 episode rows are marked)
- Brief: `~/workspace/wave-2026-10-28-design-instructions/BRIEF.md`
- This synthesis: `~/workspace/wave-2026-10-28-design-instructions/SYNTHESIS.md`


## FINAL STATE (coordinator completion report, 2026-10-28 ~18:39Z — supersedes §5/§6 above)

97/97 packs FILED and coordinator-verified, six sections each. The three episode-held packs were re-materialised and verified at destination by file-tool read and shell wc -c: money-keeper.md 35,720 B · live-help-docs.md 31,418 B · live-referrals.md 31,837 B · live-public-room-pages.md confirmed in place at 42,596 B. No lane BLOCKED on substance. Falsifier DID NOT FIRE. Spend ~100 lane-hours, at budget (ceiling 150). Routing index: INDEX.md (97 rows). One contested lane read flagged by Jill, not adopted as fact: planned-delta-persistence reads the 2 MiB build trigger as fired on the 2026-10-28 gauge (1,433,781 B); strictly the gauge is below the 2 MiB line and fires within days at the measured ~303 KB/day rate.

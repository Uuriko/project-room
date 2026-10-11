# Open PR reconciliation inventory — 2026-10-11

Snapshot from GitHub: 449 open PRs returned (limit 500). These are implementation candidates, not verified missing features or a merge queue. Titles are source labels. Check current source, successor commits, test evidence and live behavior before retaining, closing or integrating anything. No PR was closed or merged by this inventory.

| PR | Title | Branch |
| --- | --- | --- |
| [#2701](https://github.com/Uuriko/project-room/pull/2701) | Carry John's Tab R28-1: Catch up chip counts from the catch-up boundary, not the resume cursor | jill/g3d3-tab-carry-r28-1 |
| [#2700](https://github.com/Uuriko/project-room/pull/2700) | Plain agent sign-in 401: one sentence for wrong ID or secret | wave500-g1-auth-agent-signin |
| [#2699](https://github.com/Uuriko/project-room/pull/2699) | Fix: @squad mention crashed message post via invalid wake kind (w500-g5-b2) | w500-g5/b2 |
| [#2698](https://github.com/Uuriko/project-room/pull/2698) | Board cards: project supersededBy and blocker records | jill/wave500-g3-boardcore |
| [#2697](https://github.com/Uuriko/project-room/pull/2697) | Ask card: status transitions instant under prefers-reduced-motion | wave500/g8-askcard-reduced-motion |
| [#2696](https://github.com/Uuriko/project-room/pull/2696) | fix(a11y): Tab from a j/k-focused board card heading reaches the card's actions | wave500/g8-board-keyboard |
| [#2695](https://github.com/Uuriko/project-room/pull/2695) | push display: suppress out-of-order pushes that would replace a newer notification | jill/wave500-g3-presence |
| [#2694](https://github.com/Uuriko/project-room/pull/2694) | Approval-inbox receipt linkage: cardId→receiptId table + payload builder (WAVE-500 G10 7/50) | jill/wave500-g10-inbox-receipts |
| [#2693](https://github.com/Uuriko/project-room/pull/2693) | test: wakeable/pull-only mode-transition regression guards (WAVE-500 g5 A2) | w500-g5/a2 |
| [#2692](https://github.com/Uuriko/project-room/pull/2692) | Bind OAuth consent POST to the displayed request (scope-widening fix) | consent-fix |
| [#2691](https://github.com/Uuriko/project-room/pull/2691) | fix(push): ask/push display bugs — dedup mounts, clear handled ask, single subscribe save | wave500/g3d10-pushask-display |
| [#2690](https://github.com/Uuriko/project-room/pull/2690) | WAVE-500 g8: keep keyboard focus across human sign-in re-renders | wave500/g8-signin-keyboard |
| [#2689](https://github.com/Uuriko/project-room/pull/2689) | Default agent avatars: deterministic SVG initials tiles from design tokens | wave500-g3-board-avatars |
| [#2688](https://github.com/Uuriko/project-room/pull/2688) | fix(auth): let agent one-time secret rows shrink on narrow viewports | wave500-g1-auth-narrow |
| [#2687](https://github.com/Uuriko/project-room/pull/2687) | [docs] name the seventh credential-less MCP tool in the discovery routes bullet | wave500-g9-docs-skill-ref |
| [#2686](https://github.com/Uuriko/project-room/pull/2686) | test: pin push SUSPEND/RESUME counter invariants in deliverPush (WAVE-500 g5 D2) | w500-g5/d2 |
| [#2685](https://github.com/Uuriko/project-room/pull/2685) | [docs] SWARM-PLUG-IN.md: fix stale MCP tool count in per-agent routes (35 → 44) | wave500-g9-docs-swarm-plug-2 |
| [#2684](https://github.com/Uuriko/project-room/pull/2684) | Ask card honesty: stalled status no longer promises a Stop button to non-controls viewers | wave500/g7/b6 |
| [#2683](https://github.com/Uuriko/project-room/pull/2683) | Quiet human chat chrome and avoid full history reads for agent status | codex/chat-refresh-speed-1011 |
| [#2682](https://github.com/Uuriko/project-room/pull/2682) | [remedy] #2536 cleanup advisories: purge registry, claim-row cascade, populated purge tests | remedy/cleanup-purge-cascades |
| [#2681](https://github.com/Uuriko/project-room/pull/2681) | Fix notification-feed mention targeting to longest-label-first (no near-miss delivery) | wave500/g6-31-notif-mention-targeting |
| [#2680](https://github.com/Uuriko/project-room/pull/2680) | WAVE-500 g4: lease exclusivity race coverage (20 workers, file-lease overlap, lapsed-lease re-claim) | wave500/g4-lease-race-probe |
| [#2679](https://github.com/Uuriko/project-room/pull/2679) | fix(join): ignore a second submit while a join is in flight | wave500-g3-board-join |
| [#2678](https://github.com/Uuriko/project-room/pull/2678) | a11y: visible :focus-visible ring for the composer textarea | wave500/g8-focus-visible |
| [#2677](https://github.com/Uuriko/project-room/pull/2677) | Surface MAX_PENDING_WAKES truncation flag on poll + MCP wake paths | w500-g5/b6 |
| [#2676](https://github.com/Uuriko/project-room/pull/2676) | Wire pending approval count into the needs-attention pulse (WAVE-500 g10 slice 46/50) | jill/wave500-g10-pulse-wire |
| [#2675](https://github.com/Uuriko/project-room/pull/2675) | ci: weekly sharded flaky-detect workflow (TST-01A) | land/flakyw |
| [#2674](https://github.com/Uuriko/project-room/pull/2674) | Make chat sends immediate and show compact typing bubbles | codex/message-local-echo-1011 |
| [#2673](https://github.com/Uuriko/project-room/pull/2673) | Retain warm room cache across unrelated database commits | codex/projection-cache-transaction-1011 |
| [#2672](https://github.com/Uuriko/project-room/pull/2672) | WAVE-500 G8-07: raise worst touch targets to the 44px floor | wave500/g8-touch-targets |
| [#2671](https://github.com/Uuriko/project-room/pull/2671) | WAVE-500 g10 slice 23/50: approval-inbox tap-list migration runner | jill/wave500-g10-inbox-migrate |
| [#2670](https://github.com/Uuriko/project-room/pull/2670) | Don't fabricate a failed report when the authority read blips | wave500/g3b6-authority-read-fix |
| [#2669](https://github.com/Uuriko/project-room/pull/2669) | Fix stale needs-attention badge: don't swallow room updates, clear count on load failure | wave500-g3-unread |
| [#2668](https://github.com/Uuriko/project-room/pull/2668) | Motion-loop audit: done-chip pop fires once per terminal transition | wave500/g3-board-motion |
| [#2667](https://github.com/Uuriko/project-room/pull/2667) | test: regression guard for per-specifier NFC index rebuild in verify-affected | jill/wave500-g2-support-nfd |
| [#2666](https://github.com/Uuriko/project-room/pull/2666) | WAVE-500 G3D8: first-run card points skill step at shipped /SKILL.md | wave500-g3-firstrun-audit |
| [#2665](https://github.com/Uuriko/project-room/pull/2665) | WAVE-500 G2: fail-first repros for onboarding skill Step 5 gaps (tests only) | jill/wave500-g2-ob-step5 |
| [#2664](https://github.com/Uuriko/project-room/pull/2664) | WAVE-500 G4: opt-in case-insensitive path comparison for claim overlap detectors | wave500-g4-claims-overlap-exact |
| [#2663](https://github.com/Uuriko/project-room/pull/2663) | a11y: fix handoff badge contrast in light theme (measured) | wave500/g8-contrast-links |
| [#2662](https://github.com/Uuriko/project-room/pull/2662) | Optional follow-up to #2612 (Codex: take, fold in, or close): honour Retry-After, stop with reconnect_agent on auth refusals | gb/codex-supervisor-retry-after-auth-stop |
| [#2661](https://github.com/Uuriko/project-room/pull/2661) | fix(machine): publish finished results when a claim close is permanently rejected | jill/wave500-g3-rev2548-distinct-member-fix |
| [#2660](https://github.com/Uuriko/project-room/pull/2660) | WAVE-500 guild5 B5: pin ackWakes idempotency + validation contract | w500-g5/b5 |
| [#2659](https://github.com/Uuriko/project-room/pull/2659) | [docs] Fix Step 3 inaccuracies in served /SKILL.md | wave500-g9/docs-skill-step3 |
| [#2658](https://github.com/Uuriko/project-room/pull/2658) | WAVE-500 g3c9: receipt_card projections carry the rc_<claimId> receipt link | jill/wave500-g3-board-events |
| [#2657](https://github.com/Uuriko/project-room/pull/2657) | test: fail-first edge cases for R36-1 resubmit/approve (WAVE-500 g6-17) | w500g6-17 |
| [#2656](https://github.com/Uuriko/project-room/pull/2656) | WAVE-500 G1: auth error-catalog drift — document transfer_ownership_required + 2 more | jill/wave500-g1-auth-errcat |
| [#2655](https://github.com/Uuriko/project-room/pull/2655) | Approval inbox web UI (WAVE-500 guild 10, slice 16/50) | jill/wave500-g10-inbox-ui |
| [#2654](https://github.com/Uuriko/project-room/pull/2654) | Refuse stop commands on a never-started session | jill/wave500-g3-board-sessionitems |
| [#2653](https://github.com/Uuriko/project-room/pull/2653) | WAVE-500 G2: #2465 regression guard + lowercase RM- fragment fix | jill/wave500-g2-invite-2465 |
| [#2652](https://github.com/Uuriko/project-room/pull/2652) | Add configured-only GitHub sign-in on web and desktop | codex/github-signin-minimal-1011 |
| [#2651](https://github.com/Uuriko/project-room/pull/2651) | Recover stalled native browser sign-in with an explicit fallback | codex/native-browser-recovery-1011 |
| [#2650](https://github.com/Uuriko/project-room/pull/2650) | pushNotify: surface 422 input validation instead of swallowing it | w500-g5/d1 |
| [#2649](https://github.com/Uuriko/project-room/pull/2649) | WAVE-500 guild 10: client-side renderer for approval-inbox card events | jill/wave500-g10-inbox-roomjs |
| [#2648](https://github.com/Uuriko/project-room/pull/2648) | Shed loop test: retry a heartbeat read that lands mid-write | land/shedhb |
| [#2647](https://github.com/Uuriko/project-room/pull/2647) | Ask card: one foldable row per ask (re-cut of #2526 onto 83746c5b) | land/ask3 |
| [#2646](https://github.com/Uuriko/project-room/pull/2646) | Fix unvotable 10th poll option (U+1F51F keycap-ten) | wave500-g3d11-polls-option10 |
| [#2645](https://github.com/Uuriko/project-room/pull/2645) | inbox: hide the empty note on a failed load (R-27) | wave500/g7/c9b |
| [#2644](https://github.com/Uuriko/project-room/pull/2644) | Pin the content type of every public asset; serve strings/en.json as JSON and install.sh as text/plain | land/ctypes |
| [#2643](https://github.com/Uuriko/project-room/pull/2643) | Catch up chip counts from the catch-up boundary, not the resume cursor (R28-1) | land/r272 |
| [#2642](https://github.com/Uuriko/project-room/pull/2642) | WAVE-500 G7 C11: receipts + results empty states say what they hide | wave500/g7/c11 |
| [#2641](https://github.com/Uuriko/project-room/pull/2641) | WAVE-500 guild 10 slice 9/50: approval-inbox NOTIFY hooks | jill/wave500-g10-inbox-notify |
| [#2640](https://github.com/Uuriko/project-room/pull/2640) | WAVE-500 G1: revive disabled OAuth method on re-link instead of duplicating | wave500-g1-auth-oauth-link |
| [#2639](https://github.com/Uuriko/project-room/pull/2639) | test: edge guards for AgentRooms.list pagination (G2 support for #2540) | jill/wave500-g2-support-agentrooms |
| [#2638](https://github.com/Uuriko/project-room/pull/2638) | Plan finish-first backlog around complete user journeys | codex/finish-backlog-1011 |
| [#2637](https://github.com/Uuriko/project-room/pull/2637) | WAVE-500 guild-7 B3: fail-first repro for R36-2 Stop wedge (repro only) | wave500/g7/b3 |
| [#2636](https://github.com/Uuriko/project-room/pull/2636) | Catch up: one number for the badge and the panel; plain update lines | claude/catchup-count-plain-updates |
| [#2635](https://github.com/Uuriko/project-room/pull/2635) | Log-in form surfaces passkey + email-link sign-in (WAVE-500 G1 friction) | jill/wave500-g1-login-passwordless-affordances |
| [#2634](https://github.com/Uuriko/project-room/pull/2634) | Test: every core MCP tool has a REST twin | gb/mcp-rest-parity |
| [#2633](https://github.com/Uuriko/project-room/pull/2633) | Asks: changes since a cursor on GET /assistant (none / delta / full), read only | gb/assistant-changes-feed |
| [#2632](https://github.com/Uuriko/project-room/pull/2632) | join-agent: delegated admins are not co-admins — name their actual grant | jill/wave500-g1-2512-delegated-admin-copy |
| [#2631](https://github.com/Uuriko/project-room/pull/2631) | Add read-only assistant focus to agent resume | codex/agent-resume-assistant-1011 |
| [#2630](https://github.com/Uuriko/project-room/pull/2630) | Connect desktop Codex host status, preflight and Stop | codex/codex-host-status-1011 |
| [#2629](https://github.com/Uuriko/project-room/pull/2629) | Qualify connected workspace execution and plan reusable React conversation | codex/connected-workspace-evidence-1011 |
| [#2628](https://github.com/Uuriko/project-room/pull/2628) | Tolerate pasted #invite/RM-<code> variants (case, whitespace, trailing junk) | jill/wave500-g2-invite-routing |
| [#2627](https://github.com/Uuriko/project-room/pull/2627) | inbox: filtered-empty state states the next step (R-27) | wave500/g7/c9 |
| [#2626](https://github.com/Uuriko/project-room/pull/2626) | MCP front door: room_search_actions + room_run_action, opt-in lean profile (core unchanged) | gb/mcp-search-actions |
| [#2625](https://github.com/Uuriko/project-room/pull/2625) | Add native room agent Start/Stop and observed host status | codex/native-room-host-1011 |
| [#2624](https://github.com/Uuriko/project-room/pull/2624) | Add og:image + twitter card tags to vs-slack/vs-discord compare pages | wave500/g7/a8 |
| [#2623](https://github.com/Uuriko/project-room/pull/2623) | Ask sounds: contain sync-throwing resume()/locks.request() (g3 fail-first) | jill/g3-chime-qa-2552 |
| [#2622](https://github.com/Uuriko/project-room/pull/2622) | updates-ui: per-filter browsed page budget; badge read best-effort (WAVE-500 g3c8) | wave500/g3-folded-drawer |
| [#2621](https://github.com/Uuriko/project-room/pull/2621) | WAVE-500 g3a6: inbox empty-state honesty (note only after a successful zero-row read; honest search-failure copy) | wave500-g3-board-empty |
| [#2620](https://github.com/Uuriko/project-room/pull/2620) | repro: fail-first webhook userinfo test + docs no-credentials rule (supports Grok Bot's #2549) | wave500/g7/a2 |
| [#2619](https://github.com/Uuriko/project-room/pull/2619) | heartbeat registration: accept workWakes:null as absent | w500-g5/a1 |
| [#2618](https://github.com/Uuriko/project-room/pull/2618) | writer-fence: register approval-inbox tables as lazy additive (wave500-g10-inbox-fence) | jill/wave500-g10-inbox-fence |
| [#2617](https://github.com/Uuriko/project-room/pull/2617) | test: onboarding skill walk-12 — regression tests for /SKILL.md steps 1–2 | jill/wave500-g2-ob-walk12 |
| [#2616](https://github.com/Uuriko/project-room/pull/2616) | fix: unicode email local parts are not agent mentions | jill/wave500-g1-unicode-mention-bound |
| [#2615](https://github.com/Uuriko/project-room/pull/2615) | wave500-g10-inbox-audit: approval inbox decision journal (append-only, hash-chained) | jill/wave500-g10-inbox-audit |
| [#2614](https://github.com/Uuriko/project-room/pull/2614) | Add native app observations and private window screenshots for local agents | codex/mac-observation-tools-1011 |
| [#2613](https://github.com/Uuriko/project-room/pull/2613) | test: give the executor-timeout test headroom over the spawn chain | wave500-g1-fix-executor-timeout-flake |
| [#2612](https://github.com/Uuriko/project-room/pull/2612) | Keep the Codex Room host listening for shared asks | codex/codex-host-supervisor-1011 |
| [#2611](https://github.com/Uuriko/project-room/pull/2611) | Keep desktop tool connections working with isolated agent homes | codex/native-explicit-connection-1011 |
| [#2610](https://github.com/Uuriko/project-room/pull/2610) | WAVE-500 guild 10 slice 30/50: approval-inbox e2e journey test | jill/wave500-g10-inbox-e2e |
| [#2609](https://github.com/Uuriko/project-room/pull/2609) | Clarify assistant status beside the room connection | codex/assistant-readiness-copy-1011 |
| [#2608](https://github.com/Uuriko/project-room/pull/2608) | [remedy] fail-first repro: lease validation vs claim/ack mutation race after expiry/reacquisition (A4) | jill/wave500-g9-remedy-expiry-race |
| [#2607](https://github.com/Uuriko/project-room/pull/2607) | password change now kills other sessions and account keys | wave500-g1-auth-sess-rev |
| [#2606](https://github.com/Uuriko/project-room/pull/2606) | WAVE-500 g6-12: fail-first R36-1 resubmit acceptance tests (tests-only) | w500/g6-12-r361-tests |
| [#2605](https://github.com/Uuriko/project-room/pull/2605) | Isolate throwing wake-waiter callbacks during signal release (WAVE-500 g5 E2) | w500-g5/e2 |
| [#2604](https://github.com/Uuriko/project-room/pull/2604) | WAVE-500 g10: approval-inbox digest renderer (replaces evening tap-list digest) | jill/wave500-g10-inbox-digest |
| [#2603](https://github.com/Uuriko/project-room/pull/2603) | Use the green cube for the desktop Dock icon | codex/desktop-cube-icon-1011 |
| [#2602](https://github.com/Uuriko/project-room/pull/2602) | WAVE-500 G1: bind Google OAuth state completion to the starting browser session (login CSRF) | jill/wave500-g1-google-oauth-state-binding |
| [#2601](https://github.com/Uuriko/project-room/pull/2601) | WAVE-500 guild 10 slice 13/50: approval-inbox health metrics | jill/wave500-g10-inbox-metrics |
| [#2600](https://github.com/Uuriko/project-room/pull/2600) | fix(pages): og/twitter share tags on /join | wave500/g7/c14 |
| [#2599](https://github.com/Uuriko/project-room/pull/2599) | WAVE-500 guild 10 slice 29/50: approval-inbox DASHBOARD | jill/wave500-g10-inbox-dashboard |
| [#2598](https://github.com/Uuriko/project-room/pull/2598) | g7-a5: neutralize credential-bearing handoff URL links at render | wave500/g7/a5 |
| [#2597](https://github.com/Uuriko/project-room/pull/2597) | Fix board card horizontal overflow at 360px (owner names, file paths) | wave500/g8-overflow-board |
| [#2596](https://github.com/Uuriko/project-room/pull/2596) | Privacy: an agent that joins by guest share link reads only from its join | gb/share-link-agent-since-join-1011 |
| [#2595](https://github.com/Uuriko/project-room/pull/2595) | Approval-inbox card templates (WAVE-500 G10 26/50) | jill/wave500-g10-inbox-templates |
| [#2594](https://github.com/Uuriko/project-room/pull/2594) | HS2 2a/2b: shared anti-loop counts (rebase of #2343) | gb/anti-loop-count-1011 |
| [#2593](https://github.com/Uuriko/project-room/pull/2593) | Fix sticky per-host cadence: bare heartbeats no longer wipe cadenceSeconds | w500-g5/a3 |
| [#2592](https://github.com/Uuriko/project-room/pull/2592) | test: repro — agent directory receipt count includes owner-hidden receipts | jill/wave500-g2-support-receiptfill |
| [#2591](https://github.com/Uuriko/project-room/pull/2591) | fix: name work permissions in words when a member asks to take work (R32-1) | wave500/g7/b10 |
| [#2590](https://github.com/Uuriko/project-room/pull/2590) | WAVE-500 g10 slice 4/50: approval inbox REST routes | jill/wave500-g10-inbox-routes |
| [#2589](https://github.com/Uuriko/project-room/pull/2589) | Carry scratch-host Stop cleanup and atomic publication onto current main | codex/scratch-stop-carry-2510-1011 |
| [#2588](https://github.com/Uuriko/project-room/pull/2588) | WAVE-500 g10/10 slice 8/50: tap-list importer for the approval inbox | jill/wave500-g10-inbox-import |
| [#2587](https://github.com/Uuriko/project-room/pull/2587) | WAVE-500 g10 slice 24: approval-inbox retention policy | jill/wave500-g10-inbox-retention |
| [#2586](https://github.com/Uuriko/project-room/pull/2586) | test: fail-first repro for braced-rename numstat misclassification (G2 support for #2538) | jill/wave500-g2-support-codedrop |
| [#2585](https://github.com/Uuriko/project-room/pull/2585) | [remedy] fail-first repro: overlapping-scope duplicate wake delivery (#2536 blocker 1) | jill/wave500-g9-remedy-scope-dup |
| [#2584](https://github.com/Uuriko/project-room/pull/2584) | R36-2 fail-first repro: demoted coordinator stop report refused after owner Stop | pr-wave500-g6-r362-repro |
| [#2583](https://github.com/Uuriko/project-room/pull/2583) | WAVE-500 g10: approval-inbox search query layer (slice 11/50) | jill/wave500-g10-inbox-search |
| [#2582](https://github.com/Uuriko/project-room/pull/2582) | passkeys: cborDecode rejects truncated length prefixes with TypeError | jill/wave500-g1-attest-cbor |
| [#2581](https://github.com/Uuriko/project-room/pull/2581) | test: fail-first repro for R36-1 resubmission hazard (WAVE-500 g7-b2) — REPRO ONLY | wave500/g7/b2 |
| [#2580](https://github.com/Uuriko/project-room/pull/2580) | [remedy] fail-first repro: concurrent acquireListenerLease double-success | jill/wave500-g9-remedy-double-acquire |
| [#2579](https://github.com/Uuriko/project-room/pull/2579) | WAVE-500 g10/s1: approval-inbox SQLite store | jill/wave500-g10-inbox-store |
| [#2578](https://github.com/Uuriko/project-room/pull/2578) | fix: symmetric NFD/NFC importer lookup; hoist composed index out of resolveSpecifier | jill/wave500-g1-2535-nfd-followup |
| [#2577](https://github.com/Uuriko/project-room/pull/2577) | Opt-in outbound webhooks for approval-inbox card transitions (WAVE-500 g10 slice 27/50) | jill/wave500-g10-inbox-webhooks |
| [#2576](https://github.com/Uuriko/project-room/pull/2576) | repro: feed title truncation can split a grapheme cluster (ZWJ / regional indicator) | jill/wave500-g2-support-opps |
| [#2575](https://github.com/Uuriko/project-room/pull/2575) | fix: do not route a shorter display name inside a longer unicode token | jill/wave500-g1-mention-unicode-boundary |
| [#2574](https://github.com/Uuriko/project-room/pull/2574) | test: pin opportunities feed title honesty — no synthesized titles | wave500/g7/a3 |
| [#2573](https://github.com/Uuriko/project-room/pull/2573) | WAVE-500 G10: approval-inbox queue core (slice 2/50) | jill/wave500-g10-inbox-core |
| [#2572](https://github.com/Uuriko/project-room/pull/2572) | WAVE-500 G10: approval-inbox terminal CLI | jill/wave500-g10-inbox-cli |
| [#2571](https://github.com/Uuriko/project-room/pull/2571) | [remedy] fail-first repro: wake ack not fenced by signal holder | wave500-g9/remedy-ack-fence |
| [#2570](https://github.com/Uuriko/project-room/pull/2570) | Fail-first tests: version fencing on approval verdicts (R36-1 slice) | w500g6-16 |
| [#2569](https://github.com/Uuriko/project-room/pull/2569) | test: fail-first repro for empty-userinfo webhook URLs (adjacent to #2549) | jill/wave500-g2-support-webhook |
| [#2568](https://github.com/Uuriko/project-room/pull/2568) | approval inbox: dark-first CSS for unified approval cards (wave500-g10) | jill/wave500-g10-inbox-css |
| [#2567](https://github.com/Uuriko/project-room/pull/2567) | docs: approval inbox canonical doc (WAVE-500 guild 10 slice 19/50) | jill/wave500-g10-inbox-docs |
| [#2566](https://github.com/Uuriko/project-room/pull/2566) | w500-g5-b1: a throwing wake waiter no longer wedges the agent's other waiters | w500-g5/b1 |
| [#2564](https://github.com/Uuriko/project-room/pull/2564) | test: fail-first repros for cross-scope wake-claim steal (WAVE-500 g6-02) | w500g6-02/cross-scope-claim-repro |
| [#2563](https://github.com/Uuriko/project-room/pull/2563) | Approval-inbox agent skill doc (Bolter teardown steal #3) | jill/wave500-g10-inbox-skill |
| [#2559](https://github.com/Uuriko/project-room/pull/2559) | test: fail-first repro — handoff url query/fragment bearer tokens must be rejected | jill/wave500-g2-support-handoff |
| [#2557](https://github.com/Uuriko/project-room/pull/2557) | WAVE-500 guild 10 slice 3/50: approval-inbox POLICY gate | jill/wave500-g10-inbox-policy |
| [#2555](https://github.com/Uuriko/project-room/pull/2555) | fix(shed): publish heartbeat snapshots atomically | dot/shed-heartbeat-atomic-20261011 |
| [#2553](https://github.com/Uuriko/project-room/pull/2553) | Require terminal evidence for native Codex acceptance | jdot/native-codex-terminal-gate-20261011 |
| [#2552](https://github.com/Uuriko/project-room/pull/2552) | Assets v0: opt-in per-room sound cues and ask status motion (no app.js, no human-experience files) | gb/room-sounds-motion |
| [#2550](https://github.com/Uuriko/project-room/pull/2550) | Room sounds, arrival pulse and empty-room art | claude/room-sounds-and-art |
| [#2547](https://github.com/Uuriko/project-room/pull/2547) | fix: keep a truncated opportunity title well-formed | grok/opportunities-title-surrogate-1010 |
| [#2546](https://github.com/Uuriko/project-room/pull/2546) | Per-run receipts: four-field run receipts + linkable receipt view (Bolter steal #2) | jill/run-receipts-20261010 |
| [#2540](https://github.com/Uuriko/project-room/pull/2540) | fix: fill the agent room list with live memberships | grok/agent-room-list-page-20261010 |
| [#2539](https://github.com/Uuriko/project-room/pull/2539) | fix: decode a git-quoted path in a code drop | grok/code-drop-quoted-path-20261010 |
| [#2538](https://github.com/Uuriko/project-room/pull/2538) | fix: exclude a git-quoted generated path from the diff-size gate | grok/diff-size-quoted-generated-20261010 |
| [#2537](https://github.com/Uuriko/project-room/pull/2537) | fix: do not route a shorter agent handle inside a longer token | grok/mention-unicode-suffix-20261010 |
| [#2535](https://github.com/Uuriko/project-room/pull/2535) | fix: select the NFC test when the changed path is NFD | grok/verify-nfd-path-20261010 |
| [#2534](https://github.com/Uuriko/project-room/pull/2534) | fix: match a display name when case folding expands it | grok/mention-fold-span-20261010 |
| [#2532](https://github.com/Uuriko/project-room/pull/2532) | fix: restore saved-message navigation and wrap Updates titles | jdot/saved-updates-polish-20261010 |
| [#2531](https://github.com/Uuriko/project-room/pull/2531) | share-link-join-concurrency: constrain the child RESULT code to a known set | land/jallow |
| [#2519](https://github.com/Uuriko/project-room/pull/2519) | timeline: bring your own sent message into view; the pill counts others only (R26-1) | land/r261 |
| [#2517](https://github.com/Uuriko/project-room/pull/2517) | Let owner-delegated agent admins record decisions | claude/agent-admin-decisions |
| [#2516](https://github.com/Uuriko/project-room/pull/2516) | Agent docs: say how to get the room command; plain agent sign-in error | claude/agent-docs-get-room |
| [#2513](https://github.com/Uuriko/project-room/pull/2513) | fix: an email address is not an already asked agent | grok/ask-email-mention-20261010 |
| [#2512](https://github.com/Uuriko/project-room/pull/2512) | join-agent: say what the invite link granted | claude/join-agent-grant-copy |
| [#2510](https://github.com/Uuriko/project-room/pull/2510) | Stop running assistant executors and atomically publish their answers | codex/assistant-execution-stop-20261010 |
| [#2509](https://github.com/Uuriko/project-room/pull/2509) | fix: treat an NFD path as the claimed Begin scope | grok/begin-scope-nfd-20261010 |
| [#2508](https://github.com/Uuriko/project-room/pull/2508) | fix: treat NFC and NFD spellings as one file in landing facts | grok/landing-lease-nfd-20261010 |
| [#2507](https://github.com/Uuriko/project-room/pull/2507) | Claude stack: design pass 3, Work panel, presence strip, cube branding (look at on staging first) | claude/stack-design-pass-3 |
| [#2506](https://github.com/Uuriko/project-room/pull/2506) | Cold-start probe: judge the Worker's time, cap the wall clock separately | claude/cold-start-probe |
| [#2505](https://github.com/Uuriko/project-room/pull/2505) | fix: treat NFC and NFD paths as one file in review scope | grok/scope-nfd-path-20261010 |
| [#2504](https://github.com/Uuriko/project-room/pull/2504) | fix: treat NFC and NFD spellings as one file in holders | grok/holders-nfd-path-20261010 |
| [#2503](https://github.com/Uuriko/project-room/pull/2503) | fix: record an NFC work-item claim that overlaps an NFD path | grok/claim-overlap-nfd-20261010 |
| [#2502](https://github.com/Uuriko/project-room/pull/2502) | fix: refuse an NFD public-work claim on an NFC leased file | grok/public-work-nfd-overlap-20261010 |
| [#2500](https://github.com/Uuriko/project-room/pull/2500) | fix: treat NFC and NFD claim paths as one file in the client guard | grok/guard-nfd-path-20261010 |
| [#2499](https://github.com/Uuriko/project-room/pull/2499) | fix: refuse an NFC claim that overlaps an NFD reservation | grok/claim-scope-nfd-20261010 |
| [#2498](https://github.com/Uuriko/project-room/pull/2498) | fix: refuse a dot-segment path over a leased file | grok/lease-dot-segment-20261010 |
| [#2497](https://github.com/Uuriko/project-room/pull/2497) | fix: flag NFC and NFD claims on the same file | grok/claim-nfd-collision-20261010 |
| [#2495](https://github.com/Uuriko/project-room/pull/2495) | fix: skip a redacted null body in room search | grok/search-redacted-body-20261010 |
| [#2493](https://github.com/Uuriko/project-room/pull/2493) | fix: hide a pre-floor outside-agent note | grok/outside-agent-history-floor-20261010 |
| [#2491](https://github.com/Uuriko/project-room/pull/2491) | fix: fill the public room directory page with visible rooms | grok/directory-hidden-page-20261010 |
| [#2489](https://github.com/Uuriko/project-room/pull/2489) | fix: hide a pre-floor pinned message body | grok/pin-history-floor-20261010 |
| [#2487](https://github.com/Uuriko/project-room/pull/2487) | fix: hide a pre-floor needs-me mention body | grok/needs-me-history-floor-20261010 |
| [#2485](https://github.com/Uuriko/project-room/pull/2485) | fix: hide a room file committed before a since_join floor | grok/file-history-floor-20261010 |
| [#2484](https://github.com/Uuriko/project-room/pull/2484) | fix: hide a pre-floor reply request body | grok/reply-history-floor-20261010 |
| [#2481](https://github.com/Uuriko/project-room/pull/2481) | fix: fill the public receipt page with visible receipts | grok/receipt-hidden-page-20261010 |
| [#2480](https://github.com/Uuriko/project-room/pull/2480) | fix: hide a pre-floor mention from the updates feed | grok/updates-history-floor-20261010 |
| [#2469](https://github.com/Uuriko/project-room/pull/2469) | [PATCH] TST-15: test naming and ownership map (report only) | jill/fo-tst15-test-map |
| [#2458](https://github.com/Uuriko/project-room/pull/2458) | TST-14: patch-series apply checker for room-file handoffs | jill/fo-tst14-patch-check-20261010 |
| [#2452](https://github.com/Uuriko/project-room/pull/2452) | New room form: make validation failures visible, fix room-limit copy | land/newroomform2 |
| [#2451](https://github.com/Uuriko/project-room/pull/2451) | 3b: 'Add to this ask' affordance on the ask card | fixwave/b4-3b2 |
| [#2444](https://github.com/Uuriko/project-room/pull/2444) | TST-13: read-only probe of every public GET route (Fo handoff) | jill/fo-tst13-public-probe |
| [#2443](https://github.com/Uuriko/project-room/pull/2443) | fixwave/a3: #942 finding 2 — holder proof-of-possession on identities.link() | fixwave/a3 |
| [#2442](https://github.com/Uuriko/project-room/pull/2442) | fixwave/a3: declare ROOM_BACKUPS R2 binding in checked-in config (#1805) | fixwave/a3-room-backups |
| [#2440](https://github.com/Uuriko/project-room/pull/2440) | fixwave/a3: SEC — gate referral-invites.mint on email verification (rebased #1797) | fixwave/a3-referral-gate |
| [#2439](https://github.com/Uuriko/project-room/pull/2439) | 1d hs2-room-in-a-paste: single-line paste that provisions a room | fixwave/b2-1d |
| [#2438](https://github.com/Uuriko/project-room/pull/2438) | 1c hs2-webhook-counts: counts-only agent.wake webhook by default + redelivery | fixwave/b2 |
| [#2437](https://github.com/Uuriko/project-room/pull/2437) | HS2 1b: device-code agent connect (server/device-codes.mjs + /approve/<code>) | fixwave/b1 |
| [#2429](https://github.com/Uuriko/project-room/pull/2429) | #1905 (slice 1): group-commit command pipeline for POST /commands | fixwave/c1 |
| [#2428](https://github.com/Uuriko/project-room/pull/2428) | fixwave-e: land guild-06 SDK contract repairs (M1-M5) + stale test fix | fixwave/e-sdk |
| [#2426](https://github.com/Uuriko/project-room/pull/2426) | rb-account-delete-500: share-link-joined accounts delete without a 500 | fixwave/c3-account-delete |
| [#2425](https://github.com/Uuriko/project-room/pull/2425) | QA-C10: folded projection id must not release another member's board card | fixwave/c3 |
| [#2424](https://github.com/Uuriko/project-room/pull/2424) | fixwave-b5: disable Create with inline People explanation when no reviewer is eligible | fixwave/b5 |
| [#2422](https://github.com/Uuriko/project-room/pull/2422) | fixwave C2: instance-lock PID-reuse false positive (WAVE-500 S-instance-lock) | fixwave/c2-instance-lock |
| [#2420](https://github.com/Uuriko/project-room/pull/2420) | fixwave C2: herdr-migrate journal robustness (WAVE-500 B1/B2) | fixwave/c2-herdr |
| [#2418](https://github.com/Uuriko/project-room/pull/2418) | fix(deps): patch sharp/undici CVEs via overrides (cloudflare, relay) [fixwave-a2 rebase of #1972] | fixwave/a2-1972 |
| [#2404](https://github.com/Uuriko/project-room/pull/2404) | fix: name a git-quoted path on a code-drop card | grok/code-drop-quoted-path-20261009 |
| [#2397](https://github.com/Uuriko/project-room/pull/2397) | fix: scan a secret when git quotes the diff path | grok/diff-gate-quoted-path-20261009 |
| [#2396](https://github.com/Uuriko/project-room/pull/2396) | fix: scan secrets behind a quoted diff header | grok/cycle-fix-20261009 |
| [#2395](https://github.com/Uuriko/project-room/pull/2395) | fix: a trailing sentence mark is the same display name | grok/display-name-trailing-punct-20261009 |
| [#2394](https://github.com/Uuriko/project-room/pull/2394) | Gate the public OAuth provider surface on real connectors (A28) | land/a28oauth |
| [#2393](https://github.com/Uuriko/project-room/pull/2393) | Say what a guest join actually does in the switch warning (A27) | land/a27join |
| [#2392](https://github.com/Uuriko/project-room/pull/2392) | Give human owners a Transfer ownership control (8375) | land/a23transferb |
| [#2391](https://github.com/Uuriko/project-room/pull/2391) | Document why the uncalled /api/account/onboarding route stays | land/a26doc |
| [#2390](https://github.com/Uuriko/project-room/pull/2390) | Use the attention-aware label in the catch-up Needs-you list | land/a25needs |
| [#2389](https://github.com/Uuriko/project-room/pull/2389) | Hide the Connect Room enroll button when agent connection is not allowed (8377) | land/a24connect |
| [#2388](https://github.com/Uuriko/project-room/pull/2388) | Distinguish proposed and accepted work in the Project dialog (8333) | land/a22dialog |
| [#2387](https://github.com/Uuriko/project-room/pull/2387) | Make the paste page's agent line conditional on the person's send | land/a18paste |
| [#2386](https://github.com/Uuriko/project-room/pull/2386) | Register un-wired browser suites in the test:browser shard plan | land/a21shards |
| [#2385](https://github.com/Uuriko/project-room/pull/2385) | Carry pending invitation into the signup verification mail URL | land/a20signup |
| [#2384](https://github.com/Uuriko/project-room/pull/2384) | antislop UI batch: sign-in tap targets, honest inbox empty state, room-link join, Log out wording (successor to #2373 without the reward-line hiding hunk) | land/antislop2373 |
| [#2383](https://github.com/Uuriko/project-room/pull/2383) | Fix growth-kit status writes bypassing the form-status visibility contract | land/a19growth |
| [#2382](https://github.com/Uuriko/project-room/pull/2382) | fix(guest-invites): mail-unconfigured bypass for the mint email gate (A16) | land/a16mail |
| [#2381](https://github.com/Uuriko/project-room/pull/2381) | fix(auth): cap rak_-minted browser sessions at 1 hour + document (F13 review) | land/f13rak |
| [#2380](https://github.com/Uuriko/project-room/pull/2380) | fix(work-claim-mirror): a folded projection id cannot release another member's card (C10) | land/a15fold |
| [#2379](https://github.com/Uuriko/project-room/pull/2379) | instance-lock: atomic publish, mutex reclaim, and own-pid stale reclaim (REL-23/A14) | land/a14lock |
| [#2378](https://github.com/Uuriko/project-room/pull/2378) | fix: branch expired-guest 401 text on v0/v1 membership (#1618) | land/r1884 |
| [#2377](https://github.com/Uuriko/project-room/pull/2377) | fix(guest-invites): cap counts this room's live invites, not every row ever minted (D-7) | land/johnstabcap |
| [#2376](https://github.com/Uuriko/project-room/pull/2376) | fix(pages): one fixed Help link across the door pages (fo-5) | land/a13help |
| [#2375](https://github.com/Uuriko/project-room/pull/2375) | docs(openapi): record that the served spec's exclusions are intentional (qa7-03) | land/qa703docs |
| [#2374](https://github.com/Uuriko/project-room/pull/2374) | fix(bonds): filter stale peer-DM threads out of listThreads (qa7-14) | land/a12bonds |
| [#2372](https://github.com/Uuriko/project-room/pull/2372) | fix(http): serve the /room/agents alias as the HTML directory page | land/a11agents |
| [#2371](https://github.com/Uuriko/project-room/pull/2371) | fix(public-work): explain an empty /api/public-work/match response (qa F12) | land/a10match |
| [#2370](https://github.com/Uuriko/project-room/pull/2370) | fix(app): give room admins the People member controls, not just the owner | land/a9people |
| [#2368](https://github.com/Uuriko/project-room/pull/2368) | Hide the Invite dialog from members without invite rights | land/a8invite |
| [#2367](https://github.com/Uuriko/project-room/pull/2367) | work claims: refuse bad keep in summarizeClaimHistory; skip work.superseded with no successor | land/fowave |
| [#2366](https://github.com/Uuriko/project-room/pull/2366) | fix: rak_ join tokens can wake - heartbeat scopes on onboarding keys + rak_ accepted in agent-wake (A2/A3) | land/a2a3b |
| [#2365](https://github.com/Uuriko/project-room/pull/2365) | Notify an agent when someone replies to its post | land/a4reply |
| [#2364](https://github.com/Uuriko/project-room/pull/2364) | Show agent rows in the People panel for the simple human experience | land/a7people |
| [#2361](https://github.com/Uuriko/project-room/pull/2361) | fix(#1609): add seeAlso pointer to the public-work pool in /api/opportunities.json | land/o1900b |
| [#2360](https://github.com/Uuriko/project-room/pull/2360) | fix(#1566): expose starter on MCP room_create for REST/MCP parity | land/m1896b |
| [#2359](https://github.com/Uuriko/project-room/pull/2359) | herdr-migrate: pre-validate operator authority in force-release (#2009) | land/herdr2009b |
| [#2358](https://github.com/Uuriko/project-room/pull/2358) | fix(client): null-safe message body reads for redacted-but-live messages | land/nullsafe1981b |
| [#2357](https://github.com/Uuriko/project-room/pull/2357) | Make older message and work search matches reachable | codex/week-search-paging-20261010 |
| [#2352](https://github.com/Uuriko/project-room/pull/2352) | feedback: persist the store to SQLite so filings survive a restart (REL-25); register feedback_state in writer fence | land/fb2103 |
| [#2340](https://github.com/Uuriko/project-room/pull/2340) | Chat: opening a room no longer marks it read; since-join guest note (successor of #2338) | land/read-marker-since-join |
| [#2337](https://github.com/Uuriko/project-room/pull/2337) | Board: name the owned-work count 'to chase' so it stops clashing with the catch-up 'need you' pill | land/board-to-chase |
| [#2332](https://github.com/Uuriko/project-room/pull/2332) | Setup resume + mint 429 docs: day-tier Retry-After is real seconds | land/setup-resume-v3 |
| [#2311](https://github.com/Uuriko/project-room/pull/2311) | fix: drop a trailing sentence period from an @mention handle | grok/mention-trailing-period-20261009 |
| [#2306](https://github.com/Uuriko/project-room/pull/2306) | Publish shared assistant answers and completion atomically | codex/assistant-publish-20261009 |
| [#2287](https://github.com/Uuriko/project-room/pull/2287) | One invitation dialog at a time | grok/land-j-one-invite-dialog-1009 |
| [#2286](https://github.com/Uuriko/project-room/pull/2286) | Ask Room with no assistant says so | grok/land-g-ask-room-hint-1009 |
| [#2285](https://github.com/Uuriko/project-room/pull/2285) | identity: refuse a repetitive (guessable) client-chosen recoverable pri_ credential | land/pri-credential-diversity |
| [#2279](https://github.com/Uuriko/project-room/pull/2279) | tests: remove temp dirs after each file in 7 tests that leaked them (TST-04 fixture hygiene) | jill/tst04-tempdir-cleanup |
| [#2260](https://github.com/Uuriko/project-room/pull/2260) | PRODUCT-200 C4: restart-mid-commit crash-recovery properties (rebased #2245) | instinct/c4-restart-mid-commit-rebased |
| [#2256](https://github.com/Uuriko/project-room/pull/2256) | docs(skill): served /SKILL.md money framing — receipts today, cash later | product200/skill-a9-money |
| [#2255](https://github.com/Uuriko/project-room/pull/2255) | PRODUCT-200 C5: event-emission chaos scenarios under fault injection | jill/product200-c5-chaosevents |
| [#2254](https://github.com/Uuriko/project-room/pull/2254) | [m-10] Mobile error + empty states: thumb-sized 404, empty-state next action, 44px toast dismiss | jill/product200-m-10-mobile-error-empty |
| [#2253](https://github.com/Uuriko/project-room/pull/2253) | fix(mobile-invite-redeem): join timeout, double-submit guard, touch-safe autofocus, bare-code entry, CTA legibility | product200/m-03-mobile-invite-redeem |
| [#2250](https://github.com/Uuriko/project-room/pull/2250) | [BLOCKED — John's call] PRODUCT-200 HP-05: SKILL.md/llms.txt money-framing audit (do not merge) | jill/hp-05-skill-md-money-framing |
| [#2248](https://github.com/Uuriko/project-room/pull/2248) | client-craft(bu-08): referral board reuses the room's standard sidebar list classes | bu-08-referral-board-polish |
| [#2247](https://github.com/Uuriko/project-room/pull/2247) | test(board): BU-12 optimistic-update honesty pins + fail-first regression | jill/bu-12-board-truth |
| [#2233](https://github.com/Uuriko/project-room/pull/2233) | Board IA: one vocabulary (Done column, New claim, named counts, review rule, palette) | jill/product200-bu-10-nav-ia |
| [#2232](https://github.com/Uuriko/project-room/pull/2232) | PRODUCT-200 E3: surface identity rotate/revoke in onboarding docs + openapi | product200/walk-e3-rotate |
| [#2231](https://github.com/Uuriko/project-room/pull/2231) | [bu-01] Orienting empty states for the room Overview dialog | bu-01-empty-states-r3 |
| [#2230](https://github.com/Uuriko/project-room/pull/2230) | Board attention UI: per-card needs-you badges + mount push soft ask | jill/bu-13-attention-ui |
| [#2229](https://github.com/Uuriko/project-room/pull/2229) | H3 privacy: account-deletion purge + data export (rebase, supersedes #1987) | fo/h3-1987-rebase |
| [#2228](https://github.com/Uuriko/project-room/pull/2228) | PRODUCT-200 M-07: 44px coarse-pointer touch floor on the offers page | jill/product200-m-07-offers-touch-44px |
| [#2213](https://github.com/Uuriko/project-room/pull/2213) | HD-08: plain-language HTML error pages for browsers on public paths | jill/hd-08-error-pages-html |
| [#2211](https://github.com/Uuriko/project-room/pull/2211) | product200 m-12: compact emoji-catalog.js for mobile first-paint budget | jill/product200-m12-mobile-perf |
| [#2210](https://github.com/Uuriko/project-room/pull/2210) | PWA behavior: service worker for every visitor, offline retry, iOS standalone metas | jill/product200-m-06-pwa |
| [#2197](https://github.com/Uuriko/project-room/pull/2197) | PRODUCT-200 reliability: chaos seed corpus + model-based differential tester + CI | jill/product200-c678-seeds |
| [#2195](https://github.com/Uuriko/project-room/pull/2195) | docs(skill): rate-limit guidance in SKILL.md — measured throttle stack + Retry-After rule | product200/skill-a5-ratelimit |
| [#2185](https://github.com/Uuriko/project-room/pull/2185) | docs(skill): honest empty-match recovery for strangers (PRODUCT-200 A2) | product200/skill-a2-emptymatch |
| [#2182](https://github.com/Uuriko/project-room/pull/2182) | PRODUCT-200 C1: deterministic seeded chaos harness scaffold | jill/product200-chaos-harness |
| [#2180](https://github.com/Uuriko/project-room/pull/2180) | ci(invariants): wire the invariant harness as a standalone CI gate | jill/product200-a12-cigate |
| [#2166](https://github.com/Uuriko/project-room/pull/2166) | mobile-nav: sync --workspace-nav-height with the measured fixed bottom bar | jill/product200-m-08-mobile-nav-height |
| [#2152](https://github.com/Uuriko/project-room/pull/2152) | docs(product200): B12 idempotency coverage synthesis report | jill/product200-b12-idempotency-synthesis |
| [#2150](https://github.com/Uuriko/project-room/pull/2150) | PRODUCT-200 HD-03: consolidate the four-door brand pileup (honest copy) | jill/product200-hd-03-four-doors |
| [#2149](https://github.com/Uuriko/project-room/pull/2149) | docs(skill): invite-redeem error recovery — close QA-200 docs/live drift (PRODUCT-200 A3) | product200/skill-a3-invite |
| [#2135](https://github.com/Uuriko/project-room/pull/2135) | QA: prototype selected-claim follow-through evidence brief | codex/claim-follow-through-experiment-20261009 |
| [#2130](https://github.com/Uuriko/project-room/pull/2130) | BU-11: board-UI accessibility regression guards (contrast ratios + dialog naming) | bu-11-board-a11y |
| [#2129](https://github.com/Uuriko/project-room/pull/2129) | Make agent work faster with batch commands and fix first-run workspace layout | codex/agent-efficiency-20261008 |
| [#2127](https://github.com/Uuriko/project-room/pull/2127) | feat(invariants): telemetry reporter + markdown renderer for the invariant harness | jill/product200-a14-invtelemetry |
| [#2124](https://github.com/Uuriko/project-room/pull/2124) | firstrun: empty-board guidance on public-work match (E1) | firstrun/e1 |
| [#2123](https://github.com/Uuriko/project-room/pull/2123) | firstrun: step-count harness for the stranger journey (M1) | firstrun/m1 |
| [#2112](https://github.com/Uuriko/project-room/pull/2112) | Keep open Project task statuses current during room updates | jill-dot/project-live-refresh-20261008 |
| [#2105](https://github.com/Uuriko/project-room/pull/2105) | QA8: closed/done Board items answer 409 work_claim_terminal; agent hints for unmapped codes | qa8/board-terminal-errors |
| [#2104](https://github.com/Uuriko/project-room/pull/2104) | Bound oversized KV backup rows and preserve exact bytes | codex/backup-large-row-20261008 |
| [#2103](https://github.com/Uuriko/project-room/pull/2103) | feedback: persist the store to SQLite so filings survive a restart (REL-25) | fo/rel25-feedback-durable |
| [#2091](https://github.com/Uuriko/project-room/pull/2091) | ch-2064: scope the invite_unavailable hint per invite family (+ sibling codes) | ch-2064/scope-invite-hint |
| [#2090](https://github.com/Uuriko/project-room/pull/2090) | ch-2056 challenge: fix not_found hint's two false diagnoses (stacked on #2056) | ch-2056/notfound-hint-followup |
| [#2083](https://github.com/Uuriko/project-room/pull/2083) | fix(priv-2): reactivation moves the since_join history floor past the removal gap | ch-2018 |
| [#2064](https://github.com/Uuriko/project-room/pull/2064) | fix: dedicated invite_unavailable hint in agentErrorAx | qa200-EP-03-invite-unavailable-hint |
| [#2050](https://github.com/Uuriko/project-room/pull/2050) | fix(claim-escrow-adapter): funding means the lock path ran, not just the flag [ch-1951 challenge] | ch-1951/escrow-funding-holes |
| [#2046](https://github.com/Uuriko/project-room/pull/2046) | fix(evaluator-seat): compare-and-swap bond writes so racing writers fail loudly [QA-200 challenge of #1950] | qa200/evaluator-seat-write-conflict |
| [#2016](https://github.com/Uuriko/project-room/pull/2016) | fix: prevent blind edits of private DMs | fix/owner-dm-edit |
| [#2008](https://github.com/Uuriko/project-room/pull/2008) | human-ux minors #1606/#1607: SW registration at startup; composer autocapitalize/autocorrect | sweep-followup/ux-minors-1606-1607 |
| [#2007](https://github.com/Uuriko/project-room/pull/2007) | GA-2 (#941): single-use guest links — join consumes the link (rescue of #1869) | jill/buildqa/sec-1869-guest-link-single-use |
| [#2006](https://github.com/Uuriko/project-room/pull/2006) | Keep attachment drafts and retries reliable; add Enter preference | codex/conversation-reliability-20261008 |
| [#2003](https://github.com/Uuriko/project-room/pull/2003) | Reduce human composer bulk and prioritize the experience backlog | codex/human-experience-plan-20261008 |
| [#2002](https://github.com/Uuriko/project-room/pull/2002) | fix: enforce REST spend parity and room file history visibility | fix/rest-spend-parity |
| [#2001](https://github.com/Uuriko/project-room/pull/2001) | Polish the sign-in logo and shared chat controls | codex/discord-polish-20261008 |
| [#1998](https://github.com/Uuriko/project-room/pull/1998) | Qualify shared web and Mac human and agent journeys | codex/web-desktop-readiness-20261008 |
| [#1997](https://github.com/Uuriko/project-room/pull/1997) | test(qa): storage recovery regression and watch ledger | qa/storage-recovery-regression |
| [#1995](https://github.com/Uuriko/project-room/pull/1995) | Add advisory agent work fit from attributed work evidence | codex/agent-work-fit-20261007 |
| [#1994](https://github.com/Uuriko/project-room/pull/1994) | REL-15: prove room posts are idempotent across REST and MCP (test-only) | fo/rel15-post-retry |
| [#1993](https://github.com/Uuriko/project-room/pull/1993) | D1: human onboarding copy matches the auto-created first room | jill/d1-stranger-onboarding |
| [#1992](https://github.com/Uuriko/project-room/pull/1992) | Simplify human invitations and preserve current-room sharing | codex/human-invite-polish-20261007 |
| [#1991](https://github.com/Uuriko/project-room/pull/1991) | Lane A1: enforce scoped API-key room scopes on hosted MCP tools | jill/audit-a1-auth-session |
| [#1990](https://github.com/Uuriko/project-room/pull/1990) | a11y: return focus to the invoking control when dialogs close (D3 audit) | jill/audit40-d3-a11y-focus |
| [#1989](https://github.com/Uuriko/project-room/pull/1989) | perf: read-path hot spots beyond #1857/#1865/#1872/#1895 (lane C2 audit) | c2-readpath-audit |
| [#1988](https://github.com/Uuriko/project-room/pull/1988) | g3: fix the quarantined p95 flake for real; deterministic confirmation-race test | g3/flake-quarantine-fixes |
| [#1986](https://github.com/Uuriko/project-room/pull/1986) | E2: first-5-minutes journey gaps — drained-queue guidance, tool-count drift, board close order | e2/first5min-journey-gaps |
| [#1985](https://github.com/Uuriko/project-room/pull/1985) | H2 backup/DR: whole-store NDJSON restore for the Durable Object + runbook | h2/backup-dr-restore-path |
| [#1984](https://github.com/Uuriko/project-room/pull/1984) | Preserve Board drafts and fix room chooser keyboard focus | codex/skip-room-chooser-20261007 |
| [#1983](https://github.com/Uuriko/project-room/pull/1983) | E1 MCP ergonomics: actionable XOR arg errors, honest room_create idempotency docs, optional receipt keys on bond/DM writes | jill/e1-mcp-ergonomics-audit |
| [#1982](https://github.com/Uuriko/project-room/pull/1982) | fix(mobile): wire the push soft ask into Notifications; 32px message menu target | jill/d2-push-ask |
| [#1981](https://github.com/Uuriko/project-room/pull/1981) | fix(client): null-safe message body reads for redacted-but-live messages | jill/b3-messaging-correctness-20261007 |
| [#1980](https://github.com/Uuriko/project-room/pull/1980) | perf: surgical projection-cache invalidation + post-write refresh on the write path | jill/c1-write-path-scale |
| [#1979](https://github.com/Uuriko/project-room/pull/1979) | fix(lifecycle): archived rooms refuse work-claim board writes (409 room_archived) | jill/h4-room-lifecycle-audit |
| [#1977](https://github.com/Uuriko/project-room/pull/1977) | H1: projection-cap relief valve — telemetry, 70/85/95% warnings, archival paging | h1/projection-relief-valve |
| [#1976](https://github.com/Uuriko/project-room/pull/1976) | H5 audit+fix: harden plug-in funnel metrics (stacked on #1937) | h5/plugin-funnel-harden |
| [#1974](https://github.com/Uuriko/project-room/pull/1974) | test: A4 secrets audit — credentials never echo in errors/events (regression lock) | lane-a4-secrets-handling |
| [#1973](https://github.com/Uuriko/project-room/pull/1973) | F4: webhook delivery OPS hardening — auto-pause dead subscriptions (qa7-12-webhook-autopause) | jill/f4-webhook-ops-hardening |
| [#1971](https://github.com/Uuriko/project-room/pull/1971) | fix(ci): pin malformed upload-artifact ref in soak-test.yml + SHA-pinning guard test | lane-a5/workflow-pin-guard |
| [#1970](https://github.com/Uuriko/project-room/pull/1970) | E3 permissions-legibility: 403 denials name the missing permission + point at access-requests | e3/permission-denials |
| [#1969](https://github.com/Uuriko/project-room/pull/1969) | perf(db): index the needs-me DM poll; per-room claim-reputation journal reads | jill-c5-db-index-hygiene |
| [#1968](https://github.com/Uuriko/project-room/pull/1968) | F5: document room export portability scope; pin with contract tests | jill/f5-export-portability-docs |
| [#1966](https://github.com/Uuriko/project-room/pull/1966) | G4: self-updating unit shard balancer (fresh durations from CI runs) | jill/wave40-g4-shard-balance |
| [#1964](https://github.com/Uuriko/project-room/pull/1964) | fix(pwa): offline page styles blocked by CSP; retry affordance + cached icon | jill/d2-offline-csp |
| [#1963](https://github.com/Uuriko/project-room/pull/1963) | fix(notifications): send-time quiet-hours re-check + service-worker stale-push drop | audit-B4-notif-fanout |
| [#1962](https://github.com/Uuriko/project-room/pull/1962) | feat(api): versioning + deprecation contract — X-API-Version, RFC 8594 Deprecation/Sunset/Link (audit F3) | jill/f3-api-versioning-deprecation |
| [#1961](https://github.com/Uuriko/project-room/pull/1961) | E2: pin skill reference anonymous MCP catalog to the live 7 tools | jill/e2-anon-catalog-copy |
| [#1960](https://github.com/Uuriko/project-room/pull/1960) | F1: OpenAPI live sweep — mechanical spec-vs-deployed drift check | jill/f1-openapi-live-sweep |
| [#1959](https://github.com/Uuriko/project-room/pull/1959) | a11y: room list exposes list/listitem semantics (D3 audit) | jill/audit40-d3-a11y |
| [#1958](https://github.com/Uuriko/project-room/pull/1958) | fix(client): adopt regressed snapshot after history replace instead of wedging the stream | jill-c3/stream-history-replace-wedge |
| [#1957](https://github.com/Uuriko/project-room/pull/1957) | fix(presence): stale host no longer masks a just-posted agent as unreachable | e4/presence-iso-ms |
| [#1956](https://github.com/Uuriko/project-room/pull/1956) | E5: directory listings carry a machine-readable join hint; A2A guide names ownerless paths | jill/e5-a2a-discovery-join-hints |
| [#1955](https://github.com/Uuriko/project-room/pull/1955) | D5 docs-vs-live: fix six→seven public-tool count and /api/health→/api/version drift | jill/d5-docs-drift-seven-tools |
| [#1954](https://github.com/Uuriko/project-room/pull/1954) | A2: gate ga1. guest-agent-link mint on email verification | a2/ga1-email-gate |
| [#1953](https://github.com/Uuriko/project-room/pull/1953) | REL-13: Durable Object transaction audit (Fo) | fo/rel13-do-txn-audit |
| [#1952](https://github.com/Uuriko/project-room/pull/1952) | Cold-start/deploy-health: smoke-prod gains revision pin + DO readiness, wired hourly | audit-c4/coldstart-deploy-smoke |
| [#1949](https://github.com/Uuriko/project-room/pull/1949) | fix(mcp): name the field in invalid_arguments for gate-only constraints | jill/f2-mcp-argument-errors |
| [#1948](https://github.com/Uuriko/project-room/pull/1948) | G5 audit: document ROOM_BODIES_AT_REST=1 pin and var persistence; runbook/workflow consistency test | jill/g5-deploy-var-docs |
| [#1946](https://github.com/Uuriko/project-room/pull/1946) | G1: Ubuntu 26 migration for test.yml AppArmor/bubblewrap sandbox setup | g1/ubuntu26-sandbox-migration |
| [#1942](https://github.com/Uuriko/project-room/pull/1942) | The Summons: the room calls the agent by name | lane8/summons-take3 |
| [#1941](https://github.com/Uuriko/project-room/pull/1941) | MCP ergonomics: rename confusing tools (backward-compat aliases), dm_send mints messageId, add room_read_work_claims | jill/lane4-mcp-ergonomics |
| [#1939](https://github.com/Uuriko/project-room/pull/1939) | HT-1 task 28: provider cost breakdown model + sensitivity analysis | feat/ht1-task-28-cost-model |
| [#1938](https://github.com/Uuriko/project-room/pull/1938) | HT-1 task 27: per-token cost instrument spec | feat/ht1-task-27-cost-instrument |
| [#1937](https://github.com/Uuriko/project-room/pull/1937) | Plug-in funnel metrics: doc read -> mint -> join -> first claim -> first receipt -> day-7 active | jill/plugin-funnel-metrics |
| [#1936](https://github.com/Uuriko/project-room/pull/1936) | HT-1 task 25: fee/reputation game-theoretic stability analysis | feat/ht1-task-25-gametheory |
| [#1934](https://github.com/Uuriko/project-room/pull/1934) | docs: exchange batch 3 — analytics, consensus, matching, notifications — hard tasks 111, 113–115 | feat/ht4-111-113-114-115-exchange-docs3 |
| [#1932](https://github.com/Uuriko/project-room/pull/1932) | Lane6 plug-in crew: the 'here's what you can do here' permission moment | lane6/permission-moment |
| [#1931](https://github.com/Uuriko/project-room/pull/1931) | REL-07..10: land Fo's handoff — room-only land items, accurate wake ackHint, stale-signal TTL, events-limit 422 clarity | wave40-W34/fo-rel07-10-series |
| [#1930](https://github.com/Uuriko/project-room/pull/1930) | HT-1 task 9: x402-style payment-gated API demo (server + client) | feat/ht1-task-9-x402-demo |
| [#1929](https://github.com/Uuriko/project-room/pull/1929) | HT-1 task 18: dispute-resolution simulator + ruling logic | feat/ht1-task-18-dispute-sim |
| [#1928](https://github.com/Uuriko/project-room/pull/1928) | docs: money-adjacent exchange specs — Season-0 bridge, fee analysis, points simulator — hard tasks 110, 119, 120 | feat/ht4-110-119-120-money-specs |
| [#1927](https://github.com/Uuriko/project-room/pull/1927) | HT-1 task 11: provider onboarding attestation spec + verifier | feat/ht1-task-11-provider-attestation |
| [#1926](https://github.com/Uuriko/project-room/pull/1926) | docs: exchange batch 2 — dispute evidence, reputation, 25 bounty templates — hard tasks 107–109 | feat/ht4-107-109-exchange-docs2 |
| [#1925](https://github.com/Uuriko/project-room/pull/1925) | lane1/first5min: un-dead-end the first-claim funnel when the volunteer board is empty | lane1/plugin-first5min-2026-10-07 |
| [#1924](https://github.com/Uuriko/project-room/pull/1924) | HT-1 task 10: settlement security model | feat/ht1-task-10-security-model |
| [#1923](https://github.com/Uuriko/project-room/pull/1923) | Lane 5: wake-signal retention — a quiet queue for returning agents | lane5/wake-signal-retention |
| [#1922](https://github.com/Uuriko/project-room/pull/1922) | HT-1 task 8: CCTP v2 funding metadata model + simulator | feat/ht1-task-8-cctp-funding |
| [#1919](https://github.com/Uuriko/project-room/pull/1919) | HT-1 task 19: settlement API surface design + mock server + client test | feat/ht1-task-19-settlement-api |
| [#1917](https://github.com/Uuriko/project-room/pull/1917) | fix(connectors): dogfood muse.md brief against the real API (ht5-96) | wave40-W15-ht5-96-muse-brief |
| [#1916](https://github.com/Uuriko/project-room/pull/1916) | task 175: webhook security review — forged/replayed delivery tests + review doc | wave40/W38-webhook-security-review |
| [#1915](https://github.com/Uuriko/project-room/pull/1915) | HT-6 (161/163/164/165/167/168/169/170): security & reliability docs | ht-6/docs |
| [#1914](https://github.com/Uuriko/project-room/pull/1914) | HT-6 (166): chaos-scenarios suite + export truncation fails loudly | ht-6/166-code |
| [#1913](https://github.com/Uuriko/project-room/pull/1913) | discovery: fix access-request contract in /SKILL.md, agent card, and 405 hint | jill/plugin-discovery-a2a |
| [#1912](https://github.com/Uuriko/project-room/pull/1912) | HT-1 task 14: multi-epoch settlement accounting ledger + reconciler | feat/ht1-task-14-settlement-ledger |
| [#1911](https://github.com/Uuriko/project-room/pull/1911) | fix(wake): active reaction acks the reactor's own pending wake signals | wave40-W29/wake-reaction-ack |
| [#1910](https://github.com/Uuriko/project-room/pull/1910) | feat: credits ledger v1 + bounty lifecycle + escrow timeouts — hard tasks 101, 116, 102, 112 | feat/ht4-101-116-credits-ledger |
| [#1909](https://github.com/Uuriko/project-room/pull/1909) | fix(#1554): bond_propose 404 to unlinked identity carries hint/next | is-sec-3/fix-1554 |
| [#1903](https://github.com/Uuriko/project-room/pull/1903) | fix(#1847): verifyChain truncation anchor — optional { expectedLength, expectedHeadHash } | wave40-W30-topic |
| [#1902](https://github.com/Uuriko/project-room/pull/1902) | Fix #1522: bind createJoinSession sessions to the identity secret hash | wave40-W23-topic |
| [#1901](https://github.com/Uuriko/project-room/pull/1901) | test: regression for #834 — full-verb rebuild --out <in-repo> --commit-push commits and pushes | wave40-W07/rebuild-834-regression |
| [#1897](https://github.com/Uuriko/project-room/pull/1897) | test+lint: import-closure analyzer covers dynamic import(), require(), JSON modules | wave40-W16-import-closure |
| [#1894](https://github.com/Uuriko/project-room/pull/1894) | Deploy supply-chain audit + fail-closed signing guard [wave40-W11] | wave40-W11-supply-chain-audit |
| [#1893](https://github.com/Uuriko/project-room/pull/1893) | HT-1 task 29: orchestration overhead measurement harness + report | feat/ht1-task-29-overhead-harness |
| [#1890](https://github.com/Uuriko/project-room/pull/1890) | fix(mcp): pre-gate onboarding tokens keep heartbeat/wake + inbox; insufficient_scope is an access error | wave40-W06-mcp-legacy-wake |
| [#1889](https://github.com/Uuriko/project-room/pull/1889) | Fix #1522: join sessions bound to identity secret hash (rotation now kills them) | fix/1522-join-session-secret-binding |
| [#1888](https://github.com/Uuriko/project-room/pull/1888) | test: channel permission matrix — role×action grid for create/rename/archive (200-hard-tasks #88) | w18/channel-permission-matrix |
| [#1887](https://github.com/Uuriko/project-room/pull/1887) | HT-1 task 20: kill-criteria and tripwire rules + evaluator | feat/ht1-task-20-tripwires |
| [#1885](https://github.com/Uuriko/project-room/pull/1885) | Lane 2: rewrite SWARM-PLUG-IN.md as cold-start-first reference | jill/lane2-plugindoc-rewrite |
| [#1883](https://github.com/Uuriko/project-room/pull/1883) | Tests for #1526: PR settlement idempotency across cron and webhook | fix/issue-1526-is-sec-2 |
| [#1882](https://github.com/Uuriko/project-room/pull/1882) | Lane9 ladder: you.standing block on the orient endpoint | lane9/plugin-ladder |
| [#1881](https://github.com/Uuriko/project-room/pull/1881) | security hardening: 200-hard-tasks #171/#173/#175/#176/#179 implementation | ht-7/sec-impl-171-180 |
| [#1879](https://github.com/Uuriko/project-room/pull/1879) | test: import-closure lint follows relative dynamic import() + JSON import attributes (ht-82) | wave40-W22-pick |
| [#1878](https://github.com/Uuriko/project-room/pull/1878) | Harness: self-dogfood 10-journey synthetic user walkthrough (200-hard-tasks #84) | feat/ht3-self-dogfood |
| [#1877](https://github.com/Uuriko/project-room/pull/1877) | Lint: import-closure follows dynamic relative imports (200-hard-tasks #82) | feat/ht3-import-closure-dynamic |
| [#1875](https://github.com/Uuriko/project-room/pull/1875) | Add work-claims protocol fuzzer (200-hard-tasks #86) | feat/ht3-claims-fuzzer |
| [#1874](https://github.com/Uuriko/project-room/pull/1874) | HT-1 task 12: settlement reorg/reconciliation test matrix (14 cases) | feat/ht1-task-12-reconciliation-matrix |
| [#1873](https://github.com/Uuriko/project-room/pull/1873) | CI: measure coverage from unit shards instead of re-running the suite | jill/hardwork-ci-coverage-shards |
| [#1870](https://github.com/Uuriko/project-room/pull/1870) | HT-1 task 13: escrow cancellation/refund path hardening | feat/ht1-task-13-escrow-refund |
| [#1868](https://github.com/Uuriko/project-room/pull/1868) | HT-1 task 3: idempotency-key + replay-protection design | feat/ht1-task-3-idempotency |
| [#1867](https://github.com/Uuriko/project-room/pull/1867) | docs: dogfood the Muse connector brief — 15 friction fixes — hard task 96 | feat/ht4-96-muse-brief |
| [#1865](https://github.com/Uuriko/project-room/pull/1865) | perf: share immutable primitives in the reducer's state clone | jill-perf-clone-state |
| [#1863](https://github.com/Uuriko/project-room/pull/1863) | HT-1 task 5: job-acceptance vs payment-finality state machine | feat/ht1-task-5-job-payment-states |
| [#1861](https://github.com/Uuriko/project-room/pull/1861) | ops: one-shot VAPID provisioning workflow (dispatch-only) | ops/provision-vapid |
| [#1859](https://github.com/Uuriko/project-room/pull/1859) | HT-1 task 4: signed settlement receipt schema + dasha-verify-receipt CLI | feat/ht1-task-4-receipt-cli |
| [#1858](https://github.com/Uuriko/project-room/pull/1858) | test: MCP scope pins — per-tool surface snapshot + identity-secret access check — hard task 94 | feat/ht4-94-mcp-scope-pins |
| [#1857](https://github.com/Uuriko/project-room/pull/1857) | perf: pin mention_states as the driving table in mention reads | jill-perf-mention-join |
| [#1856](https://github.com/Uuriko/project-room/pull/1856) | HT-1 task 30: demand-side job-flow simulator + saturation report | feat/ht1-task-30-demand-simulator |
| [#1855](https://github.com/Uuriko/project-room/pull/1855) | fix(polls): normalize FE0F-less keycap votes to the stored option emoji | jill/hardwork-wildcard-poll-vote-key |
| [#1854](https://github.com/Uuriko/project-room/pull/1854) | Mobile page weight: pack emoji catalog 197KB -> 126KB (hardwork-mobile-1) | jill/hardwork-mobile-emoji-weight |
| [#1850](https://github.com/Uuriko/project-room/pull/1850) | test: A2A enrollment conformance suite for SWARM-PLUG-IN.md — hard task 93 | feat/ht4-93-a2a-conformance |
| [#1849](https://github.com/Uuriko/project-room/pull/1849) | HT-1 task 24: provider reputation score design + simulator | feat/ht1-task-24-reputation |
| [#1843](https://github.com/Uuriko/project-room/pull/1843) | HT-1 task 23: canary sampling design + simulator | feat/ht1-task-23-canary-sampling |
| [#1840](https://github.com/Uuriko/project-room/pull/1840) | HT-1 task 21: gateway-side metering prototype + divergence report | feat/ht1-task-21-gateway-metering |
| [#1837](https://github.com/Uuriko/project-room/pull/1837) | HT-1 task 22: real tokenizer integration (3 model families, vendored ranks) | feat/ht1-task-22-tokenizer |
| [#1832](https://github.com/Uuriko/project-room/pull/1832) | docs(onboarding-skill): document mint PoW and recoverable mints | jill/hardwork-onboarding-skill-mint-docs |
| [#1831](https://github.com/Uuriko/project-room/pull/1831) | HT-1 task 15: canonical adapter conformance harness + certification procedure | feat/ht1-task-15-conformance-harness |
| [#1829](https://github.com/Uuriko/project-room/pull/1829) | #1601: human digest pipeline + in-app notification center | fix/issue-1601-is-ux-1 |
| [#1828](https://github.com/Uuriko/project-room/pull/1828) | fix(agent-invite): redeem next names the room token, not a missing identity credential | jill/hardwork-onboarding-agentcode-next |
| [#1827](https://github.com/Uuriko/project-room/pull/1827) | PWA installability: register SW on load, wire install prompt (wave2-1606-pwa) | jill/wave2-1606-pwa |
| [#1826](https://github.com/Uuriko/project-room/pull/1826) | HT-1 task 7: local-only Solana adapter + cross-adapter conformance | feat/ht1-task-7-solana-adapter |
| [#1824](https://github.com/Uuriko/project-room/pull/1824) | Polls UI: render, vote, and close polls in the web client (missing-features #5 follow-up) | jill/hardwork-polls-ui-20261007 |
| [#1820](https://github.com/Uuriko/project-room/pull/1820) | HT-1 task 6: local-only Monad settlement adapter behind the envelope | feat/ht1-task-6-monad-adapter |
| [#1819](https://github.com/Uuriko/project-room/pull/1819) | docs: fix enrollment drift — access-request requestId optional, identity rotate/revoke confirm-gated | jill/hardwork-docs-2026-10-07 |
| [#1818](https://github.com/Uuriko/project-room/pull/1818) | A11y widgets 1+2: combobox expanded state + keyboard/screen-reader checks | jill/hardwork-a11y-1 |
| [#1816](https://github.com/Uuriko/project-room/pull/1816) | Claim lifecycle wake gaps: pr_closed owner wake, dependents-ready ready-work wakes | hardwork-claims-1 |
| [#1815](https://github.com/Uuriko/project-room/pull/1815) | Lane 9: escrow event log / audit ledger (hash-chained settlement trail) | jill/lane9-escrow-eventlog |
| [#1814](https://github.com/Uuriko/project-room/pull/1814) | HT-1 task 1: chain-agnostic settlement envelope v1 | feat/ht1-task-1-settlement-envelope |
| [#1811](https://github.com/Uuriko/project-room/pull/1811) | Retention: wire the claim-reputation read side (visible scoreboard) | jill/hardwork-retention-scoreboard |
| [#1809](https://github.com/Uuriko/project-room/pull/1809) | pilot_limit AX: name the cap and the back-off recovery | hardwork-errors-pilot-ax |
| [#1808](https://github.com/Uuriko/project-room/pull/1808) | Roles with hierarchy + display (missing-features #6) | roles-hierarchy-lane |
| [#1807](https://github.com/Uuriko/project-room/pull/1807) | Lane 8: settlement-evidence/1 credential prototype (Verified Receipt Credential tie-in) | lane8/settlement-evidence |
| [#1802](https://github.com/Uuriko/project-room/pull/1802) | Move agent-invite preview to the route table; add POST so the code never needs a query string | hardwork-sec/invite-preview-post |
| [#1800](https://github.com/Uuriko/project-room/pull/1800) | lane6: independent evaluator seat prototype (commit-reveal verdicts, slashable bonds, priced fees) | lane6/evaluator-seat-v2 |
| [#1799](https://github.com/Uuriko/project-room/pull/1799) | Lane 12: escrow dispute + appeals layer (prototype) | lane12/acp-disputes |
| [#1798](https://github.com/Uuriko/project-room/pull/1798) | OpenAPI wire-naming contract test | jill/openapi-naming-contract |
| [#1796](https://github.com/Uuriko/project-room/pull/1796) | search: skip bodyless (redacted) messages instead of throwing | jill/hardwork-search-nullbody |
| [#1794](https://github.com/Uuriko/project-room/pull/1794) | Group DMs (3-8 members): toMemberIds with pair-DM consent and scoping | jill/group-dms |
| [#1791](https://github.com/Uuriko/project-room/pull/1791) | Fix push opt-out recovery and trace workflow review handoff | codex/audit-release-repairs-20261007 |
| [#1790](https://github.com/Uuriko/project-room/pull/1790) | ACP lane 11: claim<->escrow adapter (pure, additive-only prototype) | jill/acp-lane11-claim-integration |
| [#1788](https://github.com/Uuriko/project-room/pull/1788) | Lane 10: evaluator bond registry prototype (design + tested module) | acp-lane10/evaluator-bond-registry |
| [#1787](https://github.com/Uuriko/project-room/pull/1787) | Lane 7: claim escrow → evaluator → release state machine (ACP adaptation) | lane7/claim-escrow-flow |
| [#1784](https://github.com/Uuriko/project-room/pull/1784) | funnel: one canonical skill.md for agents (item 4) | jill/funnel-harden-1006 |
| [#1776](https://github.com/Uuriko/project-room/pull/1776) | Inbound channel webhooks + rich message cards (missing-features #7) | jill/inbound-webhooks-rich-cards |
| [#1775](https://github.com/Uuriko/project-room/pull/1775) | Human room discovery UI: /discover browse page over the public room directory | jill/discovery-ui |
| [#1771](https://github.com/Uuriko/project-room/pull/1771) | funnel: guided room_first_task track — first receipt in 5 minutes | funnel-first-receipt |
| [#1760](https://github.com/Uuriko/project-room/pull/1760) | Make human chat startup and keyboard flows quicker | codex/human-keyboard-polish-20261006 |
| [#1758](https://github.com/Uuriko/project-room/pull/1758) | B16: surface herdr session state in room views (flag-gated, additive) | jill/herdr-b16-room-integ |
| [#1757](https://github.com/Uuriko/project-room/pull/1757) | B18: affinity router shadow scorer (D6 layout) | jill/herdr-b18-router-shadow |
| [#1755](https://github.com/Uuriko/project-room/pull/1755) | B7 (herdr redesign): #pr-view/triage view | jill/herdr-b7-triage |
| [#1754](https://github.com/Uuriko/project-room/pull/1754) | B5: herdr session + supervision-card tables and storage layer | jill/herdr-b5-tables |
| [#1751](https://github.com/Uuriko/project-room/pull/1751) | herdr B14: worker-side session lifecycle (spawn/attach/detach/destroy/heartbeat) | jill/herdr-b14-lifecycle |
| [#1745](https://github.com/Uuriko/project-room/pull/1745) | B9: legacy↔herdr parity suite (Phase-A gate) | jill/herdr-b9-parity |
| [#1744](https://github.com/Uuriko/project-room/pull/1744) | herdr B15: reattach + native resume (server/session-resume.mjs) | jill/herdr-b15-resume |
| [#1743](https://github.com/Uuriko/project-room/pull/1743) | B17: supervision-client.js triage data layer (herdr redesign) | jill/herdr-b17-inbox-data |
| [#1741](https://github.com/Uuriko/project-room/pull/1741) | T1: fail-first adapter-seam integration tests + fixtures (herdr redesign) | jill/herdr-t1-seam-tests |
| [#1729](https://github.com/Uuriko/project-room/pull/1729) | Flake root-cause fixes: unquarantine inbox delayed-confirmation test + fix board dialog race | jill/flake-fix-quarantine-20261006 |
| [#1570](https://github.com/Uuriko/project-room/pull/1570) | docs+tests: contract for GET /api/rooms/{roomId}/work-claims-read (PR #1468) | burn/1468-docs |
| [#1468](https://github.com/Uuriko/project-room/pull/1468) | feat: read canonical Board claims across MCP and SDK | jill-dot/f12-board-read |

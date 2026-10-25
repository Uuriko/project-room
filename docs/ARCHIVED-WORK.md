# Archived work

PRs closed in the 2026-10-25 repo cleanup whose branches were deleted. Each row keeps the head SHA, so the work can be restored with `git fetch origin pull/<n>/head && git push origin <sha>:refs/heads/<branch>`.

| PR | Title / idea | Branch | Head SHA | Why closed |
|---|---|---|---|---|
| #3393 | build(deps-dev): bump wrangler from 4.116.0 to 4.149.0 in /cloudflare in the minor-and-patch group across 1 directory | `dependabot/npm_and_yarn/cloudflare/minor-and-patch-d746ffe52c` | `8e3b9430ee3ccbd011c1684b51f008abbb36128e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3395 | build(deps-dev): bump the minor-and-patch group across 1 directory with 2 updates | `dependabot/npm_and_yarn/relay/minor-and-patch-fa89ca5a2d` | `b70752dd786f3a4fb768df9c632eac622dd6bb35` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3506 | Simplify conversation chrome and make first Room requests dependable | `codex/predictable-agent-request-1015` | `5cc30c99030ed12ec08c4a50e624b68b6dce51f0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3507 | fix: label read Updates accurately | `codex/read-updates-1015` | `1bd65ba0b8f17a48a87f09e09b1b36845924f99a` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3562 | AvailableWork true (B-2 PR1): projection fields for ranking consumers | `jill/availwork-pr1-projection-fields` | `6ad36e0dcd067c0bee209ab1625f23296f0cb4fc` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3573 | feat(attention): one aging doctrine + scheduled access-request expiry (B-3 step 2 PR1) | `jill/attention-aging-doctrine` | `ec12fe2b994772479dd3cca1c0ae52dcc78d01d9` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3575 | refactor(attention): bonds + bounty clocks read the aging doctrine (B-3 step 2 PR2) | `jill/attention-aging-families` | `6278c5769179324fe39a4ce8e296e362faca1c85` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3580 | refactor(members): ownMember migration slice 5 — comms/identity tail (#3224) | `jill/3224-members-slice5-tail` | `6a95c9e2f9813dbb1ff89887404f5c61a8e32494` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3582 | refactor(members): ownMember migration slice 4 — money/public surfaces (#3224) | `jill/3224-members-slice4-money` | `b06b3aa257fcd8693eea26d3b0ad4c1762f717d0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3586 | refactor(members): ownMember migration slice 3 — work surfaces (#3224) | `jill/3224-members-slice3-work` | `181be220fe1b73ba5567f567a22a69c81aa506d5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3590 | feat(attention): wire owner-alerts (O2) as the escalation engine (B-3 step 3 PR4) | `jill/attention-owner-alerts` | `b591e997624a6703400ce5978262f691e26fef00` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3643 | Agent errors: operator-directed recoveries for config codes + catalog invalid_proof_query (census F-3/F-4) | `jill/error-census-ax` | `a4100ec00977f9e0ba6d9b2a5fa075c19a0ef244` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3645 | Fix #3591: self-finalizing bounty escrow entry points (deadline/challenge race) | `jill/fix-3591-escrow-race` | `bb53b4dad377ab452df5f075450a79267678f463` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3646 | Operator status surface (1/3): composed deployment + jobs read | `jill/build-status-surface` | `897a09a84565c971f6bbce2a5ec90db2ddaaadc2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3751 | fix(directory): receipt_count credits only visible receipts, matched by identity not display name (#3705) | `jill/fix-3705-directory-receipt-count` | `2418cffcfeed16a541675dacd7761cd85c2d9f30` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3804 | perf(reads): lot index, proof-page SQL LIMIT, sitemap batch (PERF-10X L13) | `jill/perf-lotidx` | `79a49f67fb1326ec9dade645cd2dd3bc8de6cb29` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3809 | perf(jobs): arm already-due explicit jobs at ~now, not +60 s (PERF-10X L12 / Lane 8 C4) | `jill/perf-alarmtail` | `904aadb4d9e574fc03a13ae708b8c094a57620aa` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3810 | perf(sse): skip and cache the stream pump's redaction view (PERF-10X L12 / CALL 4) | `jill/perf-pumpfix` | `c263889b269284125ac0f435170c03f2d69adb5a` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3812 | verify:pr — local/hosted gate parity in one command (PERF-10X L14) | `jill/perf-gateparity` | `cfb2b1e77d3f1e399063ed86448213a5fb6879ef` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3817 | fix(cloudflare): wire orphaned checks (code-drops, room-export, restore-fk-order) + registry closure guard (F-27) | `fix/cf-checks-wiring` | `0a4d79c76b2ce7437bdb910d61f17a46fa61f1a7` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3820 | PERF-10X L1 (schema v39): VIRTUAL generated columns + indexes for the hot event fields | `jill/perf-idx-json` | `aa8eebc74096dd7e3c406a0c72121f2e08226bf7` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3821 | Backup gzip transport + per-table byte tally in export trailer (PERF-10X CALL 1) | `jill/perf-backup-gzip` | `be67eb03994d721057f7168c3562b2d702e059ba` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3832 | fix(context): stop embedding orient in HTTP context responses (C-01 ORIENT-FIX) | `jill/audit50x-c01-orient-fix` | `c99f2e6d8d16eb50af8491c6b2ae942cbb30eb3d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3833 | C-02 RELAY-DELETE: delete the undeployed relay/ Worker + relay.yml | `jill/audit50x-c02-relay-delete` | `8f0ba4fafb6705ea139480c0d3b4ae1459d0d8b2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3836 | Registry-closure census gate + writer-fence closure test (T-5 / OPP-015) | `jill/annot-t5-registry-census` | `6eb388648f30eac316e92f79c9dca7b6be7f3d1f` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3838 | T-6 dead-verdicts: execute P-15 verdict batch (OPP-018, F-38/F-39) | `jill/annot-t6-dead-verdicts` | `57afc82a73479b81697e7baaedde57648274c487` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3839 | T-1 MEMBERS-SWEEP: raw members[ → ownMember burn-down (OPP-003, #3224) | `jill/annot-t1-members-sweep` | `1d8195881fa641f0cc4e5c833ee828e920a1eab3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3845 | Composer: mark a landed send Sent when its response was lost (12609 a) | `claude/sent-mark-v2` | `2d9a395e53abc5ca5a34040b802b5e42d38960d5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3848 | Nav: Back after opening a message link returns to where you were | `claude/back-button` | `959fdc34263b8c00a3ccac84c2055385a80ed25d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3857 | Cut dead reaction storage, growth reaction mapping, and an unwired QA check | `grok/cut-dead-reaction-storage` | `f116b2049ede3d996fe026c92ef57d192fd6a889` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3859 | Timeline: skip the selection read on arrivals when nothing is selected | `claude/timeline-selection-skip` | `aeb9a15f98c1d4763ce42b86deae685bbe907130` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3969 | AEO B3+B6: /docs/agents/mcp subject page + docs OG/Twitter parity | `jill/aeo-b3-mcp-page` | `5acc37520df8eca27bcd276e984dc207607a37e2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3972 | AEO B5: receipt verification explainer (/receipts) + detail link | `jill/aeo-b5-receipt-verification` | `000b6e11a608ae78221e0dc952d26d27fca663b3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3973 | Freeze-prep: rollback compatibility receipt (ee97df61→77df0e0b) + freeze-pair evidence/generator | `jill/freeze-prep-rollback-receipt` | `66b14ecb26978fab3ed5a1c37d65e481a643c295` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3977 | fix(invites): one-shot credential-less replay rotation per redemption receipt (#3949) | `jill/fix-3949-invite-rerotation` | `1002140a28d66b5bb9624096c1b3587a2be928f7` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3978 | fix(receipts): the owner's publish toggle no longer snaps back on interaction (#3968) | `jill/fix-3968-receipt-publish-surface` | `604c71ac83322d4055fdbc7891e2cb1e9d30cbb0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3979 | fix: accept pasted human share links in the join form | `codex/fo-join-form-carrier-1018` | `41123796de2e84885770ed5d0003095d66ffbf88` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3984 | fix(public-work): match declares and serves the reward classes the board serves (AEO drift) | `jill/fix-aeo-match-rewards` | `85159e5c644e725ebfe3bb4e728ce30446527317` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3985 | fix(skill): SKILL.md money copy matches the shipped settlement reality (AEO) | `jill/fix-aeo-skill-money-copy` | `8b788797bb1031078f6910a9f0b56a9d5c80fb35` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3986 | PERF-10X BUILD-LEAN: slim room_search_actions, lean-as-default MCP catalog, rev-skip (L5 iii) | `jill/build-lean-mcp` | `07ae00b2b71da7641fc0c08140aaf00964d90fb6` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3990 | fix(invites): #3960 name the email-verification remedy; split share-link 422s per field | `jill/fix-3960-invite-verify-gate` | `05a7a5f4479302fe2a757d410f015dc810fd9bc9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #3991 | fix(signin): #3771 preserve typed password across login/signup mode switch (F-12) | `jill/fix-3771-password-preservation` | `2da11742abfad5c9e15e195a53efd3998fa8473f` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3993 | Fix Google sign-in after cross-site account selection | `codex/google-return-cookie` | `602ed508bbb83cb9f41ce626dd0511a8e6dd8101` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #3996 | Simplify sign-in and use invitation-link wording | `codex/signin-minimal` | `47e00e893d9e3d3ebd1fae85fa555859b09cd57c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4001 | docs(escrow): dispute bond spec aligned to live exactly-25% rule (#3307) + true decide path (FS-13 F1) | `jill/fix-3307-dispute-bond-spec` | `65f8074621a7987d56d6b479272053a31206c3f9` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4002 | fix(work-claims): lease never lapses while a review is outstanding (#3753) | `jill/fix-3753-lease-review-pause` | `d6179dbda98a6ab2ed41a7dc74445fbf102183cb` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4003 | fix(webhooks): dispatch honors guest (trial-seat) seating (#3881) | `jill/fix-3881-webhook-dispatch-guest-seat` | `6c686eed52c930ee9fd2fb819757a182441d4d54` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4005 | fix(invite): a shown create result owns the dialog's URL (#3794) | `jill/fix-3794-created-link-owns-dialog` | `4a0296ada2498253ff86cedeeb804d988bbb3195` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4007 | fix(join): announce the post-sign-in name step, repair focus, trap Tab (#3796) | `jill/fix-3796-join-dialog-focus` | `a2828542b35c95c865212e443c1930ce6f43180b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4009 | fix(board): following a card's record link lands focus in the record (#3967) | `jill/fix-3967-board-record-focus` | `b0a7afad0711ba99cb6f5007092da06371f00064` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4011 | fix(receipts): reconcile a PASS verdict with a rejected outcome on the receipt page (#3959) | `jill/fix-3959-receipt-verdict-outcome-split` | `19a1bbc6045258c1b40dda90d8ae247bc37905ab` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4012 | Records: criteria-level outcomes beyond the bounty lane (#3613) | `jill/build-3613-criteria-outcomes` | `92e16f7accb258207208bb3d9072cb45aa38b843` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4013 | fix(share-links): agent-facing copy states the access actually granted (#3961) | `jill/fix-3961-share-link-agent-copy` | `9100be91cf62515f5e9a2c450eab0ec91d87238c` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4014 | Stop stale agent execution promptly when a request changes | `codex/request-live-control` | `0a6db3381b0f7ffbc96db74cbb8d3874b69ef9d3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4017 | Bounty pricing guidance at post time from the room's own settled receipts (#3524) | `jill/steal-3524-pricing` | `0dfc67c3694156a7165894aeb6aad98b34ebfa5b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4018 | Reviewer load (#3755): pending-review depth surface + less-loaded offering at delivery | `jill/build-3755-reviewer-load` | `eeab47d20e6818ee8c33c5ab26d9b4e81f91a970` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4020 | fix(escrow): served ledger reads provision outstanding genesis first (#3962) | `jill/fix-3962-genesis-on-ledger-read` | `06e723746d549e8ffc1c75bdcf9683062024f5f8` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4021 | COMP-DEEP #1: verdict inbox — human surface | `jill/cd01-verdict-inbox-ui` | `51d6bf3d743b85893e4470f27a2806a4bfb2865c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4024 | records: decision records retention class >=4y + legal hold, audit-retention floor (#3614) | `jill/records-3614-retention` | `bb703644886815897a0976665a6802f54ae05c58` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4025 | COMP-DEEP #6: claim follow records with totals | `jill/cd06-follow-records` | `6bcb6d3d4472cc476d78b5bfe2cbd169f47bc49c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4026 | fix(inbox): agent-inbox cursor walks ascending — bursts larger than the page are reachable (#3948) | `jill/fix-3948-inbox-cursor-walk` | `1b8a0c8835c8030838c7bde6cfac2f70d5a9f8d7` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4027 | feat(digest): server-side room digest + since-wake delta (C-06 ROOM-DIGEST) | `jill/audit50x-c06-room-digest` | `316b06b27f76f400b77bb399b80fecba49b953d5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4030 | COMP-DEEP #4: MCP annotation truth pass | `jill/cd04-annotation-truth` | `fe1e6e71742b759105eafb0c83c070f34aef5ddc` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4032 | P0-5: serve GET /api/auth/signin-options from the Worker (zero DO requests) | `jill/perf-p0-5-signin-options-worker` | `f85a11ed3fcd768b12bcde03a413cdb88f378995` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4033 | C-07 STATUS-LEG: job-materialized main-HEAD cache — status route serves cache only, board paints without the leg | `jill/audit50x-c07-status-leg` | `bb3e0ef6afdd9dd14c5f6aaf759df4b72a94bd1c` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4034 | fix(board): focus repair on the Close-button and refused-claim paths (#3793 residual) | `jill/fix-3793-board-focus-residual` | `66423c7ba0d4aae0fd9b1e84ddbd73304032c96b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4035 | feat: bounty pricing guidance at post time from the room's settled receipts (#3524) | `jill/build-3524b-pricing-guidance` | `9208438902a58429abef93371f67846432ad0c3b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4036 | perf(jobs): stop the per-request job scan (PERF-BUILDS P0-1, supersedes #3809) | `jill/perf-p01-rearm-gate` | `b87ad1f6e3455ab8e7662c0ea07e41ad5475dcfe` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4037 | Records: auditor-grade decision-row export + evidence-read logging (#3616) | `jill/build-3616-decision-rows` | `525f3900eb1fa20705cbff1db618d8218d24cf1d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4039 | Records: adverse-decision packet + agent-participation notices as records (#3615) | `jill/build-3615-adverse-decision-packet` | `56d7b705f1f667b7d204527f9d0bfb8675d82e9d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4040 | fix(public-work): rate accounting — per-identity primary budget, per-IP admissions backstop (#3924) | `jill/fix-3924-rate-accounting` | `f7ec8535891b2a2d48644e7bec1974c3c0fe5dfe` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4043 | Records: stamp session-instance, principal, model/harness on consequential records (#3612) | `jill/build-3612-record-stamps` | `4ed1031ab5c030e01577685d8f9627e18293226d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4046 | fix(board): Verify render mirrors canCloseWork; reviews name their basis (#3885, #3889, #3887) | `jill/board-slice-r-verify-gate` | `6c6e16e04e26aca525b9e1b752a30e78dea6446c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4048 | Records: incident linkage + performance aggregates as records (#3618) | `build-3618-incident-aggregates` | `d709ee7d4384885efb2e3e7bbc69ba9a4358c804` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4050 | feat(board): per-member lanes, recorded-state chips, inline receipt cards in chat (#659) | `build-659-board` | `608ed0b4ea97d474b08c030818f3cc75c6c86da1` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4052 | #661: per-room anti-shout pacing for agent replies (server-enforced) | `build-661-pacing` | `cce123a2deb569ae7435c670cce466a86c39657d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4057 | fix(cockpit): board_review decision facts + body-less POST actions render their hint (#3890, #3891) | `jill/board-slice-c-cockpit-facts` | `9c7f2ad1b26daaa43e10a4161c28d855593043a1` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4059 | fix(board): the deep-link claim-record path names a reveal failure (#3892) | `jill/board-slice-n-reveal-notice` | `494b2d261deb8b243c943164476ab91660259def` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4060 | #650: per-room agent cards, registry skill query, deploy-aware card fields | `jill/build-650-agent-cards` | `02e7a22593a495e686b9cba74ea31f57005a5ed4` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4066 | fix(claim-reputation): close open positions on closed/deleted terminal actions (#4062) | `jill/build-f2-claim-reputation-closed-deleted` | `afafd9730f2de27bcc4ba1621482f7e9b8d1b6ec` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4067 | Registry-of-registries manifest + meta-census gate + HAND-OPEN family closures (F-26/F-28, #3673) | `jill/build-b08-registry-of-registries` | `cade1f4502905eda3112b4d5448f529d7bf6eca4` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4068 | Receipts: verify at read time by default + one graded verdict (four tiers, revert-aware) (#4058) | `jill/build-b05-receipt-verify-now` | `fbdf2647225f6bd95e45eecba1cbd0c12502ac82` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4069 | F-16 (C-9): extract PILOT_LIMITS to a leaf module + shrink-only SCC gate | `jill/build-c9-pilot-limits-scc-gate` | `fc9c60c1b49b5a541703df737a4a00877edfa7ee` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4070 | tests: fast-check stateful harness + in-repo differ for the escrow machine (F-32 / C-5) | `jill/build-c5-escrow-stateful-harness` | `e69a6ceb1a6cbe01a8cda12e3b1096a617c5704e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4072 | Practice room (#602): well-known self-join room with chat scope | `jill/build-602-practice-room` | `3f7bbd487e9b95e11a768bb57f20fcaf7219edd8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4074 | F-33 (C-10): untested-modules lint counts direct imports only — 14 direct tests, 9 waivers | `jill/build-c10-untested-imports` | `579fef875083dedb9ddbf96f867a6c4bc01de786` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4075 | Verify deleted sponsors using completed account deletion evidence | `codex/sponsor-v3-carrier-1018` | `deb57936bc69301232b8766586ece734bf54fd29` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4076 | release:verify — one releaser-runnable gate (CF-FOLD batch 1, #4073) | `build-cffold/release-verify` | `18e8461cadd84df3a3ada9eb247d4a47edd0256c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4077 | CF-FOLD batch 2: runtime-identity checks move to tests/cloudflare/ (#4073) | `build-cffold/cf-identity-family` | `cfadcdab4e26ce4cc7cbe41cb3697ceb17617321` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4078 | CF-FOLD batch 2, family 2 (state/store): eight more checks move to tests/cloudflare/ (#4073) | `build-cffold/cf-state-family` | `55e154f33bd80d3a7a507b73abe48d40585c4ab7` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4079 | CF-FOLD batch 2, family 3 (public/work): twenty more checks move to tests/cloudflare/ (#4073) | `build-cffold2/cf-public-work-family` | `0e7d19b9d3511a6b9828369b7f56f79165d3ac69` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4080 | CF-FOLD batch 2, family 4 (browser): the last three checks move to tests/cloudflare/ (#4073) | `build-cffold2/cf-browser-family` | `f49333ea157a9ab33e94a4af68cd0da6cbfcf95d` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4081 | claim-prs: run autolink follow-ups on the Worker too (#4061) | `build-f1-worker-claim-prs-parity` | `08b26ddaa627d4673be136149ae8e6a48ff42683` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4082 | fix(packet): wake-poll sentence states the three-case hostId contract (#3640) | `jill/rq3-wake-poll-sentence` | `67222648af943e71be6a1b7a146db0f9d4702443` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4084 | RQ-22: failure naming generalised — patrol names its wedged room, escrow-epochs names its failed bounty | `jill/rq22-failure-naming` | `c93c04a7417f328b9a2897bf34da97f75ef1f0a0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4085 | fix(board): claim-round identity for Deliver + basis fencing + deliver reconcile (B4 PR-A: H2/H3/H4) | `jill/b4-board-round` | `56065812784a2b72726cd550acff8e8e74c619eb` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4090 | fix(board): send-back control, criteria deliver form, policy-aware verify, review basis (B4 PR-B: H1/H5 + #3885/#3887/#3889) | `jill/b4-board-controls` | `79e2fd86adc119adbc91e970b34d839e16345c7d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4091 | fix(wake): guest-aware dispatch gates for webhook deliveries (B4 PR-C: H6 / #3881) | `jill/b4-wake-dispatch` | `c38e071dbc312c3874666f3dbea4fbf7ff35fb72` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4092 | feat(oauth): resource-side oat_ validation on REST + /mcp — AGENT-DOOR-AUTH stage 1 (#4055) | `jill/agent-door-auth-stage1` | `9d7b4510e5149abc3d90d4fd9113b5a53b3eba27` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4093 | fix(cockpit): board_review facts, spend age, adjust-as-hint, deep-link reveal notice (B4 PR-D: #3890 #3891 #3892) | `jill/b4-cockpit-deeplink` | `dbcadf244a5a2484965ff3099801cefa3c5441fb` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4094 | tooling(CH-1): un-commit CANDIDATE-MANIFEST — generate at freeze/CI time | `jill/ch1-manifest-ci-generate` | `8b9ed5c842a32f2ad7711124e2f4efe6d969c4b8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4095 | perf: gate per-command public receipt re-projection on receipt-input changes (PR-1 / HOT-PATH) | `jill/pr1-receipt-gate` | `01fb4cc290078cf85db428c9f49ba2b4c84d94e2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4096 | feat(quarantine): entry trigger — scan CI evidence, propose entries (Q-1) | `jill/q1-quarantine-trigger` | `99895b1cdfbcc8b1b7e3e06a8cd9af61a0e755a8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4097 | feat(deploy): DA-3 receipt + head-declaration generators (scripts/deploy-receipt.mjs) | `jill/da3-deploy-receipt-generators` | `9542ff90db9b096254880855a7cfb92ee35e7487` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4098 | T-1: coverage from the unit shards — shard collection + merged evaluate (scripts only, wiring pending grant) | `jill/t1-coverage-from-shards` | `15233850ef707d1d07b07fd62d311e14aeaf5819` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4099 | PR-2 (HOT-PATH F2+F5): deadline discipline for webhook drain and escrow epochs | `jill/pr2-deadlines` | `a29b48ef8753d964010a4f280e43ab7c4bf45f43` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4100 | STORAGE-S1: patrol idempotency look-back over a generated column (22 ms-class -> 0.02 ms-class) | `jill/storage-s1-patrol-idempotency` | `1a9ff84315d480e0564adffe13533e46766a86d0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4101 | Bench: shared room-scale benchmark with A/B against any commit | `claude/bench-harness` | `20731c4275cd1f62ffe5687807aef22952239a61` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4102 | Pin deployment smoke and honor the Room deployer lease | `codex/pinned-deploy-smoke-1018` | `20b49c0c2888a787bc08bab54cfa74244d97cde8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4104 | Stage 0 public offload: projection publisher + read-equivalence harness + dual-read compare (pre-D1) | `jill/stage0-public-offload` | `70f4b8078ad0c40985d464016a66767cc8de9280` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4106 | test(evals): incidents-as-evals catalogue — 26 fixtures, 6 classes (W7) | `jill/w7-incident-eval-catalogue` | `e446de5a3c97db6273e5cf4ca0a8319a0234e413` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4107 | Stage 0: transactional directory outbox + drain (wire-ready for D1) | `jill/stage0-outbox` | `dd2df757e9f9a652330b32beff68663b89dfad2f` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4108 | feat(security): scan-on-write for secrets in deliveries and messages (W10, B2) — secret_detected refusal, nothing persisted | `jill/w10-scan-on-write` | `dcd0023beb795f2943670a4920650f67761b5e97` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4109 | W4: dataset anonymiser + packager (extract-time, two-tier, six gates, R9 audit sampling) | `jill/w4-anonymiser-packaging` | `b0015fbdf36b98a5a11c05586b64280d08aa229d` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4112 | feat(escrow): dedicated keeper kill flag — global + per-room, operator-set, health-visible (C-08 step-3 remainder) | `jill/keeper-kill-flag` | `fe092b385eb68563f7fc7fdf7e3953f60afb07f1` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4113 | W2: work-episode extract assembler (work-episode/1) — stacked behind #4041 | `jill/w2-extract-assembler` | `776688ab37183b0c000b0199c510683cea7e4a83` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4115 | Enforce the release pause with a required landing status | `codex/merge-boundary-gate-1018` | `f869d79cd61e8cdc8d4a2e23a615db1266f79615` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4117 | feat(jobs): degraded-since timestamp on the job health view (F6/CN-8) | `jill/f6-claimprs-degraded-since` | `aa2f1acad71b16431abf51b29b803efe7ed55e12` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4120 | remove(sunset): owner-alerts module + availablePublicTasks (comp-deep R-2/R-3) | `jill/hunt-zombie-sunset-batch-1` | `dac1f78c878854df8d9bb97dcb3a786e814d5c12` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4121 | docs(FAQ): bounty escrow paragraph — name the real release paths | `jill/hunt-truth-faq-bounty-copy` | `ea26f8673e36ca82a6ac1a55f4d49317d673fa71` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4122 | Public receipt reads: stop paying the whole corpus per request (HUNT-SCALE-SPIKE) | `jill/hunt-scale-receipt-reads` | `895e049ecf51c395c906c550382b955c9c1ccc85` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4133 | Prune guard: pruneMessages deletes only against a replay-certified projection (PRUNE-SAFETY) | `jill/prune-guard` | `d0068fe0c69b631900ea357fb0693ecdf5494ef5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4135 | Conservation audit completion: payable-flow reconciliation + scheduled audit job (#4125) | `jill/conservation-watch-audit` | `d838f923eaf147a1df2bf620351f7bce3549e05a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4137 | Parseable-but-wrong projections: typed reads, shape-aware repair, patrol parity (#4127) | `jill/corruption-hardening-shape` | `0125b14e1ee50cddf214db1f66f88d9a43b6ebd0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4138 | Keeper stuck-state census: unreachable count + degraded health (#4128) | `jill/conservation-watch-census` | `c6d9b73be9a311d47408311863c79b55fd8d5e1f` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4139 | C4: backup-token operator doors to purge-surface standard (SECURITY-FIX) | `jill/secfix-c4-backup-doors` | `805cb706c85fa9066d8c26c5b37e524695e34396` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4142 | Board: one id per new-item form-fill — a lost create response no longer duplicates the item | `jill/hunt-frontend-create-idempotency` | `3d90cfb7cde252620153b88c4433cbab946cc96a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4143 | Composer drafts: cap eviction follows last write, not first creation | `jill/hunt-frontend-draft-eviction` | `7560d08e25b71645c382b6a1fbd5e39f65f352d7` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4144 | docs(contract): catalogue terms_changed + invalid_proof_query; formalize accept attestation and webhook secret in openapi.yaml | `jill/hunt-contract-docs` | `f3f0d24329e6a311d8c299c2af2c10f2fdbdb71b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4146 | Composer drafts: write() sheds to the size cap read() enforces | `jill/hunt-frontend-draft-size-budget` | `763eb7883019787fb44a0f8e2b954a5b4b7aeef9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4149 | Restore honesty: verify watermark tables + sequences and conservation on every restore path | `jill/restore-honesty` | `adf0ec7d7fa01583d3f29f283533a632cde0cd81` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4152 | perf(work-claims): cache prepared statements in the durable registry (PERF2-BOARD step 1) | `jill/perf2-board1-stmt-cache` | `0ab56716d923f6d449f91b23e734f2c7a182e80b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4154 | PERF2-MEASURE: sampled route counters on the health surface + store-gauge warm-tier breakdown | `jill/perf2-route-stats` | `97f65be873f684154d5fff0a73738101edc3fd13` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4155 | Money-copy honesty: truthful accept moment (C-H1) + no attestation by default (H-3) | `jill/money-copy-accept-window` | `e602ea9b3aad6cf509960c0917d145aed6cf057f` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4162 | simplify: delete EXP-5 share-poster generation (OG cards + badges) | `jill/simplify-posters` | `4559bc3707df41b527fe4deeefc78c45df2976d8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4166 | Bodies-at-rest: carry ROOM_BODIES_AT_REST in wrangler config as the floor | `jill/bodies-at-rest-config` | `bb0ab4a969ca23c4cde31ff7c790aaafefcab8e2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4167 | simplify: fold receipts-live into the public read model (register D10) | `jill/simplify-receipts-live-fold` | `0d59ace92606d6291b99bc9a7fa0a7a7327e63c7` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4168 | FIX-C5: rotation of an identity-linked connection refuses sponsor-chosen keys | `jill/fix-c5-rotation` | `21e4ee9d49f459b989a5b76d5bd4f0da529d4b40` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4171 | Job registry honesty: probe-error state, unrecorded-tick counter, per-job stopTolerance (ATLAS-JOBS-WAKES R-5/R-6/R-7) | `jill/job-registry-honesty` | `9d6f47bea5a61493bfaa3391e9f311b32e845dd5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4172 | TD-0: per-tool MCP call telemetry (daily rollups, caller classes, diet read side) | `jill/td0-telemetry` | `1d357de40745bdc968f87052cde641f6bf86a6b5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4173 | perf(join): import AccountClient from account-client.js, not the client.js barrel (−334 KB closure) | `jill/client-weight-join` | `b12bf9fa37ba37e37b5c72768a116b3f04e3c551` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4174 | simplify: cut the /project-room/ discovery mirror (register D10) | `jill/simplify-project-room-prefix` | `f5b063de34380b76722f8376469a10f38c62b62e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4178 | Webhook drain: drain-until-budget + retry-fair batches (HUNT-SOAK S-1) | `jill/webhook-drain-budget` | `e5ab15d76f3d3518cc01dfdacb8f8e252574737a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4179 | Fix #3753: delivered work survives its claim lease — send-backs restart the window, post-lapse writes name the lapse | `jill/fix-3753-delivered-immunity` | `6a4fe639c673a2f2b9f5e4581453aa29d6abee5f` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4180 | Retention: drain-until-budget across all tables + a recorded disposition for every table | `jill/retention-drain-budget-registry` | `aa64f69559bf67fd9843cda99a3fbc80c763681a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4181 | fix(public): start_href names the room owner only with publicName consent (P-2) | `jill/consent-start-href` | `1ea011d5e4789e728f3ded1a5a7412cfcf4c359a` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4183 | S-2: cheap alarm-path due probes — index-backed claim probes, SQL starter-pool gate | `jill/alarm-probe-cheap` | `a862f636fb3ff1d42afd559a178abd546659d2d2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4184 | QA seed packs: reproducible builders + fixtures for the QA wave (QA-T0) | `jill/qa-t0-seed-packs` | `a20d3a3afcf301fe6f5e8e991618e9e2b80b29bd` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4186 | perf(app): make the board lazy seam honest — board-ui loads on first need only | `jill/client-weight-board-seam` | `8513b74a92c8afcd288869b01a2e1839bdca4c5d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4187 | fix(a11y): room view keeps a level-1 heading at mobile widths | `jill/client-weight-mobile-h1` | `53460c0073622f77c8801ffd207ffb39fbda4041` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4188 | ESCROW-GUARDS PR2: settlement refuses a deactivated claimant (funds stay in escrow) | `jill/escrow-guards-deactivated-claimant` | `b266500b26da2b601dfea2f900ad4e7bbdf16074` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4189 | PERF2-SITEMAP: sitemap index + paged receipts — kill the N+1 and the silent 1,000-receipt clamp (C-2) | `jill/perf2-sitemap-c2` | `40b482891f826ac0fdcee9c0589119d2443042b2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4194 | fix(legal): unpublish lands in the central operator audit (C7) | `jill/backlog-burn-c7-unpublish-audit` | `99ea9cbf1ea9307871f7e8de6e5c26dbb2440ca3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4195 | Directory lists only rooms whose page and proof serve (P-10) + /contact + /agent-signin.html | `jill/directory-404-fix` | `4ee42e0d07dbb333f436e88bce5a833e2ea520b9` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4196 | QA-R1-SPINE: regression-spine replay pack — every hunt wave 1–3 finding replayed + classified | `qa-r1-regression-spine` | `b99c31de93eba024327c08ed8c0e214842256cf5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4198 | Bound board-claim lease renewals (#3707 mirrored into work-claims) + RQ-12 window reuse | `jill/lease-renewal-bounds` | `19b8f8edf59b4cccaf2dfcd0753a166f22f41dee` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4199 | WAKE0-1: the wake kind + the §2.1 emission rule (wake-on-mention Step 0) | `jill/wake0-1-wake-kind` | `6f5d5e4ade09d200f9be071db97c07d717a1f105` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4200 | Bind projection storage caps to the runtime sqliteValueLimit probe | `jill/cap-probe-binding` | `080a1e2eb976c84b0ce6ee47305fb31f91566b52` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4202 | Consent #3710: public-receipts toggle discloses link reach, sitemap listing, search indexing | `jill/consent-3710-indexing-disclosure` | `de3908f4e75cde863d2773c67cf655276f53daee` | near-duplicate of #4761 |
| #4207 | errors: size refusals state the size and the limit (T062) | `codex/size-errors-t062-1019` | `33a3ce73a36041d559936d26bae6e2550775f4ce` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4220 | CI: fold schema-gate, pr-diff-size, zero-bug-gates, invariants into fast-gates | `jill/ci-diet-04` | `6f4ff0faa381e0c46261ae3bc935500b7d611427` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4223 | CI: Playwright restore-keys; npm cache for qa3-gates, machine, relay | `jill/ci-diet-07` | `2e1295067fb400d7ff43e55ebd2609309ce6d7c4` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4227 | deploy-prod: run guarded recovery on cancelled runs too, not only failures (#3897) | `jill/fix-3897-deploy-cancel-recovery` | `6b6d358a887610804ecd13adc55b6b692db98922` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4228 | RP-1: lease expiry is store-open/write maintenance, never a read (cures RC-1) | `jill/rp1-board-read-purity` | `3184f32a0796e6d6071b4f6c8734fef824379341` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4229 | deploy-prod: drop the --var ROOM_BODIES_AT_REST flags (wrangler config is the carrier, #4166) | `jill/bodies-config-tidy` | `e36a4875b5ae2cc2a5493fc0d1328449b42d57d2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4236 | IR-2: wire the restore reconcile into the restore doors | `jill/ir2-restore-gate` | `68528632a8c4abe5a65dbb44b8507a997a73dfeb` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4238 | W-D1: doc registry + generated INDEX land in-repo (Docs Programme) | `jill/wd1-doc-index` | `5c7d384dbe8da51c33b71d5abb2fb35a56c46fa7` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4239 | Docs sweep CI leg: workflow + vendored sweep machinery (Docs Programme DS-2) | `jill/wd1-docs-sweep-ci` | `403fe8b0d4c67629a12d4da0b8edd7155a38a728` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4242 | DISPUTE-CORE: make bounty disputability a posting-time property | `jill/dispute-core-posting-time` | `df2ce50b5cc48a5548fe18add232ba5cfd46eddf` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4245 | Make fresh-user room and assistant failures recoverable | `codex/tab-fresh-user-carrier-1019` | `55532407b3c3c6d5db917508e436883bd3564fd9` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4246 | Keep claim reconcilers out of public-work namespaces | `codex/claim-sync-namespace-carrier-1019` | `90cf2d617d63a2d686627ce40f8f111dee090abf` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4247 | SPILL-1: wire the messages-archive job — corrected cap basis, dry-run by default (supersedes #4031) | `spill-1-messages-archive-live` | `4a82fa3104413612a10200ced718f2120dddc787` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4249 | Web client: carry the server error envelope (hint/next/reason) through RoomClient.request | `jill/seams-fix-transport` | `05329aac6d2decbb5f93284bd47b3b139ad79f2d` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4250 | Integrity scan: a backfill-parked room no longer zeroes the fleet signal | `jill/cure-integrity-scan` | `10763e6269077e77d7d7a5be93f29f7ccb047a26` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4251 | PROOF-WALL-FLIP: internal rooms and no-verification-fact records leave the public proof surfaces | `jill/proof-wall-flip` | `ac00b1fe3a6c4e6d569c62b64ca8863ebcac24a2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4252 | S-2: light-clone messages for every audited event type (HUNT-SCALE-2) | `jill/scale-fix-clone` | `972e1e311beb504255e6dfa2133f8f8b57b998fc` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4253 | mime-fuzz: path-filter main pushes to the sweep's actual inputs | `lab-citier/mime-fuzz-push-paths` | `0f608529bef2dfbb0926b31e3de73cd6278dc377` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4255 | pr-diff-size: advisory verdict, instrument failures still red | `lab-citier/pr-diff-size-advisory` | `7d40d896315cf15ef55959f84e86d994d1755028` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4256 | Mutation pins: archive certification gate (MA-01) + certification sequence guard (MA-03) | `mutation-pins-archive` | `47fbb1858c3b00872e0407ab9cf474d0b44ce150` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4266 | Quarantine 3 classified browser flakes — quarantine.json entries + skip toggles | `jill/flake-quarantine-enter` | `865ba78b05650f3f86a296c59fe27375aa2b4776` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4267 | Make privacy collision and socket path tests deterministic | `codex/privacy-socket-tests-1019` | `aafb0523d1db3716fd09814d7a5bf66c4cc866e6` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4269 | Invariants harness: keep the evidence — error text for every failure form, durable artifacts/comments, race-free fixture publish | `jill/invariants-harness-evidence` | `ae6f79bbbb42e45bdfdd8bec7f74b9226b92e490` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4270 | HW-4071 corrective: truthful receipt verification copy, resolvable public link, paired invite copy | `jill/hw-4071-corrective` | `9ab068b277775b6dadf058c8e29dfba77e60de41` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4271 | ci: coverage ratchet guards trunk, not PRs (ruling 23) | `lab/coverage-trunk` | `2280ae02c76a280d6f43009491e1de04fd0aa8f6` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4273 | fix(claim-prs): exclude public-work namespaces from the sync family (CP-FIX) | `jill/cp-claimprs-fix` | `e2829db26b6811e589866a1cfcbb73cf8bdb8dba` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4274 | fix(work-claims): restart a lapsed lease when reassignWork reopens a delivered claim (#4116) | `jill/hw-4116-reassign-lease` | `bdb32d02e244dc13745a300116044794c429b6ee` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4276 | Journal contributor outcome reads (public_work_review_reads sidecar) | `jill/outcome-read-journal` | `d535d993bdf48a20d9eaa720f51dac179dc59900` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4277 | Serve the agent connect skill at /.well-known/agent-skills/connect/SKILL.md | `grok/connect-skill` | `df0b1788e63d63a450ffd59097f3965615d1c938` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4278 | Keeper stuck-state census: unreachable bounties surface in summary + job health (#4128) | `jill/fix-4128-keeper-census` | `78d41221849f90faf1439c4cd28d95bd7a3ffc98` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4279 | fix(boot): quarantine corrupt rooms on the legacy upgrade path too (#4126) | `fix/4126-legacy-boot-quarantine` | `3bf8296e63f53bb045c32a08f89d43023c98f60f` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4280 | CI: coverage from the unit shards (drop the 17-min suite rerun), timeouts on 5 jobs | `claude/ci-speedup` | `a9f9ee97842bda3f5cfb9585e98f63d0f32df372` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4281 | docs: parallel landing proposal (readiness in parallel, serialize only the merge) | `claude/parallel-landing-proposal` | `39784c7201723b5cdcae563af6cf3194b02ae6a6` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4285 | Arm the renderMessages focus rescue from the settled element | `jill/fix-focus-rescue` | `01910550dd1ae6c88396b2cf580b5de0124a63fc` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4286 | Member spend default: 25¢ per-room purse for grantless agent members (ruling 29b) | `jill/default-grant-allowance` | `394303d5b07025a211d35cdc178610da853e6f79` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4290 | Room Everywhere C1: Catch-Up Card (one read, cache-stable preamble) | `grok/catch-up` | `89bced47daa94e5e6a0c2e9523af193f134b0bf8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4293 | room-guard: warn on files other open PRs change (--prs), check a claim's files (--claim) | `claude/room-guard-open-prs` | `7948a2f0c8062aaa944dd94d1df7df322cd72fd5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4294 | MONEY-LEGIBILITY step 1: bounty-card legibility (challengeEnds, snoozedUntil, time-in-state, duplicateOf) | `jill/ml-build-1-bounty-card-legibility` | `a878f1409831616ef46a5e238d3339b7d80db4b2` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4296 | Gate verification PASS on stated mechanical artifact floors (FIX-VERIFY-GATE) | `jill/fix-verify-gate` | `d84edf2d0fbd497b0ac5ee1846f57ee09ea4d797` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4298 | Phase 2 B1+C1: /for, /vs and /starters pitch pages | `grok/starters` | `38cc27cf4bb40f13285063a12dcfa25e9a171fd2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4300 | Render receipt checksClaimed/signedEvidence + earlier review rounds on the web work card (ML step 3) | `jill/ml-build-3` | `8b9835205bb5731eb6a8231b8b912451b1555b05` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4302 | docs(openapi): make docs/openapi.yaml a valid OpenAPI 3.1 document | `grok/openapi-dangling-refs-1020` | `6bab22b761920ce4da678b00a5ca2c948ae49872` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4303 | Keep cash-reward offers off the public offers list | `grok/hide-cash-offers` | `4ec95404f7feeb716f4582dc8ffc52a793adf5e5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4304 | Remove dead references to deleted boards and archived inbox paths (GHOST-CLEANUP) | `jill/ghost-cleanup` | `a917ecf9de0678a02eedb889a21956dc60daebea` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4308 | Name each native-text evidence failure in its own refusal (QA-STRANGER-2 F-2) | `jill/fix-stranger-findings` | `114dd54b6baa35feec4e9662d8bfcbdd7447227b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4309 | fix: dead DO_SQL_BIND_LIMIT export + DM consent header truth (CC-DEAD, SM-R-SM10) | `jill/bb2-simplify-riders` | `4b43dba4d9e3800f9941f30a1112c084b680393a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4310 | MCP parity: bounty_decline + bounty_reject verbs, dispute copy, history order | `jill/fix-bounty-mcp-parity` | `fb3995ce068d52edafd2985ea25ef6e76cf25230` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4311 | Front door: resultsTierVerified sibling counter + truthful field meanings (ruling 33) | `jill/fix-frontdoor-labels` | `57055e8325970073ada2c79a1e243fb030139642` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4312 | Fix routing-mentions lenient typing: refuse non-string mentionedAgentId (API-CD-1) | `jill/fix-desk-routing-type` | `07a495e282148781ab82a1ee543e3286d555a851` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4313 | Ruling 34: operator restore doors refuse trailer-absent exports unless the explicit legacy flag is passed | `jill/fix-restore-trailer` | `ba455413b7c2f50a4aabe6d1d1927d72b41dd914` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4314 | fix(mcp): list room_join and room_create in the roomless default tools/list (qa-mcp-roomless-join) | `jill/fix-roomless-join` | `d4bd1e066c2cb9234c50c931d958cfdcfcdd038b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4315 | Add native browser agent tools with visible confirmation | `codex/webmcp-room-20261020` | `e358493ef3cfe2d4c4d1d8ca0667b7813982d3f2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4317 | Remove emoji from shipped UI and agent-facing strings | `grok/no-emoji-ui-1020` | `9c623773946931f49dc8b9c4c9a4ec82868ec503` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4318 | CI: run browser shards on main pushes | `grok/browser-on-main-1020` | `9f3b065d00e8036588853ef019c545dabaf6b4b5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4319 | Activation pack: send claims and orientation once (qa-pack-duplicate-claims) | `grok/pack-dedupe-1020` | `f0fa82f98ba16fa78e8a1b8b1cb051e1cc8aec62` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4321 | Cron: name the one room Durable Object and test that the cron wakes it | `grok/cron-one-object-1020` | `3cee12c66c0a073489c09346235bda9ee0b65456` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4323 | Archived rooms refuse the last write routes, with a walk over every write route | `grok/archived-writes-1020` | `9bfbdd52fc92dd7d7cc8fa4c6ecb3cd3a82057d1` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4324 | fix(og): embedded asset fallback so receipt og.png renders in the worker bundle | `jill/fix-og-image` | `b0db0b38af0c798898715011030e2255f5ab322b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4325 | test: wait for wheel delivery in activity-feed unread-divider check (Cure A) | `grok/activity-feed-cure-a-1020` | `562e4d5dff1b1e17a25921b17fe1371e6748d613` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4327 | Make Work directly accessible from the room header | `codex/work-navigation-20261020` | `9455523a20f8af988b492f07a952c8c612702841` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4328 | One short RULES.md; review is advisory | `grok/rules-simplify-20261020` | `590bd99076e24b6e689ba38bcaa577d188ed3e74` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4329 | Start the board with work and reveal creation and options on demand | `codex/board-disclosures-20261020` | `5dd2bc51855ea49f17ac547e1c87f5b0b574eb9c` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4330 | Cache per-deploy discovery documents (public, max-age=3600) | `jill/perf-quick-cache-llms` | `3d11a92d42cdd938e474c91805202a49edf91d0a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4331 | needs-me: claim snippet skips lease, assignment and retention-ack notes | `grok/needs-me-snippet-noise` | `d0cb46ddf41f43e2285292f9c879f1a5b234aea7` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4333 | feat(claims): plain-sentence collision warnings, case-folded | `grok/collision-warnings-1020` | `9d17f36b3de6adfcbb44250df1273bdcea0b0fb9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4334 | feat(feed): PR and CI check card text | `grok/check-card-1020` | `6d71b5f1c6dc56710732aa9d7071369dad90b313` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4335 | feat(claims): suggest a claim file list from the branch diff | `grok/claim-from-diff-1020` | `3b7ea5b12f425222a87b1a2a5588173a9c0cfb45` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4337 | Signed one-click /unsubscribe route that records the opt-out | `grok/unsubscribe-route` | `bfb60f8ae8bc732d0c3f8763191924cad3710ebc` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4339 | MCP: lean default tool list v2, one stable list for every agent and room | `grok/lean-default-tools-v1` | `8a5e50cef4f6273ecf29af37bc33b37cbbe65744` | duplicate of #4438 (lean MCP catalog) |
| #4340 | Presence: machine, repo, branch, busy/idle and current claim in heartbeat and presence | `grok/presence-context-v1` | `c6ce0da46cdbf44fa2ea120012238c0f13260da9` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4341 | MCP: room_ask_user on the existing reply-request ask card | `grok/ask-user-v1` | `5f7acc8a2d5626ceeaf23e7074b9b69a3538da48` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4342 | aside: human side remarks wake no agent and skip needs-me; group join updates | `grok/aside-quiet-v1` | `23eca04e52931f92c7745490a3975fc785ce71c7` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4343 | One-line setup: a single sentence that points an agent at the connect skill | `grok/one-line-setup-v1` | `46d5f2fc2c15f67aebaa039da147e415b49da393` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4346 | Board lifecycle: release removed members' claims, drop closed dependencies, enforce creatable claim ids | `jill/board-lifecycle-1` | `71c100063788421b4d940f360c2235d5208f6a8e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4347 | ERROR-COPY-1: refusal envelope honesty batch + dispute-bond representability | `jill/error-copy-1` | `a30a9d392b635e6337dc2e51662bd664b3a2470e` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4348 | Display-name policy v3: removed members' names stay reserved in the room (qa-name-reuse-after-removal) | `jill/identity-name-1` | `51e88e882946a8e0455696f336b7839c0169a917` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4351 | Addressing: @person/agent, @person/*, @repo:<name>, @* | `grok/addressing-v1` | `28460092202b0faa366a036990172680146763a8` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4353 | Presence: live doing line from the agent's last tool action | `grok/presence-doing-v1` | `bd9ae384796de5843f307cdd8fd93dcadf86a05a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4354 | room doctor: check identity, tool list and wake path; one clear fix | `grok/room-doctor-v2` | `81d8590dac4a3bd7f1d25e05ef7f0bd36f77c30b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4355 | No-browser sign-in for SSH: room login --device | `grok/device-signin-v1` | `0c1f0b4cec01bef760a06d55c323570eb12627ae` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4356 | Held messages (opt-in, off by default) | `grok/held-messages-v1` | `382979758e8cd33f8a1778ff948938e9d7e2fb80` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4362 | Self-wake: an agent schedules its own next check (room wake-me) | `amp/self-wake` | `eea7048542d7c13682f64cebd8b1b86712821754` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4364 | confirm-live: wait until prod serves a commit (short shas, prod default) | `amp/confirm-live` | `50b31eb29e22f685f584c857faff97c9548f6c3f` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4365 | Thread snooze: hide a thread until its next message | `amp/thread-snooze` | `7b1d09e62769e892d1318787d53696f9a3013ed4` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4370 | Sharing limits per agent (Town borrow 1) | `town/sharing-limits` | `191eb1c0cf506c54af28b0539858732c486f9ede` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4371 | Approve, then act: approval cards an agent carries out on yes (Town borrow 2) | `town/approve-then-act` | `ea05cbe5163b46ea6966ad1746f962f9c8bdb620` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4372 | Shared playbook with version history (Town borrow 3) | `town/playbook` | `63124e5156cc7711e1633a9d09c6c55a3a4ea894` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4373 | Group review: one draft, many reviewers, objections in one place (Town borrow 4) | `town/group-review` | `590f60d57781c1be1b03b49032f917b6b567ebc3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4374 | Live spend meter with paused-at-cap (Town borrow 6) | `town/spend-meter` | `3f63937e7af2c0478ce6ffecab943f03e1a25d61` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4375 | Drafts by default for anything leaving Room (Town borrow 7) | `town/drafts-default` | `d486943b7332e79294773686e4ad904baa2b8fbe` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4376 | Needs-you: approvals, outbound drafts and open reviews in Updates (Town borrow 5) | `town/needs-you` | `ae28309e87460be6df2da8bc154a8c27d29749ba` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4377 | Permission modes per agent per room: ask, safe, all (Town borrow 8) | `town/permission-modes` | `a3c9d729b236b0a146f33f871aeea4b4f0bc681b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4378 | Cost preview before a priced action runs (Town borrow 9) | `town/spend-preview` | `d4799d9d83d61a6b1edcde9dfe91765b88189eca` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4379 | Shared team connections: connect once, grant to the team (Town borrow 10) | `town/team-connections` | `c8b778549e9f9ae9aeab4043d3b04648b4c37584` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4380 | Morning briefing per user across rooms, off by default (Town borrow 11) | `town/briefing` | `30d0895a2cd38599c3a676c0198fcb9b39417b85` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4381 | Team routines: installable blueprints and shared room routines (Town borrow 12) | `town/routines` | `80ddfeb81c47b732a0ca2811eaacbeaa5bc447d2` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4382 | Agent memory notes about the owner's working style (Town borrow 13) | `town/agent-notes` | `f9843651c28a4390dea599541eca577eb5afaa96` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4386 | Combined 1020 landing: 51 PRs on one branch | `grok/integ-1020` | `c45b07b56d08169bcb16fcd90ec95113fa8a8b36` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4387 | MICRO-4348: REV-4348 notes N1/N2 (guest census comment, rejoin evidence cross-check) | `jill/micro-4348-notes` | `9160ca7dfc5edca90f28d598a502bdb98433e1ed` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4388 | ChatGPT app: /mcp/chatgpt profile, inline widgets, OAuth discovery and client registration | `grokbot/chatgpt-app-20261020` | `ae02fc0df1a2c22ebf1c100a52ec45e47c16a903` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4389 | Regenerate i18n harness baseline after #4288 deletions | `jill/i18n-regen-20261020` | `06314745fb74ff3b50ac29a88f74813b75cca3ff` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4392 | SEC2-C-B: unverify requires the attester or a membership admin; gated seats suspended on unverify | `jill/sec2-c-b` | `4152911f59b42b8d1893a4b6b0ec6e211f72f3a8` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4394 | Overview counts the board; deploy pill names why it is unknown (UT-HUMAN-WEB) | `jill/human-web-20261020` | `4c9e75dc2cd020c1eb66b2dfe147a0a483c5e780` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4395 | Packet repair: create idempotency/token-recovery docs, starter visibility, archive exit, claim-conflict shape, orient HTTP mapping, card lobby tier | `jill/packet-repair-20261020` | `65a83b3735df476482bd7fafb7b4a0defae75b15` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4397 | Share-journey repairs F-2..F-6: project the deliverable, name the live twin, one tier vocabulary | `jill/share-fixes` | `8a00fa231b93885cfc1a7fd0840296560f4f6ae0` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4398 | DOCS-RECONCILE: register the 38 R4 unregistered docs (stacked on #4238) | `jill/docs-reconcile-1` | `3e0ffbe6117ee1a316736ea52f8d7bb00544d033` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4400 | SM-R-SM11: single-source the DM consent vocabulary from the server module | `jill/sm-r-sm11-dm-vocab` | `3e89225ff2357f2bd700a7e8e46f2c59c7046060` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4401 | SMALL-FIXES: journal refused bounty claims; Batch C (5)-(7); loud docs-corpus failure | `jill/small-fixes-20261020` | `85bdc1a52b6d976d8a5969c94da648c8f19f9001` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4402 | feat(cockpit): INBOX-MONEY-1 — bounty money decisions in the owner inbox | `jill/inbox-money-1` | `779787ae4c1fc8a12b33cfa6c0944435b433374d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4403 | Shared agent memory and owner-taught rules | `grokbot/shared-memory-20261020` | `44627d9b768ac85deeb586a38a7feaefe2fafc8b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4404 | Pack dedup: orient carries an id reference instead of a duplicate availableClaims copy | `jill/pack-dedup` | `5a65c5096f1f9b69ceba3a7d5a7e086724fde600` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4405 | MONEY-LEGIBILITY steps 4-6: endowment on balances (P5) + waiting age on undecided public submissions (P6) | `jill/ml-build-2` | `06f2e8c31e9777def7cf282b6441102a2d14129b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4409 | Merge train: room_land batches, bisects, risk-holds, smoke-rollback, kill switch | `grokbot/merge-train-20261020` | `dde2ba9812ff9bfe34040555cb39d7c3f1178214` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4411 | Memory follow-ups: why trail, markdown export/import, weekly cleanup card, repeat-correction rate | `grokbot/memory-followups-20261020` | `fa6e8603527ddd0824e137322248022e2d767564` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4412 | C-5 (Ruling 37): posting-time dispute-path warning + honest dispute copy | `jill/dispute-copy-c5` | `cd7a47e3ba8867b39f5c7eae244bc0648ac0ca7b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4413 | fix(rate): make the agent-connect lookup bucket durable across isolates (DEFECT-PLP-1) | `jill/fix-plp-1` | `ee0a56b9bae8109bf28667ee7488db20c15e37fb` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4414 | harden(bounty): staffed challenger-of-record + verifier overturn gate (EXP-15R items 1-2) | `jill/harden-g3` | `fbae3940e12d59d89c96768592d89dc63f1802fd` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4415 | ROOM-WAIT: room_wait MCP listen tool (waiter + lease + receipt cursor, never acks) | `jill/room-wait` | `52be427dab26ad053a1cd88e1678b29d74c6ef59` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4416 | AGENT-DOOR-AUTH stage 2: OAuth grants act as an owned agent member, never the human | `jill/agent-door-auth-stage2` | `ee17b7663956e6047f44cba9ff0705eed5b1ffc2` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4418 | Guest upgrade: resume the code step from the emailed link | `qa-1020-guest-upgrade-link` | `49e9698c869b482480251ede4c2402cfa42cd1d8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4421 | QA 10-20 room UI: guest empty state, names in pickers, archived Invite, Settings cleanup | `qa-1020-room-ui` | `02bf4901b319e449dad5879110f9879cf2d90a6b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4422 | QA 10-20: connection banner, account-first boot, password rule copy | `qa-1020-connection-auth` | `adf6e311139bcbb23cd67cf47ce08525215bdd97` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4423 | QA 10-20: archived rooms show an archived line instead of the composer | `qa-1020-archived-composer` | `496434c63bc8e615c9da324afa3361edf4c77b6a` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4424 | Fix gmail sanitizer generator on Linux; discard noscript contents in safeGmailHtml | `jill/fix-gmail-gen` | `478e0c6c5a1dbfbffe835d8b598ea2e3a1cd3176` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4425 | QA 10-20: room rename (room.title_set) with Settings field and MCP parity | `qa-1020-room-rename` | `c667041074ff92fcc170a015b181ba7c2b54e399` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4426 | QA 10-20: cut the post-login wait (~50% at 150 ms RTT) | `qa-1020-login-latency` | `9956965fff7b3735a2a03f9fabfdb5bd414c54f1` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4431 | IPv6 rate keys: /64 grouping for per-address caps + bracketed-host mint buckets | `jill/ipv6-rate-keys` | `94ec694ae4adb195d76741dfbdfb7becd75703fa` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4432 | Carrier: deploy-recovery import-pin narrowing (John's Tab patch, seq 16901) | `jill/carrier-import-pin` | `048ebf0565d0386fe6f3183f2dce5dfbd3f9191c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4433 | docs registry: register 33 post-seed drift files (DOCS-DS4-R) | `jill/docs-ds4r` | `16c2cc1d2b684f10d6953393f74c97934bbc4b77` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4434 | SMALL-FIXES-2: discard template/iframe fallback in safeGmailHtml + exact tools-profile count prose | `jill/small-fixes-2` | `ed42ab50cc86d277ed3d79d113716ea934f8a880` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4437 | F9 SEC-2b: trust-stamp raw HTTP /events and SSE /stream at the boundary | `jill/f9-sec2b-trust-stamps` | `99dafdb937a40fc5e30f236c2d7bfcf34a11a3c0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4440 | CI: per-PR lanes are test and schema-gate; slow checks move to one nightly workflow | `grok/ci-nightly` | `1618c4ae225aaa2a4e6b29f03d058c1e82acb5fc` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4443 | Cure QA-SEARCH-1: honour ?q= on the room directory and public receipts list | `jill/cure-search-q` | `fc6284c68c36fdb38a7fc05b010b890be845ef21` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4445 | AGENT-DOOR-AUTH stage 3: RFC 9728 protected-resource metadata + RFC 7591 dynamic client registration | `jill/agent-door-auth-stage3` | `291ce2646495a490aa62c0bbea6145a97665a299` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4446 | docs: link the AI Catalog from the homepage + document working search in llms.txt (GAP-3, G-6) | `jill/docs-discover-1` | `1a294af89f92245e6f2d10fc2884e18b64dfa1d6` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4452 | qa2 client: opt-in wire log (QA_WIRE_LOG) — exact request bytes + status per request | `jill/qa-wire-log` | `2c3f0795ecb8a3360ac6a7b33c6da5110cd86f19` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4455 | Key search, reply-read and discussion trust stamps on the served text's author | `jill/stamp-sweep` | `953578c3985427878297c59f9e45dde1cf30760c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4456 | Fix cancellation before the original Codex turn ID arrives | `dot/cancel-pending-turn-20261021` | `4a3538acdb6f3db224adfa7cc32d362eff488094` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4460 | Keep request progress fresh across room and session changes | `codex/request-continuity-20261021` | `7d7ca64ff573e8b78454bde1e26a4a9d10bee320` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4468 | Team skills: author + run count, skill-scoped corrections, durable store, team_skill action | `grok/skills-store-1021` | `990d35c20e6fccc9a0c49d6197a2ce04d3adc9a9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4470 | Agent feedback feed and needs-you result cards (stacked on #4466) | `grok/card-feed2-1021` | `6c80ec696bd2d0f7d1e92a892750253dea0cd9ee` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4472 | CHALLENGE.md: remove promise pointing at a missing README section | `grok/challenge-dead-link` | `ed97aa7449d426bffd04dafab1dfeef8c931c7b3` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4476 | Per-agent connect link: invite-bound MCP URL | `grok/connect-link` | `d08b065c31aea7bbbea2a6520905d82e7069be27` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4478 | Landing stories and agent-readable docs.md | `grok/landing-stories` | `aa0145ce28b8a4ae05ceeb3eb0db56d0d6e3efd5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4479 | One-paste setup intro: load settings, request schedule, report back | `grok/setup-intro` | `2306538ff70c8d55dc2b6bd48e6dd8d511517dff` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4481 | Forward opaque search cursors through the agent client | `codex/shared-search-20261021` | `843aa8fe44dadb432f44dd00ad7eec2fccf1c585` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4483 | Return from message search without losing query or draft | `codex/search-return-20261021` | `29f0116429fb6bd5b9da2c135d4f15ad33b607e0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4485 | Host outcome contract and probe (no runtime change) | `grok/host-outcome-contract` | `b84a11cfa17d16bf55526c3cc92fe0a97ebacf8d` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4486 | Human approval contract and probe (no runtime change) | `grok/human-approval-contract` | `c80ad3af9b56056a73c3a34253450125628a418b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4487 | Draft approvals: refuse a verdict on a version the human did not see | `grok/approval-expected-version` | `245ccb463c1e8ecbd565f6f435ad1b7cc4647591` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4489 | Keep conversation scrolling independent of other panels | `codex/collaboration-boundaries-20261022` | `d6c6dc774a379429ce3ff92b1829bd1f101875f6` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4491 | Reject incomplete claims before coordination decisions | `codex/complete-claim-reads` | `466536fad38c684bed0f8b10908518e414d675cc` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4492 | Make agent connection checks independent of room payload size | `codex/compact-agent-connection` | `42f9e0c484df433097c5a0b70cf966ae66364e35` | near-duplicate of #4570 |
| #4494 | WAKE-S2: dedicated rate budget for the wake poll and heartbeat doors | `jill/wake-s2-rate-budget` | `14d159d8e12eba1513a392a66501111dd9eff35f` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4495 | test(mcp): pin the structured 401 for stale room tokens at /mcp (#4493) | `jill/fix-4493-mcp-token-401` | `fe67ecb24e432ece874f4f922becce33eaa20303` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4496 | CLAIM-PRIM: native surface-claim primitive (room-scoped Claim object, presence-driven expiry) | `jill/claim-prim` | `67c128129816a5a97fe7fa6bfba754c4be9fba37` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4497 | WAKE-S34: wake lifecycle states — pickup distinct from ack, started claim productised | `jill/wake-s34-lifecycle` | `8a10c580748172fe6d68c1896ae7784ac594eea0` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4498 | Land queue: naming another member as claimant requires owner or manage_members (#3905) | `jill/build-3905-claimant-gate` | `fa1f23748555bb90c881318ee62ddb56ab591dfa` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4500 | fix(board): #3909 Low bundle — reviewable states, lease-gated Renew, claim cap, canWriteClaims mirror, newest-first history | `jill/build-w32-b-3909` | `cdf4151ef4f57ffe4f467c39cde669e8f16fc54e` | duplicate of #4776 |
| #4501 | Lot receipts on the stranger receipts index (#3958) | `jill/build-w32-e-lot-receipts-index` | `c3799e3bada4f005538dc817f61320455d5fdc47` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4502 | Fix #3904 F4: bound messages re-diagnosis by the backfill deadline (+ F5 proof-of-gone specimen) | `build/w31-a-3904` | `c11138ebe64fa16416a47b598693188e67365109` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4503 | Fix #3913 Low bundle: scripts-ops gate hardening (F4-F7) | `jill/build-w32-d-3913` | `22bf15d693623d65cc2f07e4f7607002efefe4fb` | duplicate of #4771 |
| #4504 | Fix #3910 streams-wake Low bundle (F2 leased-enqueue receipt, F3 wake-signal retention, F4 coalesced push doorbell) | `jill/build-w31-e-streams-wake` | `d1a4c63bf4147e847f1d4a6ecab68db4dfb2f062` | duplicate of #4780 |
| #4505 | Fix #3911 Low bundle (cloudflare-do): unconfigured/autolink tick failures, entry CPU cap, backup deadline | `jill/build-w32-c-3911` | `c07888471f4a1da8cd7b678f3791dafec39b6a01` | duplicate of #4795 |
| #4506 | DECLARE: availability + execution-capability declarations for agent seats (MIG-PRESENCE Gap 1 + 2) | `jill/declare-availability-execution` | `888caa0da3f695ffd1439abb956bdb195a886da9` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4507 | unit-ci: keep the deliberate fail-probe fixture out of shard receipt failures | `build-w37-c-4261` | `529cd59530b3ba00bbfeca35abd609196218acc5` | duplicate of #4885 (same fail-probe fixture fix) |
| #4508 | Agent keys: effective grant = key scope AND current permissions; rotation reports the change (#4475) | `build-4475-effective-grant` | `bbfd1666b7dcecdec8cb8d96c1c91caa1bdba671` | duplicate of #4475 (same change) |
| #4509 | docs: E7 Phase 1c — remove onboarding results.md and its auto-commit publish job (#3994) | `jill/build-w36-a-3994` | `8c94dad8769389cc8585aea641cf4b3fb0180b48` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4510 | Access review: surface owner-delegate grants (#3779) | `build-w33-c-3779` | `87b09c0fb9d4a771306616ae8c95e96c33d37a0a` | duplicate of #4783 |
| #4511 | test(work-items): #3761 regression tests — board-appended PR links and recorded outcomes survive work-item sync | `build/w33-a-3761` | `8c08a7d275de853c425d82e3034f91b4bf197943` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4512 | claim-autolink: superseded matches, repo-case webhook freshness, system-actor events (#4063) | `jill/build-w36-d-4063` | `0b1b2fdcac021b4a39811c15167ec5cad71851d8` | duplicate of #4785 |
| #4513 | fix(escrow): poster cannot dispute a bounty whose acceptance is their own verdict (#3906) | `jill/build-w32-a-3906` | `3f6023f55207e21cfb80879dbf42ad49b34fd627` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4514 | Serve docs/FAQ.md at /faq with FAQPage JSON-LD (#3976) | `jill/build-w34-d-faq` | `ac1e13cd67d417db3cc1e515f5b807e3e5709909` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4515 | Fix #3963: GET /api/agent-rooms OpenAPI summary — membership, not ownership | `fix/3963-agent-rooms-openapi` | `0e3ec43be8fbf7b62eacacfd1d8782e42240bafa` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4516 | public-read-model backfill: skip channel with record ids (#4088) | `build-w37-b-4088` | `0c4ddf90a19cc0507b776655c465236ae131f391` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4517 | work-handoff #4064: reject oversize file lists, relabel envelope checks as asserted, correct verify() comment | `jill/build-w36-e-4064` | `1e24d0e73d7d4bd707e23e66f4ac71f47ab7e59c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4519 | Simplify saved-work recovery and clarify continuation export | `codex/compact-recovery` | `acdc42214380fdce2d384f8249930fc5043aa733` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4520 | Align Node static-asset cache/ETag behaviour with the edge (#4065) | `lane/build-w37-a` | `f286dc5f23aaef7cfde9553ae519ec6d560e515c` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4522 | MIG-WAKE S7: per-agent wake-health read (GET /api/wake-health) | `jill/wake-s7-wake-health` | `a77b814fffdc8753b95d9b80c3bcdb7d1fc38fde` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4523 | docs: release lease contract proposal (no effect) | `grok/release-lease-contract` | `0602cee5b9a2a7c26e432e9de9c2177215275200` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4524 | Fix #3778: journal wake pings for wakeUrl-only hosts via an agent.wake carrier subscription | `jill/build-w33-b-3778` | `76c308cc9d86679d8e6fdcb57b525e4c17cdef84` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4525 | Fix #3842: qa5-a11y-c check follows the Advanced-gated Board path; wire it into test:browser | `jill/build-w33-e-3842` | `c348f67a59ea497a96af78052d24068474826536` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4527 | Add /compare/agent-bounties-alternatives (#3975) | `jill/build-w34-c-agent-bounties-alternatives` | `35d41d2d3236d82744ff8cd1d592ba5b98884627` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4528 | fix(scripts): repair manual-owner exercise for current UI, wire into test:browser (#3837) | `build-w33-d-3837` | `09c841aebbe1dd9fbdadea1cdc8163e555e7ea02` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4529 | Fix guest identity resolution across sweep, wake-status and presence surfaces (#3908) | `jill/build-w31-d-3908` | `aff6adb95a0655cf197daef7e1d6bdbb0bfefb44` | duplicate of #4920 (guest identity resolution) |
| #4530 | PRESENCE-PRIM: presence resolves for every seat provenance (MIG-PRESENCE Gap 3) | `jill/presence-prim` | `7b5490a7bfbb4272f0332f6cd6438bf17f432262` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4531 | WAKE-S5: mention-signal TTL + visible dead-letter (MIG-WAKE spec S5) | `jill/wake-s5-ttl-deadletter` | `be6ff1c58891f365a38ad2aaf4dcccb15da7272b` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4535 | Fix #3907 (money settlement): payout lot id named lotId in the settlement view; claim-time lane pinned for settlement | `jill/build-w31-c2-3907` | `a84a561d480e9e6b3dbf4686bbbec39613ba633e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4536 | docs(openapi): document GET+POST /oauth/authorize (issue #4526, authorize leg) | `jill/docs-4526-oauth-openapi` | `dee5369b34ef8b4f9ee2adca45179cb3b6616e06` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4538 | Offer valid next steps when room creation skips the starter | `codex/empty-room-next` | `151a6d35b4963970060486b0b30f687116f5b515` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4542 | copy: SKILL.md pay claims, llms profile sentence, compare verification default (COPY-TRUTH-1) | `jill/copy-truth-1` | `b7b73b8d9bbdbf25e4886ba9c1a9cc612d8eefcd` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4544 | External probe: add the public receipts wall check (DP-17 fleet tail) | `build-probe-revive` | `7d0b1d4a19684ba3031b33fa22c5f4e1ba5f4197` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4546 | fix(board): in-progress form input survives board re-renders (#4532) | `jill/build-4532-form-survives-paint` | `06f609325d1b9320100510808030bf1495b3abbe` | duplicate of #4792 (board input survives re-render) |
| #4547 | Serve the one-paste connect skill at /.well-known/agent-skills/ (BUILD-CONNECT-SKILL) | `build-connect-skill-20261022` | `58c2ca468b0580213689eba61bf754fa83f93147` | duplicate of #4811 |
| #4548 | Receipts: machine-checkable proof JSON — canonical tier enum + verify run as data | `build/receipts-proof-json` | `01d2b644bf5c1a421d79a06290a2af62805618c5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4549 | Cure D1: connect skill prose names the redeem credential identitySecret (+ pin) | `cure-4547-d1-20261022` | `d059b9aff8386c4b02e0caddb945dbbd509633b9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4551 | RECORD-PRIM: the Record primitive as native landing records | `jill/record-prim` | `41ee77151f00763fe34e42d3f2fa0f4de730d4f3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4553 | Wake idle assistant hosts on authorized assistant-state changes | `codex/assistant-durable-wake` | `a94e3fc6b97ca085eb5878494f763b29d1381996` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4556 | Integrate durable Room Host delivery with a single-request protocol | `codex/room-queue-service-1022` | `fdcb91164b0aefa82797449e2a75738dfcd82ecd` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4558 | Receipts: keep test traffic off the default public wall (STRANGER-PASS) | `stranger-pass-public-wall` | `62d8741dca62b2e2018131602899a3d0009f9eb9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4560 | Read the worker database size from databaseSize() | `grok/db-bytes-gauge` | `02d0b8a1afbd372a0ea47dc7fc442574114fb054` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4566 | Add laptop worker discovery, deterministic recipes and resumable Room transfers | `codex/room-native-worker-1023` | `7a5a9230c83f766bbb181f6fae9162bd01bed72b` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4567 | Explain missing room assistant beside the message composer | `codex/assistant-setup-guidance-1023` | `b180742e1922935bb13ae5afae6e7b321c982954` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4568 | Add versioned capabilities and durable local job execution | `codex/continuous-capabilities-1024` | `3ea361573d14e2d646659d9a39e46a471d95b74f` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4569 | Restore human task discovery and assistant status recovery | `codex/dual-role-ux-1023` | `d9f28675a25efa42262c84f2f73143cb1926e243` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4570 | Use compact authenticated metadata for agent connection checks | `potterair/compact-identity` | `6d88f4b08f72c817273709baea9b5dc0662ad2e3` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4579 | docs: clarify outage fallback limits in the swarm guide | `codex/sensei-fallback-limits-20261024` | `fb3b543938f5a81f6a01618f66ee639e16f7adb6` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4580 | Fix restore schema initialization and audit compatibility | `codex/backup-recovery-1024` | `499ae480d7cd987f3f7493577d0144242997df6e` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4587 | Automatically stage declared data inputs for laptop capability jobs | `codex/data-materialization-1024` | `32df435d5fa9b9bb8070d99dbb7f776241ada36c` | near-duplicate of #4611 |
| #4734 | Queue Durable Object alarms and run one slice per wake | `cursor/durable-alarm-queue-11a2` | `40ee4128c554d191f8c2fa627a4b557bb613335e` | near-duplicate of #4736 (DO alarm slicing) |
| #4741 | ci: report-only perf-budget workflow — slice 1 of #3294 | `jill/backlog-do-3294-s1` | `1821e751957cc238043491454590b9f1dc3a2ccc` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4742 | fix(public-work): starter-pool keeper restocks below a floor of 4, not only at exactly zero | `jill/funnel-keeper-threshold` | `014bd0a3c8d2d71c9778e4226d33dc435bc0b9d7` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4743 | unit-ci: keep the deliberate fail-probe fixture out of shard receipts | `jill/backlog-do-4261` | `7de739d9ba79205b306b2288fcbcefce470a7c92` | duplicate of #4885 (same fail-probe fixture fix) |
| #4744 | tests: derive claim scope expiry from the runtime clock, not 2027-01-01 | `jill/backlog-do-3318` | `e115af4430cee8862f0cf826e0a4a00d82a75917` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4745 | claim-reputation: claim_released farming guard — first paid release per (lane, claim) only (#3308) | `jill/backlog-do-3308` | `2989240c750489732b0934f280d1d68ea166f6cd` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4746 | MCP identity mint: honour decorated errors as structured refusals, not 500 | `jill/backlog-do-3270` | `d1482df84ec7eb0ecc3c4545f0c8015dbe2cda62` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4747 | auditRecovery: canonicalize BLOB cells as blob:<sha256> tokens | `jill/backlog-do-3483` | `51d596824828ceb702bf80c0521886626c015951` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4748 | access requests: persist the decider's note on plain approve | `jill/backlog-do-3378` | `5f023f356c9b355b3e9ea7bee34d7ae6e09ec3f0` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4750 | REST wake ack: enforce the shared signalIds batch cap (50) with MCP parity | `jill/backlog-do-3264` | `3b51f10e29539f62b0841435e339f2deedb8295e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4752 | docs(front-door): scope query-param rule per family, name MCP catalogs with exact counts | `jill/backlog-do-3634` | `3cb17aacfd971dea6cb7fb08b838cf5feed7a64d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4753 | test(contract): served-vs-source parity gate — fetched /openapi.json + packet vs route-contract census (#3689) | `jill/backlog-do-3689` | `9019d3962a6823a163271b3e00c4dee83ad11787` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4754 | Time-constant registry + single-role lint (#3686) | `jill/backlog-do-3686` | `86f3dcc9df7e57d49f2bcf6859b5bc8f27245bc5` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4755 | Backup writer-to-reader registry + CI closure check (#3680) | `jill/backlog-do-3680` | `3884bff79f3a140b3e763122ade55f306e6b8bb1` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4757 | test: empty-test-body lint gate (#3681) | `jill/backlog-do-3681` | `2b89d9154c72968aa57d2ceb2283fccae15ec3bd` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4759 | Invite redeem: signal the mint-vs-link fork (identityMinted) in the 201, llms.txt and 422 copy | `jill/backlog-do-3379` | `cb6fa1592bede9c465a497bb54977d1fb709b562` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4763 | Hosted MCP: enumerate tools/list profile+focus in initialize instructions, name real tools (#3212, #3213) | `jill/backlog-do-3212-3213` | `e29b6fe67905ba86f7b3219f40f2ed27890d6b0e` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4766 | Guest identity resolution: deterministic expiry sweep, guest-aware wake surfaces (#3908) | `jill/backlog-do-3908` | `f35aacd10a7924c4dfe2eff2bd603b490aeced06` | duplicate of #4920, which merges this branch up |
| #4769 | Messages backfill: honour the deadline for head-moved re-diagnoses (#3904 residual) | `jill/backlog-do-3904` | `985bd5ff9b3a6a21b2ad17b7bee60460de8bdfef` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4770 | docs(agent-start-here): claim straight from the list packet — full task read optional | `jill/backlog-do-3651` | `02140c7e18dc93443bb4f4a59c9341aed739f610` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4771 | 3913: bound browser shard attempts, cap excluded diff volume, repo-bind rollback evidence, pin container/service images | `jill/backlog-do-3913` | `f83e533386b7ee115cc1ae9416759310bf0d3e8e` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4772 | docs: add 28 error-catalogue rows for record-rails, collab and envelope codes (ERRCAT-47-DELTA) | `jill/errcat-47-delta` | `676543c43aae094bacdd3cb52070c3966853f0e2` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4773 | test(errors): #3659 gate slice — catalog self-validation + human-remedy-or-waiver | `jill/backlog-do-3659` | `529586358781bf0dae5e80f270778b9c48fb86ac` | duplicate of #4809 (errors-catalog drift guard) |
| #4774 | test(timing): #3678 gate — ban wall-clock budget assertions in the unit suite | `jill/backlog-do-3678` | `1acf846ffc6f6e578b67a591eb8745f5425d0081` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4775 | patrol: PR-merge/close settles are legal claim moves (fix false illegal_transition + done_stamp_count findings) | `jill/patrol-settle-legality` | `6907556af24707cb8903eea40b1ce920e7af7304` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4776 | Board UI: mirror the kernel on reviews, renew, claim cap, write gate, history order (#3909) | `jill/backlog-do-3909` | `ca1af0515a9d8219686c34263ac81807ad1412fb` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4777 | Remove the shadowed legacy access-requests list branch (#3406) | `jill/backlog-do-3406` | `d36cfa5ac5cbc36fcf88507a31ff5692290a4b31` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4779 | fix(tmp-hygiene): clean up secret-scan-diff probe dirs; browser-check screenshots via os.tmpdir() (#3401) | `jill/backlog-do-3401` | `f2a67f4fd0efb86d533174b98010cb373a4af979` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4781 | feat(receipts): public bounty gallery with clone-as-template (#3526) | `jill/backlog-do-3526` | `1c2e2de2142d9e237149761a9f274080b6d5f473` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4782 | test(errors): computed drift guard — computed wire-code inventory, no hand list (PT-02) | `jill/errcat-guard` | `f3f15a17ee7218a3186aef480345194413f41d49` | duplicate of #4809 (errors-catalog drift guard) |
| #4783 | Surface owner-delegate grants in the access review | `jill/backlog-do-3779` | `454d047f90cb9edcde8f6d4874a2b2e414743f4d` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4784 | Remove served-but-never-loaded pwa-install and push-ask modules (#3718) | `jill/backlog-do-3718` | `969963974f6d984c8770f3246bfb991eff6849a5` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4785 | claim-autolink: superseded matches, webhook journal casing, system actor (Refs #4063) | `jill/backlog-do-4063` | `26e1fc5be9b0ebc066309f288e8fc7105ea5f1da` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4786 | Gate HTTP land-queue writes on the caller's autonomy tier (#941 P2 tier-gate half) | `jill/backlog-do-941` | `8e303bba753407c364fe28aecb87e4cd7f4da270` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4787 | test(gates): #3681 canary tranche — must-fail + control fixtures for six gates (T1–T6) | `jill/backlog-do-3681-canary` | `2981308a311b1001c99bd1969ac492223617fec2` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4788 | tests: socket fixture dirs stay within the Unix socket limit under a long TMPDIR (#4459) | `jill/backlog-do-4459` | `c5bb990310feff81096b6ba98c581901ab11c65a` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4789 | Open the message overflow menu before Save-as-result in helper-owner-exercise (#4533) | `jill/backlog-do-4533` | `a4499569e0359df13c5ec67d25f33825549641f1` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4790 | Restore growth kit invite URL when a share-link result clears (#4473) | `jill/backlog-do-4473` | `aa09ba0f696cbb7f1dc66f9a3de9a3adb8bfa903` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4791 | fix(#1609): add seeAlso pointer to the public-work pool in /api/opportunities.json | `jill/backlog-do-1609` | `bea20d486f692e992f86c23cd2971eb21b6ffdb9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4792 | Board: preserve in-progress New item input across re-renders (#4532) | `jill/backlog-do-4532` | `5e5acf3daf3525ca648d2edbadba3d5813593407` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4793 | fix(mcp): expose starter on room_create and pass it through (#1566) | `jill/backlog-do-1566` | `24b4623c76224df6b2649adc3f7029ecacfbfe14` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4794 | fix(client): land initial focus on view content for rooms list and board (#4461) | `jill/backlog-do-4461` | `912a48ab2da6ba97a0a8b4ec1b071e499d1bbd56` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4795 | fix(#3911): honest job sub-failures, entry CPU limit, backup deadline | `jill/backlog-do-3911` | `5517bcddf2c2357dfaadad9a54362f4602c03a81` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4796 | docs(packet): reconcile public-work claim doors, name stale codes, state credential lifecycle, enumerate 512 KiB commands | `jill/backlog-do-p14-packet` | `b390dc4b9d4875fc8f532a1fe02065e5bc424394` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4797 | feat(discoverability): inventory the public proof surface in served OpenAPI (#3700) | `jill/backlog-do-3700` | `77b0e5a07cc8516ff9b0288ada909899821a89d9` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4798 | fix(escrow): acceptWork refuses at the deadline — #3591 accept-vs-finalize leg (money singleton) | `jill/backlog-do-3591` | `c2a0bea8eaac4afcab37c47b1d3b57c8d30df4a2` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4801 | fix(secret-scan): #3682 base-relative whole-tree verdict + spaced-path root fix | `jill/backlog-do-3682` | `9e30da84a8f4f6a3b67ab23757e350c511fe7034` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4802 | Fix #4493: expired/stale MCP token falls through to the structured 401 | `jill/backlog-do-4493` | `031b6e6a147f416a50179d96e7af9f76180dd9ea` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4803 | Measure the activation funnel's saw-board stage: record board views with claimable counts (#3588) | `jill/backlog-do-3588` | `b706f97701a4cc6625f2a0d07956814d2da37fa4` | stale (no commits in 24h+) and red; idea recorded in docs/ARCHIVED-WORK.md |
| #4807 | Arm signed bounty receipts: operator env signer wired into the production escrow | `fix/receipt-signer-env-arming` | `ba7bf54a083f16e97deee038517a2b1a1fa5746e` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4809 | Errors catalog integrity: regenerated rows, HTTP fixes, status-first drift guard (#3658) | `jill/backlog-do-3658` | `5bf1df9e21daeca9720f40c1e0f127a6f3a5689d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4816 | perf(events): light-clone workItems + messages slice in cloneStateForApply (#3408) | `jill/backlog-do-3408-ship` | `2cca761c617b0e0f1774d6df26a84c9d92336270` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4817 | Serve legal pages and static shells without the Durable Object | `cursor/edge-cache-static-pages-6692` | `0e201adbd2486ea1583c8b3e643b493628400fdf` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4818 | Keep test identities off the public agent directory | `cursor/public-agents-directory-da81` | `f8d3079a6ef334185b02bb8845c47a2f72c35b54` | duplicate of #4834 |
| #4823 | Serve minified, content-hashed browser bundles | `cursor/hash-immutable-assets-6692` | `2fb2af303bc49345668162a9986a0f5a926acf88` | duplicate of #4898 |
| #4825 | Optional Conversation, Work, and Receipts lanes | `cursor/room-lanes-b7de` | `104fe379794ac96a11ce726492aeca7fafc47ddd` | duplicate of #4852 (lanes vs tabs) |
| #4830 | Inline landing hero CSS and defer the stylesheets | `cursor/inline-critical-css-6692` | `961a55690dcde05eeb565b7c69d1e3dac5ac6505` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4833 | Add an optional fixed-state board face | `cursor/board-fixed-states-b7de` | `662f2677be942de11fb8daa5c70a700d1b5e03a6` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4836 | Sample successful request logs at 10% and keep every error | `cursor/sample-request-logs-6692` | `da59a2c4bb4eeff2aa73b5b804237239a94e6fe8` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4837 | Page the default room read to the newest 50 messages | `cursor/page-room-reads-6692` | `5b3d493803b0d320dcf482824948868e023cd072` | duplicate of #4857 |
| #4841 | Publish public pages only for rooms that changed | `cursor/incremental-public-pages-6692` | `1da1c86617d3a5036cd8ca76ba832cbb6240ec83` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4853 | Scope webhook subscriptions to one room | `cursor/webhook-room-scope-da81` | `f976c57272b2982ee03110f1f1f9ba5bd0334332` | duplicate of #4844 |
| #4858 | Wake webhook retries at the delivery's next attempt | `cursor/webhook-retry-schedule-da81` | `dba5f8413752ea1b5991b5cf671de28eac28ff1d` | conflicts with main and is stale; idea recorded in docs/ARCHIVED-WORK.md |
| #4889 | Cure: guard signin-navigation sync() against absent provider anchors | `cure/signin-navigation-absent-anchor` | `efaa8a9ecc75b3fec780510f9ab94fb926f1e909` | contained in #4922 |

## G10 combined

PRs folded into the G10 owner-cockpit and operator read-model pull request. Each row keeps the head SHA the combined branch was ported from.

| PR | Title / idea | Branch | Head SHA | Why closed |
|---|---|---|---|---|
| #4008 | Owner inbox #3340: account-home Needs Attention badge + per-room deep links from overview Decisions totals | `jill/build-3340-attention-badge` | `0f5448e0ec2e47db0e98e9753551fcfb916c7acd` | Combined into the G10 pull request. The candidate manifest was regenerated rather than hand-merged. |
| #4010 | Owner Cockpit slice 2: Money + Roster on /api/owner/overview (#3343) | `jill/build-3343-owner-money-roster` | `1e08a6453ec5939d3480797f2ca8f8e12b8c21c5` | Combined into the G10 pull request. `stateGroup` and `POOL_ACCOUNT` are exported so the overview can import them. |
| #4022 | COMP-DEEP #1: verdict inbox — attention set + sectioned read (server) | `jill/cd01-verdict-inbox-server` | `93c03132073749d1ab2c002105f224ae44cb79fb` | Combined into the G10 pull request. The read is a route-table row, not a new legacy-chain path. Follow totals stay null until claim-follows.mjs exists. |
| #4756 | feat(door): public door-funnel aggregates read (DOOR-FUNNEL-READ) | `jill/door-funnel-read` | `83c63e6b5cf60173d8045b35731aadf5022f4755` | Combined into the G10 pull request. This is the door-funnel contract that landed: route-table read, owner-only mint counts, ten-minute cache. Login-panel and sign-in cure commits were already superseded on main and were not reapplied. |
| #4764 | Teach patrol the PR-outcome settle (claim_legality + receipt_linkage) | `jill/build-patrol-settle` | `063fea8f6dd09fe2ab07d83fc81b7cac90b016c0` | Combined into the G10 pull request. Only the patrol settle and its tests were taken. The login-panel baseline and sign-in cure commits were already superseded on main. |
| #4805 | feat(routes): publication declarations for public routes + registry gate (#3674) | `jill/backlog-do-3674` | `179480b4fd277d79f647301fcb5728c8d8e5fa23` | Combined into the G10 pull request. Declarations also cover public routes main added after this PR's base, plus the door funnel. |
| #4886 | Add repro hold check and per-agent audit read model | `cursor/repro-and-agent-audit-6187` | `a74d90d45675ea746b97d6238bcdf79f7861a4f8` | Combined into the G10 pull request. Both modules stay pure reads; reachability keeps them until a route wires them. |
| #4890 | FUNNEL-COUNT-1 (Option B): door funnel counts at the Node boundary — GET /api/public/door-funnel | `funnel-count-1-door-funnel` | `b37c978b1d61fb24174dee3918e78c50bdcd3279` | Superseded by the #4756 read on the same path inside the G10 pull request. The counter writes on every GET, uses ISO weeks, and returns public mint counts; the kept read does not write, uses Monday America/Los_Angeles weeks, and omits mints unless the caller is a room owner. |

## Branches with no PR (deleted in cleanup)

| Branch | Head SHA |
|---|---|
| `bu-08/invite-ui-error-copy` | `8ba4a1c0876a1fce50f6b73b8622ea566bb61bcf` |
| `build/requestid-system-v1` | `b2c60825ed6f9190e965cd01bc15482552f8c056` |
| `burn/kanban` | `266c74e36351441adb8452812124ffa2527cc1d8` |
| `channels-recovered-staging` | `f5dffd29b2e3b51503252633c73efa1b7389bac0` |
| `codex/connected-workspace-plan-1011` | `d1e28d211cf8fcdc6fd3c7c78420e01c6b1894cf` |
| `codex/delta-savepoint-wakes` | `4ab3657296fdd04a9fff1d330844e5b167ce9e4d` |
| `codex/request-latest-production-release` | `a56933f7c5195f59003acd787b20994628904a0d` |
| `codex/rollback-base-20260930` | `c5da2b6b7adffd072ccd74e0e953bdc67fd871e4` |
| `codex/small-release-batch-20260924` | `f2c5183dabd38767b4ea0dcb2870e1f496511abf` |
| `coord300/guild-01` | `9fc6ce3958e85d8d928320494ce391db7e352b85` |
| `coord300/guild-02` | `9e38b009473c37f237bd0f6ff6aab35fb799b68d` |
| `coord300/guild-03` | `19624855a97389c08e31ff015fb89f74ef297b0e` |
| `coord300/guild-04` | `460632ff5784d93085ba0eaab760ccf17777d124` |
| `coord300/guild-05` | `ebaebe187f9e0078df451828afe6fa95ff2a494d` |
| `coord300/guild-06` | `d74e7fb20141ba5853ba3c5b0b60b876824e145c` |
| `cursor/door-join-hash-forward-471d` | `bd6195def95ef3aae79b4f3487532e690e83fc57` |
| `cursor/human-push-mentions-dms-rebase-1018` | `165d52690f6cbf68733c4b7de41f81e9c82b051d` |
| `cursor/mcp-core-profile-1009-rebased` | `e1dc901f78bca19fcd251b01363727dda9524e6f` |
| `dot/phone-feedback-reload-20261021` | `b73ffaff0cf651eace8b760f9d7cee57e748e9b1` |
| `fixwave/c2` | `b3fc15780ee69f32995891735756848505526e04` |
| `gb/auth-journeys` | `3894f249070d2577085a542b30c1a3337af3d6e1` |
| `gb/owner-inviter-line` | `a03a7024f1edc4009a55adf628eaa31bf9b7326d` |
| `grok/ci-playwright-apt-retry` | `bd1ad0ef3e0dd46165f32cb433cee611202e805c` |
| `grok/claim-map` | `b9d444ff2f38203642547ae56f7e808cb57b34dc` |
| `grok/growth-measurement-unpushed` | `d47a57d5c62df256ae901cbf6782d24407efd2f1` |
| `grok/hard-work-lane` | `005e2e50e7af60eb8b1e37d1594da942d30fa902` |
| `grok/land-1020` | `6d84149b558e003fef1d880f7194f75c788dff5e` |
| `grok/landing-handoff` | `0dd240c2768b22e52a9c376c7e6f6f87e2a60ead` |
| `grok/lookalike-residuals-4445` | `a3c09d31836d66021d15b9069cc197c87c697a13` |
| `grok/machine-provider-contract` | `6fbc93066060554461f51e7fc24aa83d091a9599` |
| `grok/needs-me-latest-mentions` | `970939451157b0e20ee57f6f371c34b3a178b382` |
| `grok/opportunity-title-surrogate-1010` | `f1be63eeffcbfe289a8932731104856c47c048cd` |
| `grok/qa2-systems-seed` | `b8fa54bc8887ed77afc184852a711a3e622e1582` |
| `grok/qa6-ax-1b` | `41188b658b09b40b3b397d1efd817e1a416b1915` |
| `grok/qa6-ax-1b-v2` | `6ae30cd47ca45520b0e5f7ecb8476e0674e7da59` |
| `grok/qa6-door-links-1b` | `ad3f740f0bb809a2e125a2401eafb975adf4e393` |
| `grok/qa6-door-links-1` | `f4f417bc710543f1aac6e4457dfadbd9b4fa13c1` |
| `grok/qa7-1544-window-fix` | `cd1a791fa566dc804256a7c70ab54d26b8ad2423` |
| `grok/ready-timeouts` | `e057edad7506af131671abebb7119e9a9d4b2abe` |
| `grok/sweep-2026-10-05` | `f46f394bdc4a8a00556ad7534246597bbee2f3ac` |
| `grok/4445-lookalike-cure` | `178140875cb5353db892abf31d877f1fb7a3cb3a` |
| `guild/integrator-requestid-reconcile` | `5554b5eda2f5e5d66a9d49aab7e9f37bc66d2cd3` |
| `guild/integrator-service` | `39bb2a748fc42d3b5da72fafcabccacd06b3916a` |
| `guild/load-calendar` | `f9509bf6703761eddc202682da4afb263282fbf9` |
| `guild-claimsboard/lease-first-reaper` | `410ab05ca6fa34df1bfe680ef67810b686925996` |
| `guild-fix-lanes/w1-requestid` | `dbe389222fba59a0497954f1d5a63cbf7c1210fd` |
| `guild-fix-lanes/w2-renew` | `e2b3512d60b321a9e465e8420d0e9243cf3ed121` |
| `guild-fix-lanes/w7-history` | `243741b6dcea7aabd91eebb448fe30877c15ff25` |
| `guild-identity-sybil/bound-invite-codes` | `926db7c423415cda990246fd2ed710bcc1c0e072` |
| `guild-identity-sybil/identity-discipline` | `4fe061b14c3bee66b8a2b2eb5802d00a55346620` |
| `human100/guild-02` | `5214c37bfaa237f53fd01b430ce24dee3bae558d` |
| `jill/emissary-slice3-ringdetect` | `e484fee985dbfc60cfc6d2b58e21a483f5cc14d0` |
| `jill/exec-e7-phase1b` | `f4dd81bb0388964d805460c4efefa234e79db0aa` |
| `jill/fix-3269-alt-hook` | `fb993010fd57bb9d6d7c5dc530fef7de87a3f5f4` |
| `jill/honest-push-945-from-pr` | `9cc0212d6880a7c95d940cb39af838c6ae704e92` |
| `jill/join-api-activation-pack` | `47654876d6d74b15e9f8470aa5fdb2751b71fa95` |
| `jill/loop-installer-auth-fix` | `bbc3847ff6b83e11820ef5666e8ce1ebf6ba2ade` |
| `jill/loop-relay-low-fix` | `3b8a673a4ccfd652597bee800f136c1abdf60cb7` |
| `jill/loop-relay-m1-fix` | `efb9191836e1fa7cf17e1b4369a2fa6a095810d0` |
| `jill/product200-a3-release-anchor` | `26b0066aa6e6ed99b0ad6a011721e2789db2776b` |
| `jill/public-claim-verb` | `764cc4b310ef45043ea7b5ed467e6c660882b93c` |
| `jill/rollback-qual-fixture` | `923b503d6194a14edba1b498a4970db046f60162` |
| `jill/w2-verify-pipeline` | `df9a5aabb11aa80e628d861a722614f821189883` |
| `jill/wave500-g2-qa200-unread-r2` | `bdf52c9c46fefe8616c928d963523970c5c75423` |
| `jill/wave500-g10-inbox-expiry` | `cb7a2d317976638a0737ba322563874fbd11183b` |
| `jill/webhook-fanout-937-land` | `c1955c0f2d61dce4798848ee13ae377948dd589c` |
| `jill/webhook-fanout-scope-2026-09-24-rebased` | `cf83e4559dee04bdaaa91c87536e36088acb59ca` |
| `jillian/rc-2861-moderation-visibility` | `40037a8467fe507a448050bf4721bd2254eb0c53` |
| `land/catch-up-own-events` | `c6e9a14c444e5e2ed498c51db0c2a1d836be4e84` |
| `land/nullsafe1981` | `357ea767d6fccad2273d2f624f16d817d1aa70fa` |
| `land/setup-resume-v3-1` | `4d0ee58d8be7ec764596a817a3a5a3196ed1a0a7` |
| `land/work-search-test-tick` | `51dfcf1cadde296b827d035d8d429d1b7b88e867` |
| `land/work-search-test-tick-1` | `4574669a15625f97ef48807cd7ba6bdcab846bca` |
| `pr-open-join` | `f5f9e0b330f3b0b692ba1e2c0e4432509b05e138` |
| `rescue/jill-audit-fixes-2026-10-02-1400` | `1e28b0b6207ddf7ea5936e143d04d75ee2df4677` |
| `rescue/jill-dot-f12-board-read-1468` | `2f3448b4f97146968060d0f740406574e76c400a` |
| `rescue/jill-fo-two-line-discovery-1390` | `b2ea0daf50a888c0bf80a937b15a397535c483f0` |
| `room-state` | `c35dd17330fc2aa7b80bc0a274c978defff95a51` |
| `telemetry-bus` | `0b9f3543f9b0875bb25fa7ab4ba7e3cc5bdf6ee2` |
| `telemetry-bus-dashboard` | `742fab2870d468429ca1eb01b1df5caea8dd8927` |
| `telemetry-bus-docs` | `214cdecf5c36840f4e6fcc75b807a84b2083841b` |
| `telemetry-bus-docs2` | `d6f86f8a9e4c1a89283b2c7ed96d659e19a9edaa` |
| `telemetry-bus-schema` | `1fc02a032d7c568e6587fde5526ecd98e0de3954` |
| `telemetry-bus-submit` | `ed1b32f174ddce592f22a955d52c8fee12f81759` |
| `telemetry-bus-verify` | `fe3e46f9d41cdb98d4af0c98d35c6573074646a7` |
| `w500-g5/c2` | `9a683234b81d83dbd09250743734f5ebd239acec` |
| `w500-g5/c7` | `bac5f8f012ce5505110037c907cdffc27c6a5e6f` |
| `wave2/3783-composed-preserve` | `7b81054e13270ba4b780f86068cd631b261c0098` |
| `wave300-fanout-perf` | `9b43f6e14832312d10b023d663d62e449fa79e30` |
| `wave300/data-plane-fastpath` | `18f6fc13d069cbf9b0fba813e787b65ed470f93f` |
| `wave300/fix1-commands-failfast` | `c04a1d5f1551434bb8f3e7f969a4697c526410a6` |
| `wave300/fix2-heartbeat-path` | `7eabce4c6efd6e2bfb8c1c87768a0c625c09692d` |
| `wave300/fix3-token-leak` | `411e847bac3fb78c7600c529712bc29674f80226` |
| `wave300/fix4-eventlog-read-scale` | `4eceef37698ed88bf0abc06cffe61cc33be548d2` |
| `wave300/fix5-release-compare` | `99d9f66f46fdc3c2d4252333b91b745330b41842` |
| `wave300/fix9-409-body` | `767b98ff093085b088cecb12cbb0c687d08fb0bf` |
| `wave300/fix10-federated-guilds` | `84c4b4f9be932c340cdec963fc13d4117d1154a4` |
| `wave300/fix11-renew-footgun` | `2b0bbe5af89d3dca64653248b297ab9dafc20548` |
| `wave300/fix12-unprivileged-succession` | `143543319783cefdcc0e956c350e726d4e57c5c6` |
| `wave300/fix13-quiet-reaper` | `2b35f1e982c7e3f615a5c5acd38131ee0dc45734` |
| `wave300/fix14-expiry-checkpoint` | `1e61db3dcd42b3aa90330fae81653940eb1d82ef` |
| `wave300/fix15-orphan-wake` | `fdab6186391abb65aa181bdfc524fb721a8eaea5` |
| `wave300/fix16-history-runbook` | `a540f36ce86b4df2d76dab4fa49ce65c51202798` |
| `wave300/fix17-successor-election` | `f408dbcf3cabe35a20af7d2bebd0c6eab384923a` |
| `wave300/fix18-cap-gapfill` | `9a432aaf1a82d6b64872abaf9db98bb6ae30b93d` |
| `wave300/fix19-correlated-death` | `b539d8c2ac108520b66207d812fe4e97c996187c` |
| `wave300/fix20-epoch-fencing` | `d93d970b933a9281d8f9ac68be3635b30daf28af` |
| `wave300/fix21-claim-checkpoint` | `52e38ee69e49e6f10060fb2a6b61427891362efc` |
| `wave300/fix22c-ci-queue-telemetry` | `20fbf1f11b86b1cda51e8f6facbd522bdb7c88a2` |
| `wave300/fix24-static-partition` | `a3e41422e7c7871abaee49386984bd69d597004b` |
| `wave300/fix25-telemetry-schema` | `3f281918526796e667616cb2c03f639b6579e7fd` |
| `wave300/fix27-credential-hygiene` | `7b965cdd3349b0fee350d0d885f4aa1ffbc4b70a` |
| `wave300/fix28-error-code-branching` | `b06d9a6b587ca6733a4698dbc89915ee23dcd17d` |
| `wave300/fix29-write-budget` | `e2ecbb400e14d524148ff6410ac436beec27adac` |
| `wave300/fix30-prepr-rebase` | `4db6b66fc0aa24eba419699440b138997ead66a7` |
| `wave300/fix31-base-freshness` | `5bc45f2267b3de1879312ca851241bd4b61b8243` |
| `wave300/fix32-mergebase-hook` | `84535b5574e6f5f3ddcf0521e613953f6a1967fd` |
| `wave300/fix33-path-restat` | `7482b36bcf2316d0b78622639364aeda73bf81ec` |
| `wave300/fix34-conflict-events` | `9e03788471bb183870fb9c6708e3d406a3e22bc0` |
| `wave300/fix35-filelease-create-update` | `966bd69820797e3f91b90e7c70162f2274dfde0a` |
| `wave300/fix36-dupkey-gate` | `e2d690015a05e4fd4c044ee461d811837e7dce47` |
| `wave300/fix37-claim-first-scan` | `72a5b19a7453c80557eafbec1909cca4e07bbf18` |
| `wave300/fix38-cursor-discipline` | `348af4a1034505b68f4c5f66eeaa145f819fe5dc` |
| `wave300/fix40-uniqueness-assertions` | `1f931dda2a74272f2d7d0c844a7c5e2b672774b5` |
| `wave300/fix41-contract-fixtures` | `3baefab1eaf71e8c6ebc46b516075efd6a28c9fa` |
| `wave300/fix42-rename-proof-tests` | `8d865b8a2f3eeabbf9ad29add170d1338647b350` |
| `wave300/fix43-contract-announce` | `330407aecc0890110ed1eaf4395158212b8ecbd2` |
| `wave300/fix44-contract-lint-nudge` | `6ff98d7ba300263eceaa139fd65874afbdf6fb2b` |
| `wave300/fix45-require-files` | `e6ee011ce50f77efc8aaff9df9c5154e89a6f0a3` |
| `wave300/fix46-blocked-attempts` | `3fa49500ae38a4a64ac59ea79e4dea425c3309b6` |
| `wave300/fix47-dupe-scorer` | `3684a78b5246b05b0fab0cba1398483f7b5a1ff9` |
| `wave300/fix48-scope-dedup` | `8f65d59aff3aa65cd76fb585383642a8e6fe3422` |
| `wave300/fix49-cursor-contract` | `bec039ebfaf8616fda3cfe2bf2a136885c512996` |
| `wave300/fix50-git-identity` | `2ff7a9c0889ebdf2db1fa7f0d7e3cbae68cfbef9` |
| `wave300/fix51-rebase-guard` | `7913331ec21fca3d4028f6ac8a342cca74957172` |
| `wave300/fix52-claim-arbitration` | `2b8c3feb6b64255d21d9251a8f937fd8cd90a26a` |
| `wave300/fix53-claim-caps-docs` | `99d0643e5e8796b5719dcda53e5a9ffec0d3498b` |
| `wave300/fix54-telemetry-collector` | `888832c8ab04f60db2b0ccd3db417f714d978661` |
| `wave300/fix55-capacity-digest` | `383ee39693541b8dd6822097e214f4eff5c4010a` |
| `wave300/fix56-telemetry-keeper` | `cf49e07da8ca54bd4fedf9e8e35cc9b0b41f94f6` |
| `wave300/fix57-op-timeouts` | `d0db5e61ec680a1f7d7a9bfa36a062f9b7aef79a` |
| `wave300/fix58-namespace-telemetry` | `326be73b6a8dbc559c5be10903ca989760ba4339` |
| `wave300/fix59-presence-fast` | `e2b561462107ff10d6e4824849466a09cb4f454a` |
| `wave300/fix60-batch-decide` | `4ad53e61ad9cfe1fc48853d741666e7a034c99da` |
| `wave300/fix62-rate-families` | `f9e0a074400d0d9f8fb5d4edeb6ea7cce1330beb` |
| `wave300/fix63-access-decision-notify` | `50b99980f399d880198788ded9abc0c5d62da2e3` |
| `wave300/fix64-429-shapes` | `849997bc730d932a5d4a71fdf05184845920f050` |
| `wave300/fix65-agent-cap` | `bafa9998ee395518dddde34fa0a29f6c9a11dd71` |
| `wave300/fix66-kill-switch` | `eaa4729ba4f14827f3cb15ef670811c6dc7e439d` |
| `wave300/fix67-presence-online` | `cce24ca601fb4d06bf76acd833aa93d80bf89bfc` |
| `wave300/fix68-claim-channels` | `0e58a5ea7887d58feb04ec4afe3b2df27a92dfc3` |
| `wave300/fix69-event-light-claims` | `f11c3faa78635cf2fe8034b251c318f57a2478f3` |
| `wave300/fix70-membercap-counter` | `fc2b12e9fcdff36a880d6b6a32d783fa5a7b7e72` |
| `wave300/fix71-advisory-leases` | `6fa0a13bd78d92d81c563c2760a5c9aca3591684` |
| `wave300/fix72-occ-generalize` | `ec05322970729e115b5613f05114d554b42e3a4c` |
| `wave300/fix74-roompost-fallback` | `aa782a28c09c96a1283917ce8a0122653b0d7f7c` |
| `wave300/fix75-market-maker` | `2c2cb9204641d4f75d7c8e6fc0af41f4fd929aa0` |
| `wave300/fix77-sybil-caps` | `929310da731a79d9d3b928b49749dc990c493b55` |
| `wave300/fix78-latency-attribution` | `d7baf818c7d5ede66c1fd74693959028d61039c2` |
| `wave300/fix79-mention-budget` | `ef716f55e1439d52d081e92e477eea8a4bcfad24` |
| `wave300/fix80-redteam-charter` | `a9b5e64f6626cb0c72d0535d062af0e7f021a990` |
| `wave300/honest-backpressure` | `f6e448241b3588dc23c95e49d642f1de90e7ac43` |
| `wave300/payload-store` | `1d41de10056c2a3633f243f237431467a13af16e` |
| `wave300/reaper-landing` | `7077f5851ec2548cfd9b9ba6867f8970220c984b` |
| `wave300/sharded-claim-boards` | `fca3240731f5ec04f48672e0f4e6f6c65d182b83` |
| `wave300/telemetry-prod` | `a61e07c29835cf1c993d74f193338b4ae7ad1508` |
| `wave400/audit` | `dc501447cc2e103c76f4ae7c91c19b9d2b60676c` |
| `wave400/docs-core` | `66687643cdd0ed6ab454ccd862efa3fde7c5afea` |
| `wave400/docs-tooling` | `ac5bd952f9367f3b867a0c3b95695eec383cc1a3` |
| `wave400/elegant-http-a` | `89f042538a9431f1c5022c4aa6e545849b4de151` |
| `wave400/elegant-http-b` | `e68d5f71d93001fb1042f68e6a6030c95001bc25` |
| `wave400/elegant-http-c` | `5069336361b28ac97bdaae33a982a5bdcaa4e218` |
| `wave400/elegant-rooms-a` | `61e335e20415d154e1c3fb755b83751564f0bd13` |
| `wave400/elegant-rooms-b` | `980eb824ca6acdae82fe34bbd7a26aedb5b4c7bd` |
| `wave400/elegant-routes` | `72ec29a0a85274cc342435fbdf1108d0ef2b3c1f` |
| `wave400/elegant-server` | `268a2786b7bf58fc6de133145578060d8e7296d9` |
| `wave400/elegant-store-a` | `98ed9a537a54afdd6c1894013ae83b65b65cf93a` |
| `wave400/elegant-store-b` | `81162ee640ce0c1002c6064e2e7ef0c1bcba02fc` |
| `wave400/elegant-store-c` | `d17b2378ca4aadb2ceb6d91f2bf4b049bb178920` |
| `wave400/elegant-wclaims` | `6d811726f87618f307606107016dfa5b7f6367bb` |
| `wave400/elegant-wcmisc` | `ef4fe6a2b3d8a58732e4ab41ea81207d77cc5ec6` |
| `wave400/elegant-wcroutes-a` | `23dcb8d9718a3e082b84b9a99a913fddc7616778` |
| `wave400/elegant-wcroutes-b` | `86b39533e389cb9dc4da9f75b2138d05f2d194c0` |
| `wave400/fuzz-harness` | `a5ec44bccf507c934bcb300bdbb4f51267806cc9` |
| `wave400/perf` | `88200b0a9d172cee4f38da4baa0eb689fd9cff87` |
| `wave400/perf-emit-cache` | `676adb363d39df09364c3970c8db98506d1e7a62` |
| `wave400/perf-index-audit-r2` | `cd0ebe39cd928d933c0c7f88e785be76e6ccccb5` |
| `wave400/perf-stmt-cache-r2` | `0a4c538e6cfb2afdf9887720aa4b7ae1260990ff` |
| `wave400/workflow` | `8e5384cdf87e6d35dcbe69cf6c88e64cc921572d` |
| `wave500-g4-receipt-released` | `7e5957703ffa16656dddedb273870afa7234c431` |
| `wave500-g6-r361-readpath` | `641ce14c5f84e01d5c028e1eda14bf8874f75f7d` |
| `wave500/coord-cost` | `df9dab52d532260dd35b17fd59f1ff6c8214503b` |
| `wave500/event-survival` | `a028420259dad3ef97f1c57141788b53072a9038` |
| `wave500/g7/b8` | `8e9d3507e75fb530b60b76a24cb7e0161f15f560` |
| `wave500/g7/c19` | `651329d841bc33ab557926681bd5827809685530` |
| `wave500/presence` | `e3b1b4acad1df1b92061e5238855c250fc3dcb81` |
| `wave500/presence-w1-scale` | `75d93b564f92ea4d62ab3b0f47e65b8619155968` |
| `wave500/presence-w2-pump` | `a0f9ab3d12052aad6139e8ff4768197f4a5a3b09` |
| `wave500/presence-w3-pump-tests` | `aff992c79736af6ab7f480e64fa1b2166b7d6d72` |
| `wave500/presence-w4-delta` | `c8028510cf338d7449c3e5e85fad43bdcecfe539` |
| `wave500/presence-w5-delta-tests` | `75bc041b8961613b9c31a5ff30e1c27c75559e21` |
| `wave500/presence-w6-presence` | `908c05babbbe9919cedd77143d88757bc35d2146` |
| `wave500/presence-w7-presence-tests` | `9417708fc4bc8b6ebdfedebf967db32083eca864` |
| `wave500/presence-w8-stream-bp` | `f4b6bbee0f54c256b6ed23da18f25a4b87858d97` |
| `wave500/protocol` | `5b418e90af37139b22d882faf92c535dfc685ba6` |
| `wave1000/guild-01` | `66cc81b7bfa54810dc8abe9a078b1172f0689d89` |
| `wave1000/guild-02` | `c02291546723dbc04b625cd3fd22bcb5ddc68f21` |
| `wave1000/guild-03` | `0c023d4636702be0efb6d400e67049259190a52d` |
| `wave1000/guild-04` | `7e7f68936571e7286a01aaf69551e76623daadf1` |
| `wave1000/guild-05` | `1e41c9728eb473483498605d3eb759641ffa78d5` |
| `wave1000/guild-06` | `f7d169a97861da5b95f30576691fad46fe3b8e56` |
| `wave1000/guild-07` | `8ab07c98b3f0e23a7db2c823a106d3f1bcd3ac01` |
| `wave1000/guild-08` | `74d66d886ed1d53d1e7cfe6eaba7d056f7f8c57f` |
| `wave1000/guild-09` | `aca6b0df76ce1c36fd6d8b9d4abfc2c4377f2278` |
| `wave1000/guild-10` | `39423470e3796de2f6e9b1b76ddc10768dfde531` |
| `wave1000/guild-11` | `c5c37c4c084a1da0bea4af101f0693287cdcb520` |
| `wave1000/guild-12` | `13e5fd1f3fb595cfdb12031f027258a8cac1cbe0` |
| `wave1000/guild-13` | `222b2daf564f9c0d379777f78c695d6466aeb5c0` |
| `wave1000/guild-14` | `8f00d98bca61f2cabdeff1d0afbfde09ae62045b` |
| `wave1000/guild-15` | `24f74be25029369222afab831f723e5797526b68` |
| `wave1000/guild-16` | `7497e232d0e6db435c0a2514398a6fa4fa6edcf2` |
| `wave1000/guild-17` | `55616be67820c770ac30783c57bcf8febfd8022a` |
| `wave1000/guild-19` | `b31a2cb83544fbd999c97deaf0ad1020063a9fe0` |
| `wave1000/guild-20` | `563fbe5655a641568de3bbe5ee35304695776d2e` |
| `wave2000/guild-02` | `f9bd37223899ed5577c348aa38a9d900e8954359` |
| `wave2000/guild-06` | `9e5ee489a19aec8faa0b9b77b45beb4285daa54f` |
| `wave2000/guild-20` | `bbc41dc91ead907a19afba908b1018bd209cfbb4` |
| `wave2000/guild-22` | `7a427e12b12eb3c6e974c7bbe5394cd797547ae7` |
| `wave2000/guild-26` | `5b448ebee966cf5bd9d55f33fe9dc43f580670fc` |
| `wave2000/guild-27` | `a1876bbbf3a24914589be10b10d7a363eb1fa5d5` |
| `wave2000/guild-31` | `db7eddbdb73404748e0b030d3e184bb113a892b0` |
| `wave2000/guild-33` | `f7a2630bb93312aad9e8edff153e77b9589ed9dc` |
| `wave2000/guild-40` | `d39ce846a24fe501747a878193840f25e56a2602` |

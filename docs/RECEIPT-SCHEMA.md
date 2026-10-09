# Worker Receipt Schema v1

Machine-readable DONE receipt for wave workers → coordinators. Replaces
free-text completion reports that coordinators currently re-read to extract
status. One receipt per finished worker claim; posted (or linked) wherever
the coordinator collects results.

**Relationship to wave500-protocol (extend, don't fork).** The
`origin/wave500/protocol` branch defines guild-level
`wave500-design/rollup-formats.md`, whose `DONE-ROLLUP` block ends each item
with `evidence: <receipt/ptr>` — a pointer with no defined payload. This
document defines that payload: the worker-level receipt the pointer resolves
to. Guild rollups stay as-is; this schema slots underneath them. If the
protocol branch later standardizes its own worker receipt, this schema's
`v` field exists so both can be distinguished and migrated.

## v1 field spec

| Field | Req | Type | Rules |
|---|---|---|---|
| `v` | yes | int | Must be `1` |
| `workerId` | yes | string | 1–64 chars, the lane/agent that did the work |
| `waveId` | yes | string | 1–64 chars, e.g. `wave-500` |
| `status` | yes | enum | `completed` \| `errored` \| `blocked` |
| `summary` | yes | string | 1–280 chars. What was done + the one fact that matters most |
| `filesChanged` | yes | string[] | 0–50 entries, each 1–200 chars, repo-relative paths |
| `tests` | yes | object | `{run, passed, failed}` ints ≥ 0; `passed + failed ≤ run` |
| `claimsFiled` | yes | string[] | 0–32 entries, each 1–64 chars — board claim ids this work filed |
| `branch` | yes | string | 1–100 chars |
| `headSha` | yes | string | 7–40 lowercase hex |
| `openQuestions` | yes | string[] | 0–3 entries, each 1–140 chars — unresolved items needing someone's input or awareness (may be statements, not just questions) |
| `msElapsed` | yes | int | ≥ 0 — wall-clock ms the worker spent. The worker runtime fills this; never estimate in prose |
| `pr` | no | int/string | PR number if one exists (number, or string ≤ 20) |
| `ts` | no | string | ISO-8601 completion time |
| `metrics` | no | object | Free-form small metrics (bytes, counts, ratios) |

**Hard rules enforced by `scripts/validate-receipt.mjs`:**

1. Unknown top-level fields are rejected (named in the error). v2 adds
   fields; v1 never silently absorbs them.
2. Every length/count limit above is enforced with a specific error
   (`summary: 312 chars, max 280`), never a bare "invalid".
3. Size cap: the compact canonical form (`JSON.stringify` of the parsed
   object, UTF-8) must be **≤ 2048 bytes**. Oversize → rejected with the
   byte count.
4. `tests` triple: `passed + failed ≤ run`. `{"run":0,"passed":0,"failed":0}`
   is the defined encoding for "no counted tests" (e.g. suites reported
   green without counts) — not the same as "tests passed".
5. `status` semantics: `completed` means the worker's brief is done — a PR
   may still be open/unmerged; the merge ask goes in `openQuestions`.
   `errored` = the work failed (what failed goes in `summary`).
   `blocked` = waiting on someone/something; `openQuestions` MUST be
   non-empty for `blocked` (the blocker is the content).

**What deliberately does NOT go in a receipt:** prose reasoning, exact
diffs, multi-PR ancestry chains, ambient channel notes. The receipt carries
the decision + pointers (`branch`, `headSha`, `pr`); rationale lives in the
PR body / kb notes. See "fact types that did not fit" below.

## Example 1 — completed, with code

```json
{"v":1,"workerId":"wave500-coord-cost-6","waveId":"wave-500","status":"completed","summary":"Defined worker receipt schema v1 (docs) + validator (scripts). Extends wave500-protocol DONE-ROLLUP evidence pointer; 5 real reports compressed, median 24% smaller, no decision fact lost.","filesChanged":["docs/RECEIPT-SCHEMA.md","scripts/validate-receipt.mjs"],"tests":{"run":0,"passed":0,"failed":0},"claimsFiled":["wave500-coord-cost-receipt-schema"],"branch":"wave500/coord-cost","headSha":"a1b2c3d","openQuestions":[],"msElapsed":5400000,"ts":"2026-10-08T17:40:00-07:00"}
```

(`pr` omitted — no PR exists for this work; the optional `pr` field is
shown in the demos below.)

## Example 2 — completed, docs-only

```json
{"v":1,"workerId":"wave500-docs-11","waveId":"wave-500","status":"completed","summary":"Audited 12 SKILL.md files against live routes; fixed 4 stale endpoint references in docs/SKILL-INDEX.md. No code touched.","filesChanged":["docs/SKILL-INDEX.md"],"tests":{"run":3,"passed":3,"failed":0},"claimsFiled":[],"branch":"wave500/docs","headSha":"9f8e7d6c5b4","openQuestions":[],"msElapsed":2700000,"ts":"2026-10-08T16:05:00-07:00","metrics":{"linksChecked":47,"staleFixed":4}}
```

## Example 3 — blocked, needs input

```json
{"v":1,"workerId":"wave500-queue-2","waveId":"wave-500","status":"blocked","summary":"merge_group trigger patch ready on branch but blocked: needs merge-slot + exact-head green CI before queue-config lane can flip the queue.","filesChanged":[".github/workflows/test.yml"],"tests":{"run":1,"passed":1,"failed":0},"claimsFiled":["ci-trigger-test-yml-merge-group"],"branch":"wave500/queue","headSha":"50c9eaeb61c64b43ecc93d7625d45d66b7da5252","openQuestions":["Deploy lane: take the trigger PR through the merge slot with exact-head green CI per the lander rule.","Queue stays inert until the queue-config lane flips it — no CI behavior change today."],"msElapsed":1800000,"ts":"2026-10-07T07:40:00-07:00"}
```

## Compression demos — 5 real reports → receipts

Source: live room comments (issue #266). Sizes are the original comment body
vs the compact serialized receipt. Fields the source did not state are
marked `(inferred)` in the notes; a production worker runtime fills
`msElapsed`/`ts` automatically.

### D1 — jill, 2026-09-27 (332 → 456 bytes, **−37%** i.e. +124 bytes)

Source: `[jill][done] RC-2026-09-27-2715 — A2A v1.0 JWS agent-card signatures`
(room-done block: pr 1155, sha d6f34cb6…, "JWKS discovery at
/.well-known/jwks.json; unsigned prod state unchanged").

```json
{"v":1,"workerId":"jill","waveId":"wave-2026-09","status":"completed","summary":"A2A v1.0 §8.4 JWS/EdDSA agent-card signatures merged (PR #1155); JWKS discovery at /.well-known/jwks.json; unsigned prod state unchanged.","filesChanged":[],"tests":{"run":0,"passed":0,"failed":0},"claimsFiled":["RC-2026-09-27-2715"],"branch":"main","headSha":"d6f34cb636d0fcf378827007abd620a8ea7b2521","openQuestions":[],"msElapsed":0,"pr":1155,"ts":"2026-09-27T19:27:15Z"}
```

Notes: `waveId`, `branch`, `msElapsed`, `filesChanged` inferred/absent in
source — the original was already terse, so the receipt is slightly larger.
What the receipt buys: machine-readable status, claim id, and the explicit
"no counted tests" signal instead of silence.

### D2 — instinct, 2026-09-27 (1774 → 660 bytes, **63% smaller**)

Source: `[instinct][done] RC-2026-09-27-004 CLOSED — guest referral-mint
breakout verified fixed in production` (deploy 8c0c295a on both doors,
14/14 regression incl. GX guest fixture, canary 6/6, honest caveat: live
guest-mint attempt not executable with agent credentials).

```json
{"v":1,"workerId":"instinct","waveId":"wave-2026-09","status":"completed","summary":"Guest referral-mint breakout verified fixed in prod: deploy 8c0c295a live both doors; gate at referral-invites.mjs:248-249 (403 guest_scope_denied); 14/14 regression + 6/6 canary.","filesChanged":["server/referral-invites.mjs"],"tests":{"run":20,"passed":20,"failed":0},"claimsFiled":["RC-2026-09-27-004"],"branch":"main","headSha":"8c0c295aaae16e81a5403ae6ed53e81702d1c287","openQuestions":["Live guest-token mint attempt not executable with agent creds — verified via source-gate + suite + version agreement instead."],"msElapsed":0,"pr":1156,"ts":"2026-09-27T21:08:18Z"}
```

Notes: the honest caveat survives as an `openQuestions` awareness item —
the decision-relevant part ("verified by proxy, not by live token") is
preserved; the two paragraphs explaining *why* a live attempt is impossible
live in the original comment, linked by `pr`/`headSha`.

### D3 — ci-trigger lane, 2026-10-07 (1236 → 691 bytes, **44% smaller**)

Source: `[ci-trigger lane][HELLO+CLAIM+PROGRESS+DONE] merge_group trigger
patch for test.yml` (PR #1769 open, head 50c9eaeb…, 2-line trigger-only
diff, inert until queue enabled, explicit ask: deploy lane take it through
the merge slot).

```json
{"v":1,"workerId":"ci-trigger","waveId":"wave-2026-10","status":"completed","summary":"merge_group trigger patch for test.yml done; PR #1769 open (head 50c9eaeb). Inert until queue enabled — no CI behavior change today. This lane never merges itself.","filesChanged":[".github/workflows/test.yml"],"tests":{"run":1,"passed":1,"failed":0},"claimsFiled":["ci-trigger-test-yml-merge-group"],"branch":"ci-trigger/test-yml-merge-group","headSha":"50c9eaeb61c64b43ecc93d7625d45d66b7da5252","openQuestions":["Deploy lane: take #1769 through the merge slot with exact-head green CI per the lander rule; unblocks queue-config lane (blocker 2)."],"msElapsed":0,"pr":1769,"ts":"2026-10-07T07:36:07Z"}
```

Notes: demonstrates `status` semantics — `completed` with an open PR; the
merge ask is an `openQuestions` item, not a status downgrade. The exact
2-line diff and the claim-registry collision note are pointer-recoverable
(`branch`/`headSha`).

### D4 — jill, 2026-10-07 (1050 → 794 bytes, **24% smaller**)

Source: `[jill][done] hardwork-mobile-1 — mobile page-weight fix shipped as
PR` (PR #1854: emoji-catalog.js 197,656 → 126,158 bytes, deliberately not
lazy-loaded — sync render path; weight-budget test failed-before/passes-after;
NOT merging — needs hosted CI + reviewer APPROVE; scoped-out: 1.6MB/59-module
first-paint graph, no per-asset cache validators).

```json
{"v":1,"workerId":"jill","waveId":"wave-2026-10","status":"completed","summary":"Mobile page-weight fix as PR #1854: emoji-catalog.js 197,656→126,158 bytes (36% off critical first-paint). Deliberately not lazy-loaded (sync render path). NOT merging — needs hosted CI + APPROVE.","filesChanged":["src/emoji-catalog.js"],"tests":{"run":0,"passed":0,"failed":0},"claimsFiled":["hardwork-mobile-1"],"branch":"hardwork/mobile-1","headSha":"af06c240abd4a7c3ff2e087c33199606c272f96c","openQuestions":["Needs hosted CI green + reviewer APPROVE before merge.","Scoped out: 1.6MB/59-module first-paint graph needs a bundling/code-splitting plan.","Scoped out: no per-asset cache validators (ETag/Last-Modified, Cache-Control) on the Node origin."],"msElapsed":0,"pr":1854,"ts":"2026-10-07T16:11:00Z"}
```

Notes: the lazy-load rationale compresses to its decision + constraint
("deliberately not lazy-loaded (sync render path)") — the paragraph of
reasoning lives in the PR body. The two scoped-out follow-ups survive as
`openQuestions` (max 3, exactly filled).

### D5 — jill, 2026-10-07 (670 → 525 bytes, **22% smaller**)

Source: `[jill][DONE] plugin-discovery-lane3 — A2A card + discovery audit
complete` (PR #1913 open, not merged: fixed access-request contract —
/SKILL.md Step 4 4-field body, agent card POST fields, 405 teaches contract;
3 fail-first tests; 24/24 discovery, 9/9 access-requests-http, 43/43
card-consistency, 18/18 discoverability; card byte-current with prod).

```json
{"v":1,"workerId":"jill","waveId":"wave-2026-10","status":"completed","summary":"A2A card + discovery audit complete; PR #1913 open (not merged): fixed access-request contract (SKILL.md 4-field body, card POST fields, 405 teaches contract). Card byte-current with prod.","filesChanged":[],"tests":{"run":94,"passed":94,"failed":0},"claimsFiled":["plugin-discovery-lane3"],"branch":"plugin-discovery/lane3","headSha":"0000000","openQuestions":["PR #1913 open, not merged."],"msElapsed":0,"pr":1913,"ts":"2026-10-07T18:09:37Z"}
```

Notes: `headSha` unstated in source — a production worker always knows its
head; shown as `0000000` (7-hex minimum) and flagged here as the one field
the source omitted. Four focused suites fold into one triple (94/94/0);
per-suite breakdown is pointer-recoverable from the PR.

## Results

| Demo | Original (B) | Receipt (B) | Δ |
|---|---|---|---|
| D1 | 332 | 456 | −37% (larger) |
| D2 | 1774 | 660 | 63% |
| D3 | 1236 | 691 | 44% |
| D4 | 1050 | 794 | 24% |
| D5 | 670 | 525 | 22% |

**Median byte reduction: 24%.** (Sorted: −37, 22, 24, 44, 63 → median 24%.)
Sizes are the validator-measured compact serializations, re-checked on
redispatch 2026-10-08. Excluding D1, the already-terse report, the median of
the four substantive reports is 34%. D1 shows the floor: receipts add fixed
structural cost (~460 bytes minimum), so ultra-terse reports gain structure,
not bytes.

## Fact types that did NOT fit (by design)

1. **Prose rationale** — e.g. *why* lazy-loading the emoji catalog was
   rejected (foldedReactionMap/canonicalReaction sync in render path). The
   receipt keeps the decision + the constraint; the reasoning chain lives in
   the PR body / kb note. Decision-relevant outcome preserved, argument lost.
2. **Exact diffs** — the 2-line `merge_group` diff. Replaced by
   `branch` + `headSha` pointers. Nothing decision-relevant lost for a
   coordinator; a reviewer still reads the PR.
3. **Multi-PR ancestry** — "deploy 8c0c295a carries #1156 (merge a8fa4cc5,
   ancestor-verified)". Folded into `headSha` + `pr` + `claimsFiled`;
   the ancestry chain is PR-graph-recoverable.
4. **Ambient channel notes** — e.g. "muse-room posts are 409 pilot_limit for
   sibling lanes" (D3's coordination note). Not coordinator-decision-relevant;
   dropped. If a worker is blocked *by* channel limits, that belongs in
   `openQuestions`.
5. **Stale-window claims** — e.g. "no live claim held by another lane at
   claim time" (D3). Claim-registry state, not receipt content; the claim id
   in `claimsFiled` is the join key.

## Validator

`scripts/validate-receipt.mjs` — node stdlib only. Usage:

```sh
node scripts/validate-receipt.mjs receipt.json   # file
cat receipt.json | node scripts/validate-receipt.mjs   # stdin
```

Exit 0 + `VALID (<bytes> bytes)` on success; exit 1 with one specific error
per violated rule otherwise. Rejects: unknown fields, overlong
fields/items, `openQuestions` > 3, `blocked` with empty `openQuestions`,
`passed + failed > run`, bad `headSha`, bad `status`, negative
`msElapsed`, and total size > 2048 bytes.

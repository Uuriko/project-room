# JOINT SCORECARD — HELP-UT · UT-MIXED · UT-LIMITS · Dot (local bus)

Merged by UT-DOT lane C2, 2026-10-29, from the four efforts' own filed
records (sources read 2026-10-29T17:43Z). Nothing was re-tested by this
lane. **Every row carries its provenance (side + arena + build).** Rows
from different builds or arenas are never blended: Dot's local-bus rows
are local semantics only and sit in their own section. Where two sources
give different numbers, both are printed with their sources — never
averaged (see Conflicts).

Builds: production `c47c3fc79cc3af65db095f0b653d6dedb9e24454` (HELP-UT pin) ·
production `6bda3388f6225eb4b468d4cd9ca522ebb926686f` (B10 / UT-MIXED /
UT-LIMITS pin) · Dot local bus on main `63534b92` · UT-LIMITS local lab
on `63534b92`.

## 1. HELP-UT B10 — cold-agent recovery + history privacy (Codex ask 1)

| Result | Grade | Provenance (side + arena + build) |
|---|---|---|
| Cold inbox discovery + reply recovery (room_needs_me / room_reply) | WORKS | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| Assigned-work recovery | WORKS via board; claimed task absent from inbox items | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| Pre-join public history visible to a late joiner | WORKS (visible — recovery-friendly; anything posted pre-invite is visible to the invitee) | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| Private messages withheld from non-participants on read surfaces | WORKS | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| NC: read another member's private request (room_read_request) | PASS — 404, indistinguishable from nonexistent | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| NC: cross-room read with an R1-scoped token | PASS — 403 insufficient_scope | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| NC: anonymous HTTP board read | PASS — 401 | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| NC: invalid-secret HTTP (needs-me) | PASS — 401 | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| NC: reply to another member's private request (room_reply) | **FAIL — F-B10-1, S2, NEW: injection recorded as a PUBLIC message (seq 22) and attached as context on the private thread; read path is participant-gated, write path is room-membership only** | HELP-UT B10 · production, disposable rooms · 6bda3388 |
| Presence after live activity | BROKEN — KNOWN-STILL (all members presence: null; "Nobody is online right now") | HELP-UT B10 · production · 6bda3388 |
| Tracked-ask attention (needs-me mention on reply) | KNOWN-FIXED for the tracked-ask surface (scoped claim; bounty/board attention not retested here) | HELP-UT B10 · production · 6bda3388 |

## 2. HELP-UT Cluster C — solo journey headlines

| Result | Grade | Provenance (side + arena + build) |
|---|---|---|
| Stranger door, rows 1–15 | Unchanged vs baseline: 7 BROKEN / 4 DEGRADED / 4 WORKS (row-table method, D3) | HELP-UT C01–C22/C24 + D3 · production (public doors + seeded rooms) · c47c3fc7 |
| Stranger door, row 16 (door funnel endpoint) | ABSENT → DEGRADED (endpoint now exists, joins-only) | HELP-UT D3 · production · c47c3fc7 |
| Core work/money loops end-to-end | WORKS — money conserved exactly in every drill (C04/C05/C17/C19/C20) | HELP-UT C-lanes · production, own seeded rooms · c47c3fc7 |
| Settled lots | BROKEN, KNOWN-STILL — 22/22 404 on both faces; cure PR #4998 OPEN, unlanded | HELP-UT C-lanes + D1/D4 · production · c47c3fc7 |
| Receipt og.png | BROKEN, KNOWN-STILL — 500 with cacheable headers; cure PR #4983 OPEN, unlanded | HELP-UT D1/D4 · production · c47c3fc7 |
| New verified defects found in one wave | 29 (D3 listed 30; D2/C24 re-execution struck one — see Conflicts) — UT falsifier NOT-FIRED | HELP-UT D3, adjusted by D2/C24 · production · c47c3fc7 |
| Solo negative controls (forged receipt, wrong-room invite, double claim) | PASS (C16); one NEW defect: magic-link ordering policy enforced in UI only, not server-side | HELP-UT C16 · production, own rooms · c47c3fc7 |
| needs-me at money/board moments | Empty at every step (C05/C17/C18/C20) — contrast B10's tracked-ask fix at 6bda3388 above | HELP-UT C-lanes · production · c47c3fc7 |

## 3. UT-MIXED — paired human+agent headline findings

Headlines only, per the wave's STATE ledger at the 17:43Z read; lane ids
cite the owner of each result. V = independently re-run by UT-MIXED's
V-lanes on the same build.

| Result | Grade | Provenance (side + arena + build) |
|---|---|---|
| F-B10-1 cross-confirmation: injection reproduces from bystander, owner, and zero-scope seats, on both MCP and HTTP faces; on the HTTP face the id is handed to every member by GET /bootstrap, and the injection is stored private-shaped to the sender and never reaches the thread | KNOWN-STILL, S2 — cross-confirmed (S6a, S6b/F4, S6c ×3 seats, X4 ×3 seat classes) | UT-MIXED S6a/S6b/S6c/X4 · production, paired rooms · 6bda3388 |
| Dispute can never be opened in a two-person room (disputes only on accepted work; then 422 no designated decider); a full dispute completes only with an imported third-lane decider | S2 family — S2a + F2 (rescue of S2b) | UT-MIXED S2a/F2 · production, paired rooms · 6bda3388 |
| Acceptance ignores a "fail" attestation verdict — work accepted, credits attributed anyway | NEW, S2 — V6 CONFIRMED on a fresh full cycle | UT-MIXED S2a, V6 · production · 6bda3388 |
| No scored competition exists: funded work is a first-come claim race; no native split outcome either | NEW, S2 — S7a ↔ S7b cross-confirm; conservation exact in both | UT-MIXED S7a/S7b · production, paired rooms · 6bda3388 |
| Wake rule is exact: linkage wakes, text never does — tracked asks, replies, changes_requested and assignment wake both directions; plain messages (even naming name+id), board claim/submit/accept are silent both directions | S2, KNOWN-STILL family completed (F-X3-1/F-X3-2) | UT-MIXED X3 · production · 6bda3388 |
| room_respond_to_request 500s on schema-conformant but template-incomplete calls; closing works only via the server-issued template | S2 — V2 PARTIAL: narrowed form confirmed; S6a's "cannot be closed at all" REFUTED | UT-MIXED S6a, corrected by V2 · production · 6bda3388 |
| Paid-bounty claim+submit have NO profile gate (zero-scope member claimed + submitted funded work); naming a verifier silently seats them as dispute decider while disputeDecider reads null everywhere | NEW, S2 ×2 — V1 CONFIRMED, F-X4-2 with transferability | UT-MIXED X4, V1 · production · 6bda3388 |
| Impossible-remedy family resolves in two: board face HAS an owner force-release (exists, undisclosed, shape hidden behind a false-409 list truncation verified 3/3); money face has NO remedy — F-S4a-4 escrow hostage stands as the family's only full no-remedy member | S2 family — V4 (verification tranche complete: 8 confirmed in full, 4 narrowed/corrected, 0 wholly refuted) | UT-MIXED S4a/S4b/N3, X4, V4 · production · 6bda3388 |
| Recurring shape across V2/V3/V5: the capability often exists; the discoverable surface does not reach it (template-only close; /commands-only human reply, unlinked; room_supersede_work only in the full 122-tool profile) | Seam theme for D1 | UT-MIXED V2/V3/V5 · production · 6bda3388 |
| Presence | KNOWN-STILL family (agent "idle / Nobody online" seconds after starting work; sponsor's own lastSeenAt froze) — dedicated probes X2 IN FLIGHT at read time | UT-MIXED S4a/S4b; X2 pending · production · 6bda3388 |

UT-MIXED rows still in flight at the 17:43Z read: X2 (presence probes),
M0 (ledger/roll-up), D1/D2/D3 (held for synthesis). Their results are NOT
in this scorecard yet.

## 4. UT-LIMITS — limits headlines so far (wave in flight)

| Result | Grade | Provenance (side + arena + build) |
|---|---|---|
| PR #5061 (truthful Retry-After + mintBudget) | NOT LIVE — PR open, never merged; zero mintBudget in production source | UT-LIMITS M1-CODE · production source read · 6bda3388 |
| Mint day-tier refusal honesty | Retry-After flat 3600 advertised vs 86,212 s truthful (≈24× understated); minute tier 8 exact, Retry-After honest | UT-LIMITS M2-EDGES-LOCAL · LOCAL LAB · 63534b92 |
| Production baseline before any load | Ready already flapping pre-test (1/10 samples 503, isolated); ready p50 0.936 s; no 429 — abort state does not pre-exist | UT-LIMITS C0-BASE · production (outside reads) · 6bda3388 |
| Arena A lab limits (ramps, cap cliff, entity arm, 1k rooms) + Arena B confirmations | IN FLIGHT / HELD at the 17:43Z read — no limits-table values filed yet | UT-LIMITS STATE ledger · local lab + bounded production · 6bda3388 / local builds |

## 5. Dot — local bus (RELAY-ONLY, never blended with production)

Provenance for all five rows: **Dot · LOCAL BUS (isolated) · main
63534b92 · relayed via Codex, room seq 23005.** Dot has no Room connector
or enrolled identity; these are local-semantics results and grade
nothing on production, and no production row grades them.

| Result | Grade | Provenance (side + arena + build) |
|---|---|---|
| Targeted request | PASS | Dot · LOCAL BUS · main 63534b92 · relay via Codex seq 23005 |
| Working indicator | PASS | Dot · LOCAL BUS · main 63534b92 · relay via Codex seq 23005 |
| Offline return | PASS | Dot · LOCAL BUS · main 63534b92 · relay via Codex seq 23005 |
| Followup | PASS | Dot · LOCAL BUS · main 63534b92 · relay via Codex seq 23005 |
| Changed-requirement → 409 stale-context, no obsolete answer | PASS | Dot · LOCAL BUS · main 63534b92 · relay via Codex seq 23005 |

Production ports of the last three scenario families are owned by
UT-DOT Cluster 3 (C3WI / C3OR / C3CR, gated) — see COVERAGE-MAP.md (b).
The NC2 candidate retest is UNCLAIMED pending a confirmed route
(COVERAGE-MAP.md (c)).

## Conflicts — both numbers printed, never averaged

1. **HELP-UT mint total.** ARTIFACTS.md final pass 3 (C23 registry):
   **20 / 40**, minting closed. SYNTHESIS.md §6 (D6, filed earlier):
   calls that registry "incomplete — stops at pass 2 with a mint total
   of **2**" and sums **17** mint calls from the C reports, with B10's 3
   still in flight. The readings reconcile in time order (17 C-lane +
   3 B10 = 20 = the final registry), but both source figures stand as
   printed here; UT-LIMITS' joint tally independently re-added the
   registry breakdown to 20.
2. **HELP-UT new-defect count.** D3 listed **30** NEW verified defects;
   D2 + C24 re-execution struck one (C14's magic-request claim, already
   counted in another item), so SYNTHESIS grades **29**. Both figures
   are of record; 29 is the adjusted count.
3. **Door headline method.** The quoted baseline "5 BROKEN / 2 DEGRADED /
   4 WORKS" is an 11-step instrument count; the row-table method applied
   identically to both builds gives rows 1–15 as 7 / 4 / 4 at both
   builds (§2 above). Same door, two instruments — do not mix them.
4. **UT-MIXED mint total.** Its STATE corrects its own wave-open sum
   (T1 allowances sum to 25, not 23) and records **28 counted** at
   17:40Z, worst case 29; UT-LIMITS' earlier tally (17:22Z) flagged its
   ledger at 0 recorded vs ≥3 actual. The STATE figure at 17:40Z is the
   latest of record.

---
Shared results home (proposed): branch `jill/ut-joint-scorecard-1029` in
Uuriko/project-room · workItemId `ut-dot-sync-2026-10-29`. Companion file:
COVERAGE-MAP.md (same branch).

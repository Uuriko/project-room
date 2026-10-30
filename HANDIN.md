# YC-MVP Part C hand-in to Codex — Jill's fleet, 2026-10-30

Evidence branch only — never a landing candidate. Base: `main` at
`2249dbb5da5e6f26f2f221fb54466abdda9ab37f`. Nothing in this hand-in was merged
by us, and nothing was pushed to Codex's branch by us. Composition of every
item below is Codex's call.

Payload hashes (sha256):

- `fix-d1.patch` — `3b3a1bed384e2494a65f00dd25c09e2abeac94e461a51bb6a7fa6a4663dcb4c3`
- `fix-d2.patch` — `76fa196e993e0646e2ec9de7cb4fbe904a25beb9d94082708dfa2e9cf3e19262`

## 1. D1 — claim read contradicts itself (`verification.state:"verified"` + `verification.jev:{verdict:"request-changes"}`) — CURED, patch in this branch

Defect: on the `done` transition, `server/work-claim-routes.mjs` computed the
shadow JEV heuristic score and froze `{verdict, score}` onto the verification
fact via `updateWork()`, so every claim read served `state:"verified"`
alongside an unqualified `jev` verdict of `request-changes` at score
`0.4225` — the scorer's own qualifications (`enforced:false`, shadow,
per-signal details) were stripped at the seam. Reproduction pointer:
wave census `gaps-comp.md` §6 ("Step 6 — receipt + verification honesty —
PASS (defect D1)"); reproduced exactly at the head below (same score
`0.4225`, same delivery digest, both executed checks `pass`). Cure shape:
the shadow score no longer rides the verification fact — at write (route no
longer passes `jev` into `updateWork()`, full decision still journalled), at
transition (`updateWork()` drops the `jev` freeze), and at read
(`verificationOf()` drops a stored `jev`, so already-done immutable claims
read back cured). Files: `server/work-claims.mjs`,
`server/work-claim-routes.mjs`, new
`tests/work-claim-jev-verification.test.js`. Test evidence (verbatim
counts): failing-first new test **0/2 → 2/2**; with the cure —
work-claim-verified-routes **29/29**, work-claim-verified-state **24/24**,
jev-receipts **11/11**, jev-admission **13/13**, work-claims **8/8**,
bounty-disputability-reads **7/7**, room-acp-permission-race **14/14**;
syntax checks OK. Made and verified against PR #5428 head
`eb325a13dc5132ae335816a08c82c9e06084e380` (branch
`codex/mvp-integration-1030`); apply on that head or a descendant — the
three touched files are the only conflicts to expect. Caveat: file-backed
suites could not complete on Jill's VM during the run (write-fault episode,
A/B-proven environmental — suites that open a file-backed SQLite store
failed at `RoomStore` construction before any claim code ran); please
re-run the file-backed batches plus `qa-friend-agent-e2e --local` when
composing — they are the only unverified surface for D1.

## 2. D2 — fresh wake for a terminal claim duplicates execution — FIXED, patch in this branch

Defect: `Bridge.acceptClaim` fetched the claim and queued a turn without
inspecting `claim.state`, so a fresh `signalId` wake naming an already
`done`/`closed` claim ran a full second turn and posted a second note;
same-`signalId` redelivery was already safe via the persisted `TurnReceipt`.
Reproduction pointer: wave census `gaps-comp.md` §11 ("Step-3 sub-cases",
latent probe defect D2). Cure shape: ack-and-skip guard in
`room-acp/src/bridge.mjs` `acceptClaim`, immediately after `room.claim()` —
a local exported `TERMINAL_CLAIM_STATES = ["done","closed"]` mirroring the
server constant (room-acp must not import `server/**`); there is no
`cancelled` claim state (`cancel` lands a claim in `closed`), and
`delivered` is deliberately not guarded (not terminal). Test evidence:
at head `eb325a13dc5132ae335816a08c82c9e06084e380`, claim-retry suite
**6/6 with the guard** (5 pre-existing + 1 new); the new regression test
**fails without the guard** (prompts 2 ≠ 1). At head
`a57cb5c5791766306290ef1c2a36c8c51ff4c97f`: stub tests **5/5 with guard**,
new test **0/1 without guard**; standalone repro — unpatched
`done`/`closed` → 1 turn + 1 note each, patched → 0 turns + 0 notes + 1 ack
+ skipped 1, controls (`claimed`, no-state) → 1 turn each both ways. Patch
applies at PR #5428 head `b441a44db48c103c042542468f60002f45a7f308`
(patch base named in `fix-d2.md` §1): the two patched files are
blob-identical across `a57cb5c5` and `b441a44d` —
`room-acp/src/bridge.mjs` blob `11f2ac92d00e09c132d7242a7bbb7436e982e8a5`,
`tests/room-acp-claim-retry.test.js` blob
`db1bf8f2acce0a0d7fb6a4e28e5f1e875afa942e` — and `git apply --check -R`
passed against the patched tree at both earlier heads. Not re-run at the
final head: the server-backed claim-note API test and wider room-acp
suites (full-tree runs were EPERM-blocked on Jill's VM).

## 3. fix-publish — post-acceptance public receipts cure — ALREADY on its own branches; verification state: packaged-UNVERIFIED

Not repackaged here. Pointers: cure branch
`jill/fix-publish-pending-lots-1030` (cure commit
`3586a881b95e981e5b6b7f6c68233628e0d4e2de` on parent
`a57cb5c5791766306290ef1c2a36c8c51ff4c97f`, tip
`b7135c51f386f472afa579eae0e221fe340c3833` adds only the runbook) and
evidence branch `jill/evidence-cfix-publish-1030` at
`d3bf88cb8c33e93b46e4404ad22b9cfb60de04ba`. Defect in one line: a
post-acceptance bounty lot 404s on all public faces until settlement is
stamped after the 72 h challenge window, even with the room's public
opt-in recorded ON; the cure makes accepted/disputed lots compose as
explicitly pending-labelled lots (settlement `null`, honesty wording
pinned) while opt-in OFF / never-recorded stays 404 everywhere.
Verification state, stated plainly: **packaged-UNVERIFIED.** The packaging
lane executed 0 repo suites (VM write-fault episode); a separate
verification file (`verify-publish-fix.md`) was waited for by this
delivery lane and had not appeared when the hand-in was posted. Under the
standing kill rule, if it is still unverifiable by **Sun 2026-11-01
12:00 PT it is cut** — treat the cure as not built. Compose it only if a
runner first executes its branch runbook green
(`node --test tests/lot-receipt-pending.test.js`, expect 7/7 on the
branch, plus unchanged 20/20 on `tests/mirror-readtime.test.js` +
`tests/lot-receipt-page.test.js`). It changes public-read semantics, so it
is Codex's composition call; the demo works without it (pre-settled
specimen) if he declines.

## 4. Freeze re-run list A — from `gaps-comp.md`'s freeze note ("What changes when the frozen SHA lands"; steps 3 + 6 most sensitive)

All verdicts in that census are INTERIM at its run head; a freeze SHA
different from the run head formally invalidates them. Re-run at the
freeze, all cheap and scripted:

1. The harness golden-path journey, steps 1–7: (1) invite join +
   presence, (2) human creates room + work item, (3) claim + lost-ack,
   (4) agent delivers a result, (5) human reviews and accepts,
   (6) receipt + verification honesty, (7) another participant
   finds/reads the outcome.
2. `scripts/qa-friend-agent-e2e.mjs --local`.
3. The four test batches from `gaps-comp.md` §10: qa-friend-agent-e2e
   (6/6 at the run head); friend-agent-journey + room-acp-bridge (10/10);
   the retry / permission / claim-thread / disputability batch (36/36);
   the disconnect / privacy batch (15/15).
4. Steps **3 and 6 are the most freeze-sensitive** — bridge receipt/ack
   code and the permission delta were still landing in the composition,
   and D1 (§1 above) sits exactly there; **re-check `verification.jev`
   first**.
5. Also re-check at the freeze: the Member-invite permission set,
   join-only presence wording (caveat C1), and whether a `requestId` has
   been added to the claim POST (caveat C3). Per the §11 addendum, for
   the commits that landed after the census run head, re-check step 1
   (invite consumption/readiness) and step 6 (permission audit) first.
6. Note: even a frozen-SHA local PASS is a local golden-path pass only;
   the hosted / qa-room variant of the journey remains a separate, unrun
   qualification.

## 5. Freeze re-run list B — from `gaps-native.md` §8 (native OAuth + MCP Events path)

When Codex names the frozen SHA:

1. Re-run the census lane's two local harnesses at the frozen tree:
   harness 1 (discovery + MCP census + wake + journey) and harness 2
   (full OAuth flow incl. consent with `Origin`, `oat_` replay against
   MCP and REST, MCP claim/deliver/verification legs on an unassigned
   item, agent presence entry).
2. Run the tree's own native suites at that exact SHA:
   `tests/mcp-oauth.test.js`, `tests/mcp-oauth-http.test.js`,
   `tests/mcp-invite-oauth.test.js`, `tests/mcp-events-wire.test.js`,
   `tests/mcp-event-subscriptions.test.js`, plus the legacy oauth suites.
3. Probe the frozen tree for the §5 sequence in order:
   protected-resource metadata served without config? with a test client
   configured? form-encoded token exchange? MCP 401 challenge carrying
   `resource_metadata`?
4. Events: is an authenticated `events/` mount advertised at the frozen
   SHA, and can a subscription be created through it (not just the store
   tests)?
5. Production after any deploy: repeat the §1–§3 probes verbatim; the
   census's production verdicts are for the production revision it named
   only.

## Sanitisation note

This payload was grepped before assembly for token / credential / secret
markers and seat-config values: none present. It contains only the two
patches and this authored summary — no credentials, secrets, tokens, or
private user data.

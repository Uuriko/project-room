# EVIDENCE-PACK — Deploy ask evidence for Codex (rail copy)

Rail corrective for the deploy ask in muse-room seq 23671, filed under
AGENTS.md rule W7 (evidence transfer to seats — branch rail by default).
The original ask pointed at a VM-local path Codex cannot reach from his
Mac. This branch is the fetchable copy.

Branch: `evidence/deploy-watch-2026-10-30` in `Uuriko/project-room`
Contents of this pack:
- `EVIDENCE-PACK.md` (this file) — the 20 merged PRs with merge SHAs and
  verification state at merge, plus the production-vs-main state as
  censused on 2026-10-30.
- `DEPLOY-WATCH.md` — verbatim copy of the post-flip verification
  package from wave-2026-10-29-merge-execute (13,280 bytes,
  sha256 4b62a3c551aebcc2c2fa4490906dc290c215aa77f7ca0d194937492cf4a74dd7).
  Its post-flip check list is summarised by section name in the pointer
  section below; the full text sits beside this file.

Sanitisation: both files were grepped before publishing for tokens,
bearer strings, seat identifiers, email addresses, and
KEY/TOKEN/SECRET/PASSWORD-shaped values. None were found; no redactions
were required. DEPLOY-WATCH.md contains only generic prose uses of the
word "credential" (for example "No credential." as an API error string)
and public receipt identifiers — no credential values.

## Production vs main — state as censused 2026-10-30 19:49 UTC

Source: fleet-sync production census (wave-2026-10-30-fleet-sync),
verified at source in that census run.

- Verdict: NOT-FLIPPED. Production has not flipped.
- Production `GET https://room.trydemigod.com/api/version`:
  sourceRevision `dfe1848a2cc3c1791e2e524ac402a45d48580d60`,
  buildId `2026-10-30T04:01:35.869Z`, deployment `production`.
  Identical to DEPLOY-WATCH checks 1–4 (2026-10-30 05:59–06:26Z).
- Main head at the GitHub API: `2249dbb5da5e6f26f2f221fb54466abdda9ab37f`
  ("Merge pull request #4930").
- GitHub compare `dfe1848a2cc3c1791e2e524ac402a45d48580d60...main`:
  status `ahead`, ahead_by 93, behind_by 0. Main is 93 commits ahead
  of the deployed revision; the deployed revision is an
  ancestor-side predecessor.
- All 20 merges below are LANDED on main and UNDEPLOYED. None may be
  called deployed, and no post-flip check has been run, because there
  is no flip to check against.
- The deploy ask: please deploy production to current main through
  Codex's pipeline. The flip is Codex's act; verification after the
  flip follows DEPLOY-WATCH.md.

## The 20 merged PRs

Merge commit SHAs are full SHAs as resolved at the GitHub API in
DEPLOY-WATCH.md. Verification state at merge is from the execution
board (wave-2026-10-29-merge-execute/BOARD.md). Every row also carries
the board's standing note: deployed-build ancestry pending flip.

| PR | Merge commit | Verification state at merge |
|---|---|---|
| #5376 | 1b27a934833319cf0c7f8fe983e6f058390d0ce8 | LANDED 2026-10-30T04:01:02Z (EXEC-1); fully green, no exceptions |
| #5355 | 508b0edcdd9b9a83a72368811a12f69ecca9b521 | LANDED 2026-10-30T04:10:38Z (EXEC-1); safety-net and unit green at final head, shard failures baseline-attributed |
| #4543 | adf177f81fd21347a632eb418c127284d2922ee4 | LANDED 2026-10-30T04:08:15Z (EXEC-STORAGE); CI exceptions baseline shards only |
| #5377 | 5a61fb4b5aa9afa7b663ad6dbc14a6064bf91e7e | LANDED 2026-10-30T04:30:57Z (EXEC-2) |
| #5324 | 11eae6f25eacf685d8f7f64e64fdf61f11114e71 | LANDED 2026-10-30T04:31:13Z (EXEC-2) |
| #5337 | eb54accfc9605b4aa6fc9854e6f3e37509634527 | LANDED 2026-10-30T04:31:33Z (EXEC-2) |
| #4265 | eff3d0fb096d713d9264f4474a395ccc07ecac93 | LANDED 2026-10-30T04:33:44Z (EXEC-STORAGE); acceptance at final head ec33de28: verify:affected 748/748 PASS, Proof 3 semantics suites 30/30 PASS, bench:room exit 0 |
| #5333 | 7cdf17b4142a81ad82f25bdbd86cb82031a9e800 | LANDED 2026-10-30T04:43:37Z (EXEC-3); browser 6/6 pass at final head, failures baseline-only |
| #5325 | e808a0ba40a6e8f1dc615f2e4323df734b4c0cef | LANDED 2026-10-30T04:58:15Z (EXEC-3); failures baseline-attributed with in-lane main verification |
| #5336 | 6f0c4eb029ce934b134fb07c6af32fa5444e2ef5 | LANDED 2026-10-30T05:03:33Z (EXEC-4); failures baseline-only |
| #5343 | 0e2bd9342547f523e5e0347ed81dc4d6ab0f0f37 | LANDED 2026-10-30T05:19:16Z (EXEC-4); failures baseline-only |
| #5353 | cc9c941751a148b0d76b3d7defa57ff13c3b9362 | LANDED (EXEC-6); safety-net SUCCESS at final head |
| #5323 | cadcbce4486fc03ceb76ed11ba09d5dae0d6facd | LANDED (EXEC-6); surviving change's own test PASSED in CI |
| #5071 | 450e669b2e1f48496ec0bbf17628939946a1e0cf | LANDED (EXEC-9); own domain 54/54 local, CI failures baseline-only |
| #5061 | d831914b1f51d9dc6d1cd94ae97ef881c88117da | LANDED 2026-10-30T05:37:47Z (EXEC-8); own domain 35/35 local, CI failures attributed not-caused with clean-main reproductions |
| #5354 | eaf17c6bde8b6facf6a1ae3f047016c5d1da2505 | LANDED (EXEC-5); safety-net cleared, all 6 browser shards SUCCESS at final head, failures baseline-only |
| #5330 | b9918d981bc8b7f39a268a02d4d2146b1e7fef7d | LANDED (EXEC-5); failures baseline-only |
| #5338 | 777e3a4a427610fd4417257bba7f6823bf5ca722 | LANDED 2026-10-30T05:55:58Z (EXEC-7); verify:affected 871/871 PASS twice at final head |
| #5328 | a3ded057b08dcaa51f0eae5d1563b14848dadd8c | LANDED 2026-10-30T05:58:11Z (EXEC-10, cured then landed); invariants 44/44 restored |
| #4930 | 2249dbb5da5e6f26f2f221fb54466abdda9ab37f | LANDED 2026-10-30T06:07:41Z; Tab re-qualification PASS at muse-room seq 23611; integrity family 75/75 on the merged tree. Current main head. Does not close the live parity incident (that is #4931) |

Count note: DEPLOY-WATCH.md lists 19 merges (through #5328 /
a3ded057, main head at watch start). #4930 (merge 2249dbb5, landed
during that watch) is the 20th, completing the set.

## Pointer — DEPLOY-WATCH.md post-flip check list (by section)

Full text in `DEPLOY-WATCH.md` beside this file. Sections:

- "Ground truth verified at watch start" — main head, production base
  URL, and wave-start production revision/buildId.
- "The 19 merge commits that must ALL be ancestors of the deployed
  build" — the ancestry requirement and the compare test.
- "Version checks" (Checks 1–4) — the four pre-flip version reads, all
  showing production at dfe1848a, NO FLIP.
- "Pre-flip baselines captured during the watch" — receipt-title
  baselines (80-char truncation; "Public work" x3) and the presence
  no-auth result.
- "Full merge SHAs (resolved at the GitHub API during the watch)" —
  full SHAs for the 19, plus the ancestry procedure at a flip: for
  deployed sourceRevision D, every merge must pass
  `compare {mergeFullSha}...{D}` with behind_by 0 before any is
  called deployed. For the 20th merge (#4930, 2249dbb5), the same
  procedure applies.
- "Post-landing checklist (ready to run at a flip; status per item)":
  - (a) Presence — #5338 (REGISTER-FIX B): owed to a runner holding an
    existing member credential for a known room; pass = presence rows
    non-null against the 40/40-null baseline.
  - (b) Receipt titles — #5377 (E3-F1 / E3-F2): mint-free and runnable
    by anyone at a flip, with full specimen receipt IDs; pass = full
    84-char title shown, and no receipt face rendering "Public work".
  - (c) OWED legs, each with its exact precondition: Privacy legs
    #5355; Decider read #5071 (in-room leg owed; mint-free public half
    specified); LOOP H1 retest #5353; LOOP H5 retest #5354.
- "Flip / no-flip conclusion — NO FLIP within the watch" — the
  ready-for-flip sequence: (1) confirm /api/version sourceRevision is
  at-or-past a3ded057 (for the full 20, at-or-past 2249dbb5);
  (2) ancestry-verify all full SHAs against the deployed commit via
  the GitHub compare API; (3) run check (b) against the pre-flip
  baseline; (4) hand (a) and the (c) legs to the identity-holding
  waves.

## Housekeeping

Per W7, this evidence branch is deleted by its author after Codex's
readback or 7 days (by 2026-11-06), whichever is first.

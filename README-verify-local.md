# verify-local — lane-side verification runner

`~/workspace/fleet-tools/verify-local.mjs` (v1.3, 2026-10-29,
POST-EPISODE DISCHARGE re-run; v1.2 MERGE-DEPLOY-TOOLS lanes M1-01 +
M1-04, 2026-10-28). v1.3: the object-store bootstrap fires when ANY
required object (head, base, or main) is missing from the source store
— v1.2 probed head only, so the normal stale-clone case (head+base
present, live main absent) died at getMainDir's uncaught
listTree(mainSha) with no bundle; both deferred main reads are now
guarded (absent main ⇒ A/B unavailable, never a crash). Makes hosted CI a confirmation, not a
discovery: given a PR number or a tree/commit SHA it materialises the
tree into lane scratch (`git archive <sha> | tar -x` from a git object
store — the shared clone's objects by default, or a scratch bare
store bootstrapped by fetching the exact SHAs when the clone lacks
them), hash-verifies every extracted blob against `git ls-tree`,
then runs:

- the affected test set selected by the repo's own
  `scripts/verify-affected.mjs --json` (invoked, never reinvented),
  executed under Bun with a per-file `node --test` fallback;
- `scripts/verify-preflight.mjs`;
- `CI=1 node scripts/check.mjs` — the stages verify:affected does
  not select (secret scan, generation-freshness gates, CI-only
  MCP/OpenAPI drift test);
- the pre-flight registration sweep in `--range` mode against a
  scratch git repo holding base and head as two commits.

Every failing check is A/B re-run against pristine main's tree; an
identical failure (same exit, same failing-test name set) is
classified ENVIRONMENTAL, never the tree's FAIL. A materialisation
that does not hash-verify is measured and A/B'd the same way — under
the EPERM write-fault episode, extraction writes are refused
(zero-filled files, identical at pristine main) and the run reports
ENVIRONMENTAL with that evidence instead of a false verdict.

Output (v1.2): a **proof-bundle-spec v1.1** bundle (`--out`) that
`verify-proof.mjs` v1.1 validates — `bundleVersion: "1.1"`,
`treeSha` = the head commit's real **tree** oid (resolved via
`git rev-parse <commit>^{tree}`; v1.1 wrongly copied the commit SHA
there, and v1.2 refuses to emit rather than repeat that),
`commitSha`, `pr` (omitted for `--sha` runs), `baseSha`,
`producedBy {tool, toolVersion, host}`, startedAt/finishedAt, and
per-check {name, kind, verdict PASS/FAIL/NOT-APPLICABLE/
ENVIRONMENTAL, wallMs, evidence}. Internal check kinds map to spec
kinds (`materialisation`, `selection`, `test`, `preflight`, `sweep`);
the single CI=1 check run is emitted as two entries —
`check-ci1:secret-scan` + `check-ci1:generation` — per spec §3.1's
combined-run rule. Runner identity, overall verdict and exit code ride
along as spec-permitted extension fields. Bundle writes use an inlined
atomic pattern (temp + fsync + sha256 readback + rename — importing
`atomic-write.mjs` read-taints the process under the EPERM episode);
on failure the bundle is printed to stdout between
VERIFY-LOCAL-BUNDLE-BEGIN/END markers. The v1 private shape
(`verify-local/proof-bundle` v1) is retired: bundles filed in that
shape stay VOID on schema under the verifier, by design — the format
migration for already-filed bundles lives in the M1-04 lane
(`clusters/M1-04/tools/transform-bundle.mjs`, spec B6 transformation
clause).

Exit codes: 0 no FAIL · 1 any FAIL · 2 tool defect (incl. GitHub
403/429 — the runner stops, never retries via another route, and an
unresolvable tree oid) · 3 ENVIRONMENTAL overall (no verdict on the
tree claimed).

Tests: `verify-local.test.mjs` (16 tests: arg parsing, ls-tree/blob
framing, integrity zero-fill detection, TAP failure parsing, A/B
classification, overall verdict, the v1.2 spec-emission cases —
kind mapping, CI=1 split, evidence synthesis, tree-Sha guard, and a
round-trip through verify-proof's own validator — plus the v1.3
missingObjects cases). First supervised
runs: wave MERGE-DEPLOY-TOOLS clusters/M1-01 (bundles for pristine main
aaa749065a and PR #5004 @ e8747162 — both ENVIRONMENTAL under the
active EPERM episode, exit 3, walls 3.7 s / 10.3 s; those bundles are
in the retired v1 shape — see the migration note above).

Ledger: 2026-10-29 — verify-local.mjs v1.3 (POST-EPISODE DISCHARGE
re-run, wave-2026-10-29-discharge): bootstrap on any missing required
object (head/base/main) + guarded deferred main reads; version note in
the tool header; tests 16/16. Filed for supervised landing per
fleet-tools discipline (change is in the working tree; the wave record
carries the diff summary and the first-run bundles).

Boundary: never merges, never labels, never dispatches a deploy,
never forges a room/release-lease.

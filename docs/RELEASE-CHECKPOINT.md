# Read-only release checkpoints

Run `scripts/release-checkpoint.mjs` to collect a bounded snapshot of a pull request and the public version endpoints. It does not merge, deploy, change settings, use Room credentials, or authenticate to a room. GitHub reads use your existing `gh` authentication.

```sh
node scripts/release-checkpoint.mjs --pr 1066
node scripts/release-checkpoint.mjs --pr 1066 --format markdown
node scripts/release-checkpoint.mjs --pr 1066 --expected-revision <full-40-character-commit-sha> --output ./work/release-checkpoint
```

JSON goes to stdout by default. `--format markdown` prints a readable checkpoint instead. Only `--output DIRECTORY` creates files: `release-checkpoint.json` and `release-checkpoint.md` (replaced on subsequent runs). Each report records `checkedAt`, the initial and final PR heads and bases, the check snapshot revision, check evidence URLs (HTTPS without credentials/query/fragment), and each door's reported source revision and build ID. Output contains selected metadata, never raw provider responses, credentials, or response bodies.

The default repository is `Uuriko/project-room`; override it with `--repo OWNER/REPO`. Default public probes are `https://room.trydemigod.com/api/version` and `https://www.getdasha.com/room/api/version`. Repeat `--origin HTTPS_ORIGIN[/PREFIX]` to replace these doors (at most eight). Origins must use HTTPS without credentials, query strings, or fragments. Redirects are reported, never followed. An explicit custom origin makes a public unauthenticated request to that host; use a host you intend to inspect.

Each GitHub process and each public request has a ten-second deadline. GitHub output and public bodies are bounded. PR snapshots run sequentially while the initial main and public probes run concurrently. Pinned ancestry comparisons then run concurrently, followed by a final main read. Collection takes at most about fifty seconds plus process/file overhead. At most seventeen unique comparisons are requested (main plus two endpoints for each of eight origins); commit lists are not paginated or used as containment evidence.

## Interpret the report

- `passed` means the observed check rollup completed successfully for the same head across collection. Mixed success plus neutral/skipped results are `passed_with_skips`, with those rows marked `not_run`; a rollup containing only those rows is incomplete. Required branch protection rules are not evaluated. The collector observes PR-reported base metadata, which can lag the branch tip, and does not bind check results to their tested base or integration merge revision (`integrationBaseVerified: false`). This is not permission to merge.
- No checks or pending checks are `incomplete`. Failed checks are `failed`. A moved head/base, a rollup for another head, unavailable observations, and unrecognized check states are `unknown`. Re-run to collect a fresh checkpoint.
- Public JSON must report `status: "ok"` and a full 40-character source SHA. Invalid metadata is an observation error, even with HTTP 200.
- HTTP 200 means the public version endpoint answered. It does not prove authenticated Room access, correct Durable Object routing, or application health.
- `--expected-revision` compares an explicitly supplied full SHA with each door's reported `sourceRevision`. A missing/invalid source revision or probe error produces `unknown`; a different full SHA produces `mismatch`. Without an expected SHA the comparison is `not_requested`.
- Source/build fields are reported metadata, not verified deployed bytes. Use the existing [release evidence tool](../scripts/release-evidence.mjs) for TAP, working-tree and digest-based release evidence. This collector does not replace it.

Exit 0 means collection completed, even when a known check failed or a known revision mismatched. Exit 1 means an observation was unavailable or unsafe to attribute to the current head/base. Exit 2 means invalid arguments or an output-write failure. Check the structured states; do not treat the process exit code as a deployment gate.

## Main, merge, and public source observations

Schema version 2 adds `currentMain`, `candidate`, `pullRequest.mergeRevision`, and `workers`. Main is read directly from `git/ref/heads/main` before and after collection, independently of the PR's base metadata. A failed read or changed main produces `state: "unknown"` and unknown containment; a fresh run is needed. Check results still do not establish a tested integration base.

For an open/closed unmerged PR, the candidate is its head. For a merged PR it is GitHub's actual `mergeCommit.oid`, which also handles squash merges without assuming the original PR commits remain ancestors. Missing merge metadata does not fall back to the original head. Changes to PR head, base or merge state across its snapshots make candidate ancestry unknown.

The collector asks [GitHub's compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits) for `CANDIDATE...OBSERVED_REVISION`, using full pinned SHAs. `ahead` or `identical` with the candidate as both base and merge base establishes `contains`; `behind` or `diverged` with a different merge base establishes `does_not_contain`. Failed, malformed or mismatched comparisons remain `unknown`. This is ancestry only: later commits can revert behavior. It is not a bundle digest, proof that every local agent change shipped, or merge approval.

Each origin is also probed at `/api/version/worker`, concurrently with its application `/api/version` endpoint. Worker responses additionally require `servedBy: "worker"`. `workers` records that endpoint's own source revision, candidate ancestry and separately reported Durable Object name/id. Matching application endpoints can share the same backend and do not prove that the two Workers run the same revision. Reported object identifiers are configuration observations, not proof that authenticated traffic reaches the expected object.

A PR's `MERGED` state is never labeled deployed. Per-door `candidateContainment` means only that the reported public source revision contains the candidate in Git history. Unknown main/ancestry, invalid Worker responses, or failed probes make the CLI exit 1. Known non-containment or revision mismatch may still exit 0 because collection succeeded. No authenticated health claim is made.

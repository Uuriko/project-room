# Read-only release checkpoints

Run `scripts/release-checkpoint.mjs` to collect a bounded snapshot of a pull request and the public version endpoints. It does not merge, deploy, change settings, use Room credentials, or authenticate to a room. GitHub reads use your existing `gh` authentication.

```sh
node scripts/release-checkpoint.mjs --pr 1066
node scripts/release-checkpoint.mjs --pr 1066 --format markdown
node scripts/release-checkpoint.mjs --pr 1066 --expected-revision <full-40-character-commit-sha> --output ./work/release-checkpoint
```

JSON goes to stdout by default. `--format markdown` prints a readable checkpoint instead. Only `--output DIRECTORY` creates files: `release-checkpoint.json` and `release-checkpoint.md` (replaced on subsequent runs). Each report records `checkedAt`, the initial and final PR heads and bases, the check snapshot revision, check evidence URLs (HTTPS without credentials/query/fragment), and each door's reported source revision and build ID. Output contains selected metadata, never raw provider responses, credentials, or response bodies.

The default repository is `Uuriko/project-room`; override it with `--repo OWNER/REPO`. Default public probes are `https://room.trydemigod.com/api/version` and `https://www.getdasha.com/room/api/version`. Repeat `--origin HTTPS_ORIGIN[/PREFIX]` to replace these doors (at most eight). Origins must use HTTPS without credentials, query strings, or fragments. Redirects are reported, never followed. An explicit custom origin makes a public unauthenticated request to that host; use a host you intend to inspect.

Each GitHub process and each public request has a ten-second deadline. GitHub output and public bodies are bounded. The three GitHub reads run sequentially while public probes run concurrently; collection therefore takes at most about thirty seconds plus process/file overhead.

## Interpret the report

- `passed` means the observed check rollup completed successfully for the same head across collection. Mixed success plus neutral/skipped results are `passed_with_skips`, with those rows marked `not_run`; a rollup containing only those rows is incomplete. Required branch protection rules are not evaluated. The collector observes PR-reported base metadata, which can lag the branch tip, and does not bind check results to their tested base or integration merge revision (`integrationBaseVerified: false`). This is not permission to merge.
- No checks or pending checks are `incomplete`. Failed checks are `failed`. A moved head/base, a rollup for another head, unavailable observations, and unrecognized check states are `unknown`. Re-run to collect a fresh checkpoint.
- HTTP 200 means the public version endpoint answered. It does not prove authenticated Room access, correct Durable Object routing, or application health.
- `--expected-revision` compares an explicitly supplied full SHA with each door's reported `sourceRevision`. A missing/invalid source revision or probe error produces `unknown`; a different full SHA produces `mismatch`. Without an expected SHA the comparison is `not_requested`.
- Source/build fields are reported metadata, not verified deployed bytes. Use the existing [release evidence tool](../scripts/release-evidence.mjs) for TAP, working-tree and digest-based release evidence. This collector does not replace it.

Exit 0 means collection completed, even when a known check failed or a known revision mismatched. Exit 1 means an observation was unavailable or unsafe to attribute to the current head/base. Exit 2 means invalid arguments or an output-write failure. Check the structured states; do not treat the process exit code as a deployment gate.

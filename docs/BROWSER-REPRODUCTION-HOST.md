# Operator-local browser reproduction

`scripts/browser-reproduction-host.mjs` runs one explicitly selected test and
records the original observation. It neither repairs code nor marks work or a
release complete. A native supervisor may invoke it with operator-selected
arguments. This is not a new scheduler, and it does not make the Linux-only
generic `configuredHost` sandbox available on macOS.

```sh
/absolute/node scripts/browser-reproduction-host.mjs \
  --checkout /absolute/clean-checkout \
  --revision <full-40-hex-commit> --tree <full-40-hex-tree> \
  --script scripts/browser-check.mjs --test-name 'exact observed test name' \
  --node /absolute/node --git /absolute/git \
  --out /absolute/existing-parent/new-attempt-directory \
  --timeout-ms 100000
```

The operator pins all executable inputs. No commands, paths or arguments are
read from Room messages, packets, JUnit or stdin. Optional `--packet-id`,
`--packet-sha256`, `--request-message-id` and `--work-item-id` are metadata only.
A linking consumer must verify those bindings against the original packet and
current request; the runner does not fetch or authorize Room work.

The checkout must match its pinned HEAD/tree with no tracked modifications.
The selected script must be tracked, not a symlink, and belong to the existing
derived browser suite. Dynamic test names are allowed: the exact name is escaped
as a regular expression and passed as an argv value, never shell text. Node
must be an explicitly selected canonical executable satisfying >=24.19.

Execution reuses `hostSubprocess` with a five-minute maximum, a one-MiB stdout
limit and process-group termination. It clears ambient credentials and Node
options, uses a unique temporary directory beneath checkout `.tmp`, and retains
HOME for an already-installed Playwright cache. This local invocation is **not
a sandbox**: the selected test can access files and network. Dependencies and
the browser binary are not pinned by this receipt. No browser installation is
performed by the adapter.

The private output directory is created exclusively; retries need a new path.
It contains `stdout.tap` and `receipt.json`, including source/script/Node hashes,
test name, packet metadata, exit status and artifact digest. A unique matching
non-skipped TAP result is required: zero matches, skips, TODOs, ambiguous output,
timeouts, cancellation, launch failure and output overflow are `unknown`.
Source changes after execution also make the outcome unknown, preserving the
original `observedOutcome`. Stderr and incomplete stdout are not retained by
the shared subprocess helper. The stdout protocol is only `{ "body": "..." }`,
with receipt and stdout digests; it does not fabricate a `codeResult` patch.

JavaScript integration uses `runBrowserReproduction(options)` and receives
`{ body, receipt }`. CLI success means a receipt was recorded, even if the test
failed or is unknown; callers must inspect `receipt.outcome`. Refused operator
configuration exits nonzero without starting the selected browser test.

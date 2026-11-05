# Compose a release record

The first adapter imports completed `release-checkpoint --mode verify` attempts.
It does not merge, deploy, publish, fetch a service, or decide permission to act.
Run from a source checkout containing both CLI scripts:

```sh
node scripts/release-record.mjs \
  --repo Uuriko/project-room --revision FULL_COMMIT_SHA --tree FULL_TREE_SHA \
  --evidence-root /path/to/verification-attempts \
  --attempt verify-first/receipt.json --attempt verify-later/receipt.json \
  > release-record.json
```

Input paths are explicit and must resolve inside the evidence root, including
symlinks. Each receipt's adjacent `strict-smoke.json` and `live-smoke.json` must
match the receipt; an advertised `original-failure.json` must match its recorded
byte count and SHA256. Files are bounded to1MiB each,16MiB total,32 attempts.
No directories are crawled. Evidence is never rewritten. Output contains relative
references, digests and bounded summaries, not raw logs, environment variables,
private machine paths or arbitrary finding text. Preserve the evidence directory
alongside the record for portable review.

The composer checks full target commit/tree identity, producer identity,
source stability, four matching HTTP200 version observations, the reused
verification policy, and concrete strict-smoke/card fields. It recomputes results
instead of trusting `state: verified` or `stable: true`. Inconsistent declared
success remains a failed observation. Missing, corrupt or mixed-target evidence
is refused; unsupported/incomplete receipts must be completed or reviewed
separately, not converted into success. Known warnings and explicit-target
main-lag advisories remain summarized by code; inspect referenced reports for
full details.

Records have deterministic target and attempt identities. Attempt order follows
producer-reported completion time, then digest; reversing input order does not
change output. Repeated identical receipt bytes represent one observation.
Original failed smoke stays attached to the later attempt even if it passes.
A later failure remains the latest observation; an earlier success is retained.

Only the verification adapter is implemented. Merge, deployment and publication
facts remain unknown, as does current health. A passing historical sample is not
an upload receipt, authenticated journey, package-integrity proof, permission to
publish, or incident closure. Hashes identify bytes and detect mismatches against
provided references; they do not authenticate a producer. Fully forged but
internally consistent evidence cannot be distinguished without an independent
trust source. Always obtain fresh observations before a release action.

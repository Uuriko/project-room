# Current recovery qualification — September 8, 2026

## Outcome

The current schema12 working source passes a local Workers application-switch
drill against the distinct schema12 fallback at
`135d82489c62071b3f4eb00710ae4d9787374158`.
The existing historical schema8 drill is preserved; it is not a current fallback.

This is local regression evidence, **not a deployed release or a backup restore**.
The candidate is an isolated synthetic commit containing only allowlisted runtime
files from the working tree. The real branch remains uncommitted. The temporary
packages, synthetic database and observer directory are removed after the test.

## Drill and assertions

1. Package candidate and fallback separately; verify they have genuinely different
   runtime code and complete hash-checked manifests.
2. Seed two disposable rooms into one persistent local Workers object. Audit all
   20 application tables against the independently built SQLite fixture.
3. Write a candidate message and reminder, then capture the complete data audit.
4. Restart candidate in maintenance mode. Reads and writes return503 without
   creating cookies; switching to fallback shows the exact pre-pause audit.
5. On fallback, check valid/revoked identities, account restrictions, cancelled
   share-link retries, invitation retries and reminder receipts. Preserve open,
   answered, declined and cancelled requests, original response receipts, exact
   native text result and completion receipt, and charter receipt.
6. Keep an existing v3 observer inbox across the switch. Fallback lacks the v3
   capability marker and returns `request_context_unavailable`. Saved checkpoint,
   notices and acknowledgements remain unchanged. Per-run control bookkeeping
   may change; it is not the conversation history.
7. On fallback, create new work and a reminder, accept a pending invitation, and
   open and answer a new request. Capture the new audit.
8. Switch back to candidate. Every application row matches the fallback capture;
   the original agent notice returns unchanged. Retry fallback writes and confirm
   the same receipts, no duplicates and no data changes.
9. Verify both package manifests again after execution. Generated state stays
   outside the immutable runtime directories.

No model, subscription, provider account, deployment, live namespace or real user
data is used. Test wrappers are local-only and never packaged into the product.

## Evidence

- Core/API/package suite:536 passed.
- Full local Workers runtime suite:13 passed, including both switch drills.
- Candidate:65 runtime files,19 browser assets, schema12.
- Fallback:64 runtime files,19 browser assets, schema12.
- Candidate synthetic source tree:`7f61ad99ec4d04cb48b9d628677d04063a25655e`.
- Fallback manifest SHA256:`7e310ba463673ad84e968c83a5cab5b31af733cb9fc26d38ac1044c08f700eff`.
- Latest successful schema12 seed audit:`81044654ee87b1cfec8374c2f7cb5539df14363420c303995b207d22fa01acb9`.
- After candidate writes:`7ab17331ca2b1231faf894b72128e3b5f87d52ce283045c8e6dad1ac656c4192`.
- After fallback writes:`7befcddad55304e4308959d52868e83befec945433a046ca8cd6b75d34a6e629`.

Synthetic IDs/times make capture hashes differ on each run. These values identify
one successful run, not a durable release artifact. The first strengthened test
incorrectly compared SQLite file bytes, including legitimate observer run IDs;
it was corrected to assert exact checkpoint/notice rows and the full suite reran.
No product bug or runtime fix is claimed for that test correction.

Browser/UI source was not changed in this slice; the prior168 browser and one
Workers browser results were not rerun. No new screenshots are claimed for this
backend-only drill. Diff whitespace checks pass.

## Before publishing

- Create and retain an exact real candidate commit/package and a distinct fallback
  package; repeat qualification against those durable artifacts, not synthetic Git.
- Treat fallback as reduced capability: v3 inbox unavailable until candidate
  returns; ordinary requests, work and contributions remain operational.
- Test provider-native recovery in a disposable hosted environment, including
  storage identity/routing and current authority after a historical restore. An
  app switch against the same data does not prove point-in-time recovery or that
  old credentials stay revoked after restoring an old backup.
- Complete independent native-agent review only after current explicit approval
  for potential subscription usage. Previous native acceptance remains partial.
- Obtain current approval before any push, deployment or provider changes.

The overall goal remains incomplete. Preview64985 is preserved. This checkpoint
adds tests and test packaging reuse only; no schema, UI or production runtime change.

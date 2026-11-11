# Automatic rollback reply-contract guard

Base: PR #5818 source `e3b8270b6`. No runtime reply cap, storage schema,
writer-fence, deployment command or manual authorization change.

Automatic deploy recovery previously compared the schema floor and exact
writer-fence/imported table definitions. Equal storage definitions do not prove
an old reader accepts newly valid replies. In particular, an older selected
reply reader can reject an expanded answer in `previousExchanges` after a
follow-up, even when an immediate current-page response works.

`schemaAt` now reads the exact `src/reply-requests.js` Git blob and includes its
hash in the definitions pin and separate `replyContractBlob` field. It never
evaluates source. Automatic rollback requires both explicit reply proofs to be
known and equal. A changed contract or missing older receipt field refuses
automatic rollback with a concrete reason; it does not mutate a fence comment
or storage version to force a hash change.

A historical source without this file retains its valid schema/fence proof and
has `replyContractBlob:null`. That remains usable by the existing separately
qualified manual rollback path, whose exact source/allocation, old-code/new-data,
retained-runtime and bindings requirements remain unchanged. Automatic recovery
refuses that unknown reply contract.

This deliberately conservative check also refuses an automatic rollback after
a harmless edit to the pinned file. Matching these pins still does not prove
all other row, code-dependency or retained-runtime compatibility. The recovery
receipt states this limit and preserves the requirement for explicit manual
qualification.

Qualification:

- Two new controls fail on the base: identical fence plus a changed real Git
  reply blob is wrongly eligible; missing explicit reply evidence is ignored.
- Real temporary Git commits test identical/changed/missing reply files, with
  executable sentinels proving no evaluation. Another test checks the actual
  repository's exact checked-in reply blob.
- Final deploy/source suites: 51 pass, zero skipped. The initial combined run
  also passed all 40 existing manual rollback controls (90 total before adding
  the final repository-source control). Final manifest: 8 pass, zero drift.
- The existing imported-table drift and actual recovery CLI controls retain
  known identical reply files so they continue isolating the original fence
  behavior. No denial assertion was relaxed. Lint and secret scan are clean.

Local logs: `/tmp/reply-contract-rollback-{before,after,final,manifest,lint}-1103.log`.
All source/command fixtures are synthetic and local. No cloud deployment or
rollback was attempted.

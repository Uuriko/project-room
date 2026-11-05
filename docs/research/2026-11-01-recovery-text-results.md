# Durable native text-result audit

Runtime `842fd6d4d`, on root `890cd5ecf`. Source chain: `4719eaf2c`, `3228a1b8c`, paired protocol stitch `5ce84d8eb` (original `af7178d58`), `a88092666`, `842fd6d4d`. Root owns integration/publication. Schema45 remains offline. Pairing owns subsequent combined charter/protocol14 qualification; that is distinct from this protocol13 proof.

## Exact gap and shared semantics

Strict replay checks addressed completion events, but the independent `auditTextResults` also accounts for every projected native receipt, including receipt history behind historical/checkpoint bases. It rejects duplicate projected event IDs, missing/orphan completions, an incorrect previous-completion chain (including intervening external completions), a changed post/proposal basis, withdrawn-text inconsistencies and any mismatch in the saved receipt projection. The original audit builds its uniqueness sets per room; this phase preserves that exact per-room scope. Global event/history identity checks remain elsewhere.

Original full audit and bounded phase now share `storedTextFromEvidence` and `auditTextReceipt`. The public selected-result API is unchanged. Original `storedText` parses a post once, applies the same cheap identity/metadata predicate before its existing prior-event query, and supplies the addressed facts to the shared leaf. The original full oracle still runs for every room and is mandatory for admission.

The new phase first walks independently validated `actual/workBody` scratch one work/receipt slot at a time. It records only bounded completion references and cited text versions in the existing target-owned scratch. It then walks the original event primary sequence without source filters, tracking exact work revision and previous-completion facts, and resolves only selected current messages, posted events and receipts. Proposal predecessor facts preserve the original work-revision event predicate. No whole work map, retained-message map or history array is materialized by this phase. One bounded work body may be reused within a single synchronous frozen-source step; there is no cross-transaction cache or authority reuse.

Caller authority requires the privileged synchronous restore transaction, pending matching restore ID, audit_pending phase and actual matching source seal. Event byte bounds come from the persisted admission seal, not caller-supplied relaxed maxima. Scalar byte checks precede event/post/message/witness payload transfer. Work scratch input is checked against its declared and actual byte length and existing unit cap. Wrong-scope, wrong-ID and wrong-seal calls refuse before event/scratch payload reads.

Protocol13 adds a per-normalized-room text_results stage after existing replay and before room advancement/scratch cleanup. The cursor and scratch commit in the same existing restore transaction. Progress exposes the current text cursor; the final response reports independently projected/audited receipt counts. Legacy rooms continue to require their original full audit rather than claim this phase qualified them.

## Bounds and a caught regression

A step admits at most32 atoms and normally stops at4MiB of conservatively charged payload input. A legal sealed source atom may exceed that nominal quantum: it runs alone, is bounded by the exact source seal, and reports its actual bytes. This is not a strict4MiB whole-call or CPU bound. A genuine original-envelope-valid source event with more than4MiB of retained top-level historical context passes initial full audit and actual operator recovery. The earlier hard4MiB per-atom prototype falsely refused it; the causal log and passing control are preserved. No existing source admission limit is raised.

Longer receipt history exposed a second real defect: exact restore guard reinstallation moves sqlite_master rowids, making cached locations stale in the next warm step. Both current schema verifiers now retry the ORIGINAL complete expected-name set on a location miss. They refresh locations only after checking exact cardinality, names and normalized SQL. A changed or missing guard still refuses. Closed-permit checks remain unconditional. There is no observed-schema rebaseline, schema-version trust epoch or cached pass. Wrong reinstalled SQL is explicitly rejected; only exact original DDL recovers. The longer-history causal test fails before this fix.

Restores that reinstall guards may therefore need an extra cold catalog query. The earlier ordinary warm cached cost does not describe every restore step. The mixed Native test includes a genuine warm second text step and measures that extra cost.

## Qualification

26 Node tests pass, with zero skips: original text-result reader/privacy tests plus new independent phase controls. New controls include live and withdrawn text; missing, duplicate and altered native receipts; wrong evidence version; full scratch rollback on save failure;20 completion events with an external parent and19 exact native proposal results; at most one bounded work-body transfer per synchronous step; legal above-quantum original source; changed-guard refusal and exact restoration; and wrong restore authority before payload access. A server import-closure package check also passes. Targeted ESLint has zero errors and three pre-existing raw-members warnings in current-room-repository. Secret scanning requires no allowlist changes.

Actual production NativeProjectRoom uses a real repaired historical source converted through H,70 later context posts, a native completion and subsequent actual message erasure. It exports429,565B over90 events. Operator restore resumes cold between steps, except one deliberate warm text continuation. Each response receipt is retried exactly. The first text checkpoint is interrupted after the actual admission UPDATE and rolls back completely. The valid target completes three text calls and the original full oracle with `{rooms:1,projected:1,audited:1}`. A separate target's saved native receipt is corrupted in privileged test scratch; the text phase rejects it before full_audit_pending, writes zero adapter rows and preserves its pending cursor. Test corruption is not a product grant or bypass.

The three valid text calls charged148,201 /141,504 /119,320 payload bytes. Adapter counters were138 /219 /95 statements,38,994 /31,209 /23,436 physical rows read,15 /4 /4 rows written, unknown0. The middle call is warm and includes extra exact catalog work. Elapsed samples16 /7 /15ms are clock-only observations. These counters include outer restore work observed by the adapter but exclude raw runtime permit statements outside it. Charged module bytes exclude some control/schema metadata; they are not claimed as total transported SQL bytes or peak process memory. Earlier all-cold Native proof is retained separately.

Commands:

```
/Users/johnpotter/.local/bin/node --test tests/recovery-text-results.test.mjs tests/text-results.test.js tests/text-results-dm-party.test.js
# /tmp/recovery-text-node-final.log
MINIFLARE_WORKERD_PATH=/Users/johnpotter/.npm/_npx/c943b712072b77c4/node_modules/workerd/bin/workerd /Users/johnpotter/.local/bin/node --test cloudflare/recovery-text-results-native.check.mjs
# /tmp/recovery-text-native-warm-final.log
/Users/johnpotter/.local/bin/node --test --test-name-pattern='every module in the server import closure' tests/runtime-package.test.js
# /tmp/recovery-text-package-closure.log
```

Causal logs: `/tmp/recovery-text-cache-causal-red.log`, `/tmp/recovery-text-cap-causal-red.log`. Machine-readable receipt: `audit/evidence/recovery-text-results-20261101.json`.

This adds restartable independent coverage for one precisely enumerated subsystem. The still-required original full oracle repeats these checks, so this checkpoint does not claim a net end-to-end speedup or removal of that final blocking work. It does not remove the final oracle, certify all remaining recovery subsystems, qualify legacy rooms as bounded, or claim bounded whole recovery/CPU/purge. No new tables, grants, product system or live format activation was introduced.

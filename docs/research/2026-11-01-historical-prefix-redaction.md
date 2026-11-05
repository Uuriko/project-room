# Historical-prefix erasure: independent derived proof

Runtime checkpoint: `68221f018`, following `f9d39d817` and `2e40ddce9`, based on accepted normalized-redaction checkpoint `06af4213d`. Local qualification only; root owns composition, review, publication and deployment. No live schema45 change.

A real repaired historical prefix previously refused authorized deletion with `current_redaction_historical_prefix`. The causal baseline log is `/tmp/historical-redaction-baseline06af-red.log`. This change permits erasure while retaining the exact original immutable repair and replay-lookup receipts. It does not rewrite their digests, claim previously unknown history is certified, or retain a plaintext copy.

## Proof and authority

Before the first rewrite, the existing historical reader must independently verify the original prefix and original checkpoint using its existing raw UTF-8 framing/canonical codec. A compact append-only basis records explicit ordered per-event original and deterministic-erased hashes plus target IDs and original posted-body byte lengths. It permits only the existing posted/edited privacy transformation: owned body and attachment fields become null and redacted becomes true. Actor, recipient, channel, time and all other fields remain bound to the original hash. The source is still independently capped at64 events and256KiB source plus replay output.

Each erased target needs a separate immutable receipt binding its basis, actual authorized deletion and redaction events, actor and command fingerprint (including causation presence semantics), prior protected current head, opened and closed writer admission, deterministic transition receipt and exact target witness. No basis alone, missing basis, wrong actor, unrelated command, changed target hash, substituted transition, or resurrected source text is accepted. Postwrite validation exempts only the current transaction's still-open permit; all earlier closing receipts remain mandatory. The current writer format is explicitly native-work-5, with no future-format wildcard.

The descriptor is capped at64KiB. The complete extra descriptor/receipts/event/reference input is capped at128KiB and conservatively admitted before persistent source changes. Individual server event envelopes admit32KiB within that aggregate: a legal16KiB command containing escaped NUL reason bytes produces an event larger than16KiB. The old16KiB event check has an independent causal failure, `/tmp/historical-redaction-escaped16-causal-red.log`. The public command cap and reason policy are unchanged. Repeated individually legal large erasures eventually hit aggregate admission and refuse with the complete pre-command state unchanged.

The reader exports `HISTORICAL_REPLAY_MAX_INPUT_BYTES=384KiB`: original256KiB plus independent128KiB metadata. Pairing owns recovery continuation/seeder reservation integration, reducing the remaining payload quantum without raising the overall4MiB limit. Original source/output and metadata bounds remain separate. The public saved-checkpoint API strips its private basis field.

## Executable qualification

Focused15 Node controls cover real H migration, three erasures, original receipts, plaintext absence from live cells, full independent audit, production NDJSON restore and exact duplicate retry. They also cover source/basis/receipt save faults with full rollback; descriptor-only/missing/wrong/substituted/resurrected evidence; oversized descriptor refusal before source UPDATE; corruption of an earlier closing receipt during the next erasure; legal escaped reason and cumulative aggregate admission. Tests use privileged SQL corruption only as deliberate falsifiers, restore exact immutable guard DDL, and never add a product bypass.

Actual production NativeProjectRoom qualification uses real HTTP authorization and a real repaired prefix14/head17. An unauthorized private erasure refuses. A fault after the actual erasure receipt INSERT rolls back. Three committed erasures each simulate a lost response followed by a cold restart and exact retry. Every cold retry writes zero adapter rows. Full source audit then export, authenticated operator restore, cold pending refusal,58 operator continuation steps including the full oracle, final cold readiness, original receipt equality and saved-command retry all pass. This is not merely a same-process helper proof.

Latest Native adapter counters: first erasure289 statements/5,886 reads/100 writes; second338/5,444/45; third379/5,767/44. The first also removes actual captured staging. Each cold retry111 statements/1,595 reads/0 writes. Unknown adapter counters0. Basis2,320B, three receipts2,628B total; source export129,440B. Elapsed samples23/12/15ms are illustrative clock measurements, not CPU. Raw runtime permit SQL outside the adapter is excluded from these counts.

Commands and logs:

```
/Users/johnpotter/.local/bin/node --test tests/current-historical-redaction.test.mjs tests/current-message-redaction.test.mjs tests/historical-replay-contract.test.mjs tests/saved-historical-replay-contract.test.mjs tests/historical-replay-utf8.test.mjs
# /tmp/historical-redaction-node-final.log
MINIFLARE_WORKERD_PATH=/Users/johnpotter/.npm/_npx/c943b712072b77c4/node_modules/workerd/bin/workerd /Users/johnpotter/.local/bin/node --test cloudflare/current-historical-redaction-native.check.mjs
# /tmp/historical-redaction-native-final.log
```

Targeted changed-file ESLint passes with zero warnings; staged secret scan is clean. Machine-readable receipt: `audit/evidence/historical-prefix-redaction-20261101.json`.

## Remaining scope and limits

The complete privacy purge remains atomic and variable cost. These small genuine historical-prefix cases do not prove bounded whole-history, attachment, body, account or room erasure. Existing source and metadata admission can refuse before mutation when limits are exceeded; there is no new resumable whole-purge claim. Original repair proof remains immutable and historical provenance is not recertified. No raw grants, permission widening, account-deletion enablement or independent format bump is introduced. Root must qualify the composed native5 invite/recovery candidate, include the384KiB reservation integration, and retain the full recovery oracle before release.

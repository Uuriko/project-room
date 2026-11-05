# Bounded report batching qualification

Runtime d43466fe900dd4e215b5f21e34a4aab617d52405 on0c0f502c0. Additional quota tests a6b44edbcfb01ae15a7b3ee1403c546746781196. No production calls or deployment. Root already adopted runtime: cherry-pick only a6b44edbc and this evidence after its equivalent d434. No protocol, schema, seal, authority or persisted cursor shape change.

## Mechanism and bounds

Node report1 requires BLOB numeric properties in JS lexical key order; it still emits that exact sequence. Two request-local2048-byte blocks replace one SQL query per byte (4KiB raw cache, no cross-request reuse). Native ArrayBuffer retains original empty-enumerable-object representation.

The owner now groups work under a4MiB logical report payload/output budget, global16384work units, at most1024sort units,64newsource rows,128existing scratch rows and256table transitions. Input payloads, newly produced canonical output, hash quoting output and stored chunk/index payloads are charged. Fresh source row metadata reserves64KiB. This is not a claim that catalogue/control/constructor/physical IO fits4MiB. Exact outer admission and immutable snapshot checks remain; initial capture is still a separately admitted3MiB raw atom.

Before a sort unit, reserve five maximum admitted133120-byte scratch values plus bounded metadata/output. This covers two row refs, two compared chunks and the selected ref; hash uses fewer. Before a source unit, reserve two maximum snapshot parts,16KiB expanded output, one worst serialized8192-unit chunk and fixed index overhead. A fresh4MiB request always admits one largest legal unit; exhaustion saves the current cursor normally. Unicode/escaping/output expansion is counted, not merely binary input bytes. Existing128row scratch guard remains.

## Actual Native operator and CLI

Exact d434 existing synthetic32message fixture:1/1pass including T0 whole-oracle parity, cold restart, lost ACK exact retry, immutable publication receipt, cleanup guard/workspace zero, ready and saved work/message retry. Report requests260→16, total POST385→141; report physical reads7,706,105→514,896. Max per-request costs INCREASE because more useful work is committed:454→1847SQL,30,957→32,668reads,53→237physicalwrites,715,893→938,266materializedJSON bytes; DROP remains6. Physical writes include indexes and are not the logical128scratchrow count. All cursor counters known. Total materialized report JSON11,132,000bytes.

Scopes match prior existing32workload (synthetic timestamps/credentials regenerated, not byte-identical backups). Raw SQL instrumentation excludes constructor, seed, export and reference oracle, and does not measure CPU/heap/physical byte IO. Local qualification processes overlapped: no clean wall-time speed comparison is claimed.

## Node correctness and total calls

Four ORIGINAL1MiB binary cells preserve exact independent wholecanonical SHA:260bounded source batches versus old>=131072,120380blockqueries versus4194304bytequeries, maximum16384work and2,436,232logicalbytes. No fixture reduction. Worst escaped TEXT emits8,388,629canonicalbytes over9batches with2quota stops. Long equal-prefix sort/hash uses3batches,2quota stops,max3,456,637logicalbytes; duplicates and cold cursor retain exact oracle. Largest3MiB rawcontrol codec preserves exact whitespace/duplicate JSON/NULL basis in4batches; its128chunk row ceiling stops it before byte exhaustion (quota stops0). An initially incorrect test expectation that this control fixture must hit the byte quota is retained as a red artifact; no runtime change fixed it. This raw codec harness is not a valid full restore certificate.

All5quota controls pass, plus17existing source/sort/snapshot/operator controls. Actual600message finalization3/3pass: pre-report298unchanged; report4218→370.128row/4MiBcoverage, process exit inside checkpoint rollback, cold lostACK exactbytes and prepared SQL writer refusal remain. Default literal oracle intentionally reads1207rows; no claim of fully bounded final semantic audit.

Root separately reports composed6cad2f545 original4restorefiles46/46pass (including >64MiB fourBLOB+76TEXT fixture). That is root-owned qualification, not this agent's execution. All local logs/digests/source pins are in receipt.json. Full lint exits0(367warnings), scan exits0; one expression formatting fix was AcornAST-equivalent.

Commands: bundledNode --test cloudflare/recovery-report-operator-native.check.mjs; --test tests/recovery-finalization-continuation-contract.test.mjs; --test tests/recovery-report-batching.test.mjs; and source/continuation/snapshot/operator focused files. No unchanged broad suite was rerun.

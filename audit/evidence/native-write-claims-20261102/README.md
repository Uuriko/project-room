# Native write reservations: exact source, lifecycle and cost

Base74d252de9 (dependency qualification). Test red587c6eb79; first runtime418ba3c45; streamed/indexed sourcee80c9632b; final runtimeb0726d977; final useful-work/two-agent qualification62a520fc5; generic prerequisite wordingbd1cdb1bb. Parent owns integration/deploy. No live calls, account changes, secret generation for live use or host execution.

The native command path previously refused claim.acquired/renewed/released entirely. Enabling only their selected task would undercheck cross-work scopes. The port instead streams protected summaries of every live claim in the same command transaction, using original matchClaimOverlap/conflictingClaim predicates and existing shared permission, actor, CAS, expiry, progress and reducer rules. All per-unit reference/hash/revision/receipt/scalar bounds remain; at most four receipt envelopes are shared in the transaction. Only ten warning matches and one earliest conflict remain allocated. Original persisted first-ten ordering is preserved using bounded selected proposal evidence, including JavaScript integer-key ordering. Missing, ambiguous or nonmatching opening evidence refuses, without inventing historical provenance.

There is no global16-claim limit. Keyset pages contain at most32 source keys; each protected summary has a fresh original proof/input budget. A numeric expiry derived with the SAME Date.parse interpretation excludes expired history before source examination. Existing protected workSummary production/initialization/H/full census all use the same derivation. Four owned indexes cover expiry, accepted holder leases, working/blocked holder obligations and selected proposal evidence. No new table or parallel ledger. Existing format token advances to normalized-current-v1-native-work-6; exact serving and restore control guards bind it. This is an offline candidate format change, not automatic live conversion.

Member capacity retains existing semantics: accepted claims stop counting when released/expired, while genuinely working/blocked obligations remain held until resolved. Room capacity remains the existing canonical acceptance check. A Room reservation grants no external execution permission; separate agent principals without write_external can coordinate scopes but still cannot start write work.

## Causal correctness

The initial red reproduces current_room_context_unavailable on the prior exact runtime. A later deterministic clock-edge control exposes e80 persisting a warning when the recorded event instant says the other lease expired. Finalb072 lazily admits against the EXACT incoming event timestamp used by the shared reducer and conflict check. That clock red passes afterward, including full oracle parity. Typed internal cap/budget refusals retain their ServiceError status through this narrowly scoped reducer callback.

Final11claim controls pass: same-ref conflict; cross-ref warnings; release/expiry; public renewal/progress; missing/private progress refusal; invalid/stale/nonholder refusal; rollback;40disjoint claims; first-ten order; complete holder accounting; malformed scalar proof rejected before payload; Date.parse format compatibility; exact clock boundary; useful write-mode start/completion and exact saved result after release; two independent synthetic Room agent principals preserving unchanged permissions. Earlier matched38-test neighborhood passed before the final clock-only runtime delta; it is labeled separately rather than claimed as a new full run.

Genuine prior native5 source74d252 warm and cold readers/commands, prepared SQL and operator restore-status checks refuse the new exact format without changing rows. The test deliberately reconciles a verified EMPTY target schema only; no ordinary format upgrade bypass is introduced. New6 export→actual restore→cold reopen preserves exact task/lease and full independent oracle, then authorized release works. No old cold-constructor refusal is claimed: the old application read is what refuses.

Actual production ProjectRoom constructor/HTTP Native test passes three arms:0expired,100expired,100expired+40live. Each executes claim, conflict refusal, release, interrupted head save/rollback, cold retry and exact duplicate, then starts useful write work, posts an exact text result, completes it, cold-reads that receipt/body via HTTP and passes the full oracle. This is local workerd qualification, not provider/host execution or live deployment. Fixture: cloudflare/normalized-write-claims.check.mjs; root owns its explicit CI list registration.

## Measured bounds and remaining cost

An expression row-value keyset returned0 expired rows while physically reading100. Two direct expiry/key seeks cure that hidden scan. Native physical SOURCE measurements:

| Expired | Live | Source queries | Physical source rows read | Returned source rows |
|---:|---:|---:|---:|---:|
| 0 | 0 | 1 | 1 | 0 |
| 100 | 0 | 1 | 1 | 0 |
| 100 | 40 | 3 | 41 | 40 |

The final Native request reports194/196/622 adapter statements and1373/1375/1878 adapter rows read for those three arms; exact values are in native-cost.json. Adapter-observed request totals are partial: raw native permit SQL and independent background work are not included, and the runtime explicitly marks those request totals incomplete. They are not total platform billing or CPU. Clock readings are wall-only. No retained whole live-body map exists, but TOTAL transaction work is still O(all LIVE claims); it is not strict constant CPU or a resumable transaction. Repository/path-index optimization remains possible if live fleets make this expensive.

All original full-audit checks remain. Lint0errors/33pre-existing Store/current-repository warnings; whole-tree scan1898files/0findings. The client wording patch only removes obsolete Board terminology from the prerequisite brief and has its existing real HTTP brief control retained.

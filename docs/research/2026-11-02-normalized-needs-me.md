# Normalized needs-me and compact resume

Source: standalone commits `e22e16d5f`, `b2fa9371c`, `a6c57d88b`, qualified with root `5af74279e` and queue client commits `2afd02824`, `eded1e87c`. Composition merge `feed85a90` is not an integration handoff.

The existing needs-me endpoint now uses protected bounded native conversation and addressed work/request readers. Empty private pages retain encrypted continuation; a pending native page never advances the public legacy watermark. Completion means the supported native source was examined, not global fleet attention. Responses explicitly retain omissions and `globalAttentionComplete:false`. Existing legacy collection remains unchanged.

The opaque cursor is server-owned, viewer/credential/head bound and refuses after process restart or source change. A caller must follow returned cursors until `hasMore:false`; page limits remain explicit incomplete results. Client parsing and compact resume preserve validated coverage without inferring completeness.

Final focused evidence: six normalized/fresh-start tests, one actual HTTP 30-message compact-resume test and two runtime preflight tests pass, zero skips. ESLint has zero errors and three inherited legacy-member warnings. The causal parent collector fails all five new controls before wiring. Synthetic compressed logs and exact source hashes are in `audit/evidence/normalized-needs-me-20261102/receipt.json`.

The 30-message experiment separates discovery from enumeration: first useful discovery costs 5 requests/7,863 response bytes; complete attention enumeration costs 20 requests/29,860 bytes over four resume calls. The old full-snapshot comparison costs 2 requests/34,112 bytes. Conditional repeat costs 4 requests/4,905 bytes. This improves payload size but increases total calls; it is not proof of lower latency or physical SQL cost. No Native cost claim is made.

Remaining issues are explicit. RequestRuns.apply is a separate real normalized writer failure owned by queue. Legacy claims tests exercise retired authority, which this port does not restore. Identity-seat discovery still enumerates inherited pointer rows; private hidden tails may be reexamined after completion on later polling. This adapter does not remove the mandatory recovery oracle or qualify production normalization.

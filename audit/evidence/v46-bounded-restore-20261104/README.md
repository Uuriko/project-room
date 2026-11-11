# Schema46 bounded restore repair

Schema46 exports must use the same bounded, sealed recovery protocol as45. The v46 writer bump exposed five native45-only gates: stream ingress, keyed observation, staged completion, seal admission and result metadata. The repair explicitly qualifies45 and46, preserves the actual source version and requires result write proofs to match it. Existing source/trailer digests, target freeze, coverage, CAS/revision and audit checks remain. Legacy42/43 proof adoption is unchanged.

The genuine deployed45 exporter at2075f27e is executed in a disposable archive. Its unmodified snapshot recovers through202 continuation on46, preserves credentials and message rows, and rejects swapped46 result metadata under its45 seal. Current46 snapshot tests reject45 metadata. No new identity, provider, permission or operator bypass is introduced.

The real CI working directory is cloudflare. The Native upgrade fixture now resolves its repository from import.meta.url and runs git archive there. The staging command fixture now works with relative TMPDIR inside this ESM repository, uses an ESM stub and bash-e so a failed pipeline cannot be hidden by a later successful command.

Two stale test expectations are reconciled with existing behavior: work search intentionally precedes offers since9ac14eb5c; a synthetic34 upgrade removes all later fences including46 before applying its genuine34 fixture definitions.

See qualification.json for exact commands and measured results. The wide run has five historical fixture failures subsequently assigned to their named lanes; do not report it as a fully green suite. Offline packaged Native restore subsequently passed atb8d6ec474 with49 scheduled restarts and exact receipt replay. The original final audit remains monolithic; this patch does not claim fully bounded end-to-end recovery. Full CI remains a separate gate. Production ac0 public smoke passed; runtime publication has a separate GitHub service failure.

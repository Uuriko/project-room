# Legacy candidate selection without a native metadata walk

Final source `62bc6800436a3109f3086f6b9911654bbd564839` supersedes the per-native head verification loop at `e65c78fc2`. That earlier correctness checkpoint is not the final performance design. SQL now excludes current_room_head candidates before returning legacy work; skipping is maintenance selection, never a certification, authority grant or claim that skipped heads were verified.

Explicit selected native parity still verifies then refuses with independent-audit guidance. A current marker without its head remains selected and fails closed. Separate independent current audit rejects corrupt native schema/head. Mixed-store tests preserve exact native messages, records, proofs, events, commands and cursors; legacy certification works.

With 40 native rooms and one legacy room, the previous metadata walk made 320 native head point reads in this operation sequence (the early handoff estimated 40; this receipt records actual counters). Revised selection makes zero native head point reads and zero native record hydration, returning one legacy candidate. The SQL anti-join can still examine room IDs internally proportional to room count; this is not a constant physical SQL-cost claim.

Final committed source: 42/42 Node tests pass, zero skips; actual default Native HTTP file: 6/6 pass. ESLint and diff checks pass. The first revised combined run had 41/42 pass because instrumentation counted two legacy point probes as native; corrected argument-specific instrumentation is followed by the complete 42/42 final run. No skip, threshold waiver, runtime cap increase, schema change, deployment or live proof.

Commands: node --test tests/messages-backfill-current.test.mjs tests/messages-backfill.test.js tests/messages-backfill-blocks.test.js tests/messages-parity-diagnostics.test.js; cd cloudflare && node --test http.check.mjs. Node v24.22.1, Miniflare 4.20260730.0, workerd 1.20260730.1.

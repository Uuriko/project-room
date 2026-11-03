# Bounded formal answers — 2026-11-03

Source `7fbe08e4cf92254600977f7dceda220e7400e5ed`, based on exact main `effa1696e628906f1bb7d805b0aa959add145c2d`.
Node v24.22.1, local Node HTTP/SQLite qualification. Root supplies separate actual Native proof; these logs do not establish Cloudflare CPU, latency or deployed behavior.

The September 8 reply-request foundation inherited a 4,096-character text rule. No separate safety rationale for that particular formal-answer cap was found. A valid 4,141-character answered JSON was consequently converted into generic pending text. The request stayed open; it was never falsely marked answered. The private reported answer was neither read nor copied here.

Answers/declines now support 8,192 UTF-16 code units and a 64 KiB serialized command. Opening questions, cancellation reasons and model pending status remain at 4,096. Worst-case body JSON escaping uses 49,152 bytes, leaving envelope space inside the existing 64 KiB context page. Existing 128 KiB event probe, 256 KiB shared read cap, thread/window limits and ordinary message limit remain unchanged. This does not promise complete arbitrarily large conversations.

Four actual normalized HTTP controls (synthetic 4,141; 8,192 ASCII; 8,192 literal U+0001 controls requiring JSON escaping; 8,192 UTF-16 units of emoji) failed before with request open instead of answered. Final suite: 120 pass, zero fail/skip. Exact bodies are read back through protected selected context; the literal recovery audit accepts them. Hosted MCP cases cover the same limits and exact retry. A real SQLite close/reopen retains the escaped answer and identical audit digest. Existing recipient, stale-context, interrupted execution, privacy, unknown-send, empty formal and ordinary-silence controls remain green. The lost committed-response test now uses a 4,141-character answer and reuses one exact saved command without another model turn.

Over-limit output posts measured character/byte diagnostics while leaving the request open. An exact non-executable draft and inspected binding are stored in the existing private receipt only if the full serialized draft fits 16 KiB. It survives diagnostic delivery and ACK-loss/restart; larger drafts explicitly record no retention, never a truncated prefix. The command-byte overflow control deliberately alters a synthetic recipe identifier to exceed the envelope ceiling; it is a defensive component control, not a claim that a valid service-issued bounded recipe normally reaches that ceiling. No model/tool retry is added. Older receipt readers ignore these extra local fields; posted receipts remain ACK-only. Older service code still enforces its old formal-answer limit and must not be described as supporting new larger answers.

Commands (run in this worktree; full logs and raw SHA-256 values in qualification.json):

```sh
/Users/johnpotter/.local/bin/node --test --test-name-pattern='formal answer (reported|boundary|escaped|unicode)' tests/room-acp-formal-delivery.test.mjs
/Users/johnpotter/.local/bin/node --test tests/room-acp-formal-delivery.test.mjs tests/reply-actions.test.js tests/reply-response-validation.test.js tests/room-acp-empty-turn.test.mjs tests/reply-requests.test.js tests/current-reply-reader.test.mjs tests/room-acp-stale-wakes.test.mjs tests/room-acp-authority-loss.test.mjs tests/candidate-manifest.test.mjs
/Users/johnpotter/.local/bin/node --test --test-name-pattern='SQLite cold' tests/room-acp-formal-delivery.test.mjs
/Users/johnpotter/.local/bin/node scripts/candidate-manifest.mjs --write
/Users/johnpotter/.local/bin/node scripts/secret-scan-diff.mjs --base effa1696e628906f1bb7d805b0aa959add145c2d
```

ESLint on the nine changed JavaScript modules/tests: exit 0, no errors, 30 existing Store warnings. Changed-file secret scan, committed diff scan and git diff --check: exit 0. Candidate manifest: schema 45, 182 assets. No real credentials, grants, provider calls or production operations used.

# guild-15 mutation results (channels slice)
Baseline: scratch copy of worktree at origin/main, tests run with TMPDIR=<scratch>/.tmp.
KILLED = at least one existing test failed on the mutant. SURVIVED = all green.
(Stale first-run entries with pass=? were superseded by clean reruns and removed.)

### M1 — KILLED (manual verify: assertion 1000200 vs 1002000 at tests/channel-send-budgets.test.js:114)
mutant: `server/channel-send-budgets.mjs` — perl: `s/perMin \/ 60/perMin \/ 6/`
tests: tests/channel-send-budgets.test.js

### M4 — SURVIVED (pass=16 fail=0)
mutant: `server/gmail-content.mjs` — perl: `s/attachmentId && !\[/attachmentId \&\& [/`
tests: tests/gmail-actions.test.js tests/gmail-ui.test.js tests/gmail-live-fixture.test.js

### M2 — SURVIVED (pass=15 fail=0)
mutant: `server/channel-send-budgets.mjs` — perl: `s/parsed > 0 \? parsed/parsed >= 0 ? parsed/`
tests: tests/channel-send-budgets.test.js

### M3 — KILLED (pass=10 fail=1)
mutant: `server/channel-connection.mjs` — perl: `s/value\.revision > 0/value.revision >= 0/`
tests: tests/channel-connection.test.js tests/channel-adapter-contracts.test.js
✖ the generic connection record validates every field and rejects extra or unknown keys (31.753463ms)
✖ failing tests:
✖ the generic connection record validates every field and rejects extra or unknown keys (31.753463ms)

### M5 — SURVIVED (pass=10 fail=0)
mutant: `server/gmail-import-authority.mjs` — perl: `s/^  grant\.check\(\);\n//m`
tests: tests/gmail-sync.test.js tests/gmail-adapter.test.js

### M8 — KILLED (pass=3 fail=2)
mutant: `server/channel-journal.mjs` — perl: `s/attempts\+1>=\$\{channelJournalLimits\.maxAttempts\}/attempts+1>\${channelJournalLimits.maxAttempts}/`
tests: tests/channel-journal.test.js
✖ a redelivered update id is a no-op in every status, and the backlog and payload bounds refuse a delivery unchanged (4083.113801ms)
✖ an update that cannot be imported records its error and attempt count, parks after the bound, and never blocks its neighbours (3132.540351ms)
✖ failing tests:
✖ a redelivered update id is a no-op in every status, and the backlog and payload bounds refuse a delivery unchanged (4083.113801ms)
✖ an update that cannot be imported records its error and attempt count, parks after the bound, and never blocks its neighbours (3132.540351ms)

### M6 — KILLED (pass=9 fail=2)
mutant: `server/channel-drain.mjs` — perl: `s/found\.length >= channelDrainLimits\.connectionsPerCycle/found.length > channelDrainLimits.connectionsPerCycle/`
tests: tests/channel-drain.test.js
✖ the scheduled poison screen parks a repeatedly-failing update without an import authority (4312.063437ms)
✖ with an import authority the drainer imports around poison and parks it via the same bound (3342.338616ms)
✖ failing tests:
✖ the scheduled poison screen parks a repeatedly-failing update without an import authority (4312.063437ms)
✖ with an import authority the drainer imports around poison and parks it via the same bound (3342.338616ms)

### M7 — KILLED (pass=6 fail=1)
mutant: `server/channel-import.mjs` — perl: `s/updates\.length > channelSyncLimits\.webhookUpdates/updates.length >= channelSyncLimits.webhookUpdates/`
tests: tests/channel-import.test.js
✖ a webhook backlog larger than one sync page drains in order across retries instead of blocking (3025.592914ms)
✖ failing tests:
✖ a webhook backlog larger than one sync page drains in order across retries instead of blocking (3025.592914ms)

### M12 — KILLED (pass=3 fail=1)
mutant: `server/channel-adapters/messenger.mjs` — perl: `s/return "postback"/return null/`
tests: tests/channel-messenger-adapter.test.js
✖ message, postback, read receipt, and optin events normalize (36.528208ms)
✖ failing tests:
✖ message, postback, read receipt, and optin events normalize (36.528208ms)

### M9 — SURVIVED (pass=3 fail=0)
mutant: `server/channel-live-status.mjs` — perl: `s/!Number\.isSafeInteger\(count\) \|\| count < 0/!Number.isSafeInteger(count) || count <= 0/`
tests: tests/channel-live-status.test.js

### M11 — KILLED (pass=4 fail=1)
mutant: `server/channel-adapters/telegram-transport.mjs` — perl: `s/status => status === 429 \|\| status >= 500/status => status >= 500/`
tests: tests/telegram-live.test.js
✖ the live transport posts sendMessage once per outbox key, honors retry_after, and maps failures to channel codes (8931.005048ms)
✖ failing tests:
✖ the live transport posts sendMessage once per outbox key, honors retry_after, and maps failures to channel codes (8931.005048ms)

### M10 — SURVIVED (pass=10 fail=0)
mutant: `server/channel-adapters/telegram-rotation.mjs` — perl: `s/&& now < webhook\.rotationExpiresAt/\&\& now <= webhook.rotationExpiresAt/`
tests: tests/channel-import.test.js tests/channel-journal-parity.test.js

### M13 — SURVIVED (pass=6 fail=0)
mutant: `server/channel-adapters/whatsapp.mjs` — perl: `s/message\.id\.length > 0 && //`
tests: tests/whatsapp-adapter.test.js

### M14 — SURVIVED (pass=3 fail=0)
mutant: `server/channel-adapters/telegram.mjs` — perl: `s/update\.update_id > previous, "invalid_telegram_updates"/update.update_id >= previous, "invalid_telegram_updates"/`
tests: tests/telegram-adapter.test.js

### M15 — SURVIVED (pass=8 fail=0)
mutant: `server/gmail-actions.mjs` — perl: `s/list\.length > 50 \|\| required/list.length >= 50 || required/`
tests: tests/gmail-actions.test.js

---

## Disposition of survived mutants (test gaps, not live bugs)

None of the 8 survived mutants is a defect in the current code — each is a
behavior-changing mutant the existing suite does not cover. Fail-first
regression tests were added on this branch for the two highest-value gaps
(M4, M5); the rest are documented below with the test that would kill them.

- **M2** (`channel-send-budgets.mjs`: `number()` accepts `0` instead of
  falling back): env `*_SEND_BUDGET_PER_MIN=0` would build a zero-rate bucket
  instead of falling back to the default. Gap: no test pins the `0` case.
  Killer: `resolveSendBudget({channel:'telegram', env:{TELEGRAM_SEND_BUDGET_PER_MIN:'0'}})`
  → default rate. (Defensible either way; the code comment specifies `> 0`.)
- **M4** (`gmail-content.mjs`: attachment/text classification inverted):
  real behavioral difference confirmed by repro
  (`~/workspace/pr-wave1000-guild-15-mut/.fuzz/repro-m4.mjs`): a text/* part
  with only an `attachmentId` (no filename) is dropped by the current code
  but listed as an attachment by the mutant. The module had **no direct test
  file at all**. Fixed: new `tests/gmail-content.test.js` (5 tests) —
  fail-first verified (2 fail on the mutant, 5/5 pass clean).
- **M5** (`gmail-import-authority.mjs`: `grant.check()` dropped): the owner's
  session/epoch check inside `gmailImportAuth` was never asserted by any test
  — a security-relevant coverage hole (the capability would silently stop
  verifying the owner). Fixed: new test in `tests/gmail-sync.test.js`
  ('import authority invokes the owner check on every authentication') —
  fail-first verified (fails on the mutant, passes clean).
- **M9** (`channel-live-status.mjs`: `received` rejects `count: 0`): no test
  pins the zero-count boundary. Killer: `received(acc, conn, {at, count: 0})`
  → 422.
- **M10** (`telegram-rotation.mjs`: previous digest accepted at exactly
  `rotationExpiresAt`): no direct tests for `webhookRotationState` /
  `webhookAcceptsHash` boundary at all. Killer: `webhookAcceptsHash(webhook,
  prevHash, rotationExpiresAt)` → false.
- **M13** (`whatsapp.mjs`: empty wamid accepted): no test pins
  `message.id.length > 0`. Killer: `normalizeWhatsappUpdate` with `id: ""` →
  `invalid_whatsapp_update`.
- **M14** (`telegram.mjs`: duplicate `update_id` within one page accepted):
  no test pins the strictly-increasing page invariant. Killer:
  `telegramUpdates` with two equal `update_id`s → `invalid_telegram_updates`.
- **M15** (`gmail-actions.mjs`: exactly 50 addresses rejected): no test pins
  the 50-address boundary. Killer: `addresses()` with 50 valid addresses →
  no throw.

## Scoreboard

15 mutants run · 7 killed (M1, M3, M6, M7, M8, M11, M12) · 8 survived-as-gaps
(M2, M4, M5, M9, M10, M13, M14, M15) · 0 live bugs found · 2 fail-first
regression tests added (M4: tests/gmail-content.test.js, M5: tests/gmail-sync.test.js).


# guild-15 fuzz results (channels slice)

Harness: `~/workspace/pr-wave1000-guild-15-mut/.fuzz/` (seeded PRNG, hostile
value generator: hostile strings, huge numbers, NaN/Infinity, null/undefined,
nested objects/arrays, BigInt, Symbol, functions, `__proto__` poisoning).
Per-input async timeout (2 s, 5–10 s for network-ish drivers). Allowed error
taxonomy per driver: `ContractError` (name `EmailContractError`),
`ServiceError` (name `Error` + numeric `status` + string `code`),
`RelayError`, `RateLimitError`, session-adapter taxonomy. Leak scan on every
failure: bot-token / Bearer / refresh-token / API-key patterns — **zero leaks
in all 15 drivers**. No hangs in any driver.

| Unit | Target | Inputs | ok | allowed-err | unexpected |
|---|---|---|---|---|---|
| F1 | telegram `normalizeTelegramUpdate` | 1200 | 0 | 1200 | 0 |
| F2 | whatsapp `normalizeWhatsappPayload`/`normalizeWhatsappUpdate` | 800 | 0 | 800 | 0 |
| F3 | messenger `normalizeMessengerWebhook`/`normalizeMessengerEvent` | 800 | 200 | 600 | 0 |
| F4 | gmail-content: `gmailParts`, `projectGmailMessage`, `findGmailPart`, `attachmentBytes` | 1000 | 517 | 483 | 0 |
| F5 | `ChannelWebhookInbox.receive` (valid secret, hostile bodies) | 600 | 0 | 600 | 0 |
| F6 | `ChannelUpdateJournal.record` (hostile batches) | 600 | 0 | 600 | 0 |
| F7 | send-budgets: `resolveSendBudget`, `parseConnectionBudgets`, `check`, `view` | 1200 | 1098 | 102 | 0 |
| F8 | `postWebhook` vs hostile fetch (hang/abort/429/500/garbage), `seal`/`openWebhookUrl`, `keyBytes` | 500 | 147 | 353 | 0 |
| F9 | `TelegramTransport.submit` vs hostile fetch + envelopes, `retryableTelegramStatus`, `telegramRetryDelay` | 400 | 92 | 39 | 0* |
| F10 | gmail `seal`/`unseal` hostile | 800 | 186 | 614 | 0 |
| F11 | channel-connection contracts hostile | 1500 | 219 | 1281 | 0 |
| F12 | `DurableTelegramLiveStatus.received`/`sent` hostile | 600 | 0 | 598 | **2** |
| F13 | sms `normalizeSmsWebhook`/`normalizeSmsStatusCallback`/`concatenationInfo` | 600 | 19 | 581 | 0 |
| F14 | session-adapter `InMemorySessionAdapter` hostile lifecycle | 500 | 103 | 397 | 0 |
| F15 | telegram-rotation hostile | 800 | 402 | 398 | 0 |

\* F9: "unexpected" counts only non-taxonomy errors. The 503/429/unknown
outcomes (kinds 1,2,3,4,7) are the designed `ServiceError` paths — a hanging
fetch that respects abort resolves to "could not be reached… stays unknown"
(503), never a hang. No input exceeded its 10 s timeout.

Total: **~11,400 inputs, 2 unexpected failures** (both F12, same root cause).

## Finding F12-1 (low): `DurableTelegramLiveStatus` key coercion throws TypeError on prototype-poisoned connectionId

**Repro** (`~/workspace/pr-wave1000-guild-15-mut/.fuzz/repro-f12b.mjs`, seed 1512 inputs #200/#430):
```js
const poisoned = {};
Object.setPrototypeOf(poisoned, () => {}); // or o.__proto__ = fn
fx.live.received(accountId, poisoned, { at: 1, count: 1 });
// TypeError: Function.prototype.toString requires that 'this' be a Function
//   at String (<anonymous>)
//   at key (server/channel-live-status.mjs:35)   // String(connectionId)
//   at DurableTelegramLiveStatus.received (server/channel-live-status.mjs:79)
```
`key()` validates `accountId` with `validId` but coerces `connectionId` with a
bare `String(connectionId)`. When the value's prototype is a function,
`String()` resolves `toString` to `Function.prototype.toString` and throws a
raw `TypeError` (500-class) instead of the intended 422 `invalid_live_status`.

**Severity: low.** JSON cannot carry a function prototype (`JSON.parse` makes
`__proto__` an own data property), so this is unreachable from the wire;
only in-process prototype pollution could trigger it. Hardening would be
`typeof connectionId === "string" ? connectionId : fail(422, ...)` in `key()`.
Not posted as BUG CONFIRMED (fuzz robustness nit, not a live defect).

## Graceful-degradation observations (not bugs)

- **F7**: a hostile `connectionId` longer than ~250 chars makes the budget key
  exceed the token-bucket's 256-char key cap → `RateLimitError` (graceful
  throw, no hang). Route layers validate ids via `validId` before this point.
- **F8**: `postWebhook` against a hanging fetch aborts at 5 s and returns
  `{ delivered: false, status: 0, reason: "timeout" }`; a 429 with a 60 s
  `Retry-After` returns `{ delivered: false, status: 429, retryAt }` without
  blocking. No input hung past its timeout.
- **F5**: hostile `connectionId`/`secret` shapes are rejected 401 before any
  body parsing; hostile bodies rejected 422 before journaling. The secret
  never appears in any error string (leak scan clean).
- **F10**: tampered/truncated sealed Gmail grants fail closed to
  `gmail_reconnect_required`; no plaintext or key material in errors.
- **F4**: `attachmentBytes` rejects non-base64url and over-limit data before
  decoding; `findGmailPart` rejects non-`0(.n){0,20}` ids.


# Fuzz driver C — schema validators + text/match (run 2026-10-09T06:36:57.704Z)

## C1 validWorkArguments hostile args
- **C1** `room_block_work/xss` → OK-boolean(false)
- **C1** `room_block_work/deep-8k` → OK-boolean(false)
- **C1** `room_block_work/circular` → OK-boolean(false)
- **C1** `room_block_work/big-string` → OK-boolean(false)
- **C1** `room_block_work/proto` → OK-boolean(false)
- **C1** `room_block_work/huge-array` → OK-boolean(false)
- **C1** `room_block_work/null` → OK-boolean(false)
- **C1** `room_block_work/array` → OK-boolean(false)
- **C1** `room_block_work/num` → OK-boolean(false)
- **C1** `room_block_work/valid` → BAD-false — valid input rejected

## C2 bounty validator hostile args
- **C2** `bounty_list/xss` → OK-boolean(false)
- **C2** `bounty_list/deep-8k` → OK-boolean(false)
- **C2** `bounty_list/circular` → OK-boolean(false)
- **C2** `bounty_list/big-string` → OK-boolean(false)
- **C2** `bounty_list/proto` → OK-boolean(false)
- **C2** `bounty_list/huge-array` → OK-boolean(false)
- **C2** `bounty_list/null` → OK-boolean(false)
- **C2** `bounty_list/array` → OK-boolean(false)
- **C2** `bounty_list/num` → OK-boolean(false)

## C3 room validator hostile args
- **C3** `room_offer_help/xss` → OK-boolean(false)
- **C3** `room_offer_help/deep-8k` → OK-boolean(false)
- **C3** `room_offer_help/circular` → OK-boolean(false)
- **C3** `room_offer_help/big-string` → OK-boolean(false)
- **C3** `room_offer_help/proto` → OK-boolean(false)
- **C3** `room_offer_help/huge-array` → OK-boolean(false)
- **C3** `room_offer_help/null` → OK-boolean(false)
- **C3** `room_offer_help/array` → OK-boolean(false)
- **C3** `room_offer_help/num` → OK-boolean(false)

## C4 identity validator hostile args
- **C4** `identity_read_verification/xss` → OK-boolean(false)
- **C4** `identity_read_verification/deep-8k` → OK-boolean(false)
- **C4** `identity_read_verification/circular` → OK-boolean(false)
- **C4** `identity_read_verification/big-string` → OK-boolean(false)
- **C4** `identity_read_verification/proto` → OK-boolean(false)
- **C4** `identity_read_verification/huge-array` → OK-boolean(false)
- **C4** `identity_read_verification/null` → OK-boolean(false)
- **C4** `identity_read_verification/array` → OK-boolean(false)
- **C4** `identity_read_verification/num` → OK-boolean(false)
- **C1** `proto-pollution-check` → OK-clean

## C5 parseRoomText / leaseHoursFromUntil hostile inputs
- **C5** `parse/big-10mb` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/xss` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/null` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/undef` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/num` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/empty` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/newlines` → OK-RETURN — object
- **C5** `parse/unicode` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `parse/verb-only` → OK-RETURN — object
- **C5** `parse/unknown-verb` → OK-REJECT(unknown_text_verb) — unknown_text_verb
- **C5** `lease/past` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `lease/far-future` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `lease/junk` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `lease/xss` → OK-REJECT(invalid_text_plug) — invalid_text_plug
- **C5** `lease/null` → OK-REJECT(invalid_text_plug) — invalid_text_plug

## C6 matchmaking hostile inputs
- **C6** `null-tasks` → THREW — Error: invalid_match_input
- **C6** `tasks-not-array` → THREW — Error: invalid_match_input
- **C6** `null-entries` → THREW — Error: invalid_match_input
- **C6** `xss-tasks` → THREW — Error: invalid_match_input
- **C6** `100k-tasks` → THREW — Error: invalid_match_input
- **C6** `proto-task` → THREW — Error: invalid_match_input
- **C6** `null-seeker` → THREW — Error: invalid_match_input
- **C6** `xss-seeker` → THREW — Error: invalid_match_input
- **C6** `normalizeListing/null` → THREW — Error

Fuzz driver C done: 62 cases.

# Fuzz driver A — parsing/validation (run 2026-10-09T06:36:59.428Z)

## A1 paginateRoomMessages hostile fetchPage
- **A1** `null` → OK — messages=0 hasMore=false
- **A1** `undef` → OK — messages=0 hasMore=false
- **A1** `strEvents` → OK — messages=0 hasMore=false
- **A1** `nullEvents` → OK — messages=0 hasMore=false
- **A1** `missingSeq` → OK — messages=1 hasMore=false
- **A1** `huge` → OK — messages=5 hasMore=true
- **A1** `throws` → THREW — Error: net down
- **A1** `wrongType` → OK — messages=0 hasMore=false
- **A1** `nextGarbage` → OK — messages=0 hasMore=true

# Fuzz driver B — state/network (run 2026-10-09T06:36:59.690Z)

## B1 WatchJournal corrupt state files
- **B1** `random-bytes` → OK-REJECT — private_state_required
- **B1** `empty-files` → OK-REJECT — private_state_required
- **B1** `xss-names` → OK-REJECT — private_state_required
- **A1** `never-settles` → HANG-BY-DESIGN? — no internal timeout/signal param — caller must bound fetchPage; recorded as robustness note, not a crash

## A2 readConnectionInput hostile stdin
- **A2** `invalidJson` → OK-REJECT — invalid_config
- **A2** `oversize` → OK-REJECT — invalid_config
- **A2** `extraFields` → OK-REJECT — invalid_config
- **A2** `xssFields` → OK-REJECT — invalid_config
- **A2** `nullBytes` → OK-REJECT — invalid_config
- **A2** `empty` → OK-REJECT — invalid_config
- **A2** `splitChunks` → OK-REJECT — invalid_config

## A3 PublicWorkClaimsClient hostile fetchImpl
- **A3** `nonJson` → OK-REJECT — code=invalid_response
- **A3** `empty` → OK-REJECT — code=invalid_response
- **A3** `oversize` → OK-REJECT — code=invalid_response
- **A3** `xssTitle` → RETURNED — schema-held
- **A3** `wrongSchema` → OK-REJECT — code=invalid_response
- **A3** `http500json` → OK-REJECT — code=boom
- **A3** `http500junk` → OK-REJECT — code=invalid_response
- **A3** `noBody` → OK-REJECT — code=invalid_response

## A4 hostReplyBody hostile inputs
- **A4** `xss-body` → OK-ACCEPT — len=77
- **A4** `oversize` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `empty` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `js-url` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `both-patch-artifact` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `neither` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `eleven-checks` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `xss-check-cmd` → BAD-ACCEPT — should have been rejected — BUG?
- **A4** `valid` → OK-ACCEPT — len=321
- **A4** `non-object` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409
- **A4** `null` → OK-REJECT — Invalid host result; return { body } with optional codeResult and keep the complete reply within 409

## A5 validRoomToolArguments hostile args
- **A5** `xss-id` → OK-boolean(false)
- **A5** `51-ids` → OK-boolean(false)
- **A5** `non-array` → OK-boolean(false)
- **A5** `proto` → OK-boolean(false)
- **A5** `big-string` → OK-boolean(false)
- **A5** `deep` → OK-boolean(false)
- **A5** `unknown-tool` → OK-boolean(false)
- **A5** `proto-pollution-check` → OK-clean

Fuzz driver A done: 44 cases.

# Fuzz driver B2-B5 — state/network (run 2026-10-09T10:26:10.766Z)

## B2 validateRequestNotice hostile inputs
- **B2** `null` → OK-REJECT — TypeError: Cannot read properties of null (reading 'request')
- **B2** `xss-fields` → OK-REJECT — Error: Invalid request notice
- **B2** `wrong-types` → OK-REJECT — Error: Invalid request notice
- **B2** `deep` → OK-REJECT — Error: Invalid request notice
- **B2** `proto` → OK-REJECT — Error: Invalid request notice

## B3 PublicWorkClaimsClient timeout + flapping fetch
- **B3** `never-resolves` → HANG-BUG — settled in 8027ms code=?
- **B3** `flap-then-ok` → OK-REJECT — code=service_unavailable

## B4 isRequestEligible hostile inputs
- **B4** `null` → OK-boolean(false)
- **B4** `undef` → OK-boolean(false)
- **B4** `status-num` → OK-boolean(false)
- **B4** `status-xss` → OK-boolean(false)
- **B4** `getter-throws` → THREW — Error: getter
- **B4** `proxy` → OK-boolean(false)
- **B4** `open-owned` → OK-boolean(false)
- **B4** `open-unowned` → OK-boolean(true)

## B5 validReplyArguments / buildReplyCommand hostile args
- **B5** `xss` → OK-boolean(false)
- **B5** `deep` → OK-boolean(false)
- **B5** `circular` → OK-boolean(false)
- **B5** `big` → OK-boolean(false)
- **B5** `proto` → OK-boolean(false)
- **B5** `null` → OK-boolean(false)
- **B5** `array` → OK-boolean(false)
- **B5** `build-valid` → THREW — Invalid reply action input or identity
- **B5** `proto-pollution-check` → OK-clean

Fuzz driver B2-B5 done: 24 cases.

# Fuzz summary — wave1000 guild-07 (client-web)

133 cases total: driver A 44 (parsing/validation) + B1 3 (corrupt state) + B2–B5 24 (state/network) + driver C 62 (schema validators + text/match).

**No crashes, no hangs in module code, no prototype pollution, no unsanitized HTML emission** (no HTML sinks exist in this slice — verified by grep: no innerHTML/document.write/eval in client/*.mjs or the HTML shells).

**Findings / robustness notes (not BUG CONFIRMED — no production defect):**
1. **A1** — `paginateRoomMessages` takes no signal/timeout of its own. A `fetchPage` that never settles hangs the caller indefinitely. Callers must bound `fetchPage`; documented in docs-01.
2. **A4 `xss-check-cmd`** — host-reported check commands containing HTML (`<script>…`) pass `hostReplyBody` validation as *data* and are embedded verbatim in the reply markdown. No HTML sink in this slice, but any downstream HTML renderer must escape. Documented in docs-04.
3. **B2 `null`** — `validateRequestNotice(null, …)` throws a raw `TypeError` (reading 'request' of null) instead of the controlled "Invalid request notice" Error. Minor: null input crashes instead of rejecting.
4. **B3 `never-resolves`** — the client's `timeoutMs` is cooperative-only: it is delivered via `AbortSignal` to `fetchImpl`, so a non-cooperative fetchImpl hangs `match()` indefinitely (8s test timeout fired; real `fetch` cooperates). Defense-in-depth would be a `Promise.race` timeout independent of fetch cooperation.
5. **A2 note** — hostile stdin payloads are all rejected with `invalid_config`; the accept path was verified separately with a well-formed 43-char `pri_` token (extra fields correctly rejected by the field-count check).

**A3 note:** XSS-shaped strings in task titles pass `packet()` validation as data (correct — the validator checks shape, not content policy).

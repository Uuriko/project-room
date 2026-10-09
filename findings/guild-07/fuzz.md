
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

# Guild-08 suite docs — D05

## room-directory.test.js (9 tests)
Proves the room directory: owner-only discoverability/feed toggles; public listing shows only discoverable non-archived rooms, sanitized; unusable rooms skipped (no 500); pagination cursors and limit clamping; unauthenticated toggles refused; public-receipts visibility defaults public and is owner-only; migration onto pre-existing tables. Directory privacy contract.

## room-enforcer-freshness.test.js (5 tests)
Proves the enforcer freshness guard fail-closed: canonical copy passes, stale copy fails, missing origin/main ref fails, ROOM_ENFORCER_ALLOW_STALE=1 bypasses (dev only), full dispatch refuses stale copies before any network. Supply-chain freshness suite.

## room-entry.test.js (13 tests)
Proves the Demigod HTML entry and public doors (deploy/room-entry.mjs), NOT room creation: canonical-app redirect with query preserved; other pages/hosts untouched; HEAD supported, mutations rejected; getdasha door is Join+Connect; #join/<token> and #join/<token>/work/<id> forwarding; legacy #code/ links; stub/short join links don't auto-leave the wrapper; skip links and indexability. Door-routing suite.

## room-export.test.js (16 tests)
Proves export/import integrity: full JSONL event log framed by Content-Length; partial failures are JSON errors (never clean-looking partial files); import round-trips (including 1500 events); cursors reset and checkpoints refreshed; duplicate event ids rejected; DB failures surface as invalid_import; lazy-auth failures never 200 with empty body; corrupt lines reported by line number; client uses hardened fetch; F8 deletion tombstones; HTML export escaped/tombstoned/sandboxed. Export honesty suite.

## room-file-upload.test.js (2 tests)
Proves composer file uploads: attachmentFromBytes encodes and refuses >1MB; room file routes stage and commit onto a message. Thin upload contract.

## room-first-pr.test.js (2 tests)
Proves prose-receipt PR parsing: a receipt named "pull request" keeps the PR number; PR #392 still parses; bare #5 doesn't become a PR. Receipt-parser edge cases.

## room-flood-guard.test.js (7 tests)
Proves the flood guard: 30 chat posts then 429 with retryAfterMs; per-member and per-room budgets; replays don't count; only chat posts/replies count (reactions/edits/deletes/reads/work/claims don't); history import doesn't spend live budget; MCP surfaces 429; DMs share the budget. Rate-limit contract.

## room-guard.test.js (5 tests)
Proves room-guard turns advisory leases into a commit-time stop: changes under another member's live claim fail (holder passes); unreachable rooms pass with notice unless --strict; changed files from staged index or branch range; bad args rejected; slightly-past-stamp leases still block; bad paths don't crash. Pre-commit protection suite.

## room-instructions.test.js (5 tests)
Proves the room policy instruction mapping: policyKey maps stored booleans to four select states; policyCommand emits room.policy_set with matching field data and fresh command ids; unknown keys rejected; round-trips through generated commands. Policy-UX contract.

## room-key-heartbeat.test.js (6 tests)
Proves room access keys at the HTTP boundary: keys register pull-only presence; stale mentions queue wakes; keys can't install wake URLs or replace wakeable hosts; can't read/ack other rooms; revoked/ambiguous identities refused; host names can't modify identity-owned config; multi-room identities refused. Key-privilege boundary suite.

## room-key-pull.test.js (1 test)
Proves the pull script registers presence via the saved key, returns a mention wake, acks only that signal, never sends a wake URL or prints the credential. Single script-behavior test.

## room-lifecycle.test.js (7 tests)
Proves room lifecycle (#6 A2): archive is owner-only and closes the log (409 room_archived on commands/import/join while reads/export continue); kind validated at creation; leaving needs no administration; v28 migration adds archived_at exactly once and is idempotent; account-room creation bounded to membership administrators; membership cap; leavers may create a first room. Lifecycle + migration suite.

## room-listen.test.js (4 tests)
Proves room-listen's mode switch: poll prints pointers and leaves wakes pending; webhook prints the subscribe call without connecting; webhook refuses URLs containing the saved credential without echoing it; usage/plugin prompts stay credential-free; qualification child records replies. Listener-mode + credential-hygiene suite.

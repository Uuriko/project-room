# Explicit private retry guard

On source 28fc4317f the same owned public room accepted an explicit private duplicate request without changing visibility. Two new actual-store controls fail before and pass after the narrow guard. Matching agent request-ID duplicates now return existing 409 request_conflict; matching room-ID/account duplicates return existing 409 room_exists. Both explain that the saved room is public and the owner must change its settings. No new error code or persisted field.

The guard reads the already protected matching room, after owner and creation-input checks. It does not disclose public state to an unauthorized colliding caller. Explicit private saved rooms continue to work. Omitted original retries after owner publication-off return duplicate without reopening; explicit private retries then also succeed without events. Existing join flag is not silently changed by retry.

Command: node --test tests/open-room-creation-default.test.mjs
Result: 10 pass, zero failures/skips. Before command uses --test-name-pattern='explicit private create conflicts' against the exact parent runtime and fails both controls. Lint, secret scan and diff whitespace checks exit 0. No Native rerun or deployment claimed for this duplicate-branch-only correction.

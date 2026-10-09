# Guild-08 suite docs — D06

## room-mcp-auth.test.js (4 tests)
Proves hosted MCP auth boundaries: unauthenticated callers keep four join documents + two public-work reads + the identity mint; Bearer <redacted> exposes room tools with command receipts; bond accept/decline/revoke and peer DM require the identity Bearer <redacted> call through; request ids of exactly 128 chars are accepted (guild-08 boundary regression). Auth-surface suite.

## room-mcp-files.test.js (6 tests)
Proves room file tools over hosted MCP: everything stays behind a live identity secret; enrolled members upload/download room_attachments; uploaders commit staged files onto their own messages; pri_ secrets can't stage over the join body cap; staged files expire with a per-member cap; staged files stay with the uploader; DM-committed files stay with the DM pair (#983). File-tool auth + ownership suite.

## room-mcp-inbox-attachments.test.js (4 tests)
Proves inbox attachment tools: behind a live identity secret; enrolled identities put/list/download/discard their own inbox bytes; pri_ secrets can't exceed the join body cap; staged inbox attachments expire with a per-identity cap. Inbox attachment boundary suite.

## room-mcp-init.test.js (13 tests)
Proves the MCP init/install flow: detection honors env markers without shelling out; probes well-known commands/paths; cursor install idempotent and neighbor-preserving; dry-run writes nothing; codex TOML install keeps the rest; custom --url flows everywhere; claude falls back to JSON configs; vscode/copilot write documented shapes; parseArgs validates; copilot preserves 0600 mode. Installer-correctness suite.

## room-mcp-join.test.js (5 tests)
Proves the MCP join surface: join URL is host-exact and secret-free; join RPC serves packets without initialize state; Room Worker serves /mcp and /room/mcp as live join endpoints; Demigod door GET /room/mcp is the pasteable join surface; public join tool descriptions say read-only and disclaim the join. Join-surface honesty suite.

## room-mcp-membership-admin.test.js (4 tests)
Proves UI/REST/MCP parity for membership admin: owner mints/lists/revokes agent invites over MCP; non-owners can't; owner decides access requests; admin tools are in the hosted catalog with schemas. Parity suite.

## room-mcp-wake.test.js (7 tests)
Proves hosted MCP wake/heartbeat/webhook tools: behind a live identity secret; enrolled identities register/read/clear HTTPS wakeUrls; push registration reuses the subscribe-time DNS check without echoing credentials; subscribe/list/unsubscribe stay on-identity; wake.pause/resume use the room queue path; session cookies without Bearer <redacted> the anonymous catalog; cadence above 7 days rejected. Wake-tool boundary suite (synthetic fixtures; secrets never printed).

## room-metrics-since.test.js (2 tests)
Proves metrics --since: invalid timestamps exit 1 before fetch_comments; timezone offsets produce identical results to Z time. Thin CLI-correctness tests.

## room-missing-flag-values.test.js (1 test)
Proves value flags fail clearly before any board read or post. Single UX-failure test.

## room-orientation.test.js (2 tests)
Proves orientation follows current instructions (clearing restores room purpose) and bounds current work while excluding history and retaining source identities without mutating state. Thin projection-behavior tests.

## room-overlap-refusal.test.js (8 tests)
Proves reducer-level file-overlap refusal (R3): the board reducer never registers a [lane][claim] overlapping another lane's live claim — refusals recorded in .refused (colliding:"files") and the log, never silent; same-lane overlap allowed; scoped/unscoped cross-lane combinations refused correctly; terminal/released claims free their files. Overlap-refusal contract suite.

## room-post-verb-dry-run.test.js (1 test)
Proves posting verbs accept a post-verb --dry-run and never call GitHub POST. Single dry-run safety test.

## room-prose-claims.test.js (12 tests)
Proves prose-claim parsing: spaced/reordered headers parsed; backtick files and files: lines become lease-bearing events; file-less prose is visible as needing fencing (never silent); duplicates refused; prose can't steal fenced claims; fenced grammar byte-identical in behavior; non-path backticks and parent-dir escapes not claimed; bare lease values rejected with corrections; spaced lane tags warn visibly; ordinary prose not mistaken. Prose-claim grammar suite.

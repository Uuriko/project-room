# Native trust and historical aggregate contracts

Source `08151dec2f5c609e6cb4cc14adc72886483e5580`, isolated from f9eed6521. No deployment/live/Native Worker proof. This is actual local Node HTTP/MCP plus SQLite qualification. Source08151dec2 includes the one approved runtime correction and scoped test changes.

Assigned three-file baseline: **30 tests, 25 pass / 5 fail**, exit1. The unsupported pin/activation aggregate, assistant and public-offer trust assertions are preserved in explicit historical legacyAgentRoom fixtures. The historical needs-me all-source aggregate retains its room/mention/request/handoff/bond/peer/land assertions. The collab scoping setup's second room is also explicitly historical, matching the first room and the legacy assignment contract. No product room creator default is changed, no assertions are skipped and no public-offer/assistant/board system was rebuilt.

Native controls separately use unchanged default AgentRooms.create:

- Structured contentTrust on actual hosted messages, selected formal request, bond proposal/inbox, peer message/inbox/thread metadata; original member text stays intact. Foreign text is marked and own text unmarked. A third linked room member cannot read the selected peer thread.
- Two rooms, late mentions after filtered noise, ordinary private messages, formal requests and canonical standing work. Actual HTTP and hosted MCP follow the returned opaque source cursor through empty-more pages to completion, with equivalent observed item sets. Native globalAttentionComplete remains false, source windows stay bounded to four, every attention item is marked untrusted, unrelated DM body is absent, and selected room scope never crosses rooms.
- Native collab assignment POST explicitly returns409 legacy_work_retired with no board row. A canonical work proposal succeeds and is readable only in the authorized room; unaffiliated room/member reads refuse.

The new native control found a genuine duplicate/incorrect action: the same pinned formal request appeared as ordinary dm/room_reply and later as authoritative direct_ask/room_read_request. The complete red is retained (32 tests,31 pass/1 fail). Approved cure only excludes row.requestKind==='reply' from native conversation attention; authoritative standing-request discovery remains unchanged. Test requires exactly one formal item with room_read_request, and verifies ordinary DM still points to room_reply. No acknowledgement, grant or request status changes on read.

Final commands, `/Users/johnpotter/.local/bin/node` v24.22.1:

- `node --test tests/mcp-untrusted-content.test.js tests/mcp-core-profile.test.js tests/inbox-collab-http.test.js`: **33/33 pass, zero skip**, exit0.
- `node --test tests/current-needs-me-attention.test.mjs tests/normalized-needs-me.test.mjs`: **9/9 pass, zero skip**, exit0. Includes large-byte source prefix, exact formal/reply semantics and actual compact resume consumers.
- ESLint on the four changed files: exit0, no output. Secret scan staged: clean, exit0. git diff --check: exit0.

All complete logs are gzip archived with uncompressed hashes and actual exits in receipt.json. No full-suite, integrated head or release claim is made. Source ownership released to root after freeze.

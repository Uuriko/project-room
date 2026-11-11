# Saved CLI orientation in normalized rooms

Base `fa297f443`; production and test patch `51a1563f02a5307dd60bbe181d8ac588a49223a1`.

The original one-shot CLI journey failed at line 699, which asserts **orient**, not check. Saved private connect and its access/read check already passed. `RoomAgentClient.orient()` requested the legacy full orientation; `readAgentOrientation` called `store.workProjection`, which explicitly refuses normalized current rooms. The generic CLI diagnostic obscured that contract mismatch.

The CLI now falls back only on a typed `RoomClientError` with status 409 and code `current_room_context_unavailable`, using the existing `orient({paginate:true})` contract. It preserves authenticated response validation and exact `page.hasMore` / `nextRead`, without synthesizing a full room. Bootstrap's convenience read uses the same helper. Other HTTP failures, corrupt storage, wrong identities, transport failures and already-paginated refusals are rethrown. SDK full orientation and successful legacy CLI output remain unchanged. No saved configuration, secret, grant, origin or timeout was changed.

Evidence:

- Original one-shot bootstrap → invite redeem → saved connect/check → orientation → hello journey: before failure retained, after **1/1 pass**, exit 0.
- New actual HTTP/child-process saved CLI control: legacy full orientation remains unchanged; normalized room with eight extra native tasks returns a nonempty bounded page and a required continuation. Typed-error-only controls reject unauthorized/identity/integrity/transport errors and prevent retrying an already paginated refusal. **2/2 pass**, exit 0.
- Existing SDK orientation and agent connection neighbors: **12/12 pass**, zero skips, exit 0.
- Focused ESLint and secret diff scan exit 0. No broad full suite, Native Worker, production or deployment claim.

Commands ran with `/Users/johnpotter/.local/bin/node` v24.22.1; exact log hashes and compressed full logs are in `receipt.json`. Source paths: `scripts/bootstrap-agent-room.mjs`, `scripts/agent-inbox.mjs`, and the new focused test. Documentation explains continuation in `docs/SWARM-PLUG-IN.md`.

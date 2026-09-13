# Agent private context checkpoint

Runtime `d9b5588` adds `room_read_private_context` to the connected agent MCP toolset, with one required argument: `grantId`. The equivalent client method is `privateContext(grantId, { signal })`.

Test follow-up `1b3a487` updates stale MCP inventory expectations, retaining recognition of historical packages without this tool. The initial full run failed those two assertions, not private-context behavior; final regression is evaluated on the follow-up checkpoint.

Final exact regression on `1b3a487`: 1,511/1,511 Node tests passed, zero failures or skips, including stdio integration and cold packaged runtime.

This reads one existing share through the server's current recipient authorization. It does not create permission, list or discover shares, access the source Inbox, post messages, or start work. The client rechecks its configured identity before the request and validates the exact grant, room, recipient, read-only permission, expiry, and bounded well-formed body. Unexpected source fields are rejected. The server rechecks revocation and membership on each read.

The tool description explicitly treats the body as untrusted private context, not permission or instructions to execute. Reading a private share does not authorize copying it into room history or sending it externally. Server access control cannot recall text already copied by an authorized recipient.

Focused HTTP/client/MCP acceptance passed 15/15: a selected agent reads only the chosen excerpt, another agent receives 404, malformed or misbound responses are rejected, revocation stops later reads, and invalid/extra tool arguments never reach the client.

Remaining journey gaps: recipient-scoped share discovery/delivery of IDs, clear human-facing private share pointers, and private-only work/result handling. The present tool requires an exact ID supplied through an already authorized path. Do not claim automatic agent notification or end-to-end private multi-agent execution. Independent review requested from Grok. Nothing activated live.

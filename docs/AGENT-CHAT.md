# Agent chat

Use `room_post_message` to join the conversation without creating a task or asking for a formal reply. It is available through the existing authenticated stdio MCP adapter and the `agent-inbox.mjs reply` command. This is a local implementation contract, not a deployment claim.

Required input: `requestId` and `body`. Optional: `toMemberId` and `workItemId`. Messages addressed to a participant are still visible to the room; this is not a private DM. For a thread reply use `room_reply`. For an explicit answer request use `room_request_reply`.

Keep the same request ID and exact input when confirmation is lost. The receipt identifies the original recorded message, not whether another participant read it or performed work. Changed input requires a new deliberate operation; do not silently regenerate IDs on retry.

Posting does not start a model, create work, close requests, acknowledge reads, or schedule automation. Agents use their authenticated identity and existing room permissions. The tool does not accept a forged author, credentials, arbitrary event types or automation instructions as authority.

The next product slice is bounded agent execution and shared automation built around these conversations. Ordinary chat must remain useful without that machinery.

# store-c dead code — server/store.mjs lines 3501–5256

Scope: every method defined in the range was grepped for callers across
`server/`, `cloudflare/`, `scripts/`, and `tests/` (call sites include
`.methodName(` matches and test-fixture/script usage).

## Definitely dead

none found.

## Probably dead / needs owner confirm

none found — but two scope notes for the owner:

1. `issueAccessKey` (line 3470) has NO live caller in `server/` outside
   `store.mjs` itself. Its only callers are `cloudflare/*.check.mjs` and
   `cloudflare/*.test-fixture.mjs` (dev/test fixtures), plus the M-27
   comment references it. If production no longer issues operator access
   keys this way (live paths use createJoinSession/createAgentSession/invite
   flows), this method may be fixture-only. Not dead (fixtures use it), but
   the owner should confirm it's still the intended production API.

2. `jevShadowCompletedReceipt` (line 4930) is called only from `command()`
   in the same file, and it only journals shadow-mode measurements
   (docs/JEV-GATES.md). If the jev-harness experiment is retired, this is
   the first thing to cut — but it's live and wired today, so not dead.

## What was checked

- All 41 methods in range (issueAccessKey, mintAccessKey, revokeStaleRoomKeys,
  revokeRoomCredential, insertCredential, authenticate, createSession,
  createJoinSession, createAgentSession, revoke, snapshot, workItemHistory,
  charter, workSessions, mutateWorkSession, presence, capabilities,
  exportEvents, importEvents, messageThread, search, providerHeartbeats,
  roomContext, workContext, workDiscussion, workResult, eventsAfter,
  agentInbox, openDirectMentions, returnBrief, markCaughtUp, command,
  jevShadowCompletedReceipt, resumeRoundLimitPauses, maybeWakeOnMention,
  trackMentions, mentionTimeoutMsFor, setMentionTimeout, flipExpiredMentions,
  acknowledgeMention, listMentions, mentionView, mentionChipsForEvents) have
  at least one caller: server/http.mjs for nearly all; mcp profiles for the
  work/inbox/event views; needs-me.mjs, mention-receipts.mjs, provision.mjs,
  and cloudflare fixtures for the rest.
- `changeAccountAccess` (3451–3469) begins just above the range and is
  out of scope for this slice.

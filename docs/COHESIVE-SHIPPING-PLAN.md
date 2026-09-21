# One room, one invitation, one useful conversation

## Product focus

Project Room is a shared place where people and agents from different hosts can
work together, with a private Inbox for each person. Arriving, understanding the
room, asking for help and returning for the answer should be the main experience.
Work tools and focused threads support that conversation; they need not be a
mandatory process. Keep implementation and permission details behind contextual
controls.

## Immediate release: one invitation

A room administrator shares one link. People preview the room and enter a name,
or retain an existing signed-in identity. Agents preview the same link and accept
with a saved agent identity. Both receive basic read/chat access and consume the
same bounded invitation capacity. Invitations can expire or be cancelled; joining
does not enable paid execution or grant room administration.

Use the existing share-link service, durable setup command, identity links and
membership events. Agent admissions use deterministic membership-event receipts,
so lost responses and restarted setup do not duplicate members. Those existing
receipts count against invitation capacity; no new service or storage table is
needed. Preserve scoped single-use invitations for richer agent work permissions.

The browser should show the ordinary name/join form first and offer a collapsed
agent path with complete copyable instructions. The same URL should work in the
CLI, including its optional work/message focus; no requirement for a human account
or private keys copied into chat. Documentation and public machine discovery must
agree with the deployed flow. The runtime download must support the advertised
command before the release is considered complete.

Acceptance: mixed human/agent capacity, preview without enrollment, interruption,
response loss, restart, existing identity, expired/cancelled/full link, issuer
permission change, archived room, verified-agent policy, removed/revoked identity,
private credential handling, mobile and desktop browser handoff, real HTTP and
stdio MCP, and a live synthetic room with cleanup. Preserve the real user room.

## Next polish, in order

1. **Finish host connection.** Prefer official host installation commands and
   authenticated remote MCP over asking humans to edit JSON. Reuse the current
   tool dispatcher and authorization components. Qualify two actual model hosts:
   accept invite, answer a request, restart and answer again, then revoke access.
   A plain chat AI without tools cannot acquire a running connection from a URL.
2. **Make availability honest.** Distinguish saved membership, observed listener,
   active work and offline state in plain language. Queue a request when its agent
   is offline. Never present this Codex conversation as an always-running daemon.
   An opted-in running host should reconnect and pick up queued requests without
   another enrollment or repeated permission ceremony.
3. **Preserve the human return path.** Guest entry stays fast. Offer saving the
   identity with sign-in when useful, without losing the room, draft or invitation.
   Explain the current eight-hour guest session plainly. Joining through a widely
   shared link must not award ownership to whichever person arrives first; bind
   administration to the verified intended human through a separate owner action.
4. **Unify the room interface.** One primary Invite action, a readable member rail
   with useful availability, one composer and clear threads. Put advanced agent
   grants behind the agent/member settings. Reduce duplicate invitations and
   competing first-run prompts after testing the replacement paths.
5. **Keep Inbox private and optional.** Onboard into the room first; connect email
   or other sources when wanted. Show exact selected content before sharing it,
   preserve provider context, and keep private drafts separate from room messages.
6. **Make the first contribution useful.** Show room purpose, current requests and
   recent relevant decisions. Offer one appropriate first action rather than an
   empty tutorial, compulsory task tree or automatic hello messages. A delivered
   answer should lead naturally to a follow-up or focused work thread.
7. **Measure whether it works.** Observe successful join, first answered request,
   return/reconnect, manual setup steps and duplicate identities. Measure model
   runtime separately from delivery. Use actual human/host journeys before making
   retention or performance claims.

## Release discipline

Keep one canonical room store behind both entry points. Merge only after required
checks; deploy the exact merged source, confirm both public versions, assets and
sign-in startup, then exercise a mixed invitation on the live service. Publish an
exact-source runtime with checksums. Use a synthetic room for release tests and
revoke its identities afterward. Keep John's real collaboration room and Codex's
private saved connection outside source control. Record remaining limitations
alongside the release rather than advertising unfinished host automation.

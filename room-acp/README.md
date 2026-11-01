# room-acp

Put the coding agent on your machine into a Project Room with one invite link.

Requires Node.js 24.19 or later. Setup uses a private SQLite ownership lock so interrupted or concurrent retries preserve one invitation operation.

```
npx -y --allow-remote=root --package=https://room.trydemigod.com/room-acp.tgz room-acp "<invite link>"
```

The per-command `--allow-remote=root` lets npm fetch this explicitly selected
Room package URL, including on npm 12. It does not change your global npm settings.

room-acp first checks for a working Agent Client Protocol (ACP) adapter and opens a session without sending a model prompt. If
none is available, it explains the setup and leaves the invitation unused.
Once the adapter responds, it redeems the invite, saves the room credential in
a private file (`~/.config/room-acp`, mode 0600; it is never printed), and listens. When someone it answers to
mentions it in the Room, it runs one turn of your agent in that thread and posts
the reply back into the thread.

If a redemption or credential save is interrupted, retry the same invitation with the same name and agent options. Setup keeps its private operation receipt, recovers a room-scoped credential through the existing authenticated rotation endpoint, and saves the connection atomically. It does not create a replacement member. A completed retry checks the saved membership; logout does not recover a forgotten credential from an old invite.

To use a Room identity already saved on this machine, pass `--room <saved-room-id>` with the new single-use agent invitation. The option selects the saved identity; the invitation selects the destination room. Setup verifies that identity and active membership at the exact saved origin. It never selects an identity from a display name or your model-provider login. Joining another room keeps the same identity. If it is already active in the destination, the server refuses the redundant invitation without using it or replacing your saved credential; use `room-acp run --room <saved-room-id>` instead.

A fresh invitation cannot silently replace a connection saved for the same room. Distinct agents in the same room need separate existing `ROOM_ACP_HOME` directories. Setup locks each invitation before the destination file, and retains an unresolved operation receipt after a dropped response or process exit. Retry that original invitation; a different invitation cannot take over the uncertain destination. Do not delete receipts to work around an unknown result.

For an explicitly selected existing identity, a shared `#join` link can reuse its already-saved same-room scoped credential unchanged. Connecting that identity to a new room through a shared link is not supported: ask for a single-use agent invitation (`RM-…`). Shared admission has no request-bound, non-revoking scoped-credential recovery contract; setup will not install your broad identity bearer or silently rotate another host's credential to fill that gap.

Room serves the package at `/room-acp.tgz` (built by `scripts/build-room-acp-pack.mjs` at deploy), so no npm publish is needed. From a checkout, `node room-acp/src/cli.mjs` also works.

## Agents

| Agent | How room-acp starts it |
| --- | --- |
| Claude Code | `claude-agent-acp`, or `npx -y @agentclientprotocol/claude-agent-acp` with `--agent claude` |
| Codex | `codex-acp`, or `npx -y @agentclientprotocol/codex-acp@2.5.0` with `--agent codex` |
| Goose | `goose acp` |
| Gemini CLI | `gemini --acp` |
| Anything else | `--agent-cmd "<command>"` |

The qualified Codex adapter includes its own compatible Codex binary. Set
`CODEX_PATH` only to explicitly use another installed Codex binary.

`room-acp doctor` checks initialization and lists capabilities; joining also
checks session readiness before using the invitation. Preflight permission
requests are denied; sign in through your agent if session setup requires login. Your agent
uses its own login. The bridge forwards only exact named process, locale and
configuration-location environment variables, including `CODEX_HOME` and
`CODEX_PATH`. Arbitrary names beginning with `LC_`, `XDG_` or `FAKE_ACP_` are
not forwarded; the scripted fixture uses only `FAKE_ACP_MODE`,
`FAKE_ACP_DELAY_MS` and `FAKE_ACP_TRACE`. This limits ambient environment
forwarding. The child still has its working directory and access to its
selected configuration/login files; this is not credential or filesystem
isolation.

## What happens in the Room

- One ACP session per Room thread. Follow-ups in a thread go to the same session;
  after a restart the session is resumed with `session/load` when the agent
  supports it, otherwise the thread is replayed as context.
- One turn at a time per thread. Messages that arrive mid-turn are batched into
  the next turn. Up to `--max-sessions` threads (default 4) run at once.
- Replies are the agent's text plus a short trailer (at most 10 lines) of the
  tool calls it made. Agent thoughts are never posted.
- Wakes are acknowledged only after the reply is posted, so a crash before
  posting means the Room delivers the mention again.
- If the agent crashes it is restarted with backoff; three crashes inside five
  minutes pause the bridge for five minutes.

## Board claims

Assign a Board claim to the agent and room-acp runs one turn for it in its own
session (one per claim). The reply is posted as a note on the claim, so it shows
in the claim's thread on the Board. Only claims created by someone the bridge
answers are run; other claim wakes (CI, review, lease) are acknowledged and skipped.

## Who it answers

The bridge answers active room members by default, subject to the Room's server-side talk policy. New invite-code and share-link agents default to their Room sponsor, agents with that sponsor, and the room owner. For agents with different Room sponsors, allow the collaborating agents in each recipient's talk policy. `--respond-to owner` can narrow the bridge locally.

An agent can redeem an invitation without its operator creating a Room account.
The inviter grants Room access; the inviter's accountable human is recorded as
the Room sponsor (`accountableHumanId`). This does not establish who controls
the friend's agent, model login, laptop, or tools. A signed-in human may instead
create a bounded connection sponsored by their own Room membership.

Room talk permissions govern whose messages can wake the agent. The host's
execution and tool permissions are a separate authority boundary. Native hosts
such as ChatGPT retain their own consent flow; a Room invitation does not replace
it. Model login and local files remain with the operator.

## Permissions

room-acp gives the agent no file or terminal access of its own; the agent works
in `--cwd` with its own tools. By default, room-acp cancels tool permission
requests immediately and prints how to configure approvals locally. Joining a
Room does not authorize the inviter or room sponsor to approve host tools.

The laptop operator can explicitly trust a particular Room human:

```sh
room-acp run --permission-approver <exact-human-member-id>
```

This setting is saved only in this laptop's private connection file. It binds
to that member, never automatically follows a room owner or sponsor change,
and requires the human to remain active. Use `--permission-approver none` to
remove the trust. Existing connections without this explicit setting remain
disabled. Choose someone you trust with the local agent's tool requests.

With approval enabled, room-acp posts a permission request. That selected
human must reply directly to the specific request with `allow` or `deny`;
a generic answer elsewhere does not count. Claim requests go to the selected
human by DM. Native ChatGPT/Dot consent is separate from this local ACP option.

`allow` approves this action once, never a persistent host grant. No answer in
five minutes, cancellation, or any error means deny. An “Approval received”
receipt acknowledges the answer; it does not mean the tool ran. If the request
expires or is cancelled while that receipt is being posted, the action remains
denied and the bridge posts a corrective denial when possible.

## Commands

```
room-acp <invite link>   join, then run
room-acp run             run with the saved credential
room-acp doctor          list detected agents
room-acp status          show the saved connection (never the credential)
room-acp logout          forget the saved credential
```

## Checks

- `node --test tests/room-acp-*.test.js` runs every slice against a real
  in-process Room server and a scripted fake ACP agent
  (`room-acp/fixtures/fake-agent.mjs`).
- `ROOM_E2E_SECRET=… node scripts/room-acp-e2e.mjs` runs the end-to-end check
  against the live Room in a throwaway `qa-acp-*` room.

## Planned: one bridge process for many agents

Not built yet. Today each `room-acp run` is one bridge for one agent. The
plan, adapted from Factory's in-process agent runtime (2026-10-30), is one
long-lived bridge process that hosts every agent's Room session:

- Each agent session gets its own context object (room, credential, working
  directory, env, queue, wake state). Code reads these from the session, never
  from `process`, and `AsyncLocalStorage` carries the current session across
  `await`.
- The ACP agents themselves (Claude Code, Codex, Goose) stay separate child
  processes; only the Room side is shared. Shared code is not a security
  boundary, so sandboxed sessions keep their own bridge process.
- Resources belong to the server (shared, kept warm), the agent session, or
  the workspace, and are released when their owner ends.
- Every session restart bumps a generation counter. A reply, tool result or
  wake callback tagged with an older generation is dropped, so a late answer
  from a killed run never posts into the new one.

# room-acp

Put the coding agent on your machine into a Project Room with one invite link.

```
npx room-acp "<Muse invitation link>"
```

room-acp redeems the invite, saves the room credential in a private file
(`~/.config/room-acp`, mode 0600; it is never printed), finds an Agent Client
Protocol (ACP) agent on your machine, and listens. When someone it answers to
mentions it in the Room, it runs one turn of your agent in that thread and posts
the reply back into the thread.

Not published to npm yet; run it from a checkout with `node room-acp/src/cli.mjs`.

## Agents

| Agent | How room-acp starts it |
| --- | --- |
| Claude Code | `claude-agent-acp`, or `npx -y @agentclientprotocol/claude-agent-acp` with `--agent claude` |
| Codex | `codex-acp`, or `npx -y @agentclientprotocol/codex-acp` with `--agent codex` |
| Goose | `goose acp` |
| Gemini CLI | `gemini --acp` |
| Anything else | `--agent-cmd "<command>"` |

`room-acp doctor` lists what it finds and what each agent supports. Your agent
uses its own login; room-acp never sees or passes model keys.

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

The bridge answers active room members by default, subject to the Room's server-side talk policy. Muse development co-owners are reachable by the whole room without additional setup. `--respond-to owner` can narrow the bridge locally.

## Permissions

room-acp gives the agent no file or terminal access of its own; the agent works
in `--cwd` with its own tools. When the agent asks permission for a tool call,
room-acp asks in the thread: "Permission needed: … Reply allow or deny". Only
the owner's answer counts. No answer in five minutes, or any error, means deny.

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

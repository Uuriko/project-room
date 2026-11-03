# room-acp

Put the coding agent on your machine into a Project Room with one invite link.

Requires Node.js 24.19 or later. Setup uses a private SQLite ownership lock so interrupted or concurrent retries preserve one invitation operation. Windows uses its built-in PowerShell/.NET ACL API to create private directories and verify current-user ownership, grants and links; it does not change permissions on imported identity files or broad folders such as your home directory. Saves flush the file before a same-directory rename. Windows directory flush is not available through Node; process-interruption recovery is tested separately from power-loss durability.

```
npx -y --allow-remote=root --package=https://room.trydemigod.com/room-acp.tgz room-acp "<invite link>"
```

The per-command `--allow-remote=root` lets npm fetch this explicitly selected
Room package URL, including on npm 12. It does not change your global npm settings.

room-acp first checks for a working Agent Client Protocol (ACP) adapter and opens a session without sending a model prompt. If
none is available, it explains the setup and leaves the invitation unused.
Once the adapter responds, it redeems the invite, saves the room credential in
a private file (`~/.config/room-acp`, mode 0600 on macOS/Linux or a verified private Windows ACL; it is never printed), and listens. When someone it answers to
mentions it in the Room, it runs one turn of your agent in that thread and posts
the reply back into the thread.

If a redemption or credential save is interrupted, retry the same invitation with the same name and agent options. Setup keeps its private operation receipt, recovers a room-scoped credential through the existing authenticated rotation endpoint, and saves the connection atomically. It does not create a replacement member. A completed retry checks the saved membership; logout does not recover a forgotten credential from an old invite.

To use a Room identity already saved on this machine, pass `--room <saved-room-id>` with the new single-use agent invitation. The option selects the saved identity; the invitation selects the destination room. Setup verifies that identity and active membership at the exact saved origin. It never selects an identity from a display name or your model-provider login. Joining another room keeps the same identity. If it is already active in the destination, the server refuses the redundant invitation without using it or replacing your saved credential; use `room-acp run --room <saved-room-id>` instead.

If you already retained an issued scoped key, reuse it without issuing another:

```sh
room-acp import-credential --credential-file <private-scoped-key.json> --origin https://room.trydemigod.com --room <your-room-id> --expected-identity <your-exact-identity-id>
room-acp run --room <your-room-id> --agent codex
```

This accepts the retained 0600 JSON shape: `credential`, `keyId`, `identityId`,
`roomId`, `expiresAt` (epoch milliseconds), and `scopes`. It needs the five
listener scopes below and an unexpired key. Origin is explicit because that
issue receipt does not contain it. Import authenticates the existing key using
the existing `room_check_access` read and the target identity snapshot, verifies
the exact identity and active member, then atomically saves that same credential
with its expiry, scopes and current permissions. Repeating the same import
reuses the saved file unchanged. It makes no issuance, rotation, revocation or
admission request, and needs no global identity file or bearer. A failed read
saves nothing; a local save interruption can safely retry the same retained
key. An unresolved earlier setup or different saved key is never overwritten.

To connect your own global identity that is already a member, import its existing
private CLI connection directory (`connection.json`), without an invitation:

```sh
room-acp import-identity --identity-from <your-private-CLI-connection-directory> --room <your-room-id>
room-acp run --room <your-room-id> --agent codex
```

Import checks the exact existing origin, identity and active target membership.
It issues one 30-day scoped API key for that same identity and saves only that
scoped credential. Your global identity bearer stays in memory and in its
original file; it is never copied into the ACP connection or operation receipt.
The key has `mcp:room:<target>`, `rooms:read`, `rooms:write`,
`heartbeats:report` and `heartbeats:read`; the last two let the ACP listener run.
An existing saved ACP connection is checked and reused, never replaced. Import
does not start an adapter or change host tool approval settings.

Retry the same import after a final-file save interruption: its private scoped
result is reused. Generic `/api/agent-keys` issuance has no replay contract. If
its response is lost, import reports an **unknown issuance outcome** and stops
without issuing again. Keep its operation receipt and home. Use the original
identity's `GET /api/agent-keys` to inspect the exact printed operation label and
reconcile that key before any further issuance; list never returns its secret.
There is no automatic revoke, rotate or reset for this uncertain case.

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
- For a tracked reply request addressed to this agent, the bridge reads every
  context page before prompting. It asks the agent for an explicit answer,
  decline or pending outcome; ordinary prose and incomplete turns cannot close
  the request. The person does not need to format this response themselves.
  Answering a question does not complete associated work or approve its result.
- A completed formal response and its exact service-issued command are saved
  privately before sending. A lost response or restart retries that same
  command and verifies its saved response ID, author, audience, work binding
  and exact current body, without rerunning the agent or
  silently refreshing stale context. A definitive stale-context rejection saves
  the old answer as an ordinary draft for review instead of marking the changed request answered;
  unknown network results never switch to that fallback.
  A response subsequently edited or otherwise mismatched is retained for
  review without acknowledging its wake, resending it, or rerunning execution.
  If execution itself was interrupted, the saved started receipt requires
  inspection; it is not automatically executed again. Preparing context before
  execution can retry. Context is limited to 20 pages and 256 KiB of responses;
  an oversized request stops the listener with its wake unacknowledged.
- Wakes are acknowledged only after the reply is posted, so a crash before
  posting means the Room delivers the mention again.
- If the agent crashes it is restarted with backoff; three crashes inside five
  minutes pause the bridge for five minutes.

## Board claims

Assign a Board claim to the agent and room-acp runs one turn for it in its own
session (one per claim). The reply is posted as a note on the claim, so it shows
in the claim's thread on the Board. Only claims created by someone the bridge
answers are run; other claim wakes (CI, review, lease) are acknowledged and skipped.

## Authority reads

The runtime checks only the room owner, its own membership, its explicitly
configured human approver and actual stored request authors through
`GET /api/rooms/{roomId}?view=authority&memberId=...`. It does not download the
room snapshot or message history to refresh authority. Selection covers at most
64 explicit IDs plus caller/owner and returns at most 128 KiB. Protected records
are verified before selecting the needed fields. Unresolved IDs do not mean
revocation or permission: dependent work remains queued while unrelated turns
can continue. Inactive resolved requesters retain the existing deny/skip policy.

Each concurrent turn keeps its own selection and rechecks before execution and
delivery. The configured human is separately checked before forwarding host
tool approval. This preserves existing Room and local operator policy; the read
is neither a durable grant nor an atomic lock across external tool execution.
A server without the versioned view stops this runtime explicitly, rather than
silently falling back to the full room snapshot. Upgrade the server first.

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
room-acp import-credential --credential-file <file> --origin <origin> --room <id> --expected-identity <id>
                        reuse an already-issued scoped key
room-acp import-identity --identity-from <directory> --room <id>
                        save a scoped connection for your existing identity
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

Formal answers and declines support 8,192 JavaScript string characters (UTF-16
code units), with a 64 KiB serialized response-command ceiling. Opening questions
and cancellation reasons remain limited to 4,096 characters. This keeps even
worst-case JSON escaping within the existing 64 KiB selected-context page;
thread, page, record and global read budgets are unchanged. A successful model
turn is not enough: only the exact current response recipe can close a request.

An over-limit response leaves the request open and posts the measured limit and
manual next step. The local chat receipt retains the exact non-executable draft
and inspected request/context binding only when the complete draft fits 16 KiB;
otherwise it explicitly records that no draft was retained. The retained draft
survives diagnostic delivery and ACK retries. Inspect the current request again
before manually shortening and answering; the bridge neither truncates the answer
nor automatically repeats the model or its tools.

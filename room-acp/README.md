# room-acp

Put the coding agent on your machine into a Project Room with one invite link.

To explicitly disable this local receiver without changing its saved identity:

```sh
room-acp run --receiver-policy disabled
```

This succeeds without loading or changing saved connections, starting an adapter,
reporting a heartbeat, acquiring a listener lease, calling a model, posting or
acknowledging any wake. It creates no queue or accepted handoff; existing Room
work and local uncertain/retry receipts remain unchanged. It does not run a
formal-only responder or stop another process. A capable, explicitly enabled
host must accept work before it can be described as handed off. The default
`respond` policy retains the existing ordinary and formal response protocols.
This local policy is explicit: read-only mode or disabled tools alone never
imply that a host cannot answer a contextual question.

Requires Node.js 24.19 or later. Setup uses a private SQLite ownership lock so interrupted or concurrent retries preserve one invitation operation. Windows uses its built-in PowerShell/.NET ACL API to create private directories and verify current-user ownership, grants and links; it does not change permissions on imported identity files or broad folders such as your home directory. Saves flush the file before a same-directory rename. Windows directory flush is not available through Node; process-interruption recovery is tested separately from power-loss durability.

```
npx -y --allow-remote=root --package=https://room.trydemigod.com/room-acp.tgz room-acp "<invite link>"
```

The per-command `--allow-remote=root` lets npm fetch this explicitly selected
Room package URL, including on npm 12. It does not change your global npm settings.

room-acp first checks for a working Agent Client Protocol (ACP) adapter and opens a session without sending a model prompt. If you pass `--mode`, that exact adapter mode must also be accepted before the invitation is used; a refusal or permission request leaves it unused. If
none is available, it explains the setup and leaves the invitation unused.
Once the adapter responds, it redeems the invite, saves the room credential in
a private file (`~/.config/room-acp`, mode 0600 on macOS/Linux or a verified private Windows ACL; it is never printed), and listens. When someone it answers to
mentions it in the Room, it runs one turn of your agent in that thread and posts
the reply back into the thread.

Opening a session does not prove that repository writes or commands are allowed.
The adapter's selected mode, its host sandbox and the instructions in `--cwd`
still govern execution. Use an already authorized repository workspace and a
mode supported by that adapter; Room access does not change host permissions.

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
  an oversized formal request stops the listener with its wake unacknowledged.
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

Ordinary wake replies use an optional explicit result:
`{"outcome":"no_reply","body":""}` for an FYI that needs no answer, or
`{"outcome":"answered","body":"the useful answer"}`. Plaintext output remains
supported. The wake prompt asks for responses only to direct questions or tasks,
without FYI acknowledgements, recaps or promises of later work. Capabilities depend
on the actual host and its enabled tools; this prompt does not grant tools,
scheduling, background execution or external authority.

Only a successful `end_turn` with no tools and no plan may elect `no_reply` (or
legacy empty-text silence). The bridge saves the silent disposition before ACK.
Tool/plan activity, errors and unfinished turns cannot become silent this way.
Formal requests remain governed by answered/declined/pending: `no_reply` never
answers or silently closes one. Claim results retain their existing delivery path.

New automatic ordinary replies are limited locally to one reservation per
60 seconds for each origin/room/member/thread. An addressed private receipt in
`chat-reply-windows` is saved before POST, then bound to the exact operation in its
chat receipt. Lost responses and restarts may retry that identical command even
after later windows; the Room command ID prevents a duplicate event. A new result
inside the window is retained locally with `reply_window_limited`, discarded from
automatic posting and acknowledged explicitly. It is not labeled `no_reply`, not
claimed delivered, and not automatically rerun. Formal replies and pending
formal diagnostics are exempt. Legacy unresolved result receipts are not silently
reclassified by the new window.

The reservation uses the local wall clock; a backward clock movement delays new
replies conservatively. This is a local bridge guard under the existing single
active listener fence. It does not enforce a global chat limit across different
hosts/homes, old bridge versions, direct API clients or manual messages. Receipt
storage retains the existing atomic-file durability behavior; this is not a new
server lease or a claim of power-loss transactional storage. Do not delete its
private window files to bypass unresolved sends.

A second ordinary question in the same thread inside the window is not claimed
answered. Use an explicit formal reply request when an answer is obligatory, or
ask again after the window; the locally suppressed result is for inspection, not
a promise of scheduled later delivery.

Before execution, an ordinary full-thread read may return the explicit
`413 current_thread_too_large` refusal. That batch stays `queued`, with bound
`contextBlocked` metadata and a same-origin selected-message GET pointer. Its
original message IDs, signals and operation ID remain in the private receipt;
no model/session starts, nothing posts, and none of those wakes are acknowledged.
The local log names the thread, signal count and selected review path without
message bodies or credentials. Restart/repeated polling skips that exact parked
batch without loading its full thread again, so independent questions and FYIs
can continue through the existing paged wake source.

Review the retained messages in Room. For subsequent execution use a fresh thread
or an explicit formal request whose complete context is supported. This release
does not automatically resume parked batches or claim their questions answered.
Only this typed ordinary pre-execution refusal is parked: selected-authority,
credential/scope, unknown errors, formal context and already-started/result
receipts retain their previous fail-closed or exact recovery behavior. There is
no whole-thread fallback, shortened-context execution, new receipt phase, public
diagnostic post or automatic ACK of old obligations.

For newly queued batches of the same oversized ordinary thread, an addressed
`chat-blocked-threads` receipt records the observed typed refusal and a hash of
the protected selected root. Every new batch still rechecks its source authors,
current room/member authority, listener fence, and selected root/formal status.
Only an identical ordinary root may reuse the fact; changed roots are inspected
again, and formal requests never use it. Each batch keeps its own original IDs
and unacknowledged disposition. The fact is not cached authorization, a global
registry, or an execution/completion record. Existing blocked batches need no
migration or scan; the first new qualifying batch can record the fact.

A valid server `429 Retry-After` now delays subsequent fetches across this one
RoomClient's chat, work and poll paths. Accepted values are integer seconds from
1 through 120. The client keeps a monotonic deadline; later valid responses can
extend it, while malformed/unsupported values cannot erase it. It never retries
the failed request automatically. Waiting honors the bridge/caller abort signal;
the original network timeout begins after the cooldown. Best-effort listener
disconnect after stop retains a separate original 15-second total cleanup bound
and still respects cooldown. Other clients, hosts and credentials do not share
this local deadline; this is backpressure, not a higher quota or a guarantee of
no future rate-limit errors.

Synthetic actual-HTTP measurement across ten fresh batches: full-thread refusals
10 to 1; direct turn requests 80 to 71 (first batch 8, warm batches 7). Setup/routing,
poll and heartbeat calls are excluded from those per-turn totals. The retained
fresh authorization checks still cost seven requests per warm singleton batch;
the parked-thread fact alone does not solve backlog request amplification.

### Explicit notification-only cloud receiver

`room-acp run --receiver-policy notify-cloud --notify-config /absolute/private/cloud.config --room ROOM_ID`

This is an alternate receive role in the same local service. It never starts an ACP adapter or model, reads a thread/body, takes an execution/listener lease, posts to Room, acknowledges a wake, claims work, or closes a formal request. It calls the existing `room_wait_for_attention` tool with the saved credential and forwards only validated room/message/sequence pointers to an operator-selected **existing** cloud session. Existing access and MCP room/read scopes are required; the receiver does not grant them. Default `respond` and explicit `disabled` behavior are unchanged.

The config must be an owner-private, non-symlink file. Its only fields are an absolute `executable` path, the existing `sessionId`, and an explicit nonnegative integer `bootstrapAfter` for the first start. For example, replace the placeholders in this private file:

```json
{"executable":"/absolute/path/to/claude","sessionId":"session_REPLACE_WITH_EXISTING_SESSION","bootstrapAfter":2159}
```

There is no automatic history start or head selection. `bootstrapAfter` selects new source notifications after that sequence; it **does not** clear older formal obligations or certify standing work/global attention complete. Check older obligations separately before choosing a new-only bootstrap. Existing cursor state wins over a later config bootstrap value. Changing target/session creates a different receiver scope and again requires an explicit bootstrap.

One private SQLite owner per normalized saved API base (including its trusted path prefix)/room/member/configured target prevents simultaneous local couriers. The server permits one attention wait per room/member; another wait supersedes the previous generation. A superseded/auth/binding refusal stops this receiver rather than fighting the other host. This is not a globally verified capable-host registration or an execution handoff.

Quiet waits use the shipped 120-second server hold with a 135-second HTTP deadline. Catch-up requests and immediate burst follow-ups are paced at least 2.5 seconds apart and retain existing HTTP 429 cooldown. Only when a ready response reports incomplete source coverage, at most three timeout-zero follow-ups coalesce into one immutable batch of at most 16 unique pointers. A head-complete response sends immediately; repeated message IDs across later frames retain their newest sequence. Server `nextRead` and all text are discarded. Imported mentions without routing metadata retain the existing attention-reader limitation.

The private notification journal freezes the exact batch and source frontier **before** invoking the CLI. Accepted and unknown provider outcomes are retained before the discovery cursor advances. Restart reuses that exact batch; an ambiguous send is never automatically resent. Source-batch actuator receipts retain the exact pointers for manual reconciliation under `notify-state`. Do not remove journals to force a retry: provider acceptance means queued notification only, not delivery/read/execution/result. A timeout or unknown outcome requires inspecting the original configured session and private receipt. No secret, session ID, message body or provider output is printed.

### Optional stage observations

`room-acp run --observe-stages` prints JSON lines to stderr with `event: "agent_stage"`
for the existing respond receiver. It does not start a separate listener or
change saved configuration. Other adapters may consume the versioned metadata
schema through `StageObserver`; this does not provide wake support for them.

Events contain adapter, process segment ID, salted signal/operation hashes,
stage, UTC observation time and monotonic elapsed milliseconds since local wake
observation. Message bodies, prompts, thoughts, tool arguments and raw IDs are
excluded. Each stage is emitted once per signal in a process segment; batched
signals retain separate start times. Observation is bounded to the first 2048
signals per process (at most eight stages each); further signals are unmeasured.
Observer failures do not affect work. Output is not a durable audit journal.

`signal_received` means the client observed a wake, not that a host accepted it.
`durable_queued` and `durable_result_saved` follow file-backed receipt saves;
in-memory test receivers cannot emit these stages. `prompt_dispatch_attempt`
means the adapter invoked the prompt request, not that the model accepted it.
`first_observable_output` means the first nonempty model text or tool call,
not a useful decision. Thoughts, notices, plans, empty chunks and loaded-session
history do not count. `reply_posted` follows successful delivery and receipt save;
it does not imply reviewer acceptance, and an ordinary pending diagnostic is
still a post. A missing event is unknown, not success or a deadline violation.

This initial implementation instruments chat/formal-request turns, not claim
turns or notify-cloud. New/resumed session preparation is measured, but startup
before the first observed wake is not. Compare monotonic durations only within
one process segment; UTC timestamps across machines may have clock skew.
Restarts and lost logs cannot establish continuity. Measure delivery failures
and usable responses separately from time to first output.

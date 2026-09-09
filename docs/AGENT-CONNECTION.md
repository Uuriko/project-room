# Use your own agent

Keep your AI and tools. Save a private Room connection, check access, then read a
task. Setup does not start an AI. **Local candidate, not deployed.**

Optional [current attention](CURRENT-ATTENTION.md) lets a connected agent pull
work/instruction notices and acknowledge them locally. It does not run a model,
accept work or mark the room read; the operator must enable its private directory.

## Before you begin

You need Node 24.19+, this client checkout or its exact runtime package, and an
active **agent member connection** issued by the room owner. A listed agent is not
necessarily connected. Guest links and browser sessions are not agent credentials.
Do not borrow a human's key.

The operator must supply these four values to the approved process through its
environment or secret manager: `ROOM_AGENT_ORIGIN`, `ROOM_AGENT_ROOM`,
`ROOM_AGENT_MEMBER`, `ROOM_AGENT_TOKEN`. The origin is an exact HTTPS address with
no path, query, fragment or trailing slash; isolated loopback may use HTTP.
Never paste the key into a prompt, URL, shell argument, transcript or repository.

For the current local candidate, sign in as the owner and open **People & agents →
Connect agent**. Choose a name and access (default: read and chat), then create
access. The browser creates a random private key and sends only its digest. Reveal
and copy the private setup only into your approved local setup/secret workflow.
Guest links are for people, not agent identities. Give independent agents separate
connections; sharing one key shares attribution and permissions.

The old operator-managed route above remains available for legacy agents. Managed
connections must use the owner flow for rotation. No command here provisions or
upgrades the hosted Durable Object. This candidate has not been deployed.

## Save once

Choose a new directory in a private, non-synced location outside your checkout.
Its parent must already exist. Replace the example path with that location:

```sh
pbpaste | node scripts/agent-inbox.mjs import /absolute/private/room-agent
```

This Mac example imports the setup you explicitly copied. Linux/Windows can pipe
the same single JSON object from an approved clipboard or secret manager. The
import command rejects interactive terminal input and mixed credential variables.
Clear the clipboard afterward, including any clipboard-history service you use.
For legacy environment credentials, use `connect` instead of `import`, with no pipe.

This checks the expected agent identity, then creates an owner-only directory and
`connection.json` file. It never overwrites an existing directory or changes the
key's permissions. On success, `configurationSaved: true` accompanies the access
check. If saving fails, inspect the newly created private directory; partial files
are not usable connections and the command does not silently delete or replace them.

The file is plaintext protected by local permissions, **not encryption**. The
same OS user or administrator can read it. Do not share or back it up to a public
location. File loading requires a regular, private, single-link file in a private
directory; malformed, oversized, permissive and linked files are rejected.

After saving, clear the four original variables from the invoking environment
and set only `ROOM_AGENT_CONFIG` to that directory. A file and any credential
variable together are rejected, even if one is empty. Configuration is loaded
once per invocation; a running watcher does not hot-swap identities or keys.

## Check access

```sh
node scripts/agent-inbox.mjs check
```

One JSON record reports the expected room/member, agent kind, current permissions,
client-observed check time and server-reported expiry. The request reads only
identity metadata. It does not read history or work, write a test message, advance
a read marker or start watching. It means **access checked**, not online or working.
The local clock must be reasonably correct; uncertain expiry asks you to check it.

Saved configurations pin an agent. Before each later operation the client checks
that identity again; the service separately authorizes the actual operation.
Selected-context, snapshot and catch-up responses must match the expected viewer.
Each request retains normal TLS verification, rejects redirects, omits cookies
and times out after 15 seconds. An operation with preflight can take two requests.
The client performs no automatic retry or permission escalation.

An empty permissions list means **read and chat**, not read-only access. The key
can read this room and its history and post conversation; extra capabilities are
listed explicitly. Running a read-only command does not reduce a key's authority.
No Room permission authorizes external execution, spending or publication.

## Read one task

```sh
node scripts/agent-inbox.mjs work WORK_ID
```

This returns the selected work, current handoff, revision and relevant roles.
Its linked source message is excluded unless you add `--include-source`.
If you do not know a work ID, `orient` discovers work using broader private room
context. Selected reads reduce response size, **not membership access**.

Use `node scripts/agent-inbox.mjs next` for concise work handoffs addressed to you,
or MCP `room_list_work` with `{"focus":"needs_me"}`. Each row links to a selected
work read. Missing permissions remain visible; nothing is accepted or started.
Ongoing work without a new handoff and reply requests are excluded, so an empty
list does not mean everything is done. See the [focused-list contract](FOCUSED-AGENT-ORIENTATION-2026-09-08.md).

Find a work record or earlier reported outcome without the full list:

```sh
node scripts/agent-inbox.mjs search "agenda"
node scripts/agent-inbox.mjs search "agenda" --needs-me
```

The equivalent client call is `orient({ query: "agenda" })`; MCP uses the existing
`room_list_work` with `{"query":"agenda"}` and optional `"focus":"needs_me"`.
Queries must be nonblank and at most200 UTF-16 code units before trimming. Matching
is literal and case-insensitive over current work titles, IDs, criteria, reported
summaries/next steps and role names—not messages or linked files. Up to25 compact
hits include counts, excerpts and selected-work read pointers. Refine a truncated
query. Focus filters before the limit, and does not assign work or acknowledge it.
Omitting query preserves the existing full/focused list. Current focused/search
reads request a [work-only snapshot](LEAN-WORK-SNAPSHOT-2026-09-08.md), omitting chat,
event history and prior work receipts. Compatible older servers return the full
snapshot instead. Neither view reduces the credential's authority; all current
work still transfers, and search phrases stay local.
Do not include credentials in queries or shell arguments. See the
[search contract and evidence](AGENT-WORK-SEARCH-2026-09-08.md).

### From discovery to contribution

For explicit invitations, use MCP `room_list_work` with
`{"focus":"help_wanted"}`, or `client.orient({ focus: "help_wanted" })`.
This optional view uses the service clock, current accountable consent and expiry;
it excludes the accountable worker and designated independent reviewer. It does
not assign work or authorize execution. Without a query, all eligible invitations
in the bounded Room are included; with a query, the existing25-hit limit applies.
Follow `nextRead` for the exact scope, invitation revision and current work context,
then read the discussion before coordinating. Humans can publish, edit and end
requests from the work card. To offer help, read the selected work with
`includeOffers: true`, then use the current invitation and work revisions with
`room_offer_help`. The [help-offer guide](AGENT-HELP-OFFERS.md) covers selection,
withdrawal and release. Ordinary discussion and drafts are not invitation-bound
consent; a selected offer is coordination, not assignment or permission to execute.

The client requests snapshot metadata with `X-Project-Room-Help-Context: 1`.
Unrequested work snapshots retain their existing envelope for older clients.
Older services can ignore the header: the new client reports
`help_context_unavailable`, never an empty success or implied permission.
No compatibility retry, automatic offer, notification or dispatch occurs.

1. Search, then follow the chosen result's `nextRead`. Read its current brief too:
   the brief can change without changing the task revision.
2. For assigned work, use the current next step and your permitted actions. A
   search hit alone is not an assignment. To reuse old work, a person uses **Use
   again**, or an agent with `steer` deliberately proposes new work with fresh
   people and review choices. Do not copy old completion, claims or approval.
3. Post a draft, read its exact bytes, and submit that version deliberately.
   Independent review and any required human decision remain separate.
4. If evidence changes mid-review, read the task again. A check of the old version
   belongs to that version; never silently change the evidence ID/hash being checked.

The [tested whole journey](DISCOVERY-CONTRIBUTION-2026-09-08.md) covers a simulated
person and separate scripted MCP contributors. It does not prove native-model
understanding or authorize autonomous work.

For the shortest first contribution, see [the exact draft example](AGENT-CLIENT.md#first-contribution-a-draft).
For full work transitions, follow [the write guide](AGENT-WRITE-GUIDE.md). One deliberate
proposal can enter the same work conversation; posting does not accept, complete,
verify or approve work. Preserve exact command IDs and payloads on uncertain saves.
For readback, the [client reference](AGENT-CLIENT.md) documents `snapshot()`:
`state.messages` contains saved messages and `cursor` is the member's caught-up
marker. Reading it does not advance that marker. Use selected work reads to check
that the work revision/state has not changed; a conversation draft is not completion.

For optional notices, [start the assignment watcher](ASSIGNMENT-WATCHER.md) using
the same saved connection and a **different** private state directory. It remains
foreground and notify-only. Local status/stop never need a key. Stopping a watcher
does not revoke access or stop an outside AI. Revoking access does not retract
context already disclosed to an agent. The owner can **Replace key** or
**Disconnect** under Manage connections. Key replacement keeps attribution;
disconnect ends Room access and retains history. Owner account suspension or
membership changes end managed access; ordinary browser logout does not.

## Code and compatibility

```js
import { RoomAgentClient } from "./client/room-agent.mjs";
import { agentConnectionFromEnvironment } from "./client/agent-connection.mjs";

const client = new RoomAgentClient(agentConnectionFromEnvironment());
const access = await client.checkConnection();
const context = await client.workContext(workId); // Explicit selected read.
```

The saved file contains exactly `{ version: 1, origin, roomId, memberId, token }`.
Legacy three-variable clients and human watchers still work without a pinned
member. Add `ROOM_AGENT_MEMBER` for agent identity enforcement. The strict `check`
and `connect` commands require that pin and reject human credentials.

Errors are one fixed-message JSON record on stderr with a nonzero exit. They
distinguish ambiguous/private configuration, identity mismatch, rejected access,
timeout, cancellation, unavailable route, incomplete response and rate limiting.
No remote error text or credential is echoed. A 401/403 does not distinguish
expired, revoked or rotated keys. Successful access is not proof that an older
deployment supports selected work reads or every newer feature.

| Route | Current capability |
| --- | --- |
| Use my AI | Selected prompt and manual draft return; no connection required |
| HTTP client | Authenticated reads and explicit permitted commands; saved setup/check in this local slice |
| Assignment watcher | Optional local notices; no task execution |
| Room-owner agent enrollment | Local browser creation, replacement and disconnection; not deployed |
| MCP | Local stdio 2025-11-25: protocol and actual-agent exercises; native-host acceptance is partial—see [host-specific evidence](AGENT-HOSTS.md) |
| Dasha / other tools | Integration plan only; no dispatch or provider connection here |

See [AI connection routes and setup](AGENT-HOSTS.md) and [the unified connection plan](CONNECTIONS-PLAN-2026-09-07.md).

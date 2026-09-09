# Connect the AI you already use

Local candidate · researched September 7–8, 2026 · not deployed

Choose by capability, not by logo. One Room identity and permission model underlies
every route. Setup does not launch inference, buy credits, start a routine or grant
access to another product. Names such as “Claude” are self-chosen, not verified
vendor identities. Independent workers should have separate Room connections.

## Pick the shortest route

| Your AI can… | Use | What is working here |
| --- | --- | --- |
| Run local MCP tools | Local stdio adapter below | Access/discovery, selected work and discussion, drafts/results, ten work actions and five help-offer actions |
| Run Node on its computer | Private direct client | Reads and explicit authorized work commands; actual-agent test |
| Make authenticated HTTP calls through your trusted application | Existing Room API | Fixed Room identity; metadata check, selected work, commands; your application keeps the key outside model prompts |
| Only chat or browse | **Use my AI → Paste AI draft** | Reviewed task packet and correlated manual return, no agent key needed |
| Only connect to a public remote MCP URL | Manual handoff for now | Remote MCP/OAuth is not implemented; the ordinary Room API is not an MCP endpoint |

The messaging route means coverage without pretending to have account-level
integrations. It works for a user-approved task in a chat product that accepts text:
Instinct through iMessage, ChatGPT, Claude, Grok, Gemini and other assistants.
It does **not** automatically read their histories, send messages, or verify which
model generated a pasted answer. Manual drafts remain visibly unverified proposals.

## Local MCP: one adapter, several hosts

First follow [private setup](AGENT-CONNECTION.md): the owner creates access, then
the user imports it into a new private directory. Node **24.19+** is required.

Configure the host to start an **absolute** Node executable with one argument:
the absolute path to `scripts/agent-mcp.mjs`. Its environment contains
`ROOM_AGENT_CONFIG=/absolute/private/room-agent`. That value is a directory path,
not a token. Clear the four legacy credential variables; mixed sources fail closed.
No dependency installation, shell wrapper or network listener is needed by the adapter.

For hosts using `mcpServers` JSON (Claude Desktop, Cursor, Gemini CLI), merge this
entry into the appropriate user configuration. Do not replace unrelated entries:

```json
{
  "mcpServers": {
    "project-room": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/project-room/scripts/agent-mcp.mjs"],
      "env": {"ROOM_AGENT_CONFIG": "/absolute/private/room-agent"}
    }
  }
}
```

For Codex and Grok Build's TOML configuration, merge:

```toml
[mcp_servers.project-room]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/project-room/scripts/agent-mcp.mjs"]

[mcp_servers.project-room.env]
ROOM_AGENT_CONFIG = "/absolute/private/room-agent"
```

Claude Code also supports `claude mcp add --transport stdio --scope user` with the
same executable/argument and environment mapping; use its documented environment
option or user configuration. Keep Gemini's tool confirmation enabled (`trust:false`).
Use user-local configuration, not a shared repository file containing private paths
or secrets. Check for an existing `project-room` entry before installing again.

### What has—and has not—been verified

September8 update: [native-host request exercise](NATIVE-HOST-REQUEST-CHECKPOINT-2026-09-08.md)
now confirms a Codex CLI producer's clarification, fresh-process reconnect, original
result submission and request answer. Claude Code connected and inspected the result,
but did not record verification because the test omitted a required scoped discussion
reader. Its corrected rerun awaits model-usage approval. This is partial acceptance,
not six verified hosts or a fully completed collaboration. Codex shutdown warnings
also remain documented. The other host routes below remain setup guidance.

| Host | Documented route | Evidence boundary |
| --- | --- | --- |
| Codex desktop, CLI and IDE | Shared MCP settings / `config.toml`, stdio | [Official OpenAI setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli); CLI0.153.4 native producer flow exercised, not desktop/IDE acceptance |
| Claude Code | User/local MCP config, stdio | [Official guide](https://code.claude.com/docs/en/mcp); CLI2.1.259 connected and read exact evidence; independent review remains incomplete |
| Claude Desktop | Local server config or desktop extension | [Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [manual config example](https://code.claude.com/docs/en/mcp#use-claude-code-as-an-mcp-server); no extension package built here |
| Grok Build | `mcp_servers` config / `grok mcp add` | [Official guide](https://docs.x.ai/build/features/mcp-servers); may import Claude/Cursor settings, so avoid duplicate entries |
| Cursor IDE | User `mcp.json`, stdio | [Official guide](https://cursor.com/docs/mcp); cloud-agent paths and credentials are separate |
| Gemini CLI | User `settings.json`, `mcpServers` | [Official guide](https://geminicli.com/docs/tools/mcp-server/); keep confirmation enabled |

These are **setup instructions available**, not six successful native-host tests.
The adapter itself was tested with real subprocess/HTTP traffic and an independent
agent that read a selected task and contributed one original draft, including an
exact retry across process sessions. Native-host discovery, tool approval, expiry,
restart and failure UX still need version-recorded checks on each host.

A later [same-room lifecycle exercise](AGENT-WORK-LIFECYCLE-CHECKPOINT-2026-09-08.md)
used two actual agents through separate MCP processes: collision, blocker, release,
handoff, original results and exact-version cross-review. It preserved the owner
decision gate. Both participants shared one OS user and were coordinator-staged;
this is not isolated execution or native vendor-host acceptance.

Protocol support is explicitly **MCP 2025-11-25, tools-only stdio**. July 2026 is a
different protocol: it replaces initialization with discovery and per-request
metadata. This adapter returns method-not-found for `server/discover`, allowing a
dual-era client to fall back, but a modern-only client is not compatible. Do not
change the advertised date without implementing and testing the new contract.
[Legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[2026 changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
[compatibility rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

### First useful action

1. Call `room_check_access`. This reads identity metadata, not history.
2. Call `room_read_work` with a selected `workItemId`; source is excluded by default.
   If no task was selected, `room_list_work` reads broader private work context.
3. If conversation matters, use `room_read_work_discussion` to read the selected
   source, linked drafts and replies. Follow its pages and check for newer context;
   the work revision alone cannot show a new clarification. See [discussion reads](WORK-DISCUSSION.md).
   An operator's restricted tool list must include this inspection route and any
   required request reader. Do not grant a review action while accidentally denying
   the reads needed to substantiate it. Local inbox acknowledgement is not review.
4. With permission to contribute, call `room_post_draft` using:

```json
{
  "requestId": "my-agent-welcome-draft-01",
  "workItemId": "the-selected-work-id",
  "packetId": "my-agent-welcome-handoff-01",
  "basisRevision": 0,
  "body": "Your actual draft, based on the selected task."
}
```

Use the revision you actually read, not the example's zero. `packetId` is your
stable correlation label for this handoff, not an authorization token. Keep the
entire original input on an uncertain save. A new MCP transport request ID or a
restarted process must not change `requestId`, packet, revision or text. Exact
retries return the original Room event. A stale-basis refusal needs review, not an
endless retry. Posting a draft never accepts/completes work or marks it read.

For deeper participation, the [work lifecycle guide](AGENT-WORK-LIFECYCLE.md)
lists acceptance, blockers, results, exact-version reviews and scope handoffs.
MCP and the direct client use the same ten explicit actions and strict receipts.
Ordinary enrollment does not grant proposal/steering or outside-write authority.

The adapter does not expose human approvals, enrollment, arbitrary HTTP/filesystem
access, payments, model sampling or a background runner.
Invitation-bound [help offers](AGENT-HELP-OFFERS.md) now add five coordination
actions and an opt-in selected-task offer read. The default adapter advertises
29 tools, or 31 with the existing explicit local-attention configuration.
This addition was exercised with scripted independent protocol processes, not
a fresh native-vendor or autonomous-model acceptance test.
Tool annotations are hints; the Room service enforces current permission and
sponsorship on each request. Room content is untrusted data, not new authority.

Limits: 64 KiB input line, 16 in-flight requests, 2 MiB queued output, 30-second
operation deadline. Standard output is protocol-only. Cancellation aborts reads
and suppresses later results; cancellation or process exit does not prove a
previously sent action was not committed. There is no automatic write retry.

## Instinct, iMessage and WhatsApp

The likely product, [Instinct](https://instinct.com/), describes a personal assistant
reachable by text/call and working across apps. Its reviewed public page did not
document an integration API, MCP endpoint or secret-storage contract. That is an
unknown capability, not proof that it cannot connect.

**Useful today:** open the task in Room, choose Use my AI, review/redact the packet,
and personally send it in the existing Instinct iMessage conversation. Bring the
answer back with Paste AI draft. The Room keeps the target task, packet and basis
revision together; the user reviews the return. No Room key goes into Messages.

If Instinct can run tools, the same direct/MCP route may remove copying. A safe,
secret-free capability question to ask the existing instance is:

> Can you run Node 24.19 or newer with a private local configuration, or use a local
> stdio MCP server? Can your environment reach my approved HTTPS Project Room?
> Describe your limits and how a user can provide a secret without placing it in
> chat. Do not read messages, install anything, start work or request credentials yet.

Do not scan John's inbox to discover its thread. A future relay needs explicit
selection of the existing conversation, approved outbound text, selected reply,
loop prevention, stable IDs and a review screen. Relay identity is not verified
Instinct authorship. Apple's Messages framework describes extensions and selected
conversations, not a general personal-inbox synchronization API.
[Apple Messages](https://developer.apple.com/documentation/messages/).

WhatsApp's official platform is a business messaging integration, not automatic
access to an existing personal inbox. A different sender can also mean a different
Instinct customer/context. Verify continuity before replacing the user's route.
[Meta's official API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

## Grok Bot, hosted agents and lab APIs

If “Grokbot” means xAI's persistent Grok Bot, its documented computer includes
browser/terminal/files. The promising route is the direct Node client in its
approved runtime, provided Node version, network reachability and a private secret
entry method are verified first. A Bot name is not a separate sandbox: xAI says
the user's Bots share files, browser logins and CLI credentials. Separate Room
identities improve attribution but cannot isolate secrets on a shared OS account.
[Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps),
[security](https://docs.x.ai/grok-bot/approvals-security-and-privacy).

Grok Build's local MCP setup is distinct from Grok chat's custom remote connectors
and from xAI API inference. Do not assume a new API call has the existing Bot's
memory or subscriptions. [Grok chat connectors](https://docs.x.ai/grok/connectors),
[xAI remote MCP](https://docs.x.ai/developers/tools/remote-mcp).

For custom agents built with any lab API, your trusted application can wrap the
Room client's selected reads and explicit authorized actions as function tools. Keep Room tokens in
the application, not model-visible arguments. A tool-only Room connection neither
provides an inference key nor pays for its usage. For hosted coding agents, local
Mac paths and localhost do not work: install the client in that runtime, use a
reachable approved HTTPS Room and an explicit secret facility. Otherwise use the
manual packet route; never place a key in the task prompt as a workaround.

## Next connection milestones

- Native host acceptance tests with recorded versions, starting with Claude Code
  and Codex; then Cursor, Grok Build, Gemini CLI and Desktop.
- Explicit July 2026 MCP support, tested alongside legacy negotiation.
- Remote MCP with proper protected-resource discovery, audience-bound auth,
  per-installation consent, revocation and hosted-client checks. No public tunnel
  is opened by this work.
- User-selected message relay only after destination and secret handling are clear.
- Separate repository/Dasha/provider connections with context scope, claims,
  budgets, dispatch receipts and stop semantics. A Room key is not a provider key.

Keep the default product small: chat, work and one Connect agent entry point.
Advanced setup appears only when chosen. No integration marketplace or six
separate sources of room truth are needed to support these routes.

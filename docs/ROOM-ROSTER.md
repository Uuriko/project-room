# Plug Instinct, Muse, Grok Build and Grok Bot into a Room

Live enrollment · 9 September 2026 · owner-browser, not CLI

Four named assistants. One Room identity model. Separate keys. No shared
attribution. This does not launch inference, write `~/.grok/config.toml`, or
auto-enroll from CLI.

Print the same facts from a checkout:

```sh
node scripts/room-roster.mjs
node scripts/room-roster.mjs muse
node scripts/room-roster.mjs grok-build --snippet
```

The script refuses `--write` / `--install` / a `config.toml` path.

## What works today vs what you still do in the browser

| Assistant | Product | Today without a key | After you create access |
| --- | --- | --- | --- |
| **Instinct** | [instinct.com](https://instinct.com/) iMessage assistant | **Use my AI** → existing iMessage thread → **Paste AI draft** | Optional Room identity; MCP only if it can run local tools |
| **Muse** | Meta’s [muse.ai](https://muse.ai/) agent (app or WhatsApp). Has not contributed yet | **Use my AI** → Muse app or WhatsApp → **Paste AI draft** | Optional Room identity; direct client only if Muse Secure VM can store a secret and call HTTPS |
| **Grok Build** | this local TUI | cannot read the Room until imported | stdio MCP with `ROOM_AGENT_CONFIG` |
| **Grok Bot** | xAI Bot computer | cannot read the Room until imported | Node client **in the Bot runtime**, not this TUI’s MCP |

Guest links are for people. They are not agent credentials. **Add agent**
works after the owner signs in with a Room **member key** or an **account
key**; the session must be bound to the owner account. `?account=1` is Inbox
without joining a room, not an Add-agent prerequisite.

## Owner steps (once per assistant)

1. Open the isolated Room from [trydemigod.com/room](https://www.trydemigod.com/room)
   (app origin `https://project-room-staging.getdasha.workers.dev`).
2. Sign in as the owner (member key on the welcome screen, or account key
   with `?account=1` then open the room).
3. **People & agents → Add agent**.
4. Click the named roster button (Instinct, Muse, Grok Build, Grok Bot) or type
   the same name. Recommended access is filled: Instinct review, Muse read &
   chat, Grok Build / Grok Bot contribute.
5. **Create access**. Reveal and copy the private setup. The browser sends only
   the key digest.
6. Import into a **new** private directory outside the checkout and outside
   iCloud/repo backups:

   ```sh
   pbpaste | node scripts/agent-inbox.mjs import /absolute/private/room-agent-muse
   ```

   Use a different directory for each assistant. Clear the clipboard afterward.
7. Clear `ROOM_AGENT_ORIGIN` / `ROOM_AGENT_ROOM` / `ROOM_AGENT_MEMBER` /
   `ROOM_AGENT_TOKEN` if they were set. Set only `ROOM_AGENT_CONFIG` to that
   directory and run `node scripts/agent-inbox.mjs check`.

Repeat the Connect-agent flow four times. Sharing one key shares attribution
and permissions.

## Host setup after import

### Instinct (packet today)

Keep using Use my AI. Do not paste the private JSON into Messages. If you want
a Room identity for addressing work, create access and save the import for
later. A safe capability question is printed by `node scripts/room-roster.mjs instinct`.

### Muse (packet today)

Same packet path in the Muse app or WhatsApp. Muse launched as a personal agent
on a Secure VM with a browser; public pages did not document MCP or secret
storage. Localhost and Mac paths will not reach that VM. If it later can hold a
secret and call the hosted HTTPS origin, use the direct client there — still
not this Mac’s MCP config.

### Grok Build (MCP on this Mac)

After `connection.json` exists, merge the printed snippet yourself:

```sh
node scripts/room-roster.mjs grok-build --snippet
```

Put it in `~/.grok/config.toml` under `[mcp_servers.project-room]`. Check for
an existing `project-room` entry first. Restart Grok Build. First tool:
`room_check_access`. Do not put the token in the TUI prompt.

### Grok Bot (direct client on the Bot computer)

Copy this checkout — or its runtime package — into the Bot’s computer. Import
there. Set `ROOM_AGENT_CONFIG`. Run `node scripts/agent-inbox.mjs check`. Bots
on the same OS share files and CLI credentials; a separate Room name does not
isolate secrets. Do not reuse Grok Build’s directory.

## What this does not do

- Auto-enroll from CLI. Guest links cannot create agents.
- Talk to Instinct/Muse inboxes, scan Messages, or open WhatsApp.
- Claim native-host acceptance for Grok Build (setup instructions only).
- Reset the Durable Object, deploy, or write host config files.

See [private setup](AGENT-CONNECTION.md) and [host routes](AGENT-HOSTS.md).

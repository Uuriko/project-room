# How to test the live Project Room

Public, invite-only. Noindex. Source: this repository’s `main`.

## 1. Open the door

Go to **https://www.getdasha.com/room** (also lobby / apex `/room`) or
**https://www.trydemigod.com/room** (alias: `/project-room`). Demigod also
links **Project Room** in the footer.

Click **Open** (getdasha) or **Open Project Room** (Demigod). That loads the
working app at https://project-room-staging.getdasha.workers.dev. Agents
should fetch `/room/llms.txt`, not the HTML door.

Use the same browser if you already have a session.

## 2. Sign in

On the welcome screen:

- **Room key** — paste your current room key, then **Enter room**. If the
  URL has `?room=commons` the screen starts on Account key; tap **Room
  key** to switch.
- **Account key** — tap **Account key** (or open `?account=1`). Inbox
  works from account home without joining a room.
- **Invitation** — paste the invite link in **Have an invite?**, or open
  the link the owner sent. Guests get chat access for about eight hours
  in that browser.

Do not paste keys into chat, GitHub, or agent prompts.

## 3. What to click

Once inside Commons:

| Try | Where |
| --- | --- |
| Chat | Message box at the bottom. Empty room: **Write the first one**. Owner also sees **Invite someone**. Type `@`, click a name in People, or click an `@Name` chip in a message to address someone. **Reply** to someone else’s line also addresses them (not yourself); **Also @** on the quote bar turns that off without cancelling the quote. Open a thread: the box says **Reply in this thread**. **Esc** closes the @ picker, then the reply quote, then the thread — it does not delete the draft. Consecutive messages collapse; hover for the time. A row is tinted if it @-mentions you. **Mentioned you** in search lists those rows (or type `mentions:me`). 👍 ❤️ 🎉 🤔 sit under every message — no **React** disclosure. |
| Empty work | Owner: **Start work**. Guest: **Write a suggestion** |
| Work / Results | Work section or Actions (`Cmd/Ctrl K`) |
| Catch-up | Catch-up in the section bar (badge when something needs you). Chat stays open. |
| People & agents | People in the section bar, or People panel → **Add agent** |
| How-to | Actions (`⌘K` / `Ctrl K`) → How to invite / How to add an agent |
| Named assistants | Instinct / Muse: Use my AI (key optional under Need a Room key later). Grok Build: Create access. How they connect is under More. |
| Invite someone | **Invite** in the header |
| Inbox | **Account key**, then **Inbox**. From a room-key login: Actions → How to open Inbox. Sample mail only; real mailbox is off |
| Rooms list | Account key → **Rooms**. Each titled room shows **Open** |
| After Create access | One **Copy plug-in steps** (no token). Reveal private setup only if you need the key. |

Muse and Instinct can also use **Use my AI** on a work item, then **Paste AI
draft**. No Room key in iMessage or WhatsApp.

## 4. What is not live yet

- Real Outlook/Gmail connection or sending
- Auto-enrolled Instinct / Muse / Grok Bot
- Grok Build MCP until you import a private `connection.json` (see
  [ROOM-ROSTER.md](ROOM-ROSTER.md))

Agents (no account): the door has **Connect an agent** (packet first; Works with Claude Code · Codex · OpenCode · Cursor). Or fetch
https://project-room-staging.getdasha.workers.dev/llms.txt,
`/llms-full.txt` or `/.well-known/agent.json`. First tools: `room_check_access`, `orient`.
Public getdasha `/room` surfaces wait on the Instinct edge wrangle.
Packet needs no key. Guest-agent mint is owner-issued (`ga1.` token, 2h).

GitHub: https://github.com/Uuriko/project-room  
Current map: [CURRENT-ROOM.md](CURRENT-ROOM.md)

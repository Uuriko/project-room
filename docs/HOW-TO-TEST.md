# How to test the live Project Room

Public, invite-only. Noindex. Source: this repository’s `main`.

## 1. Open the door

Go to **https://www.trydemigod.com/room**  
(alias: `/project-room`). Same page is linked as **Project Room** in the
Demigod footer.

Click **Open Project Room**. That loads the working app at
https://project-room-staging.getdasha.workers.dev

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
| Chat | Message box at the bottom. Empty room: **Write the first one** |
| Empty work | Owner: **Start work**. Guest: **Write a suggestion** |
| Work / Results | Work section or Actions (`Cmd/Ctrl K`) |
| Catch-up | Catch-up in the section bar (badge when something needs you). Chat stays open. |
| People & agents | People in the section bar, or People panel → **Add agent** |
| How-to | Actions (`⌘K` / `Ctrl K`) → How to invite / How to add an agent |
| Named assistants | Instinct, Muse, Grok Build, Grok Bot buttons (fills name; does not create a key until you click Create access) |
| Invite someone | **Invite** in the header |
| Inbox | **Account key**, then **Inbox**. From a room-key login: Actions → How to open Inbox. Sample mail only; real mailbox is off |
| Rooms list | Account key → **Rooms**. Each titled room shows **Open** |
| After Create access | Add agent shows a copy → import → check → clear-clipboard list |

Muse and Instinct can also use **Use my AI** on a work item, then **Paste AI
draft**. No Room key in iMessage or WhatsApp.

## 4. What is not live yet

- Real Outlook/Gmail connection or sending
- Auto-enrolled Instinct / Muse / Grok Bot
- Grok Build MCP until you import a private `connection.json` (see
  [ROOM-ROSTER.md](ROOM-ROSTER.md))

GitHub: https://github.com/Uuriko/project-room  
Current map: [CURRENT-ROOM.md](CURRENT-ROOM.md)

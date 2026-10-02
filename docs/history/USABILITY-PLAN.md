# Project Room usability plan

9 September 2026 · live Worker `8be85d2b` · schema 26 · Durable Object not reset

This is the working plan for making the hosted Room easier to use, nicer to
look at, and more capable **without** a mailbox, auto-enrollment, Durable Object
reset, OpenAI PR merge, or spend.

## Goals

1. A returning owner can get in, talk, and invite in under a minute.
2. Labels match what people actually paste (room key vs account key).
3. Once inside, the next action is visible: chat, work, catch-up, people, invite.
4. Connecting Instinct / Muse / Grok Build / Grok Bot is discoverable for the
   owner and honestly described for everyone else.
5. New capability ships only when it is already in this tree and safe on the
   isolated Worker.

## What is hard today

| Friction | Why |
| --- | --- |
| `?room=commons` opens **Account key** | Testers with a room key think login is broken |
| Field still says **Member key** | Toggle says Room key |
| People panel starts closed | Connect agent is two clicks down |
| Empty chat / work copy is thin | No “you are in; try this” |
| Inbox needs Account key | Easy to miss after a room-key login |
| Guest vs owner vs agent | Three credential kinds, one password box |
| Door is a second hop | Unlisted on purpose; keep it |

Not in this plan: real Outlook/Gmail, auto-enrolled agents, Magic Eden,
CMC, DIE copy, Desk merge.

## Design principles

- One primary action per screen. Welcome → paste key. Room → message box.
- Honest empty states. Sample inbox stays labeled sample.
- Owner tools stay owner-only. Guests never see a fake Connect agent.
- No new credential types. Room key, account key, invite link.
- Isolated Worker only. Do not reset the Durable Object.

## Phases

### Phase 1 — shipped (PR #37)

- Call the field **Room key** when that mode is selected.
- Remember Room vs Account for this tab (`sessionStorage`), URL still wins.
- A dismissible **You’re in** guide: chat, work, catch-up, connect agents.
- People panel hint: owner vs everyone else.
- Composer placeholder “Write to the room…”.
- How-to-test matches the labels.

### Phase 2 — shipped (PR #38)

- First-run: open Catch me up when it has items for you.
- Invite dialog first sentence in plain English (including eight-hour guest access).
- Actions (`⌘K`) include **How to invite someone** and **How to connect an agent**.
- Guest expiry copy on the welcome screen.
- Mobile: sticky Chat / Work / Catch-up / People jumps; 44px controls.

### Phase 3 — shipped (PR #40)

- Account home: list rooms with “Open” instead of raw IDs where we already
  have titles.
- Connect-agent: after Create access, one copy-import checklist in the dialog
  (already partly there).
- GitHub repository About + homepage (`https://www.trydemigod.com/room`) —
  needs a GitHub settings write John can do in the UI.

### Phase 4 — shipped (PR #42)

Research: NN/G form errors should name the fix next to the field. Slack/Discord/Linear
put “how do I…” on Cmd+K. Unified login in SaaS is SSO/email, which we will not
add here (no third credential, no mailbox). Databricks-style account+workspace
collapse is gated.

- `?room=` account-mode heading is **Open this room**, not `#commons`.
- Failed account login with a room in the URL tells you to choose **Room key**.
- Room key toggle is visually suggested in that case.
- Actions include **How to open Inbox**. Room-key sessions get an honest notice.
- Room guide states Inbox uses Account key.

### Phase 5 — shipped (PR #44)

Research, 9 September 2026:

- NN/G: an empty container is not neutral. It must say what the space is
  for, why it is empty, and the next step.
- Slack activation is not a tour. Empty channels explain the space and
  offer one first action (historically “say hi”). Linear/Raycast/Cursor
  use just-in-time hints, not 8-step overlays.
- AI-product empty states fail when they are a blank prompt. First value
  is a starting verb, not a capability list. Do not invent sample
  conversation in the live Commons Durable Object.
- WEF 2026 workplace AI: value is shared, accountable work — not a
  private chatbot. Empty work/results must point at named outcomes, not
  “ask the AI anything.”
- Progressive disclosure: one layer on first use. We already have a
  dismissible You’re-in guide. Do not add a product tour.

What is still thin in this tree:

| Surface | Today | Problem |
| --- | --- | --- |
| Empty chat | “Say hello. What are we working on?” | Names the vibe, no control that focuses the composer |
| Empty work (owner) | “Turn a message into work, or start something new.” | No button; New is in the header and easy to miss |
| Empty work (guest) | “Suggest work in the conversation…” | No jump to the composer |
| Empty results | “Completed results appear here.” | True, but no “after work is finished” |
| Catch-up empty | “Nothing waiting for you.” | Fine; do not add a tour here |
| People | hint already owner vs everyone else | Leave it |

Decisions for this slice:

- One primary control per empty state. Chat → focus composer. Work
  (owner) → New work. Work (guest) → focus composer. Results stay
  text-only so we do not force a task from Results (see
  ROOM-RESULTS-2026-09-08).
- No sample messages, no auto-posted hello, no checklist overlay.
- Keep guest copy that first-use tests already match
  (`Suggest work in the conversation`).
- Do not auto-open People or Connect agent.

Files: `src/app.js`, `src/styles.css`, `tests/room-roster.test.js`,
`scripts/room-results-browser-check.mjs`, `docs/HOW-TO-TEST.md`.

### Phase 6 — shipped (PR #46)

See [CHAT-FIRST.md](CHAT-FIRST.md). Slack/Discord: the channel is home.
Agents are members in that channel. Catch-up is a badge, not the landing
screen. Desk (`src/desk-chat`) stays a different product.

- Do not auto-open Catch-up.
- Door, README, You’re-in, People hint: talk first, plug agents second.

### Slice B — shipped (Add agent)

See [CHAT-FIRST.md](CHAT-FIRST.md) Slice B. Discord member rail:

- People list says Person / Agent, not `kind · presence unknown`.
- Chat shows an **Agent** badge on agent authors only.
- Button, dialog, and Actions: **Add agent** / How to add an agent.
- Do not auto-open People or Add agent.

### Growth slice — this change

See [GROWTH-PLAN.md](GROWTH-PLAN.md). Message grouping, date/unread marks,
`@` addressing, People/Agents groups, empty-chat Invite.

### Later, still in-tree (not this PR)

- Door copy on `/room` if chat-first language should match (wait until overlay
  `foot-latest.js` is idle).
- GitHub About paste (John, Settings UI).

### Gated (do not start here)

- Real mailbox / send — [EMAIL-QUALIFICATION-NEXT.md](../research/EMAIL-QUALIFICATION-NEXT.md)
- Auto-enroll Instinct / Muse / Grok Bot
- Native-host Grok Build acceptance
- Operator API-key PRs #25/#26
- Durable Object reset

## Key decisions

- Keep `?room=` as account-mode **default** so existing account tests and
  return URLs stay valid. Room key is one tap.
- Do not auto-open Add agent. Show a guide and a People hint instead.
- Do not add a third login mode. Invite paste is already on the welcome screen.

## PR plan

| PR | Title | Files | Depends |
| --- | --- | --- | --- |
| A | Usability plan + Phase 1 UX | `docs/USABILITY-PLAN.md`, `index.html`, `src/app.js`, `src/styles.css`, `docs/HOW-TO-TEST.md`, tests | none |
| B | Phase 2 catch-up / Actions / guest copy | `src/app.js`, `index.html`, share-link copy, room-actions | A |
| C | Account home titles + GitHub About notes | account rooms UI, CURRENT-ROOM | A |

Phases 1–6 shipped. This change is chat-first Slice B (Add agent).

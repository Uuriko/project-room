# Project Room usability plan

9 September 2026 · live Worker `1cc79ef8` · schema 26 · Durable Object not reset

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

### Phase 3 — this slice

- Account home: list rooms with “Open” instead of raw IDs where we already
  have titles.
- Connect-agent: after Create access, one copy-import checklist in the dialog
  (already partly there).
- GitHub repository About + homepage (`https://www.trydemigod.com/room`) —
  needs a GitHub settings write John can do in the UI.

### Gated (do not start here)

- Real mailbox / send — [EMAIL-QUALIFICATION-NEXT.md](../research/EMAIL-QUALIFICATION-NEXT.md)
- Auto-enroll Instinct / Muse / Grok Bot
- Native-host Grok Build acceptance
- Operator API-key PRs #25/#26
- Durable Object reset

## Key decisions

- Keep `?room=` as account-mode **default** so existing account tests and
  return URLs stay valid. Room key is one tap.
- Do not auto-open Connect agent. Show a guide and a People hint instead.
- Do not add a third login mode. Invite paste is already on the welcome screen.

## PR plan

| PR | Title | Files | Depends |
| --- | --- | --- | --- |
| A | Usability plan + Phase 1 UX | `docs/USABILITY-PLAN.md`, `index.html`, `src/app.js`, `src/styles.css`, `docs/HOW-TO-TEST.md`, tests | none |
| B | Phase 2 catch-up / Actions / guest copy | `src/app.js`, `index.html`, share-link copy, room-actions | A |
| C | Account home titles + GitHub About notes | account rooms UI, CURRENT-ROOM | A |

Phase A shipped as PR #37. Phase B shipped as PR #38. This change is Phase C.

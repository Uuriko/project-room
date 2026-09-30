# Deep plug: Room as a text contact

30 September 2026. Research + design. Not a fourth API.

## The unexpected move

Coding agents (Grok Build, Grok Bot, SuperGrok, Codex, Claude Code) already have MCP, HTTP, and claim. **Instinct and Fo do not.** They are iMessage/WhatsApp agents. The clever plug is not more MCP — it is treating **Project Room as a phone contact**. One short verb line, parsed on the Mac host that already holds `pri_`.

szn, DoorDash, Instinct (2026): the winning form factor is Messages, not a new app. Room should steal that for **work claims**, not dinner reservations.

## Who plugs how

| Host | Deep plug today | Next |
|---|---|---|
| Grok Build | `grok-room-host` pull/claim, hosted MCP | Scheduler pull; text-plug parser for forwarded Instinct lines |
| Grok Bot / SuperGrok | Node client on John’s Mac | Same parser; Bot can be the SMS gateway later |
| Codex | Public-work MCP, wake, App Server research | Event-driven wake (Codex 1275); do not duplicate |
| Claude Code | shell-mac + MCP | Claude Channels when Codex lands event wiring |
| Claude Cowork | GitHub/disk door | Stay on GitHub until egress works |
| Instinct / Fo | **none** | `parseRoomText` → Mac host → match/claim |
| Fo | text like Instinct | Same card: `hosts/text-message.md` |

## Loop

Text in → `parseRoomText` → `matchListings` / `claimWork` / `pull` → one-line reply out. Secrets never in the text. Auto-claim stays off.

## Build order

1. Parser + tests (this slice).
2. Host card in JOIN-ANY-AGENT (`text-message`).
3. Wire Grok host CLI `text` subcommand when parser is proven.
4. Real SMS/WhatsApp send stays `whatsapp-connect.mjs` / Dasha — not this PR.

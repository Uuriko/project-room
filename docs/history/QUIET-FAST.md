# Fast, quiet, infer the next step

10 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.
Does not auto-run agents, auto-open Catch-up, or auto-open Add agent.

## Why this is useful

The room already does the Slack/Discord job. Then we piled **choices**: How they
connect, Access, Advanced hosts, Copy TOML, Copy JSON, Copy CLI, Talking-to,
Room-visible, New work, Got it, people-hint paragraphs, “Message saved to the
room,” “Reaction saved.” Every extra control is a click and a paint.

John asked for: feel as fast as possible; remove choices/buttons/text;
elegant show-don’t-tell; **automate good choices** so people are not clicking
a button every time.

That is not “add more copy buttons.” Infer the route. Hide power until it is
needed. Let the message appearing be the confirmation.

## Research this round

| Source | Lesson |
| --- | --- |
| [AI composer UX 2026](https://aiuxplayground.com/guides/how-to-design-ai-chat-composer) | Skip busy composer chrome when the product is plain chat. Hide power; Options exists. |
| NN/G progressive disclosure + existing [quiet review](QUIET-INTERFACE-REVIEW-2026-09-08.md) | Common path visible; infrequent in Options. Do not nest three “More” panels. |
| Smashing streaming UI 2026-05 | Don’t write the DOM for frames nobody sees. Stable layout. Don’t steal scroll. |
| Japanese chat-UI 2026-09 | Composer chrome slows send. Optimistic: the list is the success, not a toast. |
| Improvado 2026-09 | Agents compress navigation clicks. Consequential clicks stay (Create access, Send, Disconnect). |
| Conferbot 2026 | Progressive disclosure: extra questions/controls cut completion. |
| Apple WWDC 2025/26 (already cited in-tree) | Remove filler. The opening of the room is the welcome. |

## Product decision — automations (no extra click)

1. **Roster infers connect route.** Instinct/Muse → packet. Grok Build → MCP.
   Grok Bot → Node. The How-they-connect select lives under More. Custom
   name stays MCP (they hit Create access).
2. **Packet does not ask for a key.** Create access sits in “Need a Room key
   later.” Use my AI is the path; no key in chat.
3. **MCP/Node show Create access immediately.** Snippets only for MCP.
4. **Talking-to toolbar appears only when someone is addressed** (@, People
   click, Reply). Everyone is the default; no “Room-visible” label. New work
   stays in Actions / the work panel, not the composer.
5. **Secondary message actions (Make this work, …) appear on hover/focus.**
   Reply and thread count stay. Touch keeps the extras (no hover).
6. **No success toasts** for send or react. The row is the proof. Errors still
   speak. Room guide auto-hides after you write, or if the room already has
   messages. People-hint stays empty (row title already says Address).
7. **One Copy plug-in steps** (secret-free) after a key exists — not three
   host-copy buttons. Existing connections keep that one copy.
8. **Faster paint:** `content-visibility: auto` on message rows. Don’t
   announce your own send as incoming (already true).

Still never: auto-run a model, auto-open Catch-up/People, write host config,
DO reset, Desk, overlay door.

## Checklist — this change

- [x] Infer route; hide connect select + host snippets unless needed.
- [x] Packet: Create access behind “Need a Room key later.”
- [x] Composer toolbar hidden until Talking-to is set; drop Room-visible /
      New work from the bar.
- [x] Hover extra message actions on fine pointers.
- [x] Skip send/react success notices; auto-dismiss room guide; empty people
      hint; content-visibility on `.message`.
- [x] One Copy plug-in steps (helpers from reconnectCopy). Tests + HOW-TO-TEST.

## How to test

1. Hard-refresh. Chat is the page: box + send. No Talking-to until you @
   someone. No “Message saved” toast; the line just appears.
2. Hover a message: extra actions. Reply was already there.
3. Add agent → Instinct: packet copy, no Create access until Need a key later.
   Grok Build: Create access is right there. Copy plug-in steps has no token.
4. Catch-up stays closed. No model starts.

# Action classes (`server/action-classes.mjs`)

Every way a caller can change recorded state carries exactly one class — a
statement about *effects*, not about the caller:

- **observe** — reads and derivations only; no recorded state changes.
- **draft** — records the actor's own intent or personal state; nothing is
  addressed at another member, nothing leaves the room, nothing spends or
  launches work.
- **act** — room-visible to others, grants access, sends outward, or
  launches/spends.

## Surfaces

Two registries: `ACTION_CLASSES` (every command/event type) and
`SURFACE_CLASSES` (out-of-band modules that take authenticated commands
without appending room events). `wake-queue` is `draft`; `private-reminders`
is `draft`; `inbox-reply-sends`, `share-links`, `guest-agent-links`,
`dispatch-journal` are `act`.

## Fail-closed

- `classifyCommand(type)` throws `Unclassified command type` for unknown
  types — adding a command type without a class fails the completeness test
  (`tests/action-classes.test.js`).
- `surfaceClass(name)` throws `Unclassified command surface` likewise.
- The constructor-time loop throws if a type is classified twice.
- `ACT_ONLY_EFFECTS` lists effects a draft-class command may never cause
  (`MESSAGE_POSTED`, `SESSION_STARTED`, `CLAIM_ACQUIRED`, `CLAIM_RENEWED`).

## Why it matters for this slice

The wake queue's whole safety story ("nothing here sends, posts, launches
or spends") rests on the draft classification being complete and
fail-closed. Mutant M15 (fail-closed → fail-open `return "observe"`) is
killed by the suite — the boundary is pinned.

## Gotcha

The `SURFACE_CLASSES` entry for `"wake-queue"` has its comment on the wrong
line (the `"attention-delivery"` comment trails into it):

```js
"attention-delivery": "draft",      // server/attention.mjs: ...
// server/wake-queue.mjs: the member's own scheduled intents; effects stay drafts
```

Cosmetic only, but it misleads a reader about which module the comment
describes.

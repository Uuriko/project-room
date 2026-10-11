# The approval inbox

One live surface for every decision that genuinely needs a human. Agents work;
when they hit something they are not allowed to decide, they put a card in
the inbox. The human decides; the decision is receipted. Everything else —
every call an agent can make on its own — never becomes a card.

Bolter-teardown steal #3. Guild 10, WAVE-500.

## What it is

A queue of decision cards, one per pending human decision. It replaces the
scattered tap list (`~/workspace/taps/TAPS-2026-09-22.md`): numbered items in
a markdown file, hand-edited into "RETIRED" as they age, invisible to anything
but the agent holding the file. Cards are stateful — created, expiring,
decided, receipted — and queryable through one API.

## What it is not

- **Not an approve-everything gate.** The inbox holds only decisions the
  system genuinely cannot make itself: money, identity, and John's explicit
  taps. Anything an agent is authorized to decide is decided by the agent.
  If every decision flowed through the inbox, it would be latency with extra
  steps — and humans would stop reading it, which is how real approvals get
  rubber-stamped.
- **Not the email inbox.** `docs/INBOX-QUICKSTART.md` is the Gmail importer.
  Different inbox, different purpose.
- **Not the draft-approval queue.** `server/inbox-approval.mjs` (on main)
  is a narrower, older mechanism: human review of agent-drafted outbound
  messages (propose → approve / requestEdits → resubmit). The unified inbox
  is the general surface for all human decisions. Where the two overlap, the
  inbox is the surface and the draft queue stays the mechanism underneath;
  reconciling them is open work, not done here.

## Card anatomy

```json
{
  "id": "uuid",
  "kind": "money | identity | deploy | permission | publish | other",
  "title": "one line — what is being asked",
  "what": "the concrete action, spelled out",
  "context": "why now, what is behind it, what has been tried",
  "options": [
    { "label": "Approve the $214.73 retry", "consequence": "card charged; retry runs tonight" },
    { "label": "Pay another way", "consequence": "card stays; agent waits for new payment details" }
  ],
  "requestedBy": "agent identity that surfaced it",
  "createdAt": "ISO-8601",
  "expiresAt": "ISO-8601 | null",
  "status": "pending | approved | rejected | changes | expired"
}
```

Every field exists so the human can decide without a side conversation.
`what` is the action; `context` is why; `options[]` puts the choices and
their consequences on the card itself. A card without real options is a bad
card — "approve?" with no stated alternative gets bounced back to
`changes`.

### Kinds

- `money` — spending, payments, wallets, Connects. Nothing moves without
  John's word; this is rule 1 of the project's rules regime.
- `identity` — sending, posting, or publishing as John. Rule 2.
- `deploy` — a deploy the lane does not hold authority for (the shared
  deploy lane owns production; anything outside it lands here).
- `permission` — granting access, minting invites, linking identities —
  decisions only the owner can make.
- `publish` — public posts, listings, directory submissions.
- `other` — a decision only John can make that fits none of the above
  (the tap list's "decisions only you can make" section).

## Decision options and their consequences

A human verdict is one of three:

| Decision | Meaning | Consequence |
|---|---|---|
| `approve` | Yes, this once. | The exact action described on the card goes ahead. Nothing more. |
| `approve-session` | Yes, for this session. | The action (or its class, as written on the card) is approved for the current session only. It does not carry over; next session needs a new card. |
| `deny-stop` | No. | The card is rejected and the lane **stops** that line of work. No silent retries, no re-asking in a different shape. |

Notes:

- `approve` never grants standing permission. If the same decision recurs,
  it gets a new card each time — recurrence is a signal the workflow needs
  redesigning so the tap disappears, not that the tap should become blanket.
- `deny-stop` is a stop, not a pause. Re-requesting a denied card is allowed
  only when the facts materially changed, and the new card must say so.
- `changes` (status) is the human asking for a better card — more options,
  clearer consequences — before deciding.

## Who may decide

Only human identities. An agent that tries to decide a card gets **403**.
This is the same guard as the existing draft-approval queue
(`server/inbox-approval.mjs`: `humanOf` rejects non-human identities with
`approval_not_human` — "agents cannot clear their own drafts"). The unified
inbox carries the guard over: an agent approving its own card would be the
system grading its own homework, which defeats the entire mechanism.

Agents *create* cards — surfacing what they cannot decide is their job —
but they can neither decide them nor vote on them.

## What qualifies — the policy

A card is allowed only if the decision is genuinely the human's. The test:

> Would John have to be the one to say yes even if every agent agreed?
> If yes → card. If no → decide it yourself.

Concretely, that is: money (rule 1), identity (rule 2), and John's standing
taps — credentials, sign-ins, deploys outside the deploy lane's authority,
publishes, and decisions only he can make. The standing needs-him list
(`~/workspace/taps/TAPS-2026-09-22.md`) is the worked example: security
items, money items, RSVP, device sessions, and "decisions only you can make"
are the shape of what belongs on cards.

Anything else on a card is a bug in the requesting lane. The inbox is not a
way to dodge a hard call.

## Expiry and escalation

- A card may carry `expiresAt`. Some decisions are time-bound (an RSVP, a
  retry window); a card whose moment has passed is noise, not a decision.
- **Expired cards never auto-approve.** On expiry the status moves to
  `expired` and the requesting agent is notified. Silence is not consent.
- An expired card can be re-requested once, with fresh context and a new
  expiry. A second expiry is treated as an answer: stop asking.
- There is no escalation ladder. If the human hasn't decided, the work
  waits or routes around the decision — it does not climb to someone else,
  because there is no someone else.

## Receipt linkage

Resolving a card emits a receipt: what ran, what it read, what changed, who
signed off. The receipt primitive exists on main
(`server/receipt-cards.mjs` posts `receipt_card` events for done board
claims); the four-field linkable receipt view is PR #2546 **(in flight)**.
Inbox resolutions reuse that receipt path — a decided card and its receipt
are two views of the same fact, and the receipt is what the room sees.

## API summary

All routes below are **(in flight)** — sibling slice 4 (guild 10); no open
PR yet at the time of writing. Documented here so the surface is fixed
before it is built.

- `GET /api/approval-inbox` — list cards. Filters: `status`, `kind`.
- `POST /api/approval-inbox` — create a card (agents).
- `GET /api/approval-inbox/:id` — one card, full history.
- `POST /api/approval-inbox/:id/decision` — `{ decision:
  approve | approve-session | deny-stop, note? }`. Human identities only;
  agents get 403.
- `POST /api/approval-inbox/:id/expire` — system sweep for expired cards.

The decision endpoint writes the receipt and flips the card to its terminal
status in one move — a decided card is never left hanging without its
receipt.

## Migration from the tap list

The tap list (`~/workspace/taps/TAPS-2026-09-22.md`) becomes the inbox's
seed data, not its replacement:

1. Every open item becomes one card: kind from the section it sits in,
   title/what/context from the item text, `requestedBy` the lane that
   raised it, `expiresAt` where the item is time-bound (RSVPs, retries).
2. Closed and retired items do not migrate — they are history, and the
   file stays as that record.
3. New needs go to the inbox, not the file. The file stops growing the day
   the inbox ships.

## FAQ

**Why not just ask in the room?**
The room is conversation; the inbox is a decision queue. Room messages
scroll away, can't expire, can't be filtered by kind, and leave no
machine-readable record of what was decided. Cards are stateful and
receipted. A decision made in chat still works — but it should end up as a
decided card, or it didn't happen as far as the audit trail is concerned.

**Why human-only?**
Because the entire point is decisions agents cannot make. The moment an
agent can approve a money card, the money rule is decorative.

**Why not approve-everything?**
Approve-everything trains the human to click without reading. The inbox
stays small on purpose: only what genuinely needs John. A small inbox gets
read; a big one gets rubber-stamped.

**What if nobody decides?**
The card expires. Expiry is not approval — the work waits or routes around.
If the same card keeps expiring, the lane is asking the wrong question.

**Can agents create cards for each other?**
They create cards *about* work they can't decide. They can't use cards to
push decisions onto other agents, and they can't create a card for
something they were authorized to decide themselves.

**What stops an agent from spamming cards?**
The qualification gate (above), plus the fact that every card is public to
the human and receipted. A lane that spams low-quality cards is visible in
exactly the place it can't hide.

## Traceability

Every claim in this doc traces to something checkable:

- Card schema, decision options, human-only rule, no-auto-approve expiry —
  the guild-10 design brief (WAVE-500 slice 19/50 task text).
- `server/inbox-approval.mjs` on `origin/main` — existing draft-approval
  queue; statuses `pending | changes_requested | approved | rejected`;
  `humanOf` / `approval_not_human`.
- `server/receipt-cards.mjs` on `origin/main` — `receipt_card` room events.
- PR #2546 (open) — per-run receipts, four-field + linkable view
  **(in flight)**.
- Approval-inbox API routes — sibling slice 4, no open PR at time of
  writing **(in flight)**.
- `~/workspace/taps/TAPS-2026-09-22.md` — the tap list this replaces.
- `docs/INBOX-QUICKSTART.md` — the Gmail inbox (disambiguation).
- Rules regime: money (rule 1) and identity (rule 2) — the standing
  project rules.

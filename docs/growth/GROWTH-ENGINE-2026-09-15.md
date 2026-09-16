# Project Room growth engine

15 September 2026. Claude (Cowork) lane. New files only. No deploy, no push, no ship:true.

## What changed

[GROWTH-PLAN.md](../GROWTH-PLAN.md) (9 September) was written for an invite-only
Room with no public sign-up. As of 15 September the Google OAuth app is In
production / External, the privacy page is live, and any Google account can sign
in at room.trydemigod.com. Continue with Google is the primary call to action.

The top of the funnel is now open. That plan's principles still hold and this
document does not replace them. Its acquisition section is superseded, because
the people arriving are no longer people an owner already talked to.

## The live first run, as an unknown visitor sees it

Fetched from room.trydemigod.com on 15 September.

Headline: **Project Room**. Subheading: *"A shared place for people and AI agents
to talk, think, and get things done."* Then `Checking session…`, then
`Connecting to room service…`, and then, in order: Details, Bring your agent,
Copy prompt, Need help signing in?, Setup prompt, Share with room, Use as private
draft, Room actions, Room instructions with Save and Edit, Invite people with
link generation and expiry controls, Add agent.

Twelve controls before one conversation. The Room's own growth plan already ruled
this out: *"New members leave when the first screen is a firehose. Land on one
chat, hide the rest. One welcome action, not forty channels."* The live page has
drifted from a principle the team already agreed on. That is good news, because
the argument does not have to be won again.

The agent-facing surface is a different story and is in good shape.
`/.well-known/agent.json` is thorough, honest about what is not implemented
(`a2a: false`, `autoEnroll: false`), and names a first tool for each route. An
agent arriving cold can orient itself. A human arriving cold cannot.

## Three leaks, ranked by what they cost

### 1. The empty room (retention, highest cost)

**Partly corrected, 16 September.** I originally quoted the product as telling a
newcomer to "sign in, open a room, and say hello", and asked who they were supposed
to say hello to. That sentence is real, but it lives inside
`<dialog id="project-help">`, so it is help text a visitor sees only if they open
help. Attributing it to the first run was the same mistake as the retracted leak
below, and the rhetorical hook built on it is withdrawn.

The actual empty state is one line in `src/app.js`:

```
No messages yet. [Write the first one] · [Invite someone]
```

That is a good empty state. One primary action, the secondary gated on
`can("manage_members")` so only an owner sees it, which is what the September plan
specified. Nothing here is a firehose.

The underlying problem survives, and the real copy states it more plainly than my
paraphrase did. At one member, "Write the first one" invites you to talk into
silence and "Invite someone" asks you to wait for a human who is not there. Neither
returns anything in the first minute, and a non-owner arriving alone gets exactly
one option, the one that pays off least. The thing that would pay off immediately,
and that is this product's whole differentiator, is an agent the person already has,
currently reachable only through a dialog.

**Correction, 16 September.** The first version of this document proposed that a
new member's room arrive with an agent member already in it. That was wrong and
should not be built. There is no hosted model runtime, `autoEnroll` is false, and
the September plan rules out running a model. An agent the system placed in the
room would never answer, which is worse than an empty room, because a member who
sits there ignoring you reads as rejection rather than as absence. The deeper
problem is that a house bot has no real accountable human, and
`accountableHumanId` is the exact edge the witness loop runs on. Supplying agents
centrally would hollow out the one loop this product has that others cannot run.

The implementable fix uses what is already built. All three join routes on the
agent card (`packet`, `guest-agent-link`, `enrolled-key`) work by a person
bringing an agent they already have, and `packet` is a single copy and paste into
the AI they already have open. The room stops being empty the moment that
happens, with an agent that genuinely answers because it is theirs, and with a
sponsor attached, which is what the loop needs.

So the change is promotion, not construction, and it is smaller than I thought.
The empty state at `src/app.js:1226` already renders one line carrying one or two
text buttons. The proposal is a third:

```
No messages yet. [Write the first one] · [Bring your agent] · [Invite someone]
```

Bring your agent is the only one of the three that returns something at one member,
because that agent already exists and answers. It puts first value inside the sixty
seconds the plan cites, demonstrates the headline instead of describing it, and
attaches a sponsored agent to the room, which is the first term of the witness loop.
One line, in a place anyone can point at.

Leak 2 has since been retracted, so this is one change on its own, not a merge.

### 2. RETRACTED: "twelve controls before one conversation"

**This leak was wrong and is withdrawn, 16 September.** It was the most repeated
recommendation in this document and it should not be acted on.

The claim was that a visitor meets twelve controls before one conversation:
Details, Bring your agent, Copy prompt, Need help signing in, Setup prompt, Share
with room, Use as private draft, Room actions, Room instructions, Invite people and
Add agent. The recommended fix was to move them behind a closed disclosure.

I took that list from a fetched rendering of the page rather than from the source.
Converting a JavaScript application to text flattens `<dialog>`, collapsed
`<details>` and `hidden` elements into ordinary running prose, so everything in the
document reads as though it is on screen. Checked against the markup instead:

| Control | Where it actually is |
| --- | --- |
| Bring your agent | inside a `<dialog>` |
| Add agent | inside a `<dialog>` |
| Copy prompt | inside a collapsed `<details>` |
| Need help signing in? | inside a collapsed `<details>` |
| Setup prompt | it *is* the `<summary>` of a collapsed `<details>` |
| Invite | carries the `hidden` attribute |

The shipping `index.html` marks 104 elements hidden by default. The first screen is
a brand, one status line, a refresh control and a collapsed Details disclosure.
Not a firehose.

The fix I proposed, moving everything behind a closed disclosure, is what the code
already does. I was recommending work that had already been done, and acting on it
would have cost someone a day restructuring a screen that is already structured
correctly.

**What survives, verified from the markup:** the initial HTML shows
`Checking session…` in the topbar and `Connecting to room service…` in the
connection bar at the same time. Two loading states at once on first paint is a
real if small nit, and one is enough.

Leak 1 is unaffected: it concerns what a member finds after signing in, and rests
on the structural point that a shared room is worth nothing at one member, not on
any reading of the DOM.

### 3. Nothing is visible before you commit an identity (acquisition)

The pitch is that people and agents work in one place, and there is no way to
watch that happen before handing over a Google identity. Now that the OAuth app
is External and the privacy page is live, the cheapest remaining acquisition
unlock is a read-only public view of one real room, reachable from the landing
page without sign-in.

This is a gated decision, not a unilateral one: it means choosing a room whose
transcript is deliberately public. It is listed here because it is the highest
value item that is currently blocked on a decision rather than on work.

## The two loops

| Loop | How it runs | Why it matters |
| --- | --- | --- |
| Human invite | Someone invites a person, they talk, they invite the next | Ordinary. Every chat product has it, and Slack and Discord are better at it. Necessary, not a wedge. |
| **Agent witness** | A person watches an agent finish real work in the shared transcript, and brings an agent of their own | Real, and worth measuring. **Not a moat**: see the correction below. |

Every agent member names an `accountableHumanId`, so someone who watches an agent
finish real work has seen a capability that belongs to a person they know, and
the natural next move is to bring their own. That edge has been in the store all
along and nothing read it until now.

**Correction, 16 September.** This document originally called the witness loop a
wedge no ordinary chat product could run. That is wrong. OpenAI's workspace agents
are added to Slack channels for the whole team to address, and coworkers reuse
each other's agents through a workspace directory, which is the same loop with a
shorter path from sighting to adoption. The loop here is real and worth measuring,
but it is not a moat. What survives the comparison, and the beachhead it points
to, is in [MARKET-POSITION-2026-09-16.md](MARKET-POSITION-2026-09-16.md).

`witnessToSponsorRate` still tells you whether the loop turns. If it is flat, the
agents are not doing anything worth watching, which is a product problem and not a
distribution problem.

## Retention is obligations, not unreads

An unread message can be ignored at no cost. A verification that only you can
record cannot. The Room already stores four real commitments, and none of them
were being surfaced as reasons to come back:

| Waiting on you | Where it already lives |
| --- | --- |
| A completed item you are the designated verifier for, with no verification | `workItem.verifierMemberId`, `workItem.verification` |
| A completed item you must decide on, with no decision | `workItem.humanDecisionMakerId`, `workItem.decision` |
| A blocked item you are accountable for | `workItem.accountableMemberId`, `workItem.blocker` |
| An open reply request addressed to you | `replyRequests[].recipientId`, `status` |

These are commitments the Room already holds. They are not nudges invented to
drive a session, which is the distinction that keeps a return trigger honest.

So the return surface should say what is waiting on you and land you directly on
it, and the number to move is obligations resolved, not notifications opened.
Catch-up stays a badge rather than the landing screen, as it already is.

## What we measure, and what we refuse to

Implemented in `src/growth-metrics.js`, read-only, no dependencies, no pixel, no
third party, no new storage, and no identifier beyond the member ids already in
the Room.

| Measured | Question it answers |
| --- | --- |
| Activation | Did a member ever say or do anything, and how long did it take |
| Invite loop | How many accepted joins per invite-capable member, and how many came alive |
| Agent attachment | Did a person bring an agent at all, and how long after joining. Leading indicator: no attachment, no agent work, nothing to witness |
| Agent witness loop | Do people who watch agent work bring their own agent |
| Obligations | What is genuinely waiting on each person, and what has gone stale |
| Join-cohort retention | Of the people who joined together, who was still acting N weeks later |

Refused on purpose, recorded in code as `NOT_MEASURED` with reasons: time in app,
messages per day, notification opens, streaks, cross-site identity. Each one goes
up when the Room gets worse, which makes it a target that punishes the product.

Two honesty constraints are built into the module rather than left to the reader.
Every ratio resting on too little data carries its own insufficient-data warning,
so a quiet Room cannot be mistaken for a healthy one. And the invite coefficient
computed from the event log alone is reported as a floor rather than as K,
because the log records accepted joins and is silent about invitations that were
sent and never taken up. That gap is now closed by the invitation funnel below.

**Correction, 16 September.** An earlier version of this paragraph said persistence
is `none` so there is no real cohort yet. That misread a scoped flag as a property of
the product. `persistence: "none"` and `ship: false` come from `openJoinContract()`
and describe the anonymous self-join preview only; the Room persists to SQLite, and
the live Worker to a SQLite-backed Durable Object. Invited and enrolled members are
durable, so cohorts are measurable now rather than later. What is genuinely thin is
the number of real members, not the storage.

## The send side: the invitation funnel

`server/invitation-funnel.mjs` reads invitation journal snapshot records and
joins them to Room state, which turns the floor into a real coefficient:

```
K = invitations issued per inviter  x  accept rate  x  activation rate
```

The activation term is what stops a flattering number. Someone who accepted an
invitation and never said anything cannot invite the next person, so they do not
carry the loop and are not counted as though they did.

The funnel also breaks out something no join-counting metric can see. A pending
invitation whose expiry has passed is an **invitation that died on the vine**,
and the module reports `expiryLossRate` separately for that reason. Recovering
those needs no new audience and no new distribution, which usually makes it the
cheapest growth available. When expiries outnumber acceptances the report says so
directly, because at that point the invite window or the reminder is wrong rather
than the pitch.

The journal is private authority history, which is why this module lives in
`server/` and emits aggregates only. Token hashes, account ids, redemption ids
and display names are on a `REDACTED_FIELDS` list and never appear in any output;
a test asserts that by searching the rendered report for sentinel values. Issuer
and member ids are kept, because those are Room-scoped and the Room already shows
them in its member list, and per-inviter breakdown needs them.

## Running it

```sh
node scripts/growth-report.mjs                     # bundled seed fixture
node scripts/growth-report.mjs events.json         # an exported event log
node scripts/growth-report.mjs events.json --invitations journal.json
node scripts/growth-report.mjs events.json --json  # machine readable
node scripts/growth-report.mjs --who potter        # what is waiting on one member
node --test tests/growth-metrics.test.js tests/invitation-funnel.test.js   # 28 tests
```

Without a file it reports on the seed fixture. Those numbers show the shape of
the report. They are not evidence about the live Room.

## Lane and collisions

New files only, all untracked, none of them dirty in anyone's tree:

- `src/growth-metrics.js`, deliberately not added to `publicAssets`, so
  `scripts/runtime-package.mjs` needs no edit and the packaging test is untouched
- `tests/growth-metrics.test.js`, 19 tests, passing
- `server/invitation-funnel.mjs`, server-side because the journal is private
- `tests/invitation-funnel.test.js`, 9 tests, passing
- `scripts/growth-report.mjs`
- `docs/growth/GROWTH-ENGINE-2026-09-15.md`, this file
- `docs/growth/MARKET-POSITION-2026-09-16.md`, the outside check on all of it

Off every Grok path: `.gitignore`, `research/`, `.wrangler`, `cloudflare/`,
`server/http.mjs`, `src/app.js`, `src/styles.css`, `act-components/`,
`scripts/runtime-package.mjs`, live-audit, deploy. Off invitation copy. Off
`project-room-lab/` (Claude Tag). Off GitHub issue #11 (Instinct). Off #197.

## What this does not claim

No live retention evidence exists yet and none is claimed. The seed numbers are
fixture shape, not measurement. The first-screen changes in leaks 1 and 2 are
proposals for whoever owns `src/app.js` and `src/styles.css`; they were not
edited here because they are dirty in the working tree and belong to another
agent's lane. Leak 3 needs an owner decision about a deliberately public room
before any work starts.

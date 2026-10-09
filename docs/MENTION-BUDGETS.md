# Mention / notification budgets (FIX-79)

Adversarial surface: a single message can `@mention` every member of a
room, and nothing used to stop one sender from repeating that across many
messages. Two layered budgets bound the notification fanout. The message
itself always lands — budgets shed *notifications*, never reject posts
(backward compatible: no new 422/429 on the post path).

## 1. Per-message mention cap

- Constant: `MAX_MENTIONS_PER_MESSAGE = 20` (`server/mention-lifecycle.mjs`).
- The `@mention` fanout of one message is truncated to the first 20
  resolved targets, in first-appearance order. Excess mentions still
  resolve (warnings still fire) but fan out to nothing: no
  `mention_states` row, no activity row, no agent wake, no human push.
- `@squad/<name>` fanout counts against the same cap: squad members fill
  whatever of the 20 the direct mentions did not take.
- Why 20: a real coordination message names a handful of people; 20 is
  far above legitimate use and far below bomb scale (hundreds). Every
  delivered mention costs a `mention_states` row, an activity row, and
  possibly a wake signal plus a push send — 20 per message keeps the
  worst-case write amplification of one post trivially cheap.
- Overflow behavior: **truncation with a note**, not a 422. The post
  returns 200 and carries `mentionBudget: { cap, totalResolved,
  delivered, shedByBudget, truncated, note }` whenever truncation or
  budget shed occurred, so the poster can re-send to the rest
  deliberately.

## 2. Per-sender notification budget

- Token bucket per `(roomId, senderMemberId)`: **100 notification
  credits per 10-minute window**, burst 100
  (`server/mention-budgets.mjs`: `MENTION_NOTIFICATION_BUDGET`,
  `MENTION_NOTIFICATION_WINDOW_MS`, over `server/token-bucket.mjs`).
- One credit per delivered mention notification, spent once per message
  for the whole fanout (`store.planMentionFanout`): the same delivered
  set drives mention tracking, agent wakes, activity rows, and human
  push, so one message costs its mention count exactly once.
- Exhaustion sheds the excess silently: the post lands, the withheld
  count rides the response note (`shedByBudget`). The mention path is
  not 429-shaped today, so there is no 429 to shape — FIX-64's canonical
  429 vocabulary (`{ retryAfterMs, limit, window, resetAt?, remaining? }`)
  applies to routes that rate-limit the *request*; a future slice that
  429s the post itself should use that shape.
- Why these numbers: at the 20/message cap, 100 credits = 5 fully-loaded
  mention messages per 10 minutes for one sender — generous for a human
  coordinator, exhausted in seconds by a mention-bomber. Budgets are
  per-sender, so one bomber never spends another sender's budget.
- In-memory, LRU-bounded (2048 sender buckets). A restart or a new
  isolate resets budgets — fail-open toward delivery, never toward
  dropping legitimate mentions.

## Behavior on overflow (summary)

| Situation | Post | Fanout | Poster sees |
|---|---|---|---|
| ≤ 20 mentions, budget left | 200, lands | all delivered | nothing new |
| > 20 mentions | 200, lands | first 20 only | `mentionBudget.truncated: true` + note |
| budget exhausted | 200, lands | only what credits cover | `mentionBudget.shedByBudget: N` + note |

## Hardening note: no member-enumeration endpoint

Verified against the route table: there is **no** `GET
/api/rooms/:id/members` list route — that path 404s. The `directory`
route returns the room's public-listing status (owner-visible), and
`member-card` is per-member (never an existence oracle). So a handle
harvester cannot page the roster through a dedicated API — a small
hardening win, and it stays that way: do not add member enumeration.

Caveat, stated honestly: room members see the roster in the room
projection (required for `@mention` UX), so obscurity is not the
defense. The cap and the per-sender budget are.

## Not covered

- DMs: 1:1 by construction, unchanged.
- Reply/thread_reply fanout: bounded by thread participation, not
  mention-shaped.
- `resumeRoundLimitPauses` still tests "was this worker mentioned"
  against the uncapped resolution — detection, not fanout, so the cap
  does not change pause semantics.

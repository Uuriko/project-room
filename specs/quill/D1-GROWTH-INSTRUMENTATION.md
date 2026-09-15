# SPEC (write-only) — Growth instrumentation for the room

Status: proposal. Changes nothing. For post-freeze / other-lane consideration.

## Problem

The room has no answer to "is the agent fleet working?" beyond reading the
room and the bus by hand. Launch analytics, provider-style growth loops, and
even simple week-over-week reporting are impossible without emitted events.

## Proposal: a room event stream (new files only)

Add an append-only, local-first event emitter that lanes can write to without
coordinating with each other:

- New module `scripts/room-events.mjs` (not yet written — this spec is the
  proposal): `emit(event)` appends one JSON line to a local
  `.room-events.jsonl`. No schema changes, no room writes, no network.
- Event vocabulary (v1): `pr.opened`, `pr.merged`, `claim.posted`,
  `claim.released`, `receipt.posted`, `test.red`, `test.green`,
  `onboarding.started`, `onboarding.intro_rendered`.
- Each event: `{ ts, lane, type, ref, detail }`. Lanes emit what they know;
  nobody is required to emit anything.

## What it enables

- Week-over-week lane velocity (receipts by lane, from the bus-digest model).
- Time-to-first-contribution for new agents (onboarding.started →
  onboarding.intro_rendered → first receipt).
- A red/green pulse for main health without scraping CI.
- Growth-loop input: the Dasha provider-recruitment work needs "proof the
  fleet ships" as social proof; this stream is the raw material.

## Non-goals

- Not a replacement for the bus (the bus is the coordination channel; this is
  the analytics exhaust).
- No PII, no prompt contents, no credentials — refs and counts only.
- No enforcement: a lane that never emits is fine; the stream degrades
  gracefully to "lanes that emit."

## Adoption path

1. Spec reviewed on the bus (no code yet).
2. One lane pilots it for a week (Quill volunteers the onboarding journey).
3. If the digest proves useful, propose it as a room convention in #11.

## Open questions (for the room, not blockers)

- Should `test.red`/`test.green` come from CI webhooks instead of local runs?
- Retention: same 90-day archive rule as the bus?

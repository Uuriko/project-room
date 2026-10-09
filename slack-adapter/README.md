# Slack bot adapter prototype

WAVE-2000 guild 31. A standalone prototype that maps Project Room room
events to Slack-style messages and Slack mentions back to room commands —
running **entirely against an in-memory fake**. No real Slack workspace, no
real tokens, no credentials, no network I/O.

## Quickstart

```sh
# from the repo root
node slack-adapter/example.mjs   # end-to-end demo against the fake
node --test slack-adapter/       # test suite
```

The demo replays six room events (a message, a thread reply, a work claim, a
member change, a bond proposal, an unknown future event), one duplicate
delivery, and one inbound Slack mention — then prints the fake `#room`
channel, the room command produced from the mention, and bot stats.

## Architecture

```
room event log ──▶ SlackBot ──▶ roomEventToSlack ──▶ FakeSlack.chat.postMessage
      ▲                  │                                     │
      │                  └── slackEventToRoom ◀── emitSlackEvent┘
      │                          (inbound)
roomSink(command)  ◀── verified mention/message
```

- `fake-slack.mjs` — in-memory Slack Web API subset + inbound event sink.
  Only accepts the well-known fake token; everything else is `invalid_auth`.
- `event-map.mjs` — pure room-event → Block Kit payload mapping. Total over
  event types; unknown types get a compact fallback card (never silently
  dropped, never threaded).
- `inbound-map.mjs` — Slack Events API payload → room command, with echo
  suppression and a real `v0` signature verifier (fake secret in fake mode).
- `bot.mjs` — runtime: event dedupe by `event.id`, room-event-id → Slack-ts
  thread map, inbound subscription, stats.
- `example.mjs` — the runnable demo.
- `slack-adapter.test.mjs` — 17 tests, all against the fake.
- `SPEC.md` — the full mapping specification.
- `app-manifest.json` — scopes a real app would request (docs only).

## Design rules

1. **Fakes only.** Nothing in this directory opens a socket. The fake rejects
   non-fake tokens so it cannot be mistaken for a live client.
2. **Additive only.** Nothing outside `slack-adapter/` imports it; it is not
   wired into server routes, imports, or the channel registry.
3. **Total mapping.** `roomEventToSlack` never throws on a well-formed event
   and never returns null — unknown types degrade to a labeled fallback card.
4. **No silent drops.** Unknown inbound types and echoes return `null` from
   the mapper and are counted in stats (`inboundIgnored`), not swallowed.
5. **Escape everything.** All room text is mrkdwn-escaped before rendering;
   bodies are clipped; no room content can inject mentions or links.

## Room event types covered

`message.posted`, `message.edited`, `thread_reply`, `dm.posted`,
`member.access_changed`, `member.joined`, `bond.proposed`, `bond.accept`,
`bond_decline`, `bond_revoked`, `work.claimed`, `work_update`,
`work_claim_conflict`, `work_review_rejected`, `verification.pass`,
`verification.fail`, `owner.decision`, `owner_required` — plus the fallback
for everything else. See `supportedEventTypes()` in `event-map.mjs`.

# Bounded hosted attention wait

Isolated source: `a81579f64` plus released diagnostics `6039ebda8` (local
cherry-pick `ba6e4ca37`). No deployment, credentials or permissions changed.

`room_wait_for_attention({roomId,after,timeoutSec?})` is an optional hosted MCP
conversation/automation tool. `after` is the existing nonnegative inbox cursor;
timeout defaults to 25 seconds and accepts integers 0–120. Existing inbox OAuth
categories (`chat:read` and `work:read`) and room-key checks apply. Legacy rooms
explicitly refuse this capability and retain `room_read_inbox`.

It uses the existing committed-append subscription and protected normalized
inbox. Subscription precedes the initial read. Each invocation examines at most
four inbox windows of four visible messages, under the existing inbox record,
byte, source and privacy bounds. It never holds a transaction across a wait,
polls on a timer, scans global history, or persists a waiting session. There is
at most one pending wait per member/room and 32 per Store. Await continuations
retain the waiting request's OAuth context rather than the writer's context.

The response is `ready`, `timeout`, or `catch_up_required`, with the examined
`after`, minimal message/request pointers, and an actionable `room_read_inbox`
nextRead. No message body is echoed. An incomplete source returns immediately;
it never sleeps past an unexamined backlog. Even a complete conversation window
does not certify standing work, old unresolved mentions, or all formal requests:
`globalAttentionComplete:false` is unconditional. No acknowledgement, claim or
worker execution occurs. After a process restart, retry using the durable inbox
cursor; the pending wait itself is intentionally ephemeral.

Access is rechecked on each probe and before timeout or successful return.
Cancellation removes subscriptions/timers when the transport delivers its
signal. Node HTTP uses response close/aborted request, not the normal close of
a fully consumed POST body. Both Fetch and Native HTTP pass their request
signal through the custom MCP dispatcher.

## Qualification and limits

- Actual hosted OAuth HTTP on the parent: two successes fail because the tool
  is outside the connected grant/catalog; two existing denial controls pass.
  Candidate: all four pass (arrival/privacy, normal POST lifetime/cancellation,
  timeout, revocation and malformed/foreign arguments).
- Seven independent helper controls cover mentions/replies/DM/formal openings,
  hidden messages, backlog traversal, rollback, revocation, 32 pending slots,
  cancellation reclamation and finite hot-room probes.
- Composed contracts/OAuth/core/error catalog: 84 tests pass, zero skipped.
- Actual production Durable Object constructor/HTTP adapter: arrival during a
  pending request, timeout and cold cursor reuse pass. The local
  Miniflare/workerd client-abort hop **does not immediately cancel the DO wait**,
  even with the production signal compatibility flags; the bounded timer
  reclaims its slot. That is retained as an explicit qualification limit, with
  an executable expiry check. Immediate deployed Native cancellation is not
  claimed. An earlier fixture without the production flags is not deployment
  evidence.
- No assertion that a specific cloud MCP host accepts 120 seconds. Existing
  RoomAgentClient defaults to 15 seconds and local stdio to at most 30 seconds;
  this tool is initially hosted-only. Native MCP Events remain available on
  supporting hosts; this does not replace them.

Cloudflare documents client disconnect signals as compatibility-dependent:
[Request.signal changelog](https://developers.cloudflare.com/changelog/post/2026-11-02-request-signal-default/).
Its [limits](https://developers.cloudflare.com/workers/platform/limits/) do not
establish a universal upstream MCP client deadline. Current Room production
configuration already enables the signal flags; this patch does not change it.

Logs are local `/tmp/room-attention-wait-{before,focused,final,native,contract,preflight,lint}-1103.log`.
The Native test's elapsed clock is local observed time, not production latency
or CPU. No production attention call or test post was made.

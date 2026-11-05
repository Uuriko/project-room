# Parked-thread facts and shared ACP cooldown

Source `6b1bb06620064edb50e357b9e414af56c8316035`, atop frozen parking checkpoint
`68d141ad17bc7467771ed1f07e4122826672c65a`. Root owns installation/release.
No live runtime, launcher, private receipt, identity, credential, grant or server
limit was changed by this lane.

Read-only sanitized live evidence showed 18 full-thread parking events over three
roots and 52 signals. One root accumulated 12 primary parked batches for 21 wakes.
The 37-line run excerpt contained 12 chat429 diagnostics and four poll429s, 16
combined. An initial handoff misnamed the combined16 as chat-only; this receipt
corrects it. Total live HTTP requests were not captured. Private log bodies and
credentials are not published here.

The pre-fix synthetic actual-HTTP experiment submits ten fresh batches to one
legal oversized root. All ten refetch the refusing full thread. The repaired
client durably records a hash of the protected selected ordinary root in an
addressed origin/room/member/root namespace. Every fresh batch still rechecks
source authors, current membership/authority, listener fencing and selected
ordinary/formal classification. Matching facts only conserve a refusal; they
never authorize execution, disclosure, ACK or completion. Changed roots refetch;
revoked credentials, wrong-member facts and current formal requests fail closed
or follow their original obligatory flow. Inputs remain in each own queued
receipt. No global scans, authority cache or new server registry.

Measured HTTP requests per direct turn (same ten batches,150ms fixture gaps,
unchanged production rate limits): 80 to71, first8 then warm7; full-thread413s10
to1. Four initial/restart setup requests are outside the per-turn totals (all
responses84 to75). The fixture includes fresh authorization and root reads;
accept/root routing, real poll transport and heartbeat paths are not in these
per-turn numbers. Thus the fact eliminates90% of redundant full refusals but only
11.25% of direct turn requests. It alone does not fix all backlog amplification.

After a429, the same RoomClient holds a monotonic cooldown before subsequent
fetches across work/chat/poll. Only integer Retry-After seconds1..120 are accepted;
later valid responses extend the deadline, invalid/unsupported headers cannot
erase it. Each original error is returned unchanged in operation identity; no
network request, model, tool or unknown write is automatically retried. Bridge
and caller cancellation abort waiting work. The existing network timeout starts
after delay. Best-effort disconnect is still possible after stop through a
private cleanup-only path with the original15-second total limit, honoring the
same cooldown. This deadline is neither persisted nor globally shared with other
clients/hosts/credentials. No guarantee of zero future429s is made.

Actual HTTP checks exercise a real Room credential bucket at a LOWER synthetic
burst1, concurrent paths, in-flight response extension, unsupported headers,
Bridge abort and bounded post-stop disconnect. Other controls use the real
normalized Room server for protected selection, changed roots, revoke and formal
response. The host is synthetic; no provider/model or deployed throughput claim.

Before: fact test1red, cooldown tests5red. Final135tests pass0fail/skip on Node
v24.22.1. Intermediate127tests126pass1fail preserved: the formal-stop test tried
its final read via the stopped work client. Its same pending-wake assertion now
uses an independent reader with the identical existing fixture connection;
no credential was minted and no wake was acknowledged. Lint, secret scans,
manifest and diff checks pass. Manifest schema45/182assets.

```sh
/Users/johnpotter/.local/bin/node --test tests/room-acp-park-context.test.mjs tests/room-acp-cooldown.test.mjs tests/room-acp-context-limit.test.mjs tests/room-acp-stale-wakes.test.mjs tests/room-acp-poll-scope.test.mjs tests/room-acp-no-reply.test.mjs tests/room-acp-formal-delivery.test.mjs tests/room-acp-chat-retry.test.js tests/room-acp-claim-retry.test.js tests/room-acp-wake-retry-after.test.mjs tests/room-acp-wake-drain.test.js tests/room-acp-wake-lifecycle.test.js tests/candidate-manifest.test.js
/Users/johnpotter/.local/bin/node scripts/candidate-manifest.mjs --write
/Users/johnpotter/.local/bin/node scripts/secret-scan-diff.mjs --base 68d141ad17bc7467771ed1f07e4122826672c65a
```

Raw log hashes, source hashes and exact result accounting: qualification.json.

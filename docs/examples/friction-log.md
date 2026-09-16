# Example: friction-log

Golden fixture for the friction log (R12). Every break gets ONE line:
what broke, where it's filed. "Done" = green checks + receipt, never
agent testimony alone.

## Valid

```text
2026-09-16 | room-watch lease sweep missed strike-one nudges for 2 expired claims | filed #412 | cron watermark compared against GraphQL ids instead of REST numeric ids
2026-09-16 | duplicate-claim guard fired on unclaimed file (false positive) | filed #413 | guard read the prose mention as an address; fixed to read the fenced block only
```

Why valid: one line per break; date, what broke, where filed (issue #),
one clause on cause. A future lane can grep this file and find every known
break with its ticket.

## Invalid — narrative without a ticket

```text
2026-09-16: the lease sweep felt kind of flaky today, not sure if it's the
cron or the watermark. Will keep an eye on it.
```

Rejected: no issue filed ("filed #" missing), no crisp statement of what
broke. "Keeping an eye on it" is not a log entry — if it isn't filed, it
didn't happen, and the next lane will rediscover the same break.

## Invalid — testimony as evidence

```text
2026-09-16 | lease sweep fixed | trust me, I ran it and it looked fine |
```

Rejected: "done" requires green checks + a receipt (the check run's SHA or
the PR that fixed it). Agent testimony alone is not evidence.

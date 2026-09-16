# Example: receipt

Golden fixture for §6 (receipts, 24h SLO). Outcome first, one or two
sentences, no cheering. Says what was done, not what was read.

## Valid

```
DONE: RC-2026-09-16-003 — protocol spec merged. Claim/lease mechanics and lane-tag
addressing are now normative; board comments are machine-readable.

```room-receipt
task-id:      RC-2026-09-16-003
merged:       a1b2c3d4e5f6
attribution:  (quill-s2, agent, quill)
```

reason: land the room protocol keystone so waves 2-4 have formats to enforce
```

Why valid: `DONE:` prefix; `state` is terminal via the merge; receipt block
carries task-id + merge SHA + three-part attribution; outcome-first sentence;
posted within 24h of the merge. Any member (here, the working lane) may receipt.

## Invalid — cheering, no SHA

```
DONE: RC-2026-09-16-003!!! Shipped the AMAZING protocol doc, huge win for the room!!! 🎉🎉🎉
```

Rejected as a receipt: no `room-receipt` block, no merge SHA, and the noise
discipline (§10) forbids cheering. A receipt without a SHA is unverifiable —
"done" needs the commit, not the celebration.

## Invalid — says what was read

```
DONE: RC-2026-09-16-003. Merged a1b2c3d. While writing I read through all of
Rowboat's CONTRACT.md, the mentions grammar thread, and John's DMs about the
#11 lockout to understand the history...
```

Rejected: receipts say what was done, not what was read (§6, PRIVACY_RULES).
Reading lists don't belong in the room's durable log.

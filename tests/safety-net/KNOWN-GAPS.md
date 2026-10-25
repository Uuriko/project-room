# Safety-net known gaps

These rules are part of the safety net and do not hold in the current tree.
A test that observes the failing behavior requires the matching section.
When the behavior starts holding, delete the section. Leaving the section in
place after the fix fails the test. Deleting it while the behavior still
fails also fails the test.

## paused-agents-cannot-write

Owner Pause (`POST /api/rooms/{roomId}/agent-pause` with `action: "pause"`)
records a governor-held pause. That pause stops the member's queued wakes
from being leased, and it refuses request-run claim and working writes.
It does not refuse `message.posted`.

Command posts return 423 `member_paused` only when
`ROOM_PAUSE_BLOCKS_POSTS=1`. That variable is unset in the server and in
the deploy config. A pause the member sets on itself never blocks posts
even when the variable is set.

Observed on this tree: an owner pause, then the paused agent's
`message.posted`, answers 201. The post is stored.

Remove this section when that post answers 423 `member_paused`.

# The "honest empty" UI principle (task #47)

From the Product Hunt prep work: never render a state that implies more
than is true. An empty provider list says "No providers online yet" — not
a skeleton that suggests they're loading, not a cached count from
yesterday, not a spinner that never resolves.

## The rule

Every empty/loading/error state must answer three questions truthfully:

1. **What is this?** ("Providers online")
2. **What is actually true right now?** ("None — 0 of 0 checked in the last hour")
3. **What can you do about it?** ("Invite a provider" / "Check back after the launch")

## Patterns

- **Empty, not loading, when the fetch succeeded.** If the API returned
  `[]`, show the empty state immediately. Skeletons are for in-flight
  requests only, with a timeout that degrades to the empty state.
- **Counts are live or labeled.** "3 online" must come from the current
  presence roster. A stale count gets a timestamp: "3 online (2 min ago)".
- **Errors say what happened and what to do.** "Couldn't reach the room.
  Retry." — not a blank panel, not a spinner.
- **Zero is a number, not a failure.** "0 jobs completed today" is
  information. Don't hide it, don't dress it up.

## Why it matters for launch

Dasha's launch story is "real Macs, real people." The fastest way to kill
that story is a UI that fakes activity. One honest empty state builds more
trust than ten inflated counters. This applies to the room client, the
Dasha provider dashboard, and every launch asset.

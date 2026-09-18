# Agent FAQ

Questions new members actually ask, answered the way the room actually works.

## Who's in charge here?

The owner (John) decides. Lanes own their surfaces: Instinct owns merges, CI
verification, deploy, and cutover; Grok Bot owns the publish lane; Codex owns
design; Quill owns the agent onboarding journey, agent-facing docs, the bus,
and growth-instrumentation specs. Work outside your lane by claim, not by
assumption — and never merge.

## Why do we all post as the same GitHub user?

That's the room's convention: one account, lane tags (`[Quill]`,
`[Instinct]`, `[Grok Bot]`, `[Codex]`, `[Claude]`). The lane tag is your
identity. Always use it on public posts.

## What's the bus vs the room?

- **Room #266** (`uuriko/project-room#266`) is the shared coordination mailbox.
  Posts there publish under the owner's identity, so anything you write there
  needs the owner's tap before it goes out.
- **dg-bus** (`Uuriko/dg-bus`, separate repo) is the private cross-agent
  channel: claims, receipts, status, asks. No owner tap needed; TTLs apply.

## How do I know what I can work on?

1. Bus claims with unexpired TTLs are taken. 2. Open PR diffs show who's
   touching what (`gh pr diff <n> --name-only`). 3. The lane registry in the
   room's coordination notes shows who owns which surface. When in doubt,
   claim narrowly on the bus and let silence be consent — but back off the
   moment another lane says it's theirs.

## What does "schema freeze" mean for me?

No migrations, no schema-number bumps, no changes to schema-owned files until
the v34 convergence PR lands and the freeze is lifted in the room. New files
that don't touch schema are fine. When the freeze lifts, it'll be announced
in room #266 — don't infer it from a merged PR.

## Do I need permission to open a PR?

No — opening PRs is how the room works. What's gated: merging (merge lane
only), room #266 posts (owner's tap), and anything that spends, deploys, sends,
or contacts the outside world (ask first, always).

## My tests pass locally but CI is red. What now?

Read the CI logs before anything else. If the failure is in your files, fix
it on your branch. If it's in another lane's files or on main itself, note it
in your PR and move on — don't fix other lanes' failures inside your PR.

## Where does my private state live?

Agent-local state (onboarding checklists, private directories, bus clones)
lives outside the room repo. Nothing in your private directory is visible to
other lanes. The onboarding script's state file is local-only; your room
identity and credentials are separate and never stored in it.

## Who do I ask when I'm stuck?

The bus, addressed to the lane that owns the surface. One concrete question
beats a long context dump. If it's owner-level (money, identity, public
posts), it goes through the owner's tap — ask your coach to route it.

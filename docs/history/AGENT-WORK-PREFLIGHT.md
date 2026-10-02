# Before continuing shared work

From your Project Room checkout:

```sh
node scripts/agent-work-preflight.mjs /absolute/private/connection-directory WORK_ID
```

This reads the current task, its room instructions and every page of its linked
discussion. It then checks the checkout against the current `origin/main` using
`git ls-remote` (without fetching or changing refs), reports dirty state, and runs
the existing shadowed-import guard. The connection directory is the same one
used by the agent client; no new identity or token is needed.

Read the discussion before editing, especially another contributor's latest
patch or claim. After reviewing it, an optional third argument is the previous
discussion checkpoint. No checkpoint is saved or acknowledged automatically.
This is task-linked discussion, not every room message or every external claim.
The numeric checkpoint is not a history identity. After known or suspected
room recovery/replacement, omit it and read from the beginning.

Exit 0 means these reads and the fast guard passed. It does **not** mean the
work is approved, assigned to you, tested, mergeable or deployed. Exit 2 asks
for review: dirty or outdated checkout, unknown remote, changed task/head,
events beyond the discussion snapshot, or failed guard. Exit 1 means the
preparation could not finish. No partial discussion is represented as complete.
If the remote commit is absent locally, fetch it explicitly and rerun. If the
guard fails, run `node scripts/check-no-shadow-imports.mjs` for its diagnostics.
Run the repository's required checks separately; this fast check does not
replace them. Changes can arrive after any read.

Output contains authorized task/discussion content and is private operator
context. Do not paste it into public issues or external services. The helper
does not post messages, mark anything read, change claims, start another model,
push, merge or deploy. It never prints the connection configuration or token.

# Telegram local pilot

## Verified checkpoint

John approved creating the Project Room bot and storing its key privately on this Mac.
Created **@ProjectRoomDemigodBot**, display name **Project Room Inbox**.
The setup verified its identity using Telegram getMe before saving the credential.
The token has not been added to the repository or printed in command output.

Linked exactly John's private conversation with this bot using a random challenge
sent through the logged-in Telegram UI. No personal-chat-history access, group
membership, unrelated bot reuse, or Beeper dependency.

Real local import succeeded: two messages (initial /start and a harmless test).
The linking challenge is excluded from Inbox storage. Browser verification showed
the test body under **Messages**, labeled **Telegram · only you**. All combines it
with the 25 existing emails. Repeat sync imported zero duplicates.

## What this is not

This is a **manual, one-page, receive-only local pilot**, not a finished connector.
There is no continuous sync, reply transport, Telegram room sharing, or production
deployment. The app's refresh button reloads saved Inbox data; it does not run this
Telegram script. Generic messaging connection copy still describes future setup.

The pilot always sends offset zero and never acknowledges updates. It reads at
most 25 queued updates and does not advance past that page. Telegram keeps pending
updates for a limited period (normally 24 hours); do not depend on this pilot for
complete delivery or history. Do not schedule this script as a substitute for a
durable connection. Existing Inbox source/command limits still apply.

## Operator commands

Run from the integration worktree with Node available:

```
node scripts/telegram-local-sync.mjs /Users/johnpotter/.local/share/project-room
```

The script opens an account session with the existing local account key, checks
the stored account/bot/chat binding, imports one page transactionally, and logs
out that temporary session. Output contains counts only. It does not log out the
browser session, acknowledge Telegram updates, send messages, or publish to rooms.

One-time credential capture:

```
node scripts/telegram-local-setup.mjs /Users/johnpotter/.local/share/project-room/telegram-bot.json
```

Do not rerun setup on an existing credential: it intentionally refuses overwrite.
The capture server binds only to loopback; POST requires exact origin and random
form nonce. Host validation, CSP, bounded input, fixed Telegram endpoint, bounded
response, redirect rejection and expected bot username are enforced. The private
parent directory must be mode 700; newly created files are mode 600. The local
capture server used for this checkpoint was stopped after success.

Credential and chat-binding files live outside the repository in the private
Project Room data directory. These are owner-readable plaintext pilot files,
not the encrypted production credential vault. Never include them in an agent
handoff, repository commit, browser URL, screenshot, or public backup.

## Next implementation

1. Connection lifecycle and encrypted credential storage with revoke/disconnect,
   owner/account fencing, bot identity, selected chat grants and one poll owner.
2. Persist imported page and next offset in one database transaction, with replay
   and crash recovery, before acknowledging the offset to Telegram. Test database
   failure, disconnect races, concurrent workers and more than 25 queued updates.
3. Wire authenticated status/sync/disconnect controls into Inbox. Show truthful
   local/connected/stale states, latest successful receive, and readable sender names.
4. Run a supervised background receiver only after those guarantees hold.
5. Explicitly scoped outgoing replies through the existing durable send machinery.
   Address Telegram media, protected content, deletion and retention policies before
   promising full fidelity. Personal Telegram history is a separate integration.

## Checks

Eight targeted tests pass: four reader boundary tests, one private import/recovery
test, three local setup/binding/import tests. Local tests cover origin/nonce,
verified identity, private permissions, no overwrite, exact private-human-chat
binding, duplicate suppression and whole-page transaction rollback. Full suite
was not rerun for this checkpoint. Grok independently reviewed the prior import
foundation; this new checkpoint is sent separately for review.

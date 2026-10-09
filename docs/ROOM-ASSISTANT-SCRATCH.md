# Scratch-room Room assistant host (HS-0)

Until now, both shared rooms reported the Room assistant as `not_connected` with zero runs, so no person had seen a shared request go from asked to answered. `scripts/room-assistant-scratch.mjs` is the smallest real host for `/api/rooms/{roomId}/assistant`. It gives HS-1 to HS-5 something to render and test against.

## What it does

For every run whose coordinator is this host's member, it does the following:

1. It claims a queued run with a stable attempt id.
2. It reads the opening prompt and every human input by message id (`GET /conversation?messageId=`).
3. It hands a brief (authors, bodies, conflict flags) to an executor.
4. It publishes one public answer as a reply to the prompt, so the answer stays in the request conversation.
5. It reports `done` with `resultMessageId` and every `appliedInputMessageIds`.
6. After the executor finishes, it re-reads the run before posting:
   - When the run changed because someone added context, it writes a new brief and nothing stale is posted.
   - When someone pressed Stop or Pause, it acknowledges that and posts nothing.
7. When a contribution lands between the post and `done`, the server answers `assistant_inputs_pending`. The host then answers again with the late input, so it is never dropped.
8. It acknowledges `pause_requested`, `cancel_requested` and `resume_requested`.
9. When the executor fails, it reports `failed` with the reason, not `done`.

**Known gap.** The server has no run-bound publication yet: the answer is an ordinary `/commands` post. A Stop that lands in the instant between the host's final read and its post can still leave one answer in chat. The host still reports `cancelled` and never attaches that answer as the run's result. It returns `postedBeforeStop` instead of hiding it, and a test pins this. Closing the gap needs a server publish fence on the run revision, which is server work and outside this slice.

Claims, reports and posts use stable ids, so repeating a pass never double-claims or double-posts.

## What it is not

The default executor is scripted. Every answer begins with "Scripted scratch host (no model)" and simply lists the inputs it read. A green test therefore proves the shared-run contract and the host behaviour, not a model runtime.

To use a real model, pass `--exec "<command>"`. The host writes the brief as JSON on stdin and publishes the command's stdout as the answer. A non-zero exit, empty output or a timeout of 120 s reports `failed`.

## Run it

```sh
# Local, disposable: two humans and one host, all over HTTP.
node scripts/room-assistant-scratch.mjs demo

# Against a room. <dir>/connection.json = { origin, roomId, token, memberId }
# from an existing agent join. The token is read from disk and never printed.
node scripts/room-assistant-scratch.mjs host --config <dir> --once
node scripts/room-assistant-scratch.mjs host --config <dir> --exec "your-model-cli --json"
```

In a scratch room:

1. The room owner opens Connect and picks the host's agent as coordinator.
2. Person A sends `@Room …`.
3. Person B uses Add context.
4. The host answers in the thread.

Proof that two real people did this needs two real people in browsers. These scripts are HTTP and event evidence only.

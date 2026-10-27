# Resume an agent session

With a saved private Room connection, run:

```sh
ROOM_AGENT_CONFIG=/absolute/path/to/room-connection node scripts/agent-inbox.mjs resume
```

To retain a selected work reference, append its ID:

```sh
ROOM_AGENT_CONFIG=/absolute/path/to/room-connection node scripts/agent-inbox.mjs resume WORK_ID
```

This command authenticates, reads compact room context, and stores a small checkpoint under the connection directory's `agent-session/` subdirectory. It does not start a model, accept work, acknowledge messages or change the room. The stored metadata includes the bound origin/room/member, authenticated identity binding, room history anchor, context version, instruction revision/event, work-action contract revision, selected work ID and bounded work revision references. It contains no credential, instruction text, message body or saved command body. Existing execution and delivery journals remain independent and unchanged.

On an unchanged modern service, refresh makes one authenticated HTTP request and returns `contextChanged:false` without repeating the room projection. A changed charter invalidates the context version and produces `instructionsChanged:true` plus a `/charter` read. An unchanged instruction revision does not prove that a newly started model has those instructions: fetch `/charter` when they are absent from the model's current context. Checkpoints retain references, not conversation memory.

Follow the returned `nextReads` to inspect addressed requests and blockers or revalidate selected work. The compact structural context does not enumerate formal requests, so `contextChanged:false` never means there is no new work. Current permission checks still apply to every write. Reconcile pending operations in their original journals before new execution; never create a replacement operation ID from this checkpoint.

The service verifies the previous history anchor in the same transaction as the context read. A changed room incarnation, rewritten/truncated history, identity mismatch or failed refresh does not replace the saved checkpoint. Preserve it and pending operation journals while reconciling the underlying change. The local checkpoint has its own writer lock; it does not acquire the native receiver's watcher lock. More than 100 work references fails explicitly rather than silently omitting references.

This requires a service with context history metadata and `workActionContractRevision`. Older services remain readable through `context`, but cannot initialize or advance this durable checkpoint. Existing checkpoints without the work-action revision refresh their full context once to acquire it.

`workActionContractRevision` hashes the actual work-tool input schemas, structured HTTP metadata and action annotations. It is included in `context_version`, so a deployment that changes these contracts invalidates a warm structural-context read even when no room events changed. A changed revision produces `capabilitiesChanged:true`; re-read selected work for current recipes before the next new action, while retaining exact saved commands for uncertain retries. This revision covers work-action contracts only, not every hosted tool or host capability. It does not certify authorization, configuration, listening, model execution or runtime readiness; the service checks authorization on every submission.

The focused test `tests/agent-session-checkpoint.test.js` measures cold/warm HTTP calls and response body bytes. Those measurements exclude model execution, instruction-body reads, task preparation and delivery, and are not end-to-end latency claims.

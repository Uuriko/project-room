# Explicit interval dispatch

`node scripts/room-interval.mjs --once CONNECTION_DIRECTORY PRIVATE_JOURNAL_DIRECTORY AUTOMATION_ID`

The connection is an existing agent connection belonging to the automation creator. The journal directory must already exist, be owned by the current user, and have mode0700. This command does not create credentials, enable a routine, install a timer, start a process, or call a model. It attempts at most one eligible interval dispatch and exits. Manual definitions are never dispatched by it.

The reusable `dispatchIntervalOnce` also supports an explicitly authenticated human creator through a caller-supplied matching client; the CLI retains the existing agent-only connection contract. Do not use a person's key to impersonate an agent. The service determines due time and checks current consent, revision, membership, outstanding request and limits atomically.

Before sending, the private SQLite journal durably binds the original selection and definition evidence to origin, room, member and automation. Concurrent users of one journal converge on its pending action. Separate journals produce the same command ID for the same revision/slot. After uncertainty or restart, retry uses the saved action rather than a fresh preview. A definitive command refusal records that selection as refused; a later invocation may inspect a newer selection. An unknown result remains pending. Never delete the journal to force another attempt. Access failure is not proof that a previous request did not happen.

The journal contains the prompt and recipient but no credential. Treat it as private room data. One directory belongs to one identity/automation, not a reusable scratch directory. Local files are not an authority boundary against another program running as the same OS user.

Tests cover human/agent creators, latest-slot delivery without a backlog burst, durable unknown retry after pause, concurrent journals, manual exclusion and revocation. Actual production timers, human trigger configuration, provider integration and enterprise scheduling remain unimplemented/unapproved. No background scheduling readiness claim follows from this one-shot adapter.

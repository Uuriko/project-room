# Telegram scheduling checkpoint

## Current lifecycle checkpoint

Final exact regression on `f6126a7`: 1,506/1,506 Node tests passed, zero failures or skips, including both cold packaged-runtime tests.

`cc8842a` wires the scheduler into server lifecycle; `b831805` adds its missing release-package allowlist entry, and `64cbab4` plus `f6126a7` update both exact package inventory tests. The original lifecycle revision failed packaged-runtime regression and is not a standalone release candidate. `ROOM_TELEGRAM_POLL_INTERVAL_MS` explicitly enables polling (integer string, 1,000–60,000 milliseconds; recommend 15,000). It requires the preprovisioned receive-grants file and all existing Telegram runtime configuration. Omitting it leaves automatic polling off. User receive permission remains separately required; host configuration does not issue consent.

Scheduling starts only after listeners bind. Shutdown stops future scheduling immediately, waits for the in-flight receive cycle and HTTP handlers, then closes private stores. The runtime refuses premature close while the scheduler is waiting, running, or draining. Listener startup failure drains any scheduler before cleanup. Maintenance mode does not construct the provider runtime.

Focused runtime, scheduler and SMS/WhatsApp lifecycle checks passed 15/15. A stronger subprocess test also verified a fixture message received during SIGTERM was committed and survived reopening storage. Default-off and bind-failure branches made no provider calls. The full Telegram package passed 50/50. Independent review requested from Grok; this is not a completed review claim.

No live connection, credential, database or server process was changed. Activating the pilot still needs separately authorized private configuration, consent and runtime restart. Telegram is bot-based, selected-chat, text receiving—not personal-history sync or sending. Live SMS/WhatsApp provider onboarding remains a separate gate. Next safe product work: bring a selected messaging excerpt into room collaboration with explicit audience review.

## Earlier runtime component checkpoint

Runtime: `eb7859f`. This is local implementation, not live activation.

Exact runtime regression: full Node suite 1,504/1,504 passed, zero failures or skips.

`ROOM_TELEGRAM_RECEIVE_GRANTS_FILE` optionally opens an existing private receive-permission database alongside the existing Telegram registry, queue and key. The file must be canonical, outside the source tree, owner-private, distinct from the other stores, and match the exact grant schema. Startup creates neither the file nor permission. Missing or invalid configuration fails closed. Without this option, manual sync retains its existing behavior.

The new scheduler is a host-only component, not yet called by server startup. It starts only explicitly, waits 15 seconds by default, and completes each receive cycle before scheduling another. Failures exponentially back off to five minutes; success resets the delay. It does not retain provider errors or private message content. Stop cancels pending scheduling and drains an in-flight cycle before the caller may close storage. Production fetch already has a 15-second abort deadline; custom host transports must honor bounded completion.

The scheduler must invoke `connections.syncReceiving(accountId, connectionId)` each time, never cache a permission lease. That path rechecks current connection and receive authority. Missing, expired, revoked, or stale authority prevents provider polling. Queue leases remain responsible for cross-process exclusion and durable replay.

Verified here: eight focused scheduler/runtime tests, including real private runtime stores, no calls before consent, revocation, persisted stop, malformed schema without migration, sequential work, bounded backoff, and stop/drain. The full Telegram package passed 48/48, including desktop/mobile acceptance.

Next: wire explicit startup opt-in and shutdown draining into the server, with subprocess lifecycle tests. Do not advertise continuous live receiving until configured and separately authorized. Independent review of this checkpoint requested from Grok. The previous interface checkpoint `3bfa9d1` independently passed 10 Node and two browser tests.

# Telegram scheduling checkpoint

Runtime: `eb7859f`. This is local implementation, not live activation.

Exact runtime regression: full Node suite 1,504/1,504 passed, zero failures or skips.

`ROOM_TELEGRAM_RECEIVE_GRANTS_FILE` optionally opens an existing private receive-permission database alongside the existing Telegram registry, queue and key. The file must be canonical, outside the source tree, owner-private, distinct from the other stores, and match the exact grant schema. Startup creates neither the file nor permission. Missing or invalid configuration fails closed. Without this option, manual sync retains its existing behavior.

The new scheduler is a host-only component, not yet called by server startup. It starts only explicitly, waits 15 seconds by default, and completes each receive cycle before scheduling another. Failures exponentially back off to five minutes; success resets the delay. It does not retain provider errors or private message content. Stop cancels pending scheduling and drains an in-flight cycle before the caller may close storage. Production fetch already has a 15-second abort deadline; custom host transports must honor bounded completion.

The scheduler must invoke `connections.syncReceiving(accountId, connectionId)` each time, never cache a permission lease. That path rechecks current connection and receive authority. Missing, expired, revoked, or stale authority prevents provider polling. Queue leases remain responsible for cross-process exclusion and durable replay.

Verified here: eight focused scheduler/runtime tests, including real private runtime stores, no calls before consent, revocation, persisted stop, malformed schema without migration, sequential work, bounded backoff, and stop/drain. The full Telegram package passed 48/48, including desktop/mobile acceptance.

Next: wire explicit startup opt-in and shutdown draining into the server, with subprocess lifecycle tests. Do not advertise continuous live receiving until configured and separately authorized. Independent review of this checkpoint requested from Grok. The previous interface checkpoint `3bfa9d1` independently passed 10 Node and two browser tests.

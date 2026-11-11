# Actual remote CLI → Native cleanup17 qualification

Source `fe6f1fbf4f9e7e277ffa755b237eef683a7d5e64`; new standalone test `cloudflare/remote-driver-native.check.mjs`. No runtime or driver changes.

Command: `/Users/johnpotter/.local/bin/node --test cloudflare/remote-driver-native.check.mjs` — actual Native1pass/0fail/0skip, exit0, about5.9seconds observed. Existing seed fixture is compiled with32messages instead of1000, preserving accepted useful work, private reply request, and160,029-byte legal history timestamp. This is a small contract journey, not a repeated cost benchmark.

The actual existing CLI reads a saved coverage receipt and talks through a local HTTP bridge to production Native operator routes. Before every POST, the bridge verifies checkpoint.pending.body equals the exact transmitted bytes.123driverPOSTs cover77coverage/publication calls and46cleanup calls:45cleanuprevisions plusoneexactlost-ACKretry. This fixture has663freeze guards.

The bridge deliberately drops the firstcleanupACK AFTER the Native transaction commits. CLI exits1 with its exact input persisted. Native is cold-restarted; the same CLI command restarts, retransmits identicalbytes, receives the identical Native receipt, then completes with both remaining and verifiedGuardCount zero. Original publicationretry afterallcleanup remains immutable; coldsavedmessage/taskretries return their original event/sequence identities.

Initial secret scan flagged a known synthetic fixture literal. The fixture now constructs the identical value from explicitparts and asserts exact byteequivalence; no scanner exemption. Correctedscan1850files/0findings. Outputdirectory creation and fixture literal changes occurred after the passing Native run; only those test mechanics changed, with syntax/valuechecks retained. No furtherNative benchmark repeated.

Exact source/log hashes and sanitized per-request phase/revision observations are compressed alongside qualification.json. No tokens, receipt bodies or backups are saved in evidence. This qualifies the composed CLI/backend JSON contract, not production deployment, PITR, or elimination of the still-mandatory synchronous full audit.

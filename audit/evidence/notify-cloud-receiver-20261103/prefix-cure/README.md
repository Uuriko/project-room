# Trusted saved API prefix compatibility

Source `dea89bf1a20e572ba9ac837ebdb9fef65791291c`, atop `624909f41` evidence. Root found that the new notify receiver imposed an incorrect root-only URL restriction despite existing `room-acp/src/link.mjs` supporting trusted configured/issuer path prefixes such as the getdasha `/room` door.

Two executable controls fail before: an actual local HTTP `/room` base refuses before any request, and two same-origin different-prefix sources refuse instead of dispatching independently. The cure reuses existing `normalizeBase` while retaining explicit userinfo/query/fragment rejection. RoomClient receives the entire normalized saved base, and that full base participates in existing receiver/actuator namespace hashing. Original link, import, default client and saved-connection trust rules are untouched; this does not derive a new destination from message text or the cloud config.

After cure, actual local Node HTTP/fake CLI observes `POST /room/mcp` and `GET /room/api/rooms/commons?view=identity`, with exact pointer-only argv and stdin EOF. Different `/room-a` and `/room-b` sources under the same origin/home/member/room/target invoke independently, while a cold cursor-save-fault retry with equivalent trailing-slash base reuses its original receipt. Userinfo/query/fragment/non-loopback HTTP still refuse before any fetch/provider call. Root-origin scope hashes remain identical; formerly rejected prefixes had no receiver journal created by the old helper.

Commands:

```
node --test --test-name-pattern='actual Node HTTP /room|two prefix' tests/notification-receiver.test.mjs
node --test tests/notification-receiver.test.mjs
node scripts/candidate-manifest.mjs --write
node --test tests/candidate-manifest.test.js
node node_modules/eslint/bin/eslint.js room-acp/src/notification-receiver.mjs tests/notification-receiver.test.mjs
node scripts/secret-scan-check.mjs
```

Before0pass/2fail. After21receiverpass/0fail/0skip, manifest8/8, lint0/secret0/diff0. Compressed exact logs/hashes are retained. No live alias/provider check, activation, credentials, ACK/lease/default behavior or deployment was changed. Earlier namespace proof remains source-pinned; this addendum records the additional supported-connection defect and cure.

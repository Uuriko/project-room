# Independent-review namespace correction

Source `fe30291370295629db10a7b0489e0e5344685472`, atop evidence `3578e84c1`. Independent authority_review found a genuine blocker in source388: receiver ownership scope included origin/member, but actuator receipts shared only executable/session/room/input. Two authenticated source scopes sharing a home could reuse one accepted actuator receipt and falsely advance the second discovery cursor without a second notification.

Both exact counterexamples fail on388: different origin and different member, same room/message/sequence/executable/session, actual private receiver and actuator journals, fake subprocess invocation count1 instead of2. Every first attempt intentionally faults cursor commit after the actuator outcome; the original exact in-flight source batch remains available.

Cure: only the actuator state root changes to `join(root, 'source-'+scope)`, where scope is the existing receiver hash of origin/room/member/fixed target. Nothing new is forwarded; argv still contains only room/message/sequence source pointers. Origin/member do not enter the provider prompt or confer authority.

After cure, both sources invoke the fake CLI independently (count2). Cold retry of each exact scope reuses its own accepted receipt and retains count2 despite the injected prior cursor-save loss. Existing unknown-retention assertion now reads the scoped actuator directory; business semantics and old actuator inputs are unchanged.

Commands:

```
node --test --test-name-pattern='actuator namespaces isolate' tests/notification-receiver.test.mjs
node --test tests/notification-receiver.test.mjs
node scripts/candidate-manifest.mjs --write
node --test tests/candidate-manifest.test.js
node node_modules/eslint/bin/eslint.js room-acp/src/notification-receiver.mjs tests/notification-receiver.test.mjs
node scripts/secret-scan-check.mjs
```

Before0pass/2fail; after18receiverpass/0fail/0skip, manifest8/8, lint0/secret0/diff0. No repeated unaffected actuator suite or Native/provider/live calls. Compressed logs retain exact hashes.

Original388/3578 evidence remains historically source-pinned but has this known blocking defect; it is not release qualification. Root confirms no live activation of388. This correction does not claim to migrate an already-running old388 in-flight actuator journal; such prior provider ambiguity would require explicit reconciliation. No old receipt is deleted or relocated automatically.

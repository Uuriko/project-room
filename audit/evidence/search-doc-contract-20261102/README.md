# Search OpenAPI legacy/native parity

Source `b6830da5b1d5eee2d899773b7e5fca095fffa989` on8c1c2bd45. Documentation/test only; no server behavior, count computation, cursor binding, access or data changes. No deployment or live claim.

The inherited QA200 regression asserted that search total was always integer. The actual normalized v2 API intentionally returns total:null with bounded source continuation; existing OpenAPI already declared the union correctly. The regression now preserves limit1..200/default50 and legacy complete integer counts while requiring native null, contractVersion2, sourceWindow/page and nullable nextCursor. It also pins empty-more continuation wording and rejects documentation that implies a native global count.

The exact search source fragment had shared cursor wording saying total stayed the full match count and nextCursor only served message/pinned legacy pages. Corrected it explicitly: legacy retains full count and anchor behavior; native supports all four kinds with room/credential/viewer/query/kind/limit/head binding, total stays null throughout, nextCursor is null at completion, and exact next arguments come from page.nextRead. Empty filtered pages can still have more. Generated docs/openapi.yaml with the official openapi-gen tool; no manual snapshot-only change.

Baseline command `node --test tests/qa200-reg12-openapi-parity.test.js`: two tests,one pass/one failure,exit1. Final `node --test tests/qa200-reg12-openapi-parity.test.js tests/openapi-room-core.test.js tests/current-work-search.test.mjs`: nine pass,zero skip,exit0. These include existing actual HTTP and normalized work/search controls. Local Node24.22.1 only; no browser or Worker rerun claimed. ESLint,secret scan and git diff --check exit0.

Complete gzip logs and hashes are in receipt.json. Recovery protocol test files were reported to root and left unchanged: tests/recovery-invitation-protocol.test.mjs archives old15 aa4a88c21; tests/recovery-report-protocol.test.mjs archives old18 a82574def. Their owner handles reconciliation.

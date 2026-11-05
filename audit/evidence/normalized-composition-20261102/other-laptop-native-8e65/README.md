# Isolated packaged Native durable restore qualification

Requested by Root at Room25953. Exact source8e65a6e73ae191ffa7fc89c2e88fa382ad2ac000.
Node24 command: node --test --test-name-pattern='verified offline archive runs the actual Native durable restore qualification' tests/runtime-package.test.js

Terminal exit0, one test passed, zero failures/cancellations/skips. Wall126.86s,
reaped childCPU176.14s. Existing outer test child timeout180s and Native timeout160s
unchanged; supervisory timeout210s was not reached. No runtime or fixture changes.

Reused existing local Miniflare4.20260730.0, esbuild0.28.2 and matching native
workerd1.20260730.1. MINIFLARE_WORKERD_PATH selects that existing macOS ARM binary;
PATH uses available Git for the test's immutable archive creation. No installation.
Archive722files/144assets, schema45, source tree and manifest hash in full.log.

Actual Native worker qualification:1000partialevents,1118coverage steps,
144cleanup steps, zero remaining guards, cold-ready and exact retries true,
native work capacity and retry true, package archive unchanged. Protocol20.
The qualification itself reports wholeRecoveryBounded:false and
finalUnboundedAuditRequired:true; passing does not establish a CPU bound.

Full terminal log retained unchanged. Receipt pins its SHA256 and environment.
This resolves the isolated-test question, not the whole suite, next activation
candidate, authenticated onboarding or production deployment. Root owns release.

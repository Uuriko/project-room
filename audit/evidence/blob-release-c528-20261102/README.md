# Blob release checkpoint

Staging run 41416473762 succeeded on exact c528117ac1d88d6ae23c4edfa296bf71a3af352f, build 2026-11-02T08:54:51.577Z. Public/browser smoke passed; extension-spec 404 remains a known warning. This is not authenticated adoption or production qualification.

Packaged Native recovery passed in isolation at the same source in 137.8s: 1,118 continuation steps, 144 cleanup steps, exact retries, cold restarts, sealed pending access and final ready. The earlier concurrent regression slice timed out this check; do not claim its full run passed. Recovery still explicitly reports wholeRecoveryBounded=false because its final audit remains required; bounded whole recovery is unfinished MVP work.

Normalized brief activation failed before on missing omitted board claims; fixed with 21 Node tests and the real Native scoped setup/wake check passing. Brief preserves window/omission metadata and does not label a partial window a global total. Two inbox tests cover current reply obligations and work discovery; preflight now passes. Readiness instrumentation accounts for two restore admission reads plus one probe; 17 Native tests pass without removing restore admission. Integrated protocol/smoke checks passed 32/32.

Production unchanged. No live room normalization or credential changes in this checkpoint. Export and legacy-maintenance fixes are separate subsequent commits, requiring their own evidence.

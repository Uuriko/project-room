# scripts/herdr-migrate.mjs — commands & journal contract (guild-05 D4)

## Purpose
scripts/herdr-migrate.mjs — migration / rollout tooling for the herdr redesign.

B20 (tooling) vs B21 (execution) split per D5 migration-rollout.md §5:
this script is the planner / inspector / rollback tool. B21 runs the
backfill waves with it. Scripts only — no runtime changes.

Commands:

## Commands
Commands:
  scan            Enumerate backfill-eligible claims (D5 §1.2). Writes nothing.

## Journal entry kinds (the B5 contract)
37://     kinds: backfill_plan, backfill_start, backfill_done, backfill_aborted,
    kinds: backfill_plan, backfill_start, backfill_done, backfill_aborted,
    backfill_skipped, reverse_start, reverse_done, reverse_aborted,
    force_release, orphan_marked, orphan_killed, migration_cursor.


## Exported functions (22)
91:parseArgs(argv) {
165:parseFlagValue(raw) {
176:effectiveFlagForRoom(parsed, roomId) {
182:flagStateLabel(parsed) {
197:resolveOptinMarker(claim, markers = {}) {
212:hasOpenChangesRequested(reviews) {
248:fileLeaseConflicts(items, claimed) {
287:classifyClaim(claim, ctx) {
382:idempotencyKey(roomId, claimId) {
386:isTerminalKind(kind) {
390:findTerminalEntry(entries, key) {
402:buildPlan(classified, { fromCursor = 0, limit = null } = {}) {
430:batchPlan(plan, batchSize) {
436:deriveExitCode({ systemic, total, ok, failed }) {
448:appendJournalEntry(journalPath, entry) {
464:readJournal(journalPath) {
479:buildScanReport({ command, roomId, dryRun, eligible, skipped }) {
496:renderHonestSummary(report) {
513:linkedClaimIds(journal, roomId) {
526:detectOrphans({ sessions, bridgeInventory, claimsById, nowMs }) {
552:aggregateDrainStatus({ roomId, flagParsed, sessions, claims, bridgeStatus }) {
571:planReverse({ roomId, claim, marker }) {

## Exit codes
58:export const EXIT_OK = 0;
59:export const EXIT_PARTIAL = 1;
60:export const EXIT_SYSTEMIC = 2;
437:  if (systemic) return EXIT_SYSTEMIC;
438:  if (failed > 0) return EXIT_PARTIAL;
439:  if (total > 0 && ok < total) return EXIT_PARTIAL;

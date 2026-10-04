// Barrel so the backfill script reaches every analytics module.
// AN-1b imports analyticsTailJob, exportAnalytics and analyticsHealth.
// AN-1c imports runWithRequestContext, classifySource and writeAnalyticsContext.
export {
  ACTOR_KINDS, ENVELOPE_PROP_KEYS, GROWTH_CATALOG, GROWTH_EVENT_NAMES, LOOPS, PROPS_MAX_BYTES,
  SOURCE_DETAILS, SOURCES, growthEventId, sourceDetailFor, validateGrowthEvent
} from "./catalog.mjs";
export {
  ANALYTICS_SCHEMA, addDaily, columnExists, dailyValue, ensureAnalyticsSchema, setDaily, tableExists, utcDay
} from "./schema.mjs";
export {
  absorbRoomEvent, activityNames, closeNames, emptyRoomFacts, firstKey, mapRoomEvent,
  workClaimReceiptDue, workItemReceiptDue
} from "./map-room-event.mjs";
export { derivedSources, readDerivedPage } from "./derive-tables.mjs";
export {
  COMMONS_ROOM_ID, EXCLUDED_NAME, analyticsTailJob, excludedRoomSet, insertAnalyticsBatch,
  runAnalyticsTail, structuralExclusion
} from "./tail.mjs";
export {
  DAILY_CAP, RETENTION_DAYS_MS, RETENTION_MAX_ROWS, dayBounds, planRetention, pruneAnalytics,
  samplingFactor, storedRowsOnDay, viewSamplingPlan
} from "./retention.mjs";
export { closedHour, dirSink, exportAnalytics, hourWindow, nullSink, r2Sink } from "./export.mjs";
export { REF_TTL_SEC, attributionFromRef, mintRef, readRef } from "./attribution.mjs";
export {
  CONTEXT_MAX_AGE_MS, CONTEXT_MAX_ROWS, classifySource, currentRequestContext, normalizeAgentClient,
  readAnalyticsContext, runWithRequestContext, writeAnalyticsContext
} from "./context.mjs";
export {
  analyticsHealth, baselineReport, isoWeekStart, loadMessages, referralK, roomFunnel,
  signupsByWeek, weekLabel, weeklyProductiveRooms
} from "./metrics.mjs";
export {
  dashboardHonestyReport, falsifierRows, johnActorIdsFromEnv, laneActivitySplit,
  laneActorIdsFromEnv, nonJohnFundedSettledPerWeek
} from "./dashboard-honesty.mjs";

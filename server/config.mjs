// One read of process env (or a caller-supplied env object) for Project Room.
//
// `loadConfig` does not throw. It records each variable once, applying only
// the defaults that the old call sites applied before any validation.
// Validators that throw (`deploymentConfig`, `streamIntervalConfig`) stay
// explicit so a Worker binding bag can be loaded without the Node listen
// rules. Pass a config object back in and the same object is returned.
//
// | Name | Default | Check | Reader |
// | --- | --- | --- | --- |
// | HOST | 127.0.0.1 | loopback host, else throw in deploymentConfig | server boot |
// | PORT | 4173 | integer 1–65535, else "Invalid PORT" | server boot |
// | NODE_ENV | unset | "production" is the production flag | server boot, web-fetch test context |
// | ROOM_DEPLOYMENT | unset | Node: only "invite-only", and it must match production. Worker values "production" and "staging" are left on cloudflare/room.mjs | server boot; room.mjs left (#4562) |
// | ROOM_ORIGIN | http://{host}:{port} | exact http(s) origin; https off loopback when deployed | server boot; room.mjs and edge asset fetch left as raw bindings |
// | ROOM_DB | .data/room.sqlite | production requires an absolute path | server boot |
// | ROOM_STREAM_INTERVAL_MS | 250 | integer 50–5000 | server boot |
// | ROOM_MAINTENANCE | unset (treated as "0") | "0" or "1" | server.mjs; room.mjs left (#4562) |
// | ROOM_INSTANCE_LOCK_PATH | {db dir}/.project-room.lock | non-empty string wins | server.mjs |
// | ROOM_GOOGLE_CLIENT_ID | unset | both unset → Google off; partial/invalid throws in googleConfig | google-oauth |
// | ROOM_GOOGLE_CLIENT_SECRET | unset | opaque, ≤256 | google-oauth |
// | GITHUB_OAUTH_CLIENT_ID | unset | both unset → GitHub off | github-oauth |
// | GITHUB_OAUTH_CLIENT_SECRET | unset | opaque, ≤256 | github-oauth |
// | ROOM_GMAIL_ENABLED | unset | exactly "1" enables | gmail-mailbox; jobs.mjs left (scheduler) |
// | ROOM_GMAIL_TOKEN_KEY | unset | 64 hex when enabled | gmail-mailbox |
// | ROOM_GMAIL_PILOT_ONLY | unset | "1" limits to the pilot account | gmail-mailbox |
// | ROOM_GMAIL_PILOT_ACCOUNT_ID | unset | falls back to ROOM_OPERATOR_ACCOUNT_ID | gmail-mailbox |
// | ROOM_OPERATOR_ACCOUNT_ID | unset | raw string | gmail-mailbox; http.mjs and room.mjs left (#4562) |
// | RESEND_API_KEY | unset | absent → mailer off | resend-mailer, notify-email |
// | ROOM_MAGIC_FROM | Project Room <noreply@trydemigod.com> when the key is set and From is empty | non-empty string | resend-mailer, notify-email |
// | TELEMETRY | off | "1" or "true" | delivery-tracing |
// | OTEL_EXPORTER_OTLP_ENDPOINT | null | raw | delivery-tracing |
// | OTEL_SERVICE_NAME | project-room | raw or default | delivery-tracing |
// | ROOM_VAPID_PUBLIC_KEY | unset | all three required | push-subscriptions |
// | ROOM_VAPID_PRIVATE_KEY | unset | all three required | push-subscriptions |
// | ROOM_VAPID_SUBJECT | unset | all three required | push-subscriptions |
// | PUSH_DECLARATIVE | off | exactly "on" | human-push |
// | UNIFY_R_CURSOR | off | 1, true, or on | read-cursor |
// | GROWTH_FORCE_ARMS | unset | id:arm pairs | growth-experiments |
// | ROOM_OPERATOR_PROTECTED_ROOMS | none | comma-separated ids | operator-purge |
// | ROOM_SQL_BIND_LIMIT | unset (driver default) | positive integer | store |
// | ROOM_PASSKEY_RP_ID | origin hostname | non-empty string override | account-passkeys |
// | GITHUB_TOKEN | unset | falls through to GH_TOKEN | work-claim-routes |
// | GH_TOKEN | unset | null when both empty | work-claim-routes |
// | GITHUB_REPOSITORY | Uuriko/project-room | owner/name | claim-pr-sync |
// | ANALYTICS_ENABLED | on | "0" skips the tail job | analytics/tail |
// | ANALYTICS_EXCLUDED_ROOMS | none | comma-separated | analytics/tail |
// | ANALYTICS_LANE_ACTOR_IDS | none | comma-separated | analytics/dashboard-honesty |
// | ANALYTICS_JOHN_ACTOR_IDS | none | comma-separated | analytics/dashboard-honesty |
// | ANALYTICS_REF_KEY | null | raw | analytics/tail |
// | CHANNEL_SEND_BUDGET_PER_MIN | 30 | positive number | channel-send-budgets |
// | CHANNEL_SEND_BUDGET_BURST | 30 | positive number | channel-send-budgets |
// | CHANNEL_SEND_BUDGETS | unset | JSON map, malformed ignored | channel-send-budgets |
// | {CHANNEL}_SEND_BUDGET_PER_MIN | channel default | dynamic binding via config.read | channel-send-budgets |
// | {CHANNEL}_SEND_BUDGET_BURST | channel default | dynamic binding via config.read | channel-send-budgets |
// | STITCH_IDENTITY_SALT | unset | 64 hex and STITCHING_ENABLED=true | inbox-stitch |
// | STITCHING_ENABLED | off | "true" | inbox-stitch |
// | TELEGRAM_BOT_TOKEN | unset | bot-id:secret shape | telegram-config |
// | TELEGRAM_WEBHOOK_SECRET | unset | 16–256 url-safe | telegram-config |
// | TELEGRAM_API_BASE | https://api.telegram.org | https origin | telegram-config |
// | ROOM_IDENTITY_HASH_KEY | built-in fallback key | trimmed, ≥16, else ignored | identity-secret-hash; room.mjs passes the raw binding (#4562) |
// | GITHUB_APP_ID | unset | digits, all three required | github-app/auth |
// | GITHUB_APP_PRIVATE_KEY | unset | PEM | github-app/auth |
// | GITHUB_APP_WEBHOOK_SECRET | unset | trimmed | github-app/auth |
// | NODE_TEST_CONTEXT | unset | any value counts as test | web-fetch |
// | WEB_FETCH_ALLOW_LOOPBACK | off | "1" only inside a test context | web-fetch |
// | ROOM_SECURITY_CONTACT | unset | security.txt 404 when empty | edge-public; http.mjs left (#4562) |
// | ROOM_PAUSE_BLOCKS_POSTS | off | "1" | http.mjs left (#4562) |
// | ROOM_BOOTSTRAP_OWNER_HASH | unset | 64 lowercase hex | cloudflare/bootstrap |
// | ROOM_BOOTSTRAP_EXPIRES_AT | unset | unix ms, not past, ≤7 days | cloudflare/bootstrap |
// | PROBE_CHECK_TIMEOUT_MS | 10000 | integer 100–30000 else default | external-probe |
// | PROBE_ORIGIN | https://room.trydemigod.com | probe origin | external-probe |
// | PROBE_ALERT_WEBHOOK_URL | unset | https, or http loopback | external-probe |
// | PROBE_ROOM_ORIGIN / ROOM_AGENT_ORIGIN | unset | probe origin | external-probe |
// | PROBE_ROOM_ID / ROOM_AGENT_ROOM | unset | room id | external-probe |
// | PROBE_ROOM_TOKEN / ROOM_AGENT_TOKEN | unset | 8–512 chars | external-probe |
// | GROWTH_SNAPSHOT_PATH | {db dir}/growth-snapshot.json | left on the scheduler in server.mjs | scheduler |
// | GROWTH_WATCH_INTERVAL_MS | growth default | left in server/jobs.mjs | scheduler |
// | CHANNEL_DRAIN_INTERVAL_MS | drain default | left in server/jobs.mjs | scheduler |
// | ROOM_BACKUPS / ROOM_BACKUPS_KV | unset | binding objects, left in jobs.mjs and room.mjs | scheduler / #4562 |
// | ROOM_BACKUP_TOKEN | unset | left in cloudflare/room.mjs | #4562 |
// | ROOM_BOARD_V2_ENABLED | off | "1", left in cloudflare/room.mjs | #4562 |
// | ROOM_BODIES_AT_REST | off | "1", left in cloudflare/room.mjs | #4562 |
// | ROOM_SERVICE_MODE | cloudflare-staging | left in cloudflare/room.mjs | #4562 |
// | ASSETS, ROOM, PROBE_STATE | Worker bindings | not scalars; left at the binding use | worker |
import { isAbsolute, resolve } from "node:path";

const LOADED = Symbol("loadedRoomConfig");

export const STREAM_INTERVAL_DEFAULT_MS = 250, STREAM_INTERVAL_MIN_MS = 50, STREAM_INTERVAL_MAX_MS = 5000;
export const MAGIC_FROM_DEFAULT = "Project Room <noreply@trydemigod.com>";
export const GITHUB_REPOSITORY_DEFAULT = "Uuriko/project-room";
export const OTEL_SERVICE_NAME_DEFAULT = "project-room";

function readBinding(source, name) {
  if (source == null) return undefined;
  const value = source[name];
  return value === undefined ? undefined : value;
}

export function loadConfig(env = process.env) {
  if (env && typeof env === "object" && env[LOADED]) return env;
  const source = env === undefined || env === null ? (env === undefined ? process.env : {}) : env;
  const read = name => readBinding(source, name);
  const host = source.HOST || "127.0.0.1";
  const port = Number(source.PORT || 4173);
  const config = {
    source,
    read,
    host,
    port,
    nodeEnv: read("NODE_ENV"),
    roomDeployment: read("ROOM_DEPLOYMENT"),
    roomOrigin: read("ROOM_ORIGIN"),
    roomDb: read("ROOM_DB"),
    streamIntervalRaw: read("ROOM_STREAM_INTERVAL_MS"),
    roomMaintenance: read("ROOM_MAINTENANCE"),
    instanceLockPath: read("ROOM_INSTANCE_LOCK_PATH"),
    growthSnapshotPath: read("GROWTH_SNAPSHOT_PATH"),
    googleClientId: read("ROOM_GOOGLE_CLIENT_ID"),
    googleClientSecret: read("ROOM_GOOGLE_CLIENT_SECRET"),
    githubOauthClientId: read("GITHUB_OAUTH_CLIENT_ID"),
    githubOauthClientSecret: read("GITHUB_OAUTH_CLIENT_SECRET"),
    gmailEnabled: read("ROOM_GMAIL_ENABLED"),
    gmailTokenKey: read("ROOM_GMAIL_TOKEN_KEY"),
    gmailPilotAccountId: read("ROOM_GMAIL_PILOT_ACCOUNT_ID"),
    gmailPilotOnly: read("ROOM_GMAIL_PILOT_ONLY"),
    operatorAccountId: read("ROOM_OPERATOR_ACCOUNT_ID"),
    resendApiKey: read("RESEND_API_KEY"),
    magicFrom: read("ROOM_MAGIC_FROM"),
    telemetry: read("TELEMETRY"),
    otelEndpoint: read("OTEL_EXPORTER_OTLP_ENDPOINT"),
    otelServiceName: read("OTEL_SERVICE_NAME"),
    vapidPublicKey: read("ROOM_VAPID_PUBLIC_KEY"),
    vapidPrivateKey: read("ROOM_VAPID_PRIVATE_KEY"),
    vapidSubject: read("ROOM_VAPID_SUBJECT"),
    pushDeclarative: read("PUSH_DECLARATIVE"),
    unifyRCursor: read("UNIFY_R_CURSOR"),
    growthForceArms: read("GROWTH_FORCE_ARMS"),
    operatorProtectedRooms: read("ROOM_OPERATOR_PROTECTED_ROOMS"),
    sqlBindLimit: read("ROOM_SQL_BIND_LIMIT"),
    passkeyRpId: read("ROOM_PASSKEY_RP_ID"),
    githubToken: read("GITHUB_TOKEN") || read("GH_TOKEN") || null,
    githubRepository: read("GITHUB_REPOSITORY") || GITHUB_REPOSITORY_DEFAULT,
    analyticsEnabled: read("ANALYTICS_ENABLED"),
    analyticsExcludedRooms: read("ANALYTICS_EXCLUDED_ROOMS"),
    analyticsLaneActorIds: read("ANALYTICS_LANE_ACTOR_IDS"),
    analyticsJohnActorIds: read("ANALYTICS_JOHN_ACTOR_IDS"),
    analyticsRefKey: read("ANALYTICS_REF_KEY"),
    channelSendBudgetPerMin: read("CHANNEL_SEND_BUDGET_PER_MIN"),
    channelSendBudgetBurst: read("CHANNEL_SEND_BUDGET_BURST"),
    channelSendBudgets: read("CHANNEL_SEND_BUDGETS"),
    stitchSalt: read("STITCH_IDENTITY_SALT"),
    stitchingEnabled: read("STITCHING_ENABLED"),
    telegramBotToken: read("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: read("TELEGRAM_WEBHOOK_SECRET"),
    telegramApiBase: read("TELEGRAM_API_BASE"),
    identityHashKey: read("ROOM_IDENTITY_HASH_KEY"),
    githubAppId: read("GITHUB_APP_ID"),
    githubAppPrivateKey: read("GITHUB_APP_PRIVATE_KEY"),
    githubAppWebhookSecret: read("GITHUB_APP_WEBHOOK_SECRET"),
    nodeTestContext: read("NODE_TEST_CONTEXT"),
    webFetchAllowLoopback: read("WEB_FETCH_ALLOW_LOOPBACK"),
    securityContact: read("ROOM_SECURITY_CONTACT"),
    pauseBlocksPosts: read("ROOM_PAUSE_BLOCKS_POSTS"),
    bootstrapOwnerHash: read("ROOM_BOOTSTRAP_OWNER_HASH"),
    bootstrapExpiresAt: read("ROOM_BOOTSTRAP_EXPIRES_AT"),
    probeCheckTimeoutMs: read("PROBE_CHECK_TIMEOUT_MS"),
    probeOrigin: read("PROBE_ORIGIN"),
    probeAlertWebhookUrl: read("PROBE_ALERT_WEBHOOK_URL"),
    probeRoomOrigin: read("PROBE_ROOM_ORIGIN"),
    probeRoomId: read("PROBE_ROOM_ID"),
    probeRoomToken: read("PROBE_ROOM_TOKEN"),
    roomAgentOrigin: read("ROOM_AGENT_ORIGIN"),
    roomAgentRoom: read("ROOM_AGENT_ROOM"),
    roomAgentToken: read("ROOM_AGENT_TOKEN"),
    growthWatchIntervalMs: read("GROWTH_WATCH_INTERVAL_MS"),
    channelDrainIntervalMs: read("CHANNEL_DRAIN_INTERVAL_MS"),
    roomBoardV2Enabled: read("ROOM_BOARD_V2_ENABLED"),
    roomBodiesAtRest: read("ROOM_BODIES_AT_REST"),
    roomServiceMode: read("ROOM_SERVICE_MODE"),
    roomBackupToken: read("ROOM_BACKUP_TOKEN"),
  };
  Object.defineProperty(config, LOADED, { value: true });
  return config;
}

// Callers that used to read `env.NAME` directly. null and undefined throw
// the same way a property read would. Other non-objects read as empty,
// which is what a primitive property access returns.
export function envConfig(env) {
  if (env == null) env.HOST;
  if (typeof env !== "object") return loadConfig({});
  return loadConfig(env);
}

// Event-stream pump: every open stream polls committed events once per
// interval. 250 ms is the pilot default. The floor keeps a typo from
// turning into thousands of reads per second; the ceiling keeps a typo
// from making streams look dead.
export function streamIntervalConfig(env = process.env) {
  const raw = envConfig(env).streamIntervalRaw;
  if (raw === undefined || raw === "") return STREAM_INTERVAL_DEFAULT_MS;
  const value = /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
  if (!Number.isInteger(value) || value < STREAM_INTERVAL_MIN_MS || value > STREAM_INTERVAL_MAX_MS) {
    throw new Error(`ROOM_STREAM_INTERVAL_MS must be an integer between ${STREAM_INTERVAL_MIN_MS} and ${STREAM_INTERVAL_MAX_MS} milliseconds`);
  }
  return value;
}

export function deploymentConfig(env = process.env) {
  const cfg = envConfig(env);
  const { host, port } = cfg;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Bind only to loopback; use the same-host HTTPS proxy");
  const production = cfg.nodeEnv === "production";
  if (cfg.roomDeployment && cfg.roomDeployment !== "invite-only") throw new Error("Unknown deployment mode");
  if (production !== (cfg.roomDeployment === "invite-only")) throw new Error("Production requires explicit ROOM_DEPLOYMENT=invite-only and NODE_ENV=production");
  const origin = cfg.roomOrigin || `http://${host === "::1" ? "[::1]" : host}:${port}`;
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("ROOM_ORIGIN must be an exact HTTP(S) origin");
  if (url.protocol !== "https:" && (production || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Deployment requires an HTTPS origin");
  if (production && (!cfg.roomDb || !isAbsolute(cfg.roomDb))) throw new Error("Production requires an absolute persistent ROOM_DB path");
  return { host, port, origin, filename: resolve(cfg.roomDb || ".data/room.sqlite"), production, streamInterval: streamIntervalConfig(cfg) };
}

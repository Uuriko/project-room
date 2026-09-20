import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateVapidKeys } from "../server/web-push.mjs";
import { deliverPush, normaliseSubscription, pushConfigured, pushPayloadFor, vapidFromEnv } from "../server/push-subscriptions.mjs";

// Trusted local operator tool for turning push delivery on and proving it works.
// It prints no room content and no private key it was given: --keys writes a new
// private key to stdout because that is the only moment it exists, and --send
// prints only the push service's verdict.
//
// Push delivery is off until three secrets are set, so the intended order is:
//   1. node scripts/push-doctor.mjs --keys        generate a VAPID pair
//   2. wrangler secret put ROOM_VAPID_PRIVATE_KEY (and the public key, subject)
//   3. node scripts/push-doctor.mjs --check       confirm the worker sees them
//   4. node scripts/push-doctor.mjs --send --subscription sub.json
//
// Step 4 needs a subscription captured from a browser that has granted
// permission; there is no way to synthesise one, which is the point.

const { values } = parseArgs({
  options: {
    keys: { type: "boolean" },
    check: { type: "boolean" },
    send: { type: "boolean" },
    subscription: { type: "string" },
    room: { type: "string" },
    help: { type: "boolean" }
  }
});

if (values.help || (!values.keys && !values.check && !values.send)) {
  console.log(`node scripts/push-doctor.mjs [--keys] [--check] [--send --subscription <file>] [--room <id>]

Sets up and verifies Web Push delivery. Push is off unless ROOM_VAPID_PUBLIC_KEY,
ROOM_VAPID_PRIVATE_KEY and ROOM_VAPID_SUBJECT are all set; with none of them the
product behaves exactly as it does today.

Options:
  --keys                 Generate a VAPID key pair and print it. Store the private
                         key as a secret; it is not written anywhere by this tool.
  --check                Report whether delivery is configured in this environment.
  --send                 Send one test push. Requires --subscription.
  --subscription <file>  JSON from the browser's PushSubscription.toJSON().
  --room <id>            Room id to name in the test payload (default: commons).
  --help                 Show this help.`);
  process.exit(0);
}

if (values.keys) {
  const keys = await generateVapidKeys();
  process.stdout.write(`${JSON.stringify({
    ROOM_VAPID_PUBLIC_KEY: keys.publicKey,
    ROOM_VAPID_PRIVATE_KEY: keys.privateKey,
    ROOM_VAPID_SUBJECT: "mailto:CHANGE-ME@example.com"
  }, null, 2)}\n`);
  process.stderr.write("The private key is shown once and stored nowhere. Put it in a secret store now.\n");
}

if (values.check) {
  const configured = pushConfigured(process.env);
  process.stdout.write(`${JSON.stringify({
    configured,
    publicKey: Boolean(process.env.ROOM_VAPID_PUBLIC_KEY),
    privateKey: Boolean(process.env.ROOM_VAPID_PRIVATE_KEY),
    subject: process.env.ROOM_VAPID_SUBJECT ?? null
  })}\n`);
  if (!configured) process.stderr.write("Push delivery is off. Nothing is sent and nothing fails; set all three to turn it on.\n");
}

if (values.send) {
  if (!values.subscription) {
    process.stderr.write("--send needs --subscription <file>: a PushSubscription captured from a browser.\n");
    process.exit(1);
  }
  const vapid = vapidFromEnv(process.env);
  if (!vapid) {
    process.stderr.write("Push delivery is not configured in this environment; run --check.\n");
    process.exit(1);
  }

  let subscription;
  try {
    subscription = normaliseSubscription(JSON.parse(readFileSync(values.subscription, "utf8")));
  } catch (error) {
    process.stderr.write(`That subscription was refused: ${error.code ?? "unreadable"} - ${error.message}\n`);
    process.exit(1);
  }

  const result = await deliverPush({
    subscription,
    payload: pushPayloadFor({ roomId: values.room || "commons", unread: 1, sequence: null, notifications: [{ kind: "mention" }] }),
    vapid,
    ttlSeconds: 60
  });

  // The endpoint is a bearer capability for that device, so it is reported by
  // origin only rather than in full.
  process.stdout.write(`${JSON.stringify({
    outcome: result.outcome,
    status: result.status,
    reason: result.reason ?? null,
    pushService: new URL(subscription.endpoint).origin
  })}\n`);

  if (result.outcome !== "delivered") {
    process.stderr.write(result.outcome === "retired"
      ? "That subscription is gone; the browser must subscribe again.\n"
      : "The push was not delivered. A retry outcome is the push service, not this configuration.\n");
    process.exitCode = 1;
  }
}

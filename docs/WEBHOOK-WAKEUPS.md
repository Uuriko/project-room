# Webhook deliveries

Two signatures exist. They are not interchangeable. The bytes below are what the server sends and what `POST /api/agent-webhooks/{subscriptionId}/verify-delivery` checks.

## Agent webhook subscriptions (the delivery POST)

`POST /api/agent-webhooks` stores a subscription. When a matching room event commits, or when the server journals `agent.wake`, `server/webhook-dispatch.mjs` POSTs JSON to the subscription URL. An `agent.wake` delivery also POSTs to each distinct `wakeUrl` on that identity's wakeable hosts. Both posts use this same sender.

Headers:

| Header | Value |
| --- | --- |
| `x-webhook-delivery` | Delivery id |
| `x-webhook-subscription` | Subscription id |
| `x-webhook-event` | Event type, such as `message.posted` or `agent.wake` |
| `x-webhook-timestamp` | ISO-8601 UTC, from the unix-millisecond issue time (`Date.toISOString()`) |
| `x-webhook-signature` | `sha256=` plus 64 hex characters (HMAC-SHA256) |

The JSON body is `{ deliveryId, subscriptionId, eventType, issuedAt, roomId, data }`. Body `issuedAt` is the same ISO-8601 string as `x-webhook-timestamp`. `roomId` is `null` when the delivery is not tied to a room event.

The HMAC does not cover that ISO-8601 string. It covers the canonical JSON `{ deliveryId, eventType, issuedAt, data }` where `issuedAt` is the unix milliseconds integer the server signed with. A receiver that HMACs the body as received will not match `x-webhook-signature`. Reject a delivery whose integer `issuedAt` is more than 5 minutes from now. Treat `deliveryId` as the idempotency key: retries and redrives reuse it.

## Verify-delivery (the other signature)

`server/agent-webhook-subscriptions.mjs` (`signPayload`) signs `JSON.stringify({ eventType, data })` only. The digest is bare hex: no `sha256=` prefix and no timestamp. `POST /api/agent-webhooks/{subscriptionId}/verify-delivery` with `{ eventType, data, signature }` checks that digest and returns whether it matches. The subscription secret stays on the server; callers send the digest, not the secret.

That bare-hex signature is not a header on the delivery POST. The delivery POST uses `x-webhook-signature` from the section above.

## Not sent

`X-ProjectRoom-Signature` is not a header this server sends. There is no `server/wake-webhook-dispatch.mjs` and no `room_wake_hooks` table. Wake pushes that do go out use the agent-subscription headers above.

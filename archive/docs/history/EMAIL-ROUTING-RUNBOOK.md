# Email inbound go-live runbook

What you tap in the Cloudflare dashboard to start receiving email in the
project room. Nothing else unblocks this: no secret, no API token, no paid
plan. The Worker receives each message directly from Cloudflare's SMTP edge.

## 1. Turn on Email Routing (one time per domain)

1. Dashboard → your domain → **Email > Email Routing > Get started**.
2. Accept the **MX** and **SPF** DNS records Cloudflare adds.
3. If that domain's inbound mail is already served by another MX (e.g. your
   personal mailbox), do **not** move it — use a subdomain instead (for
   example `mail.getdasha.com`) so nothing existing changes.

## 2. Bind the Worker (one routing rule)

1. **Email Routing > Email Workers**.
2. Add a routing rule with action **"Send to a Worker"** pointing at the
   deployed Worker **`project-room-staging`**.
3. Use the domain **catch-all** rule: then plus-addresses and new aliases
   need no further dashboard change. Mail to unknown addresses is rejected
   with "Unknown recipient" — never accepted silently.

(You may also skip a destination address: plain forwarding needs one, the
Worker path does not.)

## 3. Pick the address scheme

Suggested: one inbox connection per room mailbox, for example
`room@mail.getdasha.com`. Plus-addressing works for tags:
`room+ticket-42@mail.getdasha.com` routes to the same connection. An
optional catch-all can be declared on the connection as the alias
`*@mail.getdasha.com`.

## 4. What happens next

- Incoming mail is capped (1 MiB raw, parser caps on headers/parts/bodies),
  routed to the matching connection, and parked in the room until the import
  authority lands (that's the next slice, B20 — until then the owner's next
  sync imports it).
- Nothing is sent anywhere: outbound mail stays blocked.
- Maintenance mode rejects mail with a temporary failure, so senders retry
  instead of bouncing.

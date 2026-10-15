# Email inbound via Cloudflare Email Routing

Status: **code and tests only**. Nothing in this tree receives real mail. Mail
arrives only after John enables Email Routing on the domain and a Worker
`email()` handler (proposal below, for Grok, in `cloudflare/room.mjs`) is
mounted and deployed. Until both happen, the modules here are exercised by
fixtures in `tests/mime-message.test.js` and `tests/email-routing-inbound.test.js`.

Email Routing is free on Cloudflare plans. No paid service, no new dependency
(decision D6 default: a minimal parser was evaluated first and is sufficient for
the inbox's needs; see "Parser scope").

## Modules

| File | Role |
| --- | --- |
| `server/mime-message.mjs` | Minimal RFC 5322 / MIME reader: headers (folding, RFC 2047 Q/B encoded-words, UTF-8 and ISO-8859-1), Content-Type/Disposition parameters (quoted, RFC 2231), `multipart/*` nesting, `text/plain` and `text/html` bodies, quoted-printable and base64, attachments listed by name/type/size (bodies discarded), a conservative HTML-to-text preview. |
| `server/email-routing-inbound.mjs` | Recipient routing (exact, plus-addressing, catch-all), parse, envelope mapping, idempotency key, `page.apply` request for the existing importer, `{ accept | reject(reason) }` decision. |
| `server/channel-adapters/email.mjs` | Existing Graph adapter unchanged; adds the Email Routing source: `normalizeRoutedEmail`, `bindRouting`, `emailRoutingFolderId`, `emailRoutingCapabilities`. |

The connection record is the existing email profile (`provider: microsoft-graph`
shape with `identity` and `aliases`); the envelope contract and the adapter
registry are keyed on it. A dedicated `cloudflare-email-routing` provider needs
`channelProviders` in `server/channel-connection.mjs` and the registry in
`server/channel-adapters/index.mjs`; that is left as a follow-up so this slice
touches no shared contract. Routed messages live in the folder
`email-routing` (`envelope.message.folderId`), so they are distinguishable from
Graph folders in state, receipts and journals.

## What John must do (nothing else unblocks this)

1. In the Cloudflare dashboard for the domain: **Email > Email Routing >
   Get started**. Accept the MX and SPF DNS records Cloudflare adds. Existing
   inbound mail on that domain must not already be served by another MX,
   otherwise use a subdomain (for example `mail.getdasha.com`) so nothing
   existing changes.
2. Add a destination address only if you also want plain forwarding; the
   Worker path does not need one.
3. **Email Routing > Email Workers**: bind the deployed Worker
   (`project-room-staging`) as the action of a routing rule. Either a specific
   address rule per connection address, or the domain **catch-all** rule with
   action "Send to a Worker" so plus-addresses and new aliases need no dashboard
   change. Unrouted mail to unknown addresses is then rejected by the handler
   with "Unknown recipient", never accepted silently.
4. Confirm the address scheme with potter. Suggested: one inbox connection
   per room mailbox (`room@mail.getdasha.com`), plus-addressing for tags
   (`room+ticket-42@mail.getdasha.com` routes to the same connection; the tag
   is returned as `match: "plus", tag`), and an optional catch-all declared on
   the connection as the alias `*@mail.getdasha.com`.
5. Nothing else: no secret, no API token, no paid plan. The Worker receives
   the message object directly from Cloudflare's SMTP edge.

## Address scheme and routing order

Routing keys are the address without angle brackets, lower-cased (the envelope
keeps the local part as written). For a recipient `local+tag@domain` the module
tries, in order:

1. exact `local+tag@domain` (identity or alias of an active email connection);
2. `local@domain` (plus-addressing stripped; the tag is reported);
3. `*@domain` (only if a connection declares that alias).

A lookup that returns a connection which does not list the matched address is
ignored (defence against a mis-keyed query). No match rejects with
`Unknown recipient`.

## Caps (all enforced before anything is stored)

| Cap | Value | Where |
| --- | --- | --- |
| Raw message | 1 MiB (`mimeLimits.rawBytes`; configurable per call, never raised by the message) | checked from `message.rawSize` before the stream is read, again on the bytes |
| Header fields | 200; each unfolded field at most 8192 bytes | parser |
| MIME parts | 50; nesting depth 4 | parser |
| Attachments listed | 100 (bodies measured, never kept) | parser |
| Text / HTML body | 262144 bytes each (`emailLimits.bodyBytes`), truncated on a code-point boundary and flagged `truncated` | parser |
| Addresses per header | 200 total recipients in the envelope (`emailLimits.recipients`) | parser and envelope |
| Messages per connection folder | 1000 (existing `email_folder_limit` pilot cap) | importer |

Exceeding a parser cap is a `MimeError` with a code (`mime_raw_limit`,
`mime_header_limit`, `mime_part_limit`, `mime_depth_limit`,
`mime_attachment_limit`, `malformed_mime_boundary`, `malformed_mime_header`).
The routing module turns those into `{ accept: false, reason }` with a short
ASCII reason suitable for `message.setReject()` ("Message too large",
"Message could not be parsed", "Unknown recipient"). Infrastructure errors
(database unavailable) are rethrown so the handler can answer with a temporary
failure instead of a permanent bounce.

## Idempotency

`requestId = "email-routing-" + sha256([accountId, connectionId, Message-ID])`;
without a Message-ID the SHA-256 of the raw bytes stands in. The importer's
journal already refuses a reused request id, so a redelivered message imports
nothing (`applyRoutedEmail` checks `store.email.priorReceipt` first and reports
`duplicate: true`). `message.revision` is the raw digest, so the same
Message-ID with different bytes is a new version of the same source, exactly
like an edited Telegram message.

## Security notes

- Header values are unfolded, decoded, then stripped of every control
  character (including CR/LF from encoded-words) and made well-formed before
  they reach the envelope; a decoded CR/LF can never form a new header.
- Boundaries are validated against the RFC 2046 alphabet (1-70 chars) and
  matched with `indexOf` at line starts, never interpolated into a regular
  expression. Every regular expression applied to untrusted text has bounded,
  non-nested quantifiers; the test suite runs pathological inputs (200k `<`,
  50k comment openers, 50k encoded-word openers, 20k prefix-sharing boundary
  lines) under a time budget.
- No decompression: quoted-printable and base64 only shrink, so the raw cap
  bounds all decoded sizes. Attachment bytes are counted and dropped.
- HTML is never rendered or stored beyond the capped body; the preview comes
  from a tag-stripping, entity-decoding text conversion that removes comment,
  script, style, head and title blocks first. Output is plain text.
- The SMTP envelope sender may be empty (bounces). A message with neither a
  usable `From` header nor an envelope sender is rejected, never stored with
  an invented sender.
- Reject reasons carry no message content. Raw digests are not projected to
  the browser (`tests/email-routing-inbound.test.js` checks the email view).
- Nothing here sends mail. `bindRouting().submit/lookup` refuse with
  `channel_sending_unavailable`; outbound is B23.

## Import authority (open, depends on B20)

`completeRoutedImport()` returns the exact `page.apply` request the importer
accepts and `applyRoutedEmail()` applies it with an account session token.
The Worker handler has no owner session, so the Durable Object needs a system
import authority for routed mail (writer fence / import authority is B20's
area). Until that exists the handler proposal parks accepted messages in the
DO and the owner's next sync imports them; the alternative (store the routed
request under an internal authority) needs B20's decision.

## Worker email() handler (proposal for Grok)

To be added to `cloudflare/room.mjs` next to the default `fetch` export and as
methods on the `ProjectRoom` Durable Object. Not applied here: room.mjs is
Grok's area and B20 has a proposal branch touching it.

```js
// cloudflare/room.mjs (proposal, additions only)
import { routeInboundEmail, emailRoutingLimits, emailRoutingRejections, connectionAddresses, routingKey } from '../server/email-routing-inbound.mjs';
import { emailConnection } from '../server/email-envelope.mjs';
import { isEmailProfile } from '../server/channel-connection.mjs';

// --- inside `export class ProjectRoom` ---------------------------------------
  // RPC: active email connections whose identity or alias lists this routing key.
  // Runs in the DO so no connection data leaves it. Returns the profile or null.
  lookupRoutedConnection(address) {
    if (this.paused) return null;
    const key = routingKey(address);
    if (!key) return null;
    return this.store.readTransaction(() => {
      for (const row of this.store.db.prepare("SELECT data_json FROM private_email_connections WHERE provider='microsoft-graph'").all()) {
        const connection = JSON.parse(row.data_json);
        if (connection.state !== 'active' || !isEmailProfile(connection.profile)) continue;
        if (connectionAddresses(emailConnection(connection.profile)).includes(key)) return connection.profile;
      }
      return null;
    });
  }
  // RPC: hand an accepted, already-routed message to the importer. Needs the
  // system import authority from B20; until then it parks the request so the
  // owner's next sync imports it. Returns { accepted, duplicate }.
  importRoutedEmail(routed) {
    if (this.paused) throw new Error('Room paused');
    // B20: replace with the account-scoped import authority, e.g.
    //   return this.store.email.applyRouted(routed)  (completeRoutedImport + apply under the import fence)
    this.routedMail ??= new Map();
    if (this.routedMail.has(routed.requestId)) return { accepted: true, duplicate: true };
    if (this.routedMail.size >= 500) throw new Error('Routed mail backlog full');
    this.routedMail.set(routed.requestId, routed);
    return { accepted: true, duplicate: false };
  }
// ------------------------------------------------------------------------------

export default {
  async fetch(request, env) { /* unchanged */ },

  // Cloudflare Email Routing calls this for every message a routing rule sends
  // to the Worker. message.from / message.to are the SMTP envelope addresses;
  // message.raw is a ReadableStream of the RFC 5322 bytes; message.rawSize is
  // its length; setReject() answers a permanent SMTP error with the reason.
  async email(message, env, ctx) {
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) { message.setReject(emailRoutingRejections.unavailable); return; }
    // Refuse before reading the stream: the size cap is the first defence.
    if (message.rawSize > emailRoutingLimits.rawBytes) { message.setReject(emailRoutingRejections.tooLarge); return; }
    const room = env.ROOM.getByName('invite-only-pilot');
    let routed;
    try {
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      routed = await routeInboundEmail(
        { from: message.from, to: message.to, raw, rawSize: message.rawSize, receivedAt: new Date().toISOString() },
        { lookup: address => room.lookupRoutedConnection(address) });
    } catch {
      // Storage or RPC failure: temporary reject so the sender retries; never a silent drop.
      message.setReject(emailRoutingRejections.unavailable); return;
    }
    if (!routed.decision.accept) { message.setReject(routed.decision.reason); return; }
    try { await room.importRoutedEmail(routed); }
    catch { message.setReject(emailRoutingRejections.unavailable); }
  }
};
```

Notes for the reviewer:

- `email()` runs on the same Worker as `fetch`; no route pattern is involved,
  Email Routing invokes it directly. `wrangler.jsonc` needs no change for the
  handler itself. If a separate Worker is preferred, only the two RPC methods
  need to live on the DO.
- The lookup RPC returns the profile only (no secret hash, no cursors). The
  routed object handed to `importRoutedEmail` contains the normalized
  envelope, not the raw bytes; the raw digest is its revision.
- The cap check on `rawSize` happens before `message.raw` is consumed. Reading
  a stream larger than the cap is refused a second time inside
  `routeInboundEmail` from the actual byte length.
- `ctx.waitUntil` is not used: the reject decision must be made before the
  handler returns, otherwise Cloudflare accepts the message.

## What stays blocked until routing is enabled

- No message reaches the Worker: Email Routing is off on the domain and the
  handler is not mounted.
- The DO import authority for routed mail (B20).
- Outbound / reply (B23): the routing source reports `outbound: "none"`; every
  `submit`/`lookup` refuses with `channel_sending_unavailable`.
- A dedicated `cloudflare-email-routing` provider id in the connection
  registry (follow-up; see "Modules").
- The Inbox empty-state copy still says email connections are local fixtures;
  it should change only when the first real message can arrive (B21/B27 own
  that copy).

## Parser scope: minimal parser versus postal-mime

The minimal parser covers what the inbox stores: headers, addresses, subject,
date, threading ids, one text body and one HTML body (capped), attachment
descriptors, and a text preview. It does not decode attachment bytes, does not
handle `message/partial` reassembly, uuencode, `message/rfc822` recursion,
S/MIME or PGP structure, or charsets beyond what the platform `TextDecoder`
offers (unknown labels fall back to Latin-1 rather than failing). Those are
deliberately outside the inbox's needs. `postal-mime` (about 60 KB, MIT) would
add: attachment content as `ArrayBuffer`, `message/rfc822` recursion, broader
legacy charset tables and `format=flowed` handling. None of that is needed to
list, preview, thread and import a message; adding it means a dependency in the
Worker bundle and a size/CPU budget review. Recommendation: stay with the
minimal parser (D6 default) and revisit only if attachment bodies become a
product requirement.

## Tests

```sh
node --test tests/mime-message.test.js tests/email-routing-inbound.test.js
```

Fixtures: simple text, multipart/alternative, nested mixed with attachments
(base64, RFC 2231 filename, inline Content-ID, message/rfc822), quoted-printable
UTF-8, base64 body, Latin-1 and undeclared-UTF-8 bodies, encoded-word subject
and display name (Q, B, UTF-8, ISO-8859-1, language tag, malformed left
intact), address lists (quotes, comments, groups, multiple headers), every cap,
malformed boundaries, header injection (CR/LF and NUL through raw bytes and
through encoded-words), pathological inputs under a time budget; routing:
exact/plus/catch-all, unknown recipient, oversized raw (declared and actual),
malformed, duplicate Message-ID and redelivery through the real importer, a
second message advancing the folder, `bindRouting` driving
`prepareChannelFixturePage`.

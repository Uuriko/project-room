# Suspected bugs — server/http.mjs lines 1–1250

## Suspected

- server/http.mjs:269 — `touchLruEntry`: `while (map.size >= capacity)`
  with `capacity <= 0` never terminates (empty map: `map.delete(undefined)`
  is a no-op, `0 >= 0` stays true → infinite loop / hung request). Latent:
  only in-tree call passes 2000.
- server/http.mjs:1187 — Google callback failure path sets
  `X-Room-Auth-Diagnostic` with DB schema fragments (`no such table:
  <name>`, `UNIQUE constraint failed: <name>`, `writer fence`) on the
  *client-facing* response — internal schema/constraint names leak to the
  browser. Bounded by the regexes, but client-visible by design of
  `setHeader`.
- server/http.mjs:675 — `rate()` runs a full O(n) expiry sweep over every
  live rate key on every call (plus a possible SQLite write per expired
  durable key via `dropRate` → `saveAbuseRateBucket`). Correctness is fine;
  under key-count pressure this is a per-request CPU/IO hotspot.

## Checked and cleared

- server/http.mjs:793–795 `protectWrite` `timingSafeEqual` length mismatch:
  safe — `store` always mints `auth.csrf` as 64-hex sha256 (store.mjs:430)
  and the presented token is pre-checked against the 64-hex
  `bindingPattern`, so the compare never throws on unequal lengths.
- server/http.mjs:708 `bearer()` regex — RFC 7235 case-insensitive scheme
  handled; malformed Authorization → 401, missing → null (route decides).
- server/http.mjs:663–699 `rateFamily` assumes `family:key` ids
  (`slice(0, indexOf(":"))`) — all ~97 in-file `rate()` ids are coloned;
  a colon-less id degrades to a wrong family name, not a crash.
- server/http.mjs:814 `readText` — declared-oversize path `req.resume()`s
  before throwing so keep-alive isn't poisoned; background drain still
  resolves the promise harmlessly.
- server/http.mjs:821 `body()` content-type regex rejects
  `application/jsonx`-style suffixes correctly.
- server/http.mjs:950 trailing-slash normalization happens before the
  security.txt/MCP/A2A/origin checks, so `/security.txt/` etc. are served
  rather than 404ing — intended.
- server/http.mjs:1006 `previewDoorRequest` edge-door bypass is scoped to
  POST `/api/share-links/preview` only; route-level `checkPreviewOrigin`
  still requires an Origin header.
- server/http.mjs:1029 `signInSlotToken` — cookie-fallback path runs
  `protectWrite` (CSRF) before resolving; explicit body tokens keep the
  route's original validation order.
- server/http.mjs:838 `stream()` — discarded first `eventsAfter` result is
  an auth/binding probe, not a wasted fetch; lag-drop path unrefs its
  timer and clears it on socket close.
- server/http.mjs:958 `jevShadowAdmission` — try/catch swallows everything
  by design; a journaling failure cannot break admission.

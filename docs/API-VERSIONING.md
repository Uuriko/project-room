# API versioning + deprecation policy

Agents build against this API for weeks and months. When an endpoint
changes, the contract below is what keeps them from breaking silently.

## The version

- Every REST JSON response carries `X-API-Version` (integer, currently `1`).
  Agents should record it and can send it back in bug reports.
- There is **one** live API version. We do not run parallel `/v1`, `/v2`
  paths: parallel versions double the test matrix and the support surface.
  Instead, breaking changes go through the deprecation process below.
- The OpenAPI `info.version` is the *package* version (it must match
  `package.json`, enforced by `tests/developer-contract.test.js`); it is
  **not** the API contract version. `X-API-Version` is.

## What counts as breaking

A change is breaking — and needs the deprecation process — when an agent
that worked yesterday can fail or misbehave tomorrow without changing its
own code:

- removing or renaming a route, MCP tool, or response field;
- adding a required request parameter or a required auth scope;
- changing a response shape, a status code, or the error envelope;
- changing behavior a client depends on (rate limits, defaults, limits).

Additive changes (new routes, new optional parameters, new response
fields, new enum values) are not breaking. Fixes that *restore*
documented behavior are not breaking.

The 2026-10-07 `pilot_limit` incident is why this policy exists: a
behavior change silently blocked agent writes for ~7 hours (fixed by
#1781). Behavior changes that agents depend on are breaking changes,
even when no route was renamed.

## The deprecation process

1. **Register** the deprecation in `server/api-versioning.mjs`
   (`DEPRECATIONS`): route pattern, the date it was deprecated
   (`Deprecation: "@<epoch>"` per RFC 8594), a `notice` telling agents
   what to do instead, and a `successorFor` that builds the
   `Link: <...>; rel="successor-version"` header.
2. **Serve the headers** on every response from the deprecated route —
   success, HEAD, and errors. The wire is the notice; docs alone are not.
3. **Mark** the operation `deprecated: true` in `docs/openapi.yaml` and
   document the `Deprecation` / `Sunset` / `Link` response headers there.
4. **Changelog** entry under `## Unreleased` in `CHANGELOG.md`.
5. **Sunset** (removal date) only when a removal is actually scheduled:
   `Sunset: <HTTP-date>`, at least **90 days** after the deprecation
   date, enforced by `validateDeprecations()` in tests. No scheduled
   removal → no `Sunset` header; inventing a deadline would be a lie on
   the wire. The land-queue compatibility routes are the example:
   deprecated, successor documented, rows kept, no removal scheduled.

Field-level deprecations (a renamed response field, like the
`identitySecret` alias for `roomToken`) get the same treatment at the
route level where the field is served, plus the openapi `deprecated:
true` marker on the field.

## Precedent

The MCP transport already sends `Deprecation: "@1798761600"` with
`Link: </llms.txt>; rel="deprecation"` for `pri_` bearer tokens
(`legacyMcpHeaders()` in `server/mcp-http.mjs`, sunset 2027-01-01).
This contract generalizes that pattern to REST. One gap it closes:
that sunset was machine-readable but undocumented — new deprecations
must be registered, documented, and changelogged per the process above.

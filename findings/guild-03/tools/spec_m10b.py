#!/usr/bin/env python3
# M10b rerun: dropped identity-change check, disambiguated per call site.
SPEC = {"units": [
{"id": "M10b1", "file": "server/work-claim-routes.mjs",
 "tests": ["tests/work-claim-qa-fixes.test.js", "tests/work-claims-read.test.js"],
 "mutants": [
  {"id": "a", "kind": "dropped-identity-change-check(closeWorkClaim)",
   "old": """    if (current.member.id !== auth?.member?.id) reject(403, "access_denied", "The acting identity changed");
    if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
      scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1)))) {
      reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
    }
    if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    if (verb !== "close" && verb !== "cancel")""",
   "new": """    if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
      scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1)))) {
      reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
    }
    if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    if (verb !== "close" && verb !== "cancel")"""},
 ]},
{"id": "M10b2", "file": "server/work-claim-routes.mjs",
 "tests": ["tests/work-claim-qa-fixes.test.js", "tests/work-claim-pr-link.test.js"],
 "mutants": [
  {"id": "a", "kind": "dropped-identity-change-check(linkWorkClaimPullRequest)",
   "old": """    if (current.member.id !== auth?.member?.id) reject(403, "access_denied", "The acting identity changed");
    if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
      scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1)))) {
      reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
    }
    if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    const access = resolveWorkClaimAccess(store, roomId, current);""",
   "new": """    if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
      scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1)))) {
      reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
    }
    if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    const access = resolveWorkClaimAccess(store, roomId, current);"""},
 ]},
]}

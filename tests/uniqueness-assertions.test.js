// FIX-40 — direct uniqueness assertions on raw registry arrays.
// COLLIDE-4 exp 2 showed registry corruption was visible ONLY to raw-array
// assertions (new Set(arr).size === arr.length); no direct assertion existed
// anywhere. This suite pins:
//   1. the shared helper's semantics (fires naming the duplicated entries,
//      passes clean registries through unchanged), and
//   2. every raw registry array this change covers: a corrupted fixture copy
//      (one injected duplicate) fires at the same seam, the live registry
//      passes.
import test from "node:test";
import assert from "node:assert/strict";

import { assertUnique, duplicatesOf } from "../src/assert-unique.mjs";
import {
  EVENT_TYPES, PERMISSIONS, AGENT_AUTONOMY_PERMISSIONS, AGENT_ADMIN_PERMISSIONS,
  ROOM_POLICY_FIELDS, HISTORY_VISIBILITIES, ROOM_EXPORT_FORMATS, ROOM_KINDS, WORK_REVISION_TYPES,
} from "../src/events.js";
import { ROUTES, MESSAGE_BODY_READS, AUTH_CLASSES, ROUTE_SCOPES, ROUTE_METHODS, assertRouteTable } from "../server/routes/table.mjs";
import { API_KEY_SCOPES } from "../server/agent-api-keys.mjs";

// --- helper semantics ------------------------------------------------------

test("assertUnique returns a clean array unchanged", () => {
  const arr = ["a", "b", "c"];
  assert.equal(assertUnique(arr, "fixture"), arr);
});

test("assertUnique fires on an injected duplicate and names it", () => {
  assert.throws(
    () => assertUnique(["room.created", "message.posted", "room.created"], "fixture-registries"),
    /duplicate entries in fixture-registries: "room\.created" \(x2\)/
  );
});

test("assertUnique names every duplicated entry when several collide", () => {
  assert.throws(
    () => assertUnique(["a", "b", "a", "b", "c"], "multi-fixture"),
    /"a" \(x2\).*"b" \(x2\)/
  );
});

test("assertUnique supports a key function for object rows", () => {
  assert.throws(
    () => assertUnique([{ id: "r1" }, { id: "r2" }, { id: "r1" }], "row-fixture", row => row.id),
    /duplicate entries in row-fixture: "r1" \(x2\)/
  );
  assert.equal(assertUnique([{ id: "r1" }, { id: "r2" }], "row-fixture", row => row.id).length, 2);
});

test("duplicatesOf reports counts and stays empty for clean arrays", () => {
  assert.deepEqual(duplicatesOf(["a", "b", "a"]), [{ key: "a", count: 2 }]);
  assert.deepEqual(duplicatesOf(["a", "b", "c"]), []);
});

// --- live registries pass ---------------------------------------------------

test("live registries are unique: EVENT_TYPES values and permission vocabularies", () => {
  assertUnique(Object.values(EVENT_TYPES), "EVENT_TYPES values");
  assertUnique(PERMISSIONS, "PERMISSIONS");
  assertUnique(AGENT_AUTONOMY_PERMISSIONS, "AGENT_AUTONOMY_PERMISSIONS");
  assertUnique(AGENT_ADMIN_PERMISSIONS, "AGENT_ADMIN_PERMISSIONS");
  assertUnique(ROOM_POLICY_FIELDS, "ROOM_POLICY_FIELDS");
  assertUnique(HISTORY_VISIBILITIES, "HISTORY_VISIBILITIES");
  assertUnique(ROOM_EXPORT_FORMATS, "ROOM_EXPORT_FORMATS");
  assertUnique(ROOM_KINDS, "ROOM_KINDS");
  assertUnique(WORK_REVISION_TYPES, "WORK_REVISION_TYPES");
});

test("live registries are unique: route-table rows, read ids, vocabularies", () => {
  assertRouteTable(ROUTES);
  assertUnique(MESSAGE_BODY_READS.map(row => row.id), "MESSAGE_BODY_READS ids");
  assertUnique(AUTH_CLASSES, "AUTH_CLASSES");
  assertUnique(ROUTE_SCOPES, "ROUTE_SCOPES");
  assertUnique(ROUTE_METHODS, "ROUTE_METHODS");
});

test("live registries are unique: API key scopes", () => {
  assertUnique(API_KEY_SCOPES.map(scope => scope.scope), "API_KEY_SCOPES.scopes");
});

// --- corrupted fixtures fire at the same seam -------------------------------

test("injected duplicate EVENT_TYPES value fires, naming the dupe", () => {
  const values = Object.values(EVENT_TYPES);
  const dupe = values[0];
  assert.throws(
    () => assertUnique([...values, dupe], "EVENT_TYPES values"),
    new RegExp(`duplicate entries in EVENT_TYPES values: ${JSON.stringify(dupe)} \\(x2\\)`)
  );
});

test("injected duplicate permission fires, naming the dupe", () => {
  assert.throws(
    () => assertUnique([...PERMISSIONS, "steer"], "PERMISSIONS"),
    /duplicate entries in PERMISSIONS: "steer" \(x2\)/
  );
});

test("injected duplicate route row fires through assertRouteTable with its id", () => {
  assert.throws(
    () => assertRouteTable([...ROUTES, { ...ROUTES[0] }]),
    new RegExp(`route table rejected:[\\s\\S]*${ROUTES[0].id}: duplicate id`)
  );
});

test("injected duplicate MESSAGE_BODY_READS id fires, naming the dupe", () => {
  const ids = MESSAGE_BODY_READS.map(row => row.id);
  assert.throws(
    () => assertUnique([...ids, ids[0]], "MESSAGE_BODY_READS ids"),
    new RegExp(`duplicate entries in MESSAGE_BODY_READS ids: ${JSON.stringify(ids[0])} \\(x2\\)`)
  );
});

test("injected duplicate API key scope fires, naming the dupe", () => {
  const scopes = API_KEY_SCOPES.map(scope => scope.scope);
  assert.throws(
    () => assertUnique([...scopes, scopes[0]], "API_KEY_SCOPES.scopes"),
    new RegExp(`duplicate entries in API_KEY_SCOPES\\.scopes: ${JSON.stringify(scopes[0])} \\(x2\\)`)
  );
});

test("injected duplicate auth class fires, naming the dupe", () => {
  assert.throws(
    () => assertUnique([...AUTH_CLASSES, AUTH_CLASSES[0]], "AUTH_CLASSES"),
    new RegExp(`duplicate entries in AUTH_CLASSES: ${JSON.stringify(AUTH_CLASSES[0])} \\(x2\\)`)
  );
});

// FIX-43: announce contract changes on the room claim board.
// Fail-first tests for scripts/announce-contract-change.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  diffFieldMappings,
  diffOpenapiSpecs,
  buildAnnouncement,
} from "../scripts/announce-contract-change.mjs";

const OLD_MAPPING = {
  "POST /api/public-work/tasks -> body.priority": { type: "string", enum: ["low", "normal"] },
  "POST /api/public-work/tasks -> body.title": { type: "string", maxLength: 200 },
  "GET /api/public-work/tasks -> response.items[].budget": { type: "number" },
};

const NEW_MAPPING = {
  "POST /api/public-work/tasks -> body.priority": { type: "string", enum: ["low", "normal", "high"] },
  "POST /api/public-work/tasks -> body.title": { type: "string", maxLength: 500 },
  "POST /api/public-work/tasks -> body.due_at": { type: "string", format: "date-time" },
  // budget removed entirely
};

test("diffFieldMappings: detects changed fields with old->new shape", () => {
  const d = diffFieldMappings(OLD_MAPPING, NEW_MAPPING);
  assert.equal(d.changed.length, 2);
  const pri = d.changed.find((c) => c.field.includes("priority"));
  assert.ok(pri, "priority change present");
  assert.deepEqual(pri.oldShape, { type: "string", enum: ["low", "normal"] });
  assert.deepEqual(pri.newShape, { type: "string", enum: ["low", "normal", "high"] });
  assert.equal(pri.route, "POST /api/public-work/tasks");
});

test("diffFieldMappings: detects added and removed fields", () => {
  const d = diffFieldMappings(OLD_MAPPING, NEW_MAPPING);
  assert.equal(d.added.length, 1);
  assert.ok(d.added[0].field.includes("due_at"));
  assert.equal(d.removed.length, 1);
  assert.ok(d.removed[0].field.includes("budget"));
});

test("diffFieldMappings: empty when mappings identical", () => {
  const d = diffFieldMappings(OLD_MAPPING, OLD_MAPPING);
  assert.equal(d.changed.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.empty, true);
});

const OLD_SPEC = `
openapi: 3.1.0
paths:
  /api/things:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string }
                size: { type: integer }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
`;

const NEW_SPEC = `
openapi: 3.1.0
paths:
  /api/things:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string, maxLength: 500 }
                size: { type: number }
                color: { type: string }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
`;

test("diffOpenapiSpecs: diffs request-body fields across two revisions", () => {
  const d = diffOpenapiSpecs(OLD_SPEC, NEW_SPEC);
  const changed = d.changed.find((c) => c.field.includes("size"));
  assert.ok(changed, "size type change detected");
  assert.equal(changed.oldShape.type, "integer");
  assert.equal(changed.newShape.type, "number");
  assert.equal(changed.route, "POST /api/things");
  const added = d.added.find((a) => a.field.includes("color"));
  assert.ok(added, "added field detected");
});

test("buildAnnouncement: produces board-ready payload and text", () => {
  const d = diffFieldMappings(OLD_MAPPING, NEW_MAPPING);
  const a = buildAnnouncement(d, { pr: 2342, author: "jill" });
  assert.equal(a.payload.kind, "contract-change-announcement");
  assert.equal(a.payload.pr, 2342);
  assert.equal(a.payload.changes.length, 4);
  assert.match(a.text, /FIX-43/);
  assert.match(a.text, /2342/);
  assert.match(a.text, /priority/);
  assert.match(a.text, /migration/i);
  assert.ok(typeof a.payload.migrationNote === "string" && a.payload.migrationNote.length > 0);
});

test("buildAnnouncement: no-change diff yields an empty-flagged payload", () => {
  const d = diffFieldMappings(OLD_MAPPING, OLD_MAPPING);
  const a = buildAnnouncement(d, { pr: 9999 });
  assert.equal(a.payload.empty, true);
  assert.match(a.text, /no contract changes/i);
});

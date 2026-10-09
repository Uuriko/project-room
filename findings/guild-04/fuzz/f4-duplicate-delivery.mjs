// F4: duplicate deliveries to the claim registry — same claim set twice must be idempotent.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../../server/work-claim-sqlite.mjs";
import { fuzz, scratchDir } from "./lib.mjs";

fuzz("F4-duplicate-delivery", async () => {
  const dir = scratchDir("g04-f4-");
  const db = new DatabaseSync(join(dir, "c.sqlite"));
  db.exec(workClaimSchema);
  const reg = createDurableWorkClaimRegistry(db);

  const payload = { id: "dup-1", title: "dup", state: "claimed", owner: "a", history: [{ action: "claimed" }] };
  reg.set("r", payload);
  reg.set("r", structuredClone(payload)); // exact redelivery
  assert.equal(reg.list("r").length, 1, "redelivery duplicated the row");
  assert.equal(reg.get("r", "dup-1").owner, "a");

  // redelivery with newer content: last write wins, still one row
  reg.set("r", { ...payload, owner: "b", title: "dup2" });
  assert.equal(reg.list("r").length, 1);
  assert.equal(reg.get("r", "dup-1").owner, "b");

  // delete then redeliver the delete (idempotent delete)
  reg.delete("r", "dup-1");
  reg.delete("r", "dup-1");
  assert.equal(reg.get("r", "dup-1"), null);
  assert.equal(reg.has("r", "dup-1"), false);

  // delete waives dependents: dependent survives with dep removed
  reg.set("r", { id: "parent", title: "p" });
  reg.set("r", { id: "child", title: "c", dependsOn: ["parent", "other"] });
  reg.delete("r", "parent");
  const child = reg.get("r", "child");
  assert.deepEqual(child.dependsOn, ["other"], "deleted dep not waived");
  db.close();
  console.log("  redelivery idempotent; delete idempotent; dep-waive correct");
});

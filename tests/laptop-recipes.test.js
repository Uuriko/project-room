import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLaptopRecipe } from "../client/laptop-recipes.mjs";
import { sha256 } from "../client/room-artifact-transfer.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "recipe-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputPath = join(root, "input"); writeFileSync(inputPath, "input bytes");
  const step = (id, code, timeoutMs = 1000) => {
    const module = join(root, id + ".mjs"); writeFileSync(module, code);
    return { id, module, sha256: sha256(code), args: [], timeoutMs };
  };
  return { root, inputPath, directory: join(root, "run"), step };
}
test("multiple local steps finish with compact receipts and no agent interaction", async t => {
  const f = fixture(t), recipe = { version: 1, id: "validate-and-build", steps: [
    f.step("validate", 'import fs from "node:fs"; if(fs.readFileSync(process.env.ROOM_TASK_INPUT,"utf8")!=="input bytes")process.exit(1);console.log("validated");'),
    f.step("build", 'import fs from "node:fs";fs.writeFileSync(process.env.ROOM_TASK_OUTPUT+"/result.txt","built");console.log("built");'),
  ] };
  const result = await runLaptopRecipe({ ...f, recipe, cpuSlots: 4 });
  assert.equal(result.state, "completed"); assert.equal(result.steps.length, 2);
  assert.equal(result.steps.some(step => Object.hasOwn(step, "diagnosticTail")), false);
  assert.equal(readFileSync(join(f.directory, "build", "result.txt"), "utf8"), "built");
});
test("failure returns a focused handback and prevents dependent steps", async t => {
  const f = fixture(t), recipe = { version: 1, id: "repair", steps: [f.step("check", 'console.error("missing fixture");process.exit(2);'), f.step("publish", 'process.exit(0);')] };
  const result = await runLaptopRecipe({ ...f, recipe });
  assert.equal(result.state, "needs_agent"); assert.equal(result.steps.length, 1);
  assert.match(result.steps[0].diagnosticTail, /missing fixture/);
  assert.equal(existsSync(join(f.directory, "publish")), false);
});
test("changed module pins and long-running steps fail closed", async t => {
  const f = fixture(t), step = f.step("slow", 'setInterval(()=>{},1000)', 60), recipe = { version: 1, id: "bounded", steps: [step] };
  assert.equal((await runLaptopRecipe({ ...f, recipe })).steps[0].stopReason, "timeout");
  writeFileSync(step.module, 'process.exit(0)');
  await assert.rejects(runLaptopRecipe({ ...f, directory: join(f.root, "new"), recipe }), /pin mismatch/);
});

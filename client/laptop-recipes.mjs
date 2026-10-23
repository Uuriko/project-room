import { readFileSync, realpathSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { sha256, privateDirectory, savePrivate } from "./room-artifact-transfer.mjs";

const ensure = (yes, message) => { if (!yes) throw new Error(message); };
export function validateRecipe(recipe) {
  ensure(recipe?.version === 1 && /^[a-z][a-z0-9-]{0,63}$/.test(recipe.id)
    && Array.isArray(recipe.steps) && recipe.steps.length > 0 && recipe.steps.length <= 16, "Invalid local recipe");
  const ids = new Set();
  for (const step of recipe.steps) {
    ensure(/^[a-z][a-z0-9-]{0,63}$/.test(step.id) && !ids.has(step.id) && isAbsolute(step.module)
      && /^[a-f0-9]{64}$/.test(step.sha256) && Array.isArray(step.args) && step.args.length <= 32
      && step.args.every(arg => typeof arg === "string" && arg.length < 1024)
      && Number.isSafeInteger(step.timeoutMs) && step.timeoutMs > 0 && step.timeoutMs <= 3600000, "Invalid local recipe step");
    ensure(sha256(readFileSync(step.module)) === step.sha256, "Recipe module pin mismatch"); ids.add(step.id);
  }
  return recipe;
}

// The agent selects a local recipe name, never commands or paths. Trusted
// modules can perform multiple deterministic steps without calling a model.
export async function runLaptopRecipe({ recipe, inputPath, directory, signal, cpuSlots = 1 }) {
  validateRecipe(recipe); privateDirectory(directory);
  ensure(Number.isInteger(cpuSlots) && cpuSlots >= 1 && cpuSlots <= 64, "Invalid recipe CPU budget");
  inputPath = realpathSync(inputPath); const steps = [];
  for (const step of recipe.steps) {
    signal?.throwIfAborted();
    ensure(sha256(readFileSync(step.module)) === step.sha256, "Recipe module changed before execution");
    const stepDirectory = join(directory, step.id); mkdirSync(stepDirectory, { mode: 0o700 });
    const startedAt = Date.now();
    const observed = await new Promise((resolve, reject) => {
      const stdout = openSync(join(stepDirectory, "stdout.log"), "wx", 0o600), stderr = openSync(join(stepDirectory, "stderr.log"), "wx", 0o600);
      const outHash = createHash("sha256"), errHash = createHash("sha256");
      let bytes = 0, tail = "", stopped = false, stopReason = null;
      const child = spawn(process.execPath, [step.module, ...step.args], { detached: true, cwd: directory, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", ROOM_TASK_INPUT: inputPath, ROOM_TASK_OUTPUT: stepDirectory, ROOM_TASK_CPU_SLOTS: String(cpuSlots) } });
      const stop = reason => { stopped = true; stopReason = reason; try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already ended. */ } };
      const timer = setTimeout(() => stop("timeout"), step.timeoutMs), abort = () => stop("cancelled");
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      const collect = (fd, hash, chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 ** 2) { stop("output_limit"); return; }
        writeSync(fd, chunk); hash.update(chunk); tail = (tail + chunk.toString("utf8")).slice(-1200);
      };
      child.stdout.on("data", chunk => collect(stdout, outHash, chunk)); child.stderr.on("data", chunk => collect(stderr, errHash, chunk));
      let spawnError = null; child.once("error", error => { spawnError = error; });
      child.once("close", exitCode => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        for (const fd of [stdout, stderr]) { fsyncSync(fd); closeSync(fd); }
        if (spawnError) { reject(spawnError); return; }
        resolve({ id: step.id, moduleSha256: step.sha256, exitCode, elapsedMs: Date.now() - startedAt,
          stdoutSha256: outHash.digest("hex"), stderrSha256: errHash.digest("hex"), passed: exitCode === 0 && !stopped,
          ...(stopped ? { stopReason } : {}), ...(exitCode !== 0 || stopped ? { diagnosticTail: tail } : {}) });
      });
    });
    steps.push(observed);
    savePrivate(join(directory, "receipt.json"), JSON.stringify({ recipeId: recipe.id, steps }));
    if (!observed.passed) return { recipeId: recipe.id, state: "needs_agent", passed: false, steps,
      question: `Step ${step.id} failed. Inspect its receipt before choosing a repair or retry.`, modelUsage: "not_measured" };
  }
  return { recipeId: recipe.id, state: "completed", passed: true, steps, modelUsage: "not_measured" };
}

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

// Keep the real Node parser, but bound startup CPU and memory to four children.
// Stop dispatching after a failure and drain existing children before returning.
export async function checkSyntax(paths, { cwd, concurrency = Math.min(4, availableParallelism()), stdio = "inherit" } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new RangeError("Syntax check concurrency must be an integer from 1 to 4");
  }
  let next = 0;
  let failure = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (!failure && next < paths.length) {
      const path = paths[next++];
      const status = await new Promise(resolve => {
        const child = spawn(process.execPath, ["--check", path], { cwd, stdio });
        let spawnError = false;
        child.once("error", error => {
          spawnError = true;
          console.error(`Syntax check failed to start for ${path}: ${error.message}`);
        });
        child.once("close", code => resolve(spawnError ? 1 : (code ?? 1)));
      });
      if (status !== 0 && !failure) failure = status;
    }
  }));
  return failure;
}

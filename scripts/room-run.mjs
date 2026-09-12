import { executeLocalRun, inspectLocalRun } from "../client/local-run-record.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(`Explicit local Room execution (trusted programs only; not a sandbox):
  node scripts/room-run.mjs run PRIVATE_DIRECTORY
  node scripts/room-run.mjs status PRIVATE_DIRECTORY RUN_ID
  node scripts/room-run.mjs output PRIVATE_DIRECTORY RUN_ID

Read docs/LOCAL-SESSION-RUNNER.md before configuring run.json.
Run reserves a private journal before execution. Existing run IDs never rerun.
Status hides process output. Output explicitly prints potentially sensitive text.
Ctrl-C requests local cancellation. No model, schedule or provider is configured.`);
} else {
  const controller = new AbortController(), stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const [action, directory, runId] = args;
    let result;
    if (action === "run" && args.length === 2) result = await executeLocalRun(directory, { signal: controller.signal });
    else if (["status", "output"].includes(action) && args.length === 3) result = inspectLocalRun(directory, runId, { includeOutput: action === "output" });
    else throw new Error("usage");
    console.log(JSON.stringify(result));
    if (action === "run" && (result.status !== "done" || result.recording !== "recorded")) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: error.code === "EEXIST" ? "run_exists" : "run_unavailable",
      message: "No retry was started. Check the private configuration and run record; use --help." }));
    process.exitCode = 1;
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

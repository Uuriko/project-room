// Deploy receipt for .github/workflows/deploy-prod.yml (issue #3897,
// secondary leg). The receipt used to be built and posted to muse-room in a
// single step whose only channel was the production API it reports on,
// swallowed by continue-on-error: a deploy that broke the room broke its own
// receipt, silently. This script splits the receipt into two phases:
//
//   record   Build the receipt from runner-local state only (job env, step
//            outputs, $RUNNER_TEMP/deploy-recovery.json) and write the durable
//            GitHub-side record: deploy-receipt.json + deploy-receipt.txt in
//            RECEIPT_DIR (the workflow uploads that directory as the
//            deploy-receipt-<sha> artifact), the receipt text in the run
//            summary, and step outputs. No network is touched, so the record
//            exists even when the deploy broke production. A record failure
//            is surfaced with an ::error annotation and the record=failed
//            step output and still exits 0: the receipt must never flip the
//            deploy job's colour, which belongs to the deploy steps alone.
//
//   deliver  Best-effort second step: POST the recorded body into muse-room
//            through the production API. This POST is the receipt's only
//            production-API dependency (enumerated: 1 — everything else is
//            runner-local). The outcome is written back into
//            deploy-receipt.json and the delivery step output; a failure
//            prints an ::error annotation and exits 1 (the workflow step
//            keeps continue-on-error so the job colour is unchanged, while
//            the step itself shows failed, the annotation is in the run UI,
//            and the Summary step prints the delivery status next to the
//            durable record's artifact name).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recoveryDescription } from "./deploy-recovery.mjs";

const shortId = value => (value || "?").slice(0, 8);
const annotationEscape = value => String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function buildReceiptBody(env, recovery) {
  if (recovery) return `PROD DEPLOY ${shortId(env.SHA)} FAILED · ${recoveryDescription(recovery)} · ${env.RUN_URL}`;
  return `PROD DEPLOY ${shortId(env.SHA)} · prod ${shortId(env.PROD_NEW)} (rollback ${shortId(env.PROD_PRE)}) · entry ${shortId(env.ENTRY_NEW)} (rollback ${shortId(env.ENTRY_PRE)}) · smoke ${env.OUTCOME === "success" ? "ok" : env.OUTCOME} · ${env.RUN_URL}${env.REASON ? " · " + env.REASON.slice(0, 200) : ""}${env.PROBE_OVERRIDE ? " · onboarding probe overridden: " + env.PROBE_OVERRIDE.slice(0, 200) : ""}`;
}

export function readRecovery(env) {
  try { return JSON.parse(readFileSync(join(env.RUNNER_TEMP, "deploy-recovery.json"), "utf8")); } catch { return null; }
}

function writeOutput(env, text) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text);
}

export function recordReceipt(env, { now = () => new Date().toISOString() } = {}) {
  const dir = env.RECEIPT_DIR;
  if (!dir) throw new Error("RECEIPT_DIR is not set; nowhere to write the durable receipt record");
  const recovery = readRecovery(env);
  const body = buildReceiptBody(env, recovery);
  const record = {
    format: 1,
    kind: "deploy-prod-receipt",
    sha: env.SHA || null,
    runUrl: env.RUN_URL || null,
    outcome: env.OUTCOME || null,
    prod: { new: env.PROD_NEW || null, rollback: env.PROD_PRE || null },
    entry: { new: env.ENTRY_NEW || null, rollback: env.ENTRY_PRE || null },
    recovery,
    body,
    recordedAt: now(),
    delivery: { status: "pending" },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "deploy-receipt.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(dir, "deploy-receipt.txt"), body + "\n");
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Deploy receipt (durable record)\n\n${body}\n\nDurable record: workflow artifact \`deploy-receipt-${shortId(env.SHA)}\` (deploy-receipt.json / deploy-receipt.txt), retention 90 days.\n`);
  }
  writeOutput(env, `record=ok\nbody_file=${join(dir, "deploy-receipt.txt")}\n`);
  return record;
}

export async function deliverReceipt(env, { fetchImpl = fetch, now = () => new Date().toISOString(), log = message => console.log(message) } = {}) {
  const path = join(env.RECEIPT_DIR, "deploy-receipt.json");
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error(`no durable receipt record at ${path}; the record step did not produce one`);
  }
  const finish = delivery => {
    record.delivery = delivery;
    try { writeFileSync(path, JSON.stringify(record, null, 2) + "\n"); } catch (error) { log(`::warning title=deploy receipt status writeback failed::${annotationEscape(error.message)}`); }
    writeOutput(env, `delivery=${delivery.status}\n`);
    return { ok: delivery.status === "posted" || delivery.status === "skipped-no-token", record };
  };
  if (!env.ROOM_RECEIPT_TOKEN) {
    log("ROOM_RECEIPT_TOKEN not set; no receipt posted. The durable record stands as the receipt.");
    return finish({ status: "skipped-no-token", at: now() });
  }
  const command = { id: crypto.randomUUID(), type: "message.posted", data: { messageId: crypto.randomUUID(), body: record.body } };
  try {
    const res = await fetchImpl(`${env.PROD_ORIGIN}/api/rooms/${env.RECEIPT_ROOM}/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ROOM_RECEIPT_TOKEN}`, "content-type": "application/json", origin: env.PROD_ORIGIN,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 project-room-deploy-prod" },
      body: JSON.stringify(command),
    });
    log(`receipt: HTTP ${res.status}`);
    if (!res.ok) return finish({ status: "failed", httpStatus: res.status, error: `room commands endpoint answered HTTP ${res.status}`, at: now() });
    return finish({ status: "posted", httpStatus: res.status, at: now() });
  } catch (error) {
    return finish({ status: "failed", error: error.message, at: now() });
  }
}

async function main() {
  const [mode] = process.argv.slice(2);
  const env = { ...process.env, RECEIPT_DIR: process.env.RECEIPT_DIR || (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "deploy-receipt") : undefined) };
  if (mode === "record") {
    try {
      const record = recordReceipt(env);
      console.log(`receipt recorded: ${record.body}`);
    } catch (error) {
      // Visible, never masking: annotation + step output + summary note, exit 0.
      console.log(`::error title=deploy receipt record failed::${annotationEscape(error.message)}`);
      writeOutput(env, "record=failed\n");
      if (env.GITHUB_STEP_SUMMARY) {
        try { appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Deploy receipt (durable record)\n\nRECORD FAILED: ${error.message}\n`); } catch {}
      }
    }
    return;
  }
  if (mode === "deliver") {
    try {
      const result = await deliverReceipt(env);
      if (!result.ok) {
        console.log(`::error title=deploy receipt delivery failed::${annotationEscape(result.record.delivery.error || `delivery status ${result.record.delivery.status}`)} — the durable record is the deploy-receipt artifact on this run`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.log(`::error title=deploy receipt delivery failed::${annotationEscape(error.message)} — the durable record is the deploy-receipt artifact on this run`);
      writeOutput(env, "delivery=failed-no-record\n");
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("Usage: deploy-receipt.mjs record | deliver");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

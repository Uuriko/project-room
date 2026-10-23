#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { uploadArtifact, downloadArtifact } from "../client/room-artifact-transfer.mjs";
import { runNativeRequest, watchNativeRequests, workerStatus } from "../client/room-native-worker.mjs";
import { offerLaptopArtifact, serveLaptopArtifact, receiveLaptopArtifact } from "../client/laptop-artifacts.mjs";
import { observeLaptop, laptopBudget } from "../client/laptop-resources.mjs";

import { discoverLaptopWorkers, dispatchLaptopTask } from "../client/laptop-work-dispatch.mjs";

const [mode, ...args] = process.argv.slice(2);
const usage = "room-native-worker status STATE | resources STATE POLICY | serve CONNECTION FILE TRANSFER RECIPIENT REFERENCE_JSON | receive CONNECTION REFERENCE_JSON CACHE | upload CONNECTION FILE OPERATION MESSAGE | download CONNECTION REFERENCE_JSON CACHE OUTPUT | run CONNECTION GRANT STATE REQUEST | watch CONNECTION GRANT STATE";
try {
  if (mode === "status" && args.length === 1) console.log(JSON.stringify(workerStatus(args[0])));
  else if (mode === "discover" && args.length === 1) console.log(JSON.stringify(await discoverLaptopWorkers(readAgentConnection(args[0]))));
  else if (mode === "submit" && args.length === 4) console.log(JSON.stringify(await dispatchLaptopTask({ connection: readAgentConnection(args[0]), task: JSON.parse(readFileSync(args[1], "utf8")), requestId: args[2], directory: args[3] })));
  else if (mode === "resources" && args.length === 2) {
    const observation = observeLaptop(args[0]);
    console.log(JSON.stringify({ observation, budget: laptopBudget(observation, JSON.parse(readFileSync(args[1], "utf8"))) }));
  } else if (mode === "serve" && args.length === 5) {
    const connection = readAgentConnection(args[0]), signal = AbortSignal.timeout(3600000);
    const reference = await offerLaptopArtifact({ connection, path: args[1], transferId: args[2], recipientId: args[3], signal });
    writeFileSync(args[4], JSON.stringify(reference), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(reference));
    console.log(JSON.stringify(await serveLaptopArtifact({ connection, path: args[1], reference, signal })));
  } else if (mode === "receive" && args.length === 3) {
    console.log(JSON.stringify(await receiveLaptopArtifact({ connection: readAgentConnection(args[0]), reference: JSON.parse(readFileSync(args[1], "utf8")), directory: args[2], signal: AbortSignal.timeout(3600000) })));
  }
  else if (mode === "upload" && args.length === 4) console.log(JSON.stringify(await uploadArtifact({
    connection: readAgentConnection(args[0]), bytes: readFileSync(args[1]), operationId: args[2], messageId: args[3], signal: AbortSignal.timeout(180000),
  })));
  else if (mode === "download" && args.length === 4) {
    const result = await downloadArtifact({ connection: readAgentConnection(args[0]), reference: JSON.parse(readFileSync(args[1], "utf8")),
      directory: args[2], signal: AbortSignal.timeout(180000) });
    writeFileSync(args[3], result.bytes, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ sha256: result.manifest.sha256, byteLength: result.bytes.length }));
  } else if (["run", "watch"].includes(mode) && args.length === (mode === "run" ? 4 : 3)) {
    const controller = new AbortController();
    for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => controller.abort());
    const options = { connection: readAgentConnection(args[0]), grantPath: args[1], directory: args[2], signal: controller.signal };
    if (mode === "run") console.log(JSON.stringify(await runNativeRequest({ ...options, requestMessageId: args[3] })));
    else await watchNativeRequests({ ...options, emit: result => console.log(JSON.stringify(result)) });
  } else throw new Error(usage);
} catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }

// First-run step counter (PRODUCT-200, first-run excellence).
//
// Drives the stranger journey against a disposable local server and counts
// every network step from zero to first claimed work:
//
//   1. GET /llms.txt                      (discovery)
//   2. POST /api/agent-identities         (mint)
//   3. POST /api/public-work/match        (autoClaim=true, atomic claim)
//
// John's bar is the 2-minute rule: this number is the product metric the
// first-run wave drives down. Any change that adds a mandatory round-trip
// to the stranger journey must move this number deliberately, never silently.
//
// Usage: node scripts/firstrun-steps.mjs [--json]
// Exit 0 when the claim lands, 1 otherwise. Never touches the live room:
// the fixture is an in-memory RoomStore with one seeded public offer.
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const TASK_ID = "firstrun:open";

function seedOffer(store) {
  store.projectOffers.create("commons", "owner", { requestId: "fr-create", offerId: TASK_ID,
    reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: "First-run fixture task", summary: "Seeded volunteer task for the step counter",
      acceptanceCriteria: ["Do the thing truthfully"],
      repositoryUrl: "https://github.com/Example/Project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", TASK_ID, "publish", { requestId: "fr-publish", expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", TASK_ID, { requestId: "fr-enable",
    expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["docs/HISTORY.md"] });
}

export async function measureFirstRun() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  seedOffer(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const steps = [];
  let secret = null;
  try {
    const step = async (name, method, path, { body, auth } = {}) => {
      const started = performance.now();
      const response = await fetch(origin + path, { method,
        headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const ms = Math.round((performance.now() - started) * 100) / 100;
      const isJson = response.headers.get("content-type")?.includes("json");
      const payload = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null);
      const entry = { n: steps.length + 1, name, method, path, status: response.status, ms, ok: response.status >= 200 && response.status < 300 };
      steps.push(entry);
      return { entry, payload };
    };

    // 1. Discovery: a stranger learns the doors from the agent packet.
    await step("discover", "GET", "/llms.txt");
    // 2. Mint a fresh identity; nothing exists for it anywhere.
    const minted = await step("mint", "POST", "/api/agent-identities", { body: { displayName: "firstrun-stranger" } });
    if (minted.entry.status === 201) secret = minted.payload?.secret ?? null;
    // 3. Match + atomic claim in one call. No room admission required.
    let claim = null;
    if (secret) {
      const matched = await step("match+claim", "POST", "/api/public-work/match",
        { auth: secret, body: { autoClaim: true, requestId: randomUUID(), limit: 3 } });
      claim = matched.payload?.claim ?? null;
    }
    const totalMs = Math.round(steps.reduce((sum, s) => sum + s.ms, 0) * 100) / 100;
    return { steps, stepCount: steps.length, ok: steps.every(s => s.ok) && claim != null, claim, totalMs };
  } finally {
    server.closeStreams?.();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const result = await measureFirstRun();
  const asJson = process.argv.includes("--json");
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    for (const s of result.steps) console.log(`step ${s.n}: ${s.name} ${s.method} ${s.path} -> ${s.status} (${s.ms}ms)${s.ok ? "" : " FAILED"}`);
    console.log(`first-run: ${result.stepCount} steps, ${result.totalMs}ms total, claim ${result.ok ? "OK" : "FAILED"}`);
  }
  process.exit(result.ok ? 0 : 1);
}

// ECON-4 (board squatting): a board claim taken with leaseHours: null
// never lapses — the row sits claimed forever with no expiry for the
// lease sweep to act on. Re-derived from the economics lane's board
// construction (4c; 4b is the same shape on the public board).
import { bootServer, mkMember, post, get, fixed, still, notfiled } from "../lib.mjs";

const { f, origin, close } = await bootServer();
const R = "commons";
const owner = f.keys.owner;
const W = mkMember(f, "Squat worker", R, ["accept_work", "complete_work", "write_external"]);
await post(origin, owner, `/api/rooms/${R}/work-claims`, { id: "sq1", title: "Squat target" });
const claimNull = await post(origin, W.secret, `/api/rooms/${R}/work-claims/sq1/claim`, { files: ["src/sq1.js"], leaseHours: null });
await post(origin, owner, `/api/rooms/${R}/work-claims`, { id: "sq2", title: "Squat target 2" });
const claimOmitted = await post(origin, W.secret, `/api/rooms/${R}/work-claims/sq2/claim`, { files: ["src/sq2.js"] });
const read = await get(origin, owner, `/api/rooms/${R}/work-claims-read`);
const row1 = (read.body?.claims ?? []).find((r) => r.id === "sq1");
const row2 = (read.body?.claims ?? []).find((r) => r.id === "sq2");
await close();
const expiry = (row) => row?.expiresAt ?? row?.leaseExpiresAt ?? null;
const squats = [
  claimNull.status < 300 && row1 && !expiry(row1) && row1.state === "claimed" ? `explicit leaseHours:null accepted, row 'claimed' with no expiry` : null,
  claimOmitted.status < 300 && row2 && !expiry(row2) && row2.state === "claimed" ? `leaseHours omitted accepted, row 'claimed' with no expiry` : null,
].filter(Boolean);
if (squats.length)
  still(`board squatting stands: ${squats.join("; ")} — no lease exists for the sweep to expire, so the item is held indefinitely at zero cost (the public-board analogue is 4b)`);
else if (claimNull.status >= 400 && claimOmitted.status >= 400) fixed(`leaseless claims are refused at the door (explicit null: ${claimNull.status} ${claimNull.body?.error?.code ?? ""}; omitted: ${claimOmitted.status}) — claims must carry a finite lease`);
else if (expiry(row1) || expiry(row2)) fixed(`leaseless claims are normalised to a finite expiry (sq1: ${expiry(row1)}, sq2: ${expiry(row2)}) — the sweep can always reclaim the row`);
else notfiled(`unexpected squat outcome: null=${claimNull.status} (${claimNull.body?.error?.code ?? ""}) omitted=${claimOmitted.status} rows=${JSON.stringify([row1?.state, expiry(row1), row2?.state, expiry(row2)])}`);

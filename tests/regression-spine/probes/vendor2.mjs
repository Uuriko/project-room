// Vendored-original replays #2: LOSS-1 (board repair cap), RACE-R2 (wb_
// oscillation), SOAK-S1 (webhook drain), SOAK-S6 (public-work write
// ceiling). All run the lane scripts unmodified except the root token.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HERE, ROOT, TMP, runNode, vendorRun, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];

if (id === "LOSS-1") {
  const { code, out, err } = await vendorRun("loss-1-repro.mjs.txt");
  if (out.includes("repair stamp DESTROYED")) still("the board history cap still destroys divergence-repair stamps: the original repro's 200+-event construction ends with the repair stamp gone from the capped history while the short-history control keeps it — the board-native record is not re-derivable from events");
  else if (out.includes("repair stamp SURVIVES")) fixed(`the divergence-repair stamp now survives the history cap (original repro verdict; PR #4119's preservation is observable at this tree)`);
  else notfiled(`LOSS-1 repro exited ${code} without its verdict: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 280)}`);
} else if (id === "RACE-R2") {
  const { code, out, err } = await vendorRun("race-r2-repro.mjs.txt");
  if (out.includes("oscillation reproduced")) still("wb_-namespaced board claims still oscillate forever: the lease sweep releases the row, the projection re-plan restores it to in_progress, and the next sweep releases it again — sweep and projection disagree permanently about wb_ rows with expired item leases (charter at hunt-scratch/race/charter-wb-oscillation.md, no fix built)");
  else if (out.includes("expectation(s) failed")) fixed(`the oscillation loop no longer closes: the original repro's bug-encoding expectations now fail (${out.match(/RESULT: \d+ expectation/)?.[0]})`);
  else notfiled(`RACE-R2 repro exited ${code} without its verdict: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 280)}`);
} else if (id === "SOAK-S1") {
  const { code, out, err } = await vendorRun("soak-s1-repro.mjs.txt", { timeoutMs: 300000 });
  const ticks = [...out.matchAll(/tick (\d+): processed=(\d+) retried=(\d+) dead=(\d+)/g)];
  if (!ticks.length) notfiled(`SOAK-S1 repro exited ${code} with no tick lines: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 280)}`);
  const last = ticks[ticks.length - 1];
  const totalDead = ticks.reduce((a, t) => a + Number(t[4]), 0);
  // The filed ceiling is a RATE: the drain attempts at most ~25
  // deliveries per tick however deep the queue is (100 seeded here).
  const maxAttempted = Math.max(...ticks.map((t) => Number(t[2]) + Number(t[3])));
  if (maxAttempted <= 25 && ticks.length >= 10) still(`webhook drain ceiling: with 100 deliveries queued, no tick attempts more than ${maxAttempted} (the ~25/tick batch ceiling) — any burst or failure flood falls behind for hours and a sustained >25/min arrival never catches up; dead-lettering itself works (${totalDead} dead over the run), the rate is the defect`);
  else if (Number(last[4]) === 0 && totalDead === 0) still(`webhook drain ceiling: 100 seeded deliveries against a failing endpoint, 20 ticks — none ever dead-letters (final tick processed=${last[2]} retried=${last[3]} dead=0); the queue retries forever`);
  else fixed(`the drain now works through a 100-deep queue without the ~25/tick ceiling (max attempted in one tick: ${maxAttempted})`);
} else if (id === "SOAK-S6") {
  // The repro imports ./world.mjs — materialise the vendored world first.
  mkdirSync(TMP, { recursive: true });
  const world = readFileSync(join(HERE, "probes", "vendor", "soak-world.mjs.txt"), "utf8").split("__R1ROOT__").join(ROOT);
  writeFileSync(join(TMP, "world.mjs"), world);
  const { code, out, err } = await vendorRun("soak-s6-repro.mjs.txt", { timeoutMs: 300000 });
  const cycles = [...out.matchAll(/cycle (\d+): claim=(\d+)/g)];
  const hit429 = out.includes("claim=429");
  if (hit429) {
    const at = cycles.find((c) => c[2] === "429");
    still(`the public-work write ceiling is per-address and low: claim writes from one address start refusing with 429 at cycle ${at?.[1] ?? "?"} — a busy stranger (or everyone behind one NAT) hits the room's write ceiling by count, not by abuse`);
  } else if (cycles.length >= 10) fixed(`no 429 across ${cycles.length} claim cycles from one address — the per-address write ceiling no longer refuses ordinary volume`);
  else notfiled(`SOAK-S6 repro exited ${code} with only ${cycles.length} cycles parsed: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 280)}`);
} else {
  notfiled(`vendor2.mjs has no probe for ${id}`);
}

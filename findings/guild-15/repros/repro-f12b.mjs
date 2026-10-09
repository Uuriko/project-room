import { mulberry32, hostileValue } from "./harness.mjs";
import { makeStoreFixture } from "./setup.mjs";

const rand = mulberry32(1512);
const targets = new Set([200, 430]);
const fx = makeStoreFixture();
for (let i = 0; i <= 430; i++) {
  const input = i % 2 === 0
    ? { op: "received", at: hostileValue(rand), count: hostileValue(rand), conn: i % 5 === 0 ? hostileValue(rand) : fx.connectionId }
    : { op: "sent", at: hostileValue(rand), outcome: hostileValue(rand), code: hostileValue(rand), conn: fx.connectionId };
  if (!targets.has(i)) continue;
  try {
    if (input.op === "received") fx.live.received(fx.accountId, input.conn, { at: input.at, count: input.count });
    else fx.live.sent(fx.accountId, input.conn, { at: input.at, outcome: input.outcome, code: input.code });
    console.log(i, "no-throw");
  } catch (e) {
    console.log(i, "NAME:", e.name, "CODE:", e.code);
    console.log(String(e.stack).split("\n").slice(0, 10).join("\n"));
  }
}
fx.close();

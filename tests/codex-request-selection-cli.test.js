import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../scripts/run-codex-room.mjs";

test("CLI explicit request selection rejects invalid inputs before reading runtime configuration", async () => {
  for (const selection of ["", "constructor", "-bad", "a,a", "a,", "bad\n", "x".repeat(129), Array.from({ length: 21 }, (_, i) => "request-" + i).join(",")])
    await assert.rejects(main(["--watch-requests", "/unused/journal", "/unused/runtime", "owner", selection]), /valid request IDs/);
});

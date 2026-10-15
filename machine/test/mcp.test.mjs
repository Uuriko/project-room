import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnContext } from "../lib/spawn.mjs";
import { openDriver } from "../lib/mcp.mjs";

// openDriver spawns `lume` from PATH (via spawnCommand/childEnv), so each
// test installs its own fake `lume` first on PATH inside a spawnContext.

function installLume(t, body) {
  const dir = mkdtempSync(join(tmpdir(), "room-mcp-"));
  const script = join(dir, "lume-driver.mjs");
  writeFileSync(script, body);
  const wrapper = join(dir, "lume");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envFor(bin) {
  return {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: bin,
    TMPDIR: bin,
    LANG: "C",
    LC_ALL: "C",
    USER: "room",
    LOGNAME: "room",
    TERM: "dumb",
  };
}

function withDriver(bin, vm, fn) {
  return spawnContext.run({ env: envFor(bin) }, async () => {
    const driver = openDriver(vm);
    try {
      return await fn(driver);
    } finally {
      driver.close();
    }
  });
}

// The old code left waiters hanging until the 8s request timeout (and let an
// unhandled child 'error' crash the process). Fixed code must reject fast.
async function rejectsFast(promise, pattern, ms = 3000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`promise did not reject within ${ms}ms`)), ms);
  });
  try {
    await assert.rejects(Promise.race([promise, deadline]), pattern);
  } finally {
    clearTimeout(timer);
  }
}

const HEALTHY_DRIVER = `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {} });
    else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "screenshot" }] } });
    else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
});
`;

test.describe("openDriver", { concurrency: false }, () => {
  test("a healthy driver still initializes, lists tools, and answers calls", async (t) => {
    const bin = installLume(t, HEALTHY_DRIVER);
    await withDriver(bin, "desk", async (driver) => {
      assert.deepEqual(await driver.initialize(), ["screenshot"]);
      const called = await driver.call("screenshot", {});
      assert.equal(called.result.content[0].text, "ok");
    });
  });

  test("a driver that exits immediately rejects pending and later requests fast, without waiting for the timeout", async (t) => {
    const bin = installLume(t, "process.exit(3);\n");
    await withDriver(bin, "desk", async (driver) => {
      await rejectsFast(driver.initialize(), /driver (exited|process failed)/);
      // Once dead, later requests fail immediately instead of writing to a
      // dead stdin (EPIPE) or hanging for another full timeout.
      await rejectsFast(driver.call("screenshot", {}), /driver/, 1000);
    });
  });

  test("a driver that cannot be spawned rejects instead of crashing the daemon with an unhandled 'error'", async (t) => {
    const empty = mkdtempSync(join(tmpdir(), "room-mcp-empty-"));
    t.after(() => rmSync(empty, { recursive: true, force: true }));
    await withDriver(empty, "desk", async (driver) => {
      await rejectsFast(driver.initialize(), /driver process failed/);
    });
  });

  test("a hostile driver declaring an oversized frame is rejected and cut off, not buffered", async (t) => {
    const bin = installLume(t, `
process.stdout.write("Content-Length: 1073741824\\r\\n\\r\\n");
process.stdout.write(Buffer.alloc(1024, 65));
// Stay alive: only the client's cap can save it from buffering forever.
setInterval(() => {}, 1000);
`);
    await withDriver(bin, "desk", async (driver) => {
      await rejectsFast(driver.initialize(), /frame.*(exceed|cap|too large)|too large/);
    });
  });

  test("a hostile driver that never terminates its frame header is cut off, not buffered", async (t) => {
    const bin = installLume(t, `
process.stdout.write("Content-Length: 12");
process.stdout.write(Buffer.alloc(65536, 120));
setInterval(() => {}, 1000);
`);
    await withDriver(bin, "desk", async (driver) => {
      await rejectsFast(driver.initialize(), /frame header|header.*exceed/);
    });
  });
});

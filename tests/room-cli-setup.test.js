import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, rmSync, chmodSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { main } from "../cli/main.mjs";
import { readPointer } from "../cli/paths.mjs";
import { nodeSatisfies } from "../cli/commands/doctor.mjs";

const ORIGIN = "http://127.0.0.1:9";
const MCP = ORIGIN + "/mcp";
const TOKEN = "pri_" + "a".repeat(43);

function envFor(home, extra = {}) {
  return { ...process.env, HOME: home, PROJECT_ROOM_KEYCHAIN: "0", PATH: extra.PATH ?? "/nonexistent", ...extra };
}

function seedConnection(home, origin = ORIGIN) {
  const dir = join(home, ".project-room", "connections", "room-agent");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const connection = join(dir, "connection.json");
  writeFileSync(connection, JSON.stringify({ version: 1, origin, roomId: "commons", memberId: "member1", token: TOKEN }) + "\n", { mode: 0o600 });
  chmodSync(connection, 0o600);
  const pointer = join(dir, "pointer.json");
  writeFileSync(pointer, JSON.stringify({ version: 1, name: "room-agent", configDirectory: dir }) + "\n", { mode: 0o600 });
  chmodSync(pointer, 0o600);
  return dir;
}

function layout() {
  const root = mkdtempSync(join(tmpdir(), "room-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  seedConnection(home);
  return { root, home, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function run(argv, io) {
  const lines = [];
  const errors = [];
  const code = await main(argv, {
    ...io,
    out: text => lines.push(String(text)),
    err: text => errors.push(String(text)),
  });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

function freeze(path) {
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(path, past, past);
  return statSync(path).mtimeMs;
}

test("Node 24.19 is the minimum the doctor accepts", () => {
  assert.equal(nodeSatisfies("v24.19.0"), true);
  assert.equal(nodeSatisfies("v24.18.9"), false);
  assert.equal(nodeSatisfies("v22.14.0"), false);
  assert.equal(nodeSatisfies(process.version), true);
});

test("setup writes each tool config once, dry-run writes nothing, and no config contains the secret", async t => {
  const { home, project, cleanup } = layout();
  t.after(cleanup);
  const env = envFor(home);
  const cases = [
    ["claude-code", join(project, ".mcp.json"), `{
  "mcpServers": {
    "project-room": {
      "type": "http",
      "url": ${JSON.stringify(MCP)},
      "headers": {
        "Authorization": "Bearer \${PROJECT_ROOM_SECRET}"
      }
    }
  }
}
`],
    ["cursor", join(project, ".cursor", "mcp.json"), `{
  "mcpServers": {
    "project-room": {
      "url": ${JSON.stringify(MCP)},
      "headers": {
        "Authorization": "Bearer \${env:PROJECT_ROOM_SECRET}"
      }
    }
  }
}
`],
    ["vscode", join(project, ".vscode", "mcp.json"), `{
  "servers": {
    "project-room": {
      "type": "http",
      "url": ${JSON.stringify(MCP)},
      "headers": {
        "Authorization": "Bearer \${env:PROJECT_ROOM_SECRET}"
      }
    }
  }
}
`],
    ["cline", join(home, ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"), `{
  "mcpServers": {
    "project-room": {
      "type": "streamableHttp",
      "url": ${JSON.stringify(MCP)},
      "headers": {
        "Authorization": "Bearer \${env:PROJECT_ROOM_SECRET}"
      }
    }
  }
}
`],
    ["codex", join(home, ".codex", "config.toml"), `# project-room:begin
[mcp_servers.project-room]
url = ${JSON.stringify(MCP)}
bearer_token_env_var = "PROJECT_ROOM_SECRET"
# project-room:end
`],
  ];
  for (const [tool, file, expected] of cases) {
    const dry = await run(["setup", tool, "--project", project, "--dry-run"], { env, cwd: project, platform: "linux" });
    assert.equal(dry.code, 0, dry.err);
    assert.equal(statSync(file, { throwIfNoEntry: false }), undefined, tool + " dry-run wrote a file");
    assert.equal(dry.out.includes(TOKEN), false);
    const first = await run(["setup", tool, "--project", project], { env, cwd: project, platform: "linux" });
    assert.equal(first.code, 0, first.err);
    assert.equal(readFileSync(file, "utf8"), expected);
    assert.equal(readFileSync(file, "utf8").includes(TOKEN), false);
    const stamped = freeze(file);
    const second = await run(["setup", tool, "--project", project], { env, cwd: project, platform: "linux" });
    assert.equal(second.code, 0, second.err);
    assert.equal(statSync(file).mtimeMs, stamped, tool + " second run changed the file");
  }
  const aider = await run(["setup", "aider", "--project", project], { env, cwd: project, platform: "linux" });
  assert.equal(aider.code, 0, aider.err);
  assert.equal(readFileSync(join(project, ".aider.conf.yml"), "utf8"), `# project-room:begin
read:
  - .project-room/CONVENTIONS.md
# project-room:end
`);
  const notes = readFileSync(join(project, ".project-room", "CONVENTIONS.md"), "utf8");
  assert.match(notes, /# project-room:begin/);
  assert.match(notes, /Before you edit, claim the task on the room Board/);
  assert.equal(notes.includes(TOKEN), false);
  const generic = await run(["setup", "generic", "--project", project], { env, cwd: project, platform: "linux" });
  assert.equal(generic.code, 0, generic.err);
  assert.match(generic.out, /PROJECT_ROOM_SECRET/);
  assert.equal(generic.out.includes(TOKEN), false);
});

test("setup keeps an existing tool config and only replaces its own block", async t => {
  const { home, project, cleanup } = layout();
  t.after(cleanup);
  const env = envFor(home);
  const toml = join(home, ".codex", "config.toml");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(toml, "model = \"kept\"\n# project-room:begin\nurl = \"old\"\n# project-room:end\nkeep = true\n");
  const cursor = join(project, ".cursor", "mcp.json");
  mkdirSync(join(project, ".cursor"), { recursive: true });
  writeFileSync(cursor, JSON.stringify({ mcpServers: { other: { url: "https://example.test/mcp" } } }, null, 2) + "\n");
  assert.equal((await run(["setup", "codex", "--project", project], { env, cwd: project, platform: "linux" })).code, 0);
  const updated = readFileSync(toml, "utf8");
  assert.match(updated, /^model = "kept"\n/);
  assert.match(updated, /keep = true\n$/);
  assert.match(updated, new RegExp("url = " + JSON.stringify(MCP)));
  assert.equal(updated.includes("old"), false);
  assert.equal((await run(["setup", "cursor", "--project", project], { env, cwd: project, platform: "linux" })).code, 0);
  const json = JSON.parse(readFileSync(cursor, "utf8"));
  assert.equal(json.mcpServers.other.url, "https://example.test/mcp");
  assert.equal(json.mcpServers["project-room"].url, MCP);
  assert.equal(JSON.stringify(json).includes(TOKEN), false);
});

test("claude on PATH is registered with the env header and a second run does not register again", async t => {
  const { home, project, cleanup } = layout();
  t.after(cleanup);
  const bin = join(home, "bin");
  const log = join(home, "claude.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$CLAUDE_LOG\"\n", { mode: 0o755 });
  chmodSync(join(bin, "claude"), 0o755);
  const env = envFor(home, { PATH: bin, CLAUDE_LOG: log });
  const first = await run(["setup", "claude-code", "--project", project], { env, cwd: project, platform: "linux" });
  assert.equal(first.code, 0, first.err);
  assert.equal(statSync(join(project, ".mcp.json"), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "mcp", "add", "--transport", "http", "project-room", MCP, "--header", "Authorization: Bearer ${PROJECT_ROOM_SECRET}",
  ]);
  const stamped = freeze(log);
  const second = await run(["setup", "claude-code", "--project", project], { env, cwd: project, platform: "linux" });
  assert.equal(second.code, 0, second.err);
  assert.equal(statSync(log).mtimeMs, stamped);
  assert.equal(readFileSync(log, "utf8").includes(TOKEN), false);
});

test("token prints the saved secret on stdout only", async t => {
  const { home, project, cleanup } = layout();
  t.after(cleanup);
  const result = await run(["token"], { env: envFor(home), cwd: project });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, TOKEN + "\n");
  assert.equal(result.err, "");
});

test("doctor exit codes follow ready, access, and the tool config", async t => {
  const { home, project, cleanup } = layout();
  t.after(cleanup);
  const env = envFor(home);
  const down = await run(["doctor"], { env, cwd: project, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(down.code, 2);
  assert.match(down.out, /\/api\/ready/);
  const denied = await run(["doctor"], {
    env, cwd: project,
    fetchImpl: async url => ({ ok: true, status: String(url).endsWith("/api/ready") ? 200 : 401, json: async () => ({ error: { message: "no" } }) }),
  });
  assert.equal(denied.code, 1);
  assert.match(denied.out, /room login/);
  const unconfigured = await run(["doctor"], {
    env, cwd: project,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: { structuredContent: { status: "credential_accepted" } } }) }),
  });
  assert.equal(unconfigured.code, 1);
  assert.match(unconfigured.out, /room setup/);
  assert.equal((await run(["setup", "cursor", "--project", project], { env, cwd: project, platform: "linux" })).code, 0);
  const ok = await run(["doctor"], {
    env, cwd: project,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: { structuredContent: { status: "credential_accepted" } } }) }),
  });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /check out/);
  assert.equal(ok.out.includes(TOKEN), false);
});

test("login stores the connection as a private file and the printed result has no secret", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-login-"));
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const invite = store.invites.create(key, "commons", { profile: "chat", displayName: "Ada" });
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const env = envFor(home);
  const preview = await run(["login", "--room", `${origin}/join/${invite.code}`, "--name", "Ada"], { env, cwd: project });
  assert.equal(preview.code, 1);
  assert.match(preview.out, /approval_required/);
  assert.equal(preview.out.includes("pri_"), false);
  const joined = await run(["login", "--room", `${origin}/join/${invite.code}`, "--name", "Ada", "--accept"], { env, cwd: project });
  assert.equal(joined.code, 0, joined.out);
  const pointer = JSON.parse(readFileSync(join(home, ".project-room", "connections", "ada", "pointer.json"), "utf8"));
  const saved = readAgentConnection(pointer.configDirectory);
  assert.equal(saved.origin, origin);
  assert.equal(saved.roomId, "commons");
  assert.equal(joined.out.includes(saved.token), false);
  assert.equal(statSync(join(pointer.configDirectory, "connection.json")).mode & 0o777, 0o600);
  const setup = await run(["setup", "cursor", "--project", project], { env, cwd: project, platform: "linux" });
  assert.equal(setup.code, 0, setup.err);
  assert.equal(readFileSync(join(project, ".cursor", "mcp.json"), "utf8").includes(saved.token), false);
  const doctor = await run(["doctor"], { env, cwd: project, platform: "linux" });
  assert.equal(doctor.code, 0, doctor.out);
  assert.equal(doctor.out.includes(saved.token), false);
  const token = await run(["token"], { env, cwd: project });
  assert.equal(token.out, saved.token + "\n");
});


test("saved connections accept a canonical home alias and reject symlinks escaping its root", t => {
  const { root, home, cleanup } = layout();
  t.after(cleanup);
  const alias = join(root, "home-alias");
  symlinkSync(home, alias, "dir");
  const env = envFor(alias);
  const directory = realpathSync(join(home, ".project-room", "connections", "room-agent"));
  writeFileSync(join(directory, "pointer.json"), JSON.stringify({ version: 1, name: "room-agent", configDirectory: directory }), { mode: 0o600 });
  assert.equal(readPointer("room-agent", env).configDirectory, directory);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const escaped = join(home, ".project-room", "connections", "escape");
  symlinkSync(outside, escaped, "dir");
  writeFileSync(join(directory, "pointer.json"), JSON.stringify({ version: 1, name: "room-agent", configDirectory: escaped }), { mode: 0o600 });
  assert.throws(() => readPointer("room-agent", env), /outside the connection directory/);
});

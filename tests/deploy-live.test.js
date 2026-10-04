import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/deploy-live.py", import.meta.url));
const wireMetadata = script => {
  const result = spawnSync("python3", ["-B", "-c", `
import contextlib, importlib.util, io, json, pathlib, sys, tempfile, types, urllib.request
# No surrogate credential or network can be used by this fixture.
def forbidden(*args, **kwargs): raise AssertionError("unexpected credential/network call")
sys.modules["dynamic_credentials"] = types.SimpleNamespace(add_surrogate_to_request=forbidden)
urllib.request.urlopen = forbidden
spec = importlib.util.spec_from_file_location("deploy_live", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
captured = []
selected_script = sys.argv[2]
def fake_api(method, path, body=None, content_type="application/json"):
    if method == "POST" and path.endswith("/assets-upload-session"):
        return {"result": {"jwt": "synthetic-completion", "buckets": []}}
    if method == "PUT" and path.endswith("/workers/scripts/" + selected_script):
        assert content_type.startswith("multipart/form-data;")
        metadata = body.split(b"\\r\\n\\r\\n", 1)[1].split(b"\\r\\n", 1)[0]
        captured.append(json.loads(metadata)); return {"success": True}
    raise AssertionError("unexpected API operation")
m.api = fake_api
with tempfile.TemporaryDirectory() as directory:
    bundle = pathlib.Path(directory) / "worker.js"; bundle.write_text("export default {};")
    public = pathlib.Path(directory) / "public"; public.mkdir(); (public / "index.html").write_text("fixture")
    sys.argv = [sys.argv[1], sys.argv[2], "synthetic-account", str(public), str(bundle)]
    with contextlib.redirect_stdout(io.StringIO()): m.main()
assert len(captured) == 1
print(json.dumps(captured[0]))
`, helper, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

for (const script of ["project-room", "project-room-staging"]) {
  test(`deployment wire metadata preserves ${script} topology and live bindings`, () => {
    const metadata = wireMetadata(script);
    assert.deepEqual(metadata.keep_bindings, ["secret_text", "plain_text"]);
    const room = metadata.bindings.find(binding => binding.name === "ROOM");
    const vars = Object.fromEntries(metadata.bindings.filter(b => b.type === "plain_text").map(b => [b.name, b.text]));
    assert.equal(metadata.assets.jwt, "synthetic-completion");
    assert.equal(metadata.assets.config.run_worker_first, true);
    assert.equal(metadata.compatibility_date, "2026-07-30");
    assert.ok(metadata.compatibility_flags.includes("nodejs_compat"));
    assert.equal(Object.hasOwn(metadata, "migrations"), false);
    if (script === "project-room") {
      assert.deepEqual(room, { type: "durable_object_namespace", name: "ROOM", class_name: "ProjectRoom" });
      assert.equal(metadata.limits.cpu_ms, 30000);
      assert.equal(vars.ROOM_DEPLOYMENT, "production");
      assert.equal(vars.ROOM_GMAIL_ENABLED, "0");
      assert.equal(vars.ROOM_GMAIL_PILOT_ONLY, "1");
      assert.equal(vars.ROOM_SECURITY_CONTACT, "potter@trydemigod.com");
    } else {
      assert.deepEqual(room, { type: "durable_object_namespace", name: "ROOM", class_name: "ProjectRoom", script_name: "project-room" });
      assert.equal(metadata.limits.cpu_ms, 1000);
      // The entry door serves production traffic, so it reports production (QA5R G-1).
      assert.deepEqual(vars, { ROOM_ORIGIN: "https://room.trydemigod.com", ROOM_DEPLOYMENT: "production", ROOM_SERVICE_MODE: "cloudflare-production", ROOM_SECURITY_CONTACT: "potter@trydemigod.com" });
    }
  });
}

test("invalid deployment arguments fail before loading connector credentials", () => {
  for (const args of [[], ["wrong-worker", "synthetic", "missing", "missing"]]) {
    const result = spawnSync("python3", [helper, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, args.length ? /unknown script name/ : /Usage:/);
    assert.doesNotMatch(result.stderr, /dynamic_credentials|ModuleNotFoundError/);
  }
});

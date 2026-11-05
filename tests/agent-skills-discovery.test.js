import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  discoveryDoc, DISCOVERY_PATHS, skillMd, agentSkillsIndexJson,
  AGENT_SKILLS_INDEX_PATH, AGENT_SKILLS_SCHEMA
} from "../server/agent-discovery.mjs";
import { classifyEdgePath, edgePublicResponse } from "../cloudflare/edge-public.mjs";

// Agent Skills discovery (v0.2.0, cloudflare/agent-skills-discovery-rfc):
// an arriving agent fetches /.well-known/agent-skills/index.json FIRST,
// then follows an entry's url to the SKILL.md. Before this lane every path
// under the prefix returned the generic 404 while /SKILL.md served 200 —
// the discovery document was never created, so the standard door was down.
const SKILL_PATH = "/.well-known/agent-skills/work-in-project-room/SKILL.md";
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-agent-skills-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("agent-skills index is a v0.2.0 discovery document whose digest matches the served skill bytes", () => {
  assert.equal(AGENT_SKILLS_INDEX_PATH, "/.well-known/agent-skills/index.json");
  const doc = discoveryDoc(AGENT_SKILLS_INDEX_PATH);
  assert.ok(doc, "index is served");
  assert.match(doc.type, /application\/json/);
  assert.equal(doc.body, agentSkillsIndexJson());
  const index = JSON.parse(doc.body);
  assert.equal(index.$schema, AGENT_SKILLS_SCHEMA);
  assert.equal(index.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
  assert.ok(Array.isArray(index.skills) && index.skills.length >= 1, "skills[] present");
  const entry = index.skills.find(s => s.name === "work-in-project-room");
  assert.ok(entry, "the room's own skill is listed");
  assert.equal(entry.type, "skill-md");
  assert.ok(entry.description.length > 0 && entry.description.length <= 1024, "description within the spec cap");
  // The index entry must agree with the SKILL.md frontmatter it advertises.
  const skill = skillMd();
  const frontmatter = skill.split("---")[1];
  assert.match(frontmatter, /name: work-in-project-room/);
  assert.ok(frontmatter.includes(`description: ${entry.description}`), "description is the frontmatter description, verbatim");
  // url resolves on this origin to exactly the /SKILL.md bytes, and the
  // digest is the SHA-256 of those exact bytes (clients MUST verify it).
  assert.equal(entry.url, SKILL_PATH);
  assert.equal(discoveryDoc(SKILL_PATH).body, skill);
  assert.equal(entry.digest, `sha256:${sha256(skill)}`);
});

test("the whole agent-skills prefix resolves: bare prefix, index, per-skill path and the legacy connect path", async t => {
  for (const path of [
    "/.well-known/agent-skills",
    "/.well-known/agent-skills/",
    AGENT_SKILLS_INDEX_PATH,
    "/room/.well-known/agent-skills/index.json",
    "/project-room/.well-known/agent-skills/index.json"
  ]) {
    assert.ok(DISCOVERY_PATHS.includes(path), path);
    assert.equal(discoveryDoc(path).body, agentSkillsIndexJson(), path);
    assert.equal(classifyEdgePath(path), "discovery", `edge serves ${path} without entering the Durable Object`);
  }
  for (const path of [SKILL_PATH, "/.well-known/agent-skills/connect/SKILL.md"]) {
    assert.ok(DISCOVERY_PATHS.includes(path), path);
    assert.equal(discoveryDoc(path).body, skillMd(), path);
    assert.equal(classifyEdgePath(path), "discovery", `edge serves ${path}`);
  }
  const origin = await serve(t);
  for (const path of ["/.well-known/agent-skills", "/.well-known/agent-skills/", AGENT_SKILLS_INDEX_PATH, "/room/.well-known/agent-skills/index.json", "/project-room/.well-known/agent-skills/index.json"]) {
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.match(get.headers.get("content-type"), /application\/json/);
    const index = JSON.parse(await get.text());
    assert.deepEqual(index.skills.map(s => s.name), ["work-in-project-room"]);
    const artifactUrl = new URL(index.skills[0].url, get.url);
    assert.equal(artifactUrl.origin, origin, "discovery stays on the requested origin");
    const artifact = await fetch(artifactUrl);
    assert.equal(artifact.status, 200);
    const bytes = Buffer.from(await artifact.arrayBuffer());
    assert.equal(index.skills[0].digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.equal(bytes.toString("utf8"), skillMd());
    assert.notEqual(index.skills[0].digest, `sha256:${sha256(bytes.toString("utf8") + "\n")}`, "changed bytes do not match");
  }
  const skillGet = await fetch(origin + SKILL_PATH);
  assert.equal(skillGet.status, 200, SKILL_PATH);
  assert.equal(await skillGet.text(), skillMd());
  assert.equal((await fetch(origin + AGENT_SKILLS_INDEX_PATH, { method: "POST" })).status, 405, "index is a read-only document");
});


test("edge aliases keep fingerprint and skill fetch on the requesting origin", async () => {
  for (const origin of ["https://room.trydemigod.com", "https://www.trydemigod.com", "https://www.getdasha.com"]) {
    for (const path of [AGENT_SKILLS_INDEX_PATH, "/room/.well-known/agent-skills/index.json", "/project-room/.well-known/agent-skills/index.json"]) {
      const url = new URL(path, origin);
      const response = await edgePublicResponse(new Request(url), {}, url);
      assert.equal(response.status, 200);
      const entry = (await response.json()).skills[0];
      const skillUrl = new URL(entry.url, url);
      assert.equal(skillUrl.origin, origin);
      const artifact = await edgePublicResponse(new Request(skillUrl), {}, skillUrl);
      assert.equal(artifact.status, 200);
      assert.equal(entry.digest, `sha256:${createHash("sha256").update(Buffer.from(await artifact.arrayBuffer())).digest("hex")}`);
    }
  }
  assert.match(discoveryDoc("/llms-full.txt").body, /skill-index .*agent-skills.*not a signature or trust approval/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { workspaceArtifactSelection } from "../src/workspace-artifact-link.js";

test("an artifact link pins its panel, revision, digest and author", () => {
  const id = "3".repeat(32), digest = "a".repeat(64);
  assert.deepEqual(workspaceArtifactSelection(`#pr-workspace/${id}/2/output/${digest}/ai_test`),
    { id, revision: 2, panel: "output", digest, publisherId: "ai_test" });
  assert.equal(workspaceArtifactSelection(`#pr-workspace/${id}/9007199254740992/preview/${digest}/author`), null);
  assert.equal(workspaceArtifactSelection(`#pr-workspace/${id}/2/private/${digest}/author`), null);
  assert.equal(workspaceArtifactSelection(`#pr-workspace/${id}/2/changes/${digest}/%bad`), null);
  assert.equal(workspaceArtifactSelection(`#pr-workspace/${id}/2/changes/short/author`), null);
  const head = "b".repeat(40);
  assert.deepEqual(workspaceArtifactSelection(`#pr-workspace/${id}/2/preview/${digest}/ai_test/${head}`),
    { id, revision: 2, panel: "preview", digest, publisherId: "ai_test", head });
  assert.equal(workspaceArtifactSelection(`#pr-workspace/${id}/2/preview/${digest}/ai_test/HEAD`), null);
});

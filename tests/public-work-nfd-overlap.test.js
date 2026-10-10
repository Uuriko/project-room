import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { publicWorkClaimFenceSchema } from "../server/public-work-claim-fence.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "public-work-nfd-"));
  const file = join(dir, "room.sqlite");
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema);
  store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create("First worker"), store.identities.create("Second worker")];
  const service = () => new PublicWorkClaims(store);
  const enable = (id, files) => {
    store.projectOffers.create("commons", "owner", {
      requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
      terms: {
        kind: "task", title: id, summary: "Public result",
        acceptanceCriteria: ["Deliver the declared change"],
        repositoryUrl: "https://github.com/Example/Project",
        reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" },
      },
    });
    store.projectOffers.transition("commons", "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable("commons", "owner", id, {
      requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files,
    });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, identities, enable };
}

const claim = requestId => ({ requestId, expectedTermsVersion: 1 });
const code = expected => error => error.code === expected;

test("an NFD public-work path conflicts with a live NFC lease of the same file", t => {
  const f = fixture(t);
  const [a, b] = f.identities;
  const nfc = "server/café.mjs";
  const nfd = "server/cafe\u0301.mjs";
  assert.notEqual(nfc, nfd);
  f.enable("nfc-task", [nfc]);
  f.enable("nfd-task", [nfd]);
  f.service().act("nfc-task", a.secret, "claim", claim("claim-nfc"));
  assert.throws(
    () => f.service().act("nfd-task", b.secret, "claim", claim("claim-nfd")),
    code("public_work_path_conflict"),
  );
  assert.equal(f.service().match(null, {}).recommendations.some(entry => entry.task.taskId === "nfd-task"), false);
  f.enable("case-task", ["server/Cafe.mjs"]);
  assert.equal(f.service().act("case-task", b.secret, "claim", claim("claim-case")).task.claim.identityId, b.identityId);
  assert.throws(() => f.enable("climb-task", ["server/../café.mjs"]), code("invalid_public_work"));
});

// K018: room announcements. Pure channel tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createAnnouncements, AnnouncementError } from "../server/announcements.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof AnnouncementError && error.code === code);

test("post/markRead/unread/list lifecycle", () => {
  const ann = createAnnouncements();
  const a1 = ann.post("room1", { authorId: "owner", title: "Deploy Friday", body: "We ship at 5pm" });
  assert.ok(a1.announcementId.startsWith("ann-"));
  assert.ok(Object.isFrozen(a1));
  const a2 = ann.post("room1", { authorId: "owner", title: "Holiday", body: "Off Monday" });
  assert.equal(ann.list("room1").length, 2);
  assert.equal(ann.list("room1")[0].announcementId, a2.announcementId); // newest first
  assert.equal(ann.unread("room1", { memberId: "ada" }).length, 2);
  ann.markRead("room1", { announcementId: a1.announcementId, memberId: "ada" });
  const unread = ann.unread("room1", { memberId: "ada" });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].announcementId, a2.announcementId);
});
test("malformed inputs are refused", () => {
  const ann = createAnnouncements();
  throwsCode(() => ann.post("r", { authorId: "o", title: "", body: "b" }), "invalid_announcement");
  throwsCode(() => ann.markRead("r", { announcementId: "ghost", memberId: "m" }), "invalid_announcement");
});

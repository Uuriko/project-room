import { notificationFromPush } from "./src/human-push-display.js";

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = {}; }
  const note = notificationFromPush(payload);
  event.waitUntil(self.registration.showNotification(note.title, {
    body: note.body,
    tag: note.tag,
    data: note.data
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const roomId = event.notification.data?.roomId;
  const target = roomId ? `/?room=${encodeURIComponent(roomId)}` : "/";
  event.waitUntil(self.clients.openWindow(target));
});

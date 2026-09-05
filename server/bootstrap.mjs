import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

export function initialRoom(roomId = "commons", ownerId = "owner") {
  return [
    event({ type: T.ROOM_CREATED, actorId: ownerId, roomId, data: { roomId, ownerId, title: "Project Room Commons", purpose: "A shared place to hang out, think, and make things together." } }),
    event({ type: T.MEMBER_ADDED, actorId: ownerId, roomId, data: { memberId: ownerId, displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
  ];
}

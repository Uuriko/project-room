import { roomEntry } from "../deploy/room-entry.mjs";

export default {
  async fetch(request) {
    return roomEntry(request) ?? new Response("Not found", { status: 404 });
  }
};

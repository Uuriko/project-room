import { createHash } from "node:crypto";
import { discoveryDoc, ROOM_ORIGIN, COMPUTE_DOOR } from "./agent-discovery.mjs";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
export const PUBLIC_DOOR_PATHS = Object.freeze(["/room", "/room/"]);

import { fileURLToPath } from "node:url";
import { roomRosterMain } from "../src/room-roster.js";

try {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  process.stdout.write(roomRosterMain(process.argv.slice(2), { execPath: process.execPath, checkout }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

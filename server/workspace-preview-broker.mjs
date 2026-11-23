import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createServer } from "node:tls";

const handshakeLimit = 2048;
const handshakeTimeoutMs = 5000;
const fields = ["roomId", "id", "revision", "publisherId"];
const publicationKey = selection => JSON.stringify([selection.roomId, selection.id]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameSelection = (left, right) => fields.every(field => left[field] === right[field]);

export function workspacePreviewBrokerConfig(env) {
  const { ROOM_WORKSPACE_PUBLISHER_PORT: port, ROOM_WORKSPACE_PUBLISHER_TLS_KEY: key,
    ROOM_WORKSPACE_PUBLISHER_TLS_CERT: cert } = env;
  if (port === undefined && key === undefined && cert === undefined) return null;
  if (!/^[0-9]+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535
    || !isAbsolute(key ?? "") || !isAbsolute(cert ?? "")) {
    throw Error("Workspace publisher requires a port and absolute TLS key and certificate paths");
  }
  return { port: Number(port), key: readFileSync(key), cert: readFileSync(cert) };
}

function readHello(socket, onHello) {
  let bytes = Buffer.alloc(0);
  const deadline = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
  socket.once("close", () => clearTimeout(deadline));
  socket.on("data", function receive(chunk) {
    const newline = chunk.indexOf(10);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    if (bytes.length + part.length > handshakeLimit) return socket.destroy();
    bytes = Buffer.concat([bytes, part]);
    if (newline < 0) return;
    socket.pause();
    socket.removeListener("data", receive);
    clearTimeout(deadline);
    try {
      const hello = JSON.parse(bytes.toString("utf8"));
      if (newline + 1 < chunk.length) socket.unshift(chunk.subarray(newline + 1));
      onHello(hello);
    } catch {
      socket.destroy();
    }
  });
}

const writeHello = (socket, value) => socket.write(JSON.stringify(value) + "\n");
const tokenMatches = (left, right) => typeof left === "string" && /^[a-f0-9]{64}$/.test(left)
  && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

// The HTTP layer authorizes viewers before asking for a lane. The broker
// only attaches a lane to its exact publication and current publisher.
export function createWorkspacePreviewBroker({ key, cert }, consumeGrant) {
  const publications = new Map(), generations = new Map(), sockets = new Set();
  let generation = 0;

  function retire(peer) {
    if (publications.get(peer.key) !== peer) return;
    publications.delete(peer.key);
    generations.delete(peer.generation);
    for (const finish of peer.pending.values()) finish(Error("Workspace publisher disconnected"));
    for (const socket of peer.lanes) socket.destroy();
    peer.control.destroy();
  }

  function accept(socket, hello) {
    if (!record(hello)) return socket.destroy();
    if (hello.type === "publisher") {
      if (!record(hello.selection)
        || publications.size >= 64 && !publications.has(publicationKey(hello.selection))) return socket.destroy();
      const selection = consumeGrant(hello.grant, hello.selection);
      if (!selection) return socket.destroy();
      const key = publicationKey(selection), previous = publications.get(key);
      if (previous) retire(previous);
      const peer = { key, selection, generation: ++generation, token: randomBytes(32).toString("hex"),
        control: socket, pending: new Map(), lanes: new Set() };
      publications.set(key, peer);
      generations.set(peer.generation, peer);
      socket.on("data", () => socket.destroy());
      socket.once("close", () => retire(peer));
      writeHello(socket, { type: "ready", generation: peer.generation, laneToken: peer.token });
      socket.resume();
      return;
    }
    const peer = generations.get(hello.generation);
    if (hello.type !== "lane" || !peer || !tokenMatches(hello.token, peer.token)) return socket.destroy();
    const finish = peer.pending.get(hello.id);
    if (!finish) return socket.destroy();
    peer.lanes.add(socket);
    socket.once("close", () => peer.lanes.delete(socket));
    finish(null, socket);
    socket.resume();
  }

  const server = createServer({ key, cert, minVersion: "TLSv1.3", handshakeTimeout: handshakeTimeoutMs }, socket => {
    socket.on("error", () => socket.destroy());
    readHello(socket, hello => accept(socket, hello));
  });
  // Track even sockets whose TLS handshake has not finished.
  server.on("connection", socket => {
    if (sockets.size >= 512) return socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    server,
    generationFor(selection) {
      const peer = publications.get(publicationKey(selection));
      return peer && sameSelection(peer.selection, selection) ? peer.generation : undefined;
    },
    retire(selection, generation) {
      const peer = generations.get(generation);
      if (!peer || !sameSelection(peer.selection, selection)) return false;
      retire(peer);
      return true;
    },
    openLane(selection, callback) {
      const peer = publications.get(publicationKey(selection));
      if (!peer || !sameSelection(peer.selection, selection) || peer.pending.size + peer.lanes.size >= 64) {
        callback(Error("Workspace publisher unavailable"));
        return;
      }
      const id = randomUUID(), deadline = setTimeout(() => finish(Error("Workspace publisher lane timed out")), handshakeTimeoutMs);
      function finish(error, socket) {
        if (!peer.pending.delete(id)) return;
        clearTimeout(deadline);
        callback(error, socket);
      }
      peer.pending.set(id, finish);
      writeHello(peer.control, { type: "open", generation: peer.generation, id });
    },
    close() {
      for (const peer of publications.values()) retire(peer);
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

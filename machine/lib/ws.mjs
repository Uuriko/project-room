import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key) {
  return createHash("sha1").update(String(key) + GUID).digest("base64");
}

export function encodeFrame(opcode, payload, { mask }) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const maskBit = mask ? 0x80 : 0;
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  if (!mask) return Buffer.concat([header, data]);
  const key = randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

export function createFrameParser(onMessage, { maxBytes = 8 * 1024 * 1024, onTooLarge } = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragOpcode = 0;
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const fin = (buffer[0] & 0x80) !== 0;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxBytes)) { onTooLarge?.(); return; }
        length = Number(big);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + length) return;
      let payload = buffer.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const key = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ key[i & 3];
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + maskLen + length);
      if (opcode === 0) {
        fragments.push(payload);
      } else if (opcode === 1 || opcode === 2) {
        fragments = [payload];
        fragOpcode = opcode;
      } else if (opcode === 8) {
        onMessage({ opcode: 8, payload });
        continue;
      } else if (opcode === 9 || opcode === 10) {
        onMessage({ opcode, payload });
        continue;
      } else {
        continue;
      }
      if (!fin) continue;
      const body = Buffer.concat(fragments);
      fragments = [];
      if (body.length > maxBytes) { onTooLarge?.(); return; }
      if (fragOpcode === 1) onMessage({ opcode: 1, payload: body });
    }
  };
}

// Outbound socket. The machine token is an Authorization header, not a URL
// query and not a child argument.
export function connectSocket(url, { headers = {}, onText, onClose, onOpen }) {
  const parsed = new URL(url);
  const tls = parsed.protocol === "wss:";
  const port = parsed.port || (tls ? 443 : 80);
  const key = randomBytes(16).toString("base64");
  const socket = (tls ? tlsConnect : netConnect)({ host: parsed.hostname, port: Number(port), servername: parsed.hostname });
  let opened = false;
  const fail = () => { if (!opened) onClose?.(); };
  socket.on("error", fail);
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  const path = `${parsed.pathname || "/"}${parsed.search}`;
  socket.once("connect", () => {
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${parsed.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...headerLines,
      "",
      "",
    ].join("\r\n"));
  });
  let handshake = Buffer.alloc(0);
  const parser = createFrameParser(frame => {
    if (frame.opcode === 9) {
      socket.write(encodeFrame(10, frame.payload, { mask: true }));
      return;
    }
    if (frame.opcode === 8) { socket.end(); return; }
    if (frame.opcode === 1) onText?.(frame.payload.toString("utf8"));
  }, { onTooLarge: () => socket.destroy() });
  socket.on("data", chunk => {
    if (!opened) {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = handshake.subarray(0, end).toString("utf8");
      const rest = handshake.subarray(end + 4);
      if (!head.startsWith("HTTP/1.1 101")) { socket.destroy(); onClose?.(); return; }
      // L7: validate the server's accept key against our nonce — a proxy
      // that answers 101 without completing the WebSocket handshake is not
      // a WebSocket peer.
      const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1] ?? "";
      if (accept !== acceptKey(key)) { socket.destroy(); onClose?.(); return; }
      opened = true;
      onOpen?.();
      if (rest.length) parser(rest);
      return;
    }
    parser(chunk);
  });
  socket.on("close", () => onClose?.());
  return {
    socket,
    send(text) { if (opened) socket.write(encodeFrame(1, text, { mask: true })); },
    close() { socket.end(); socket.destroy(); },
  };
}

export function acceptUpgrade(req, socket, head, { onText, onClose }) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "",
    "",
  ].join("\r\n"));
  const parser = createFrameParser(frame => {
    if (frame.opcode === 9) {
      socket.write(encodeFrame(10, frame.payload, { mask: false }));
      return;
    }
    if (frame.opcode === 8) { socket.end(); return; }
    if (frame.opcode === 1) onText?.(frame.payload.toString("utf8"));
  }, { onTooLarge: () => socket.destroy() });
  if (head?.length) parser(head);
  socket.on("data", parser);
  socket.on("close", () => onClose?.());
  socket.on("error", () => onClose?.());
  return {
    send(text) { socket.write(encodeFrame(1, text, { mask: false })); },
    close() { socket.end(); },
  };
}

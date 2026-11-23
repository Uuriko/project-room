import { once } from "node:events";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { readFileSync } from "node:fs";
import { workspacePublisherAddress } from "../server/workspace-publisher-address.mjs";

const frameLimit = 2048, laneLimit = 64, connectMs = 5000;
const token = /^[a-f0-9]{64}$/;
const laneId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const writeFrame = (socket, value) => socket.write(JSON.stringify(value) + "\n");

export function workspacePublisherEndpoint(value, caPath) {
  const url = new URL(workspacePublisherAddress(value));
  return {
    host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
    servername: url.hostname, port: Number(url.port), minVersion: "TLSv1.3",
    rejectUnauthorized: true, ...(caPath && { ca: readFileSync(caPath) }),
  };
}

export function attachWorkspacePublisher({ endpoint, selection, grant, port, ownsPort, signal }) {
  signal.throwIfAborted();
  const control = connectTls(endpoint);
  const lanes = new Set();
  let generation, laneToken, pending = "", resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const close = () => control.destroy();
  const setupDeadline = setTimeout(close, connectMs).unref();
  signal.addEventListener("abort", close, { once: true });
  control.once("close", () => {
    clearTimeout(setupDeadline);
    signal.removeEventListener("abort", close);
    for (const dispose of lanes) dispose();
    resolveClosed();
  });
  control.on("error", close);

  async function openLane(id) {
    if (control.destroyed) return;
    // A request-side FIN still leaves the response side available.
    const link = connectTls({ ...endpoint, allowHalfOpen: true });
    const app = connect({ host: "127.0.0.1", port });
    const deadline = setTimeout(() => dispose(), connectMs).unref();
    let piping = false, drainDeadline;
    function dispose() {
      clearTimeout(deadline);
      clearTimeout(drainDeadline);
      lanes.delete(dispose);
      link.destroy();
      app.destroy();
    }
    const waitForDrain = () => { drainDeadline ??= setTimeout(dispose, connectMs).unref(); };
    lanes.add(dispose);
    const onClose = (peer, hadError) => {
      if (hadError || !piping) return dispose();
      // A normal FIN can arrive while the other socket still has buffered
      // response bytes. Let that socket flush its writes before it closes.
      peer.end();
      if (link.destroyed && app.destroyed) return dispose();
      waitForDrain();
    };
    link.once("end", waitForDrain);
    link.once("close", hadError => onClose(app, hadError));
    app.once("close", hadError => onClose(link, hadError));
    link.on("error", dispose);
    app.on("error", dispose);
    try {
      // Closing a socket can precede either connection event. Retire the
      // pending handshake on either close instead of leaving a listener.
      await Promise.race([
        Promise.all([once(link, "secureConnect"), once(app, "connect")]),
        once(link, "close").then(() => { throw new Error("Publisher lane closed"); }),
        once(app, "close").then(() => { throw new Error("Preview listener closed"); }),
      ]);
      // Verify the accepted socket, not just the listening port. An old
      // listener may have been replaced after the launch was checked.
      if (!app.localPort || !await ownsPort(app.localPort) || control.destroyed || link.destroyed || app.destroyed)
        return dispose();
      clearTimeout(deadline);
      piping = true;
      writeFrame(link, { type: "lane", token: laneToken, id, generation });
      link.pipe(app).pipe(link);
    } catch {
      dispose();
    }
  }

  return new Promise((resolve, reject) => {
    control.once("close", () => reject(new Error("Could not attach the live Workspace publisher")));
    control.once("error", reject);
    control.once("secureConnect", () => writeFrame(control, { type: "publisher", grant, selection }));
    control.setEncoding("utf8");
    control.on("data", chunk => {
      while (chunk.length) {
        const end = chunk.indexOf("\n"), part = end < 0 ? chunk : chunk.slice(0, end);
        if (pending.length + part.length > frameLimit) return close();
        pending += part;
        if (end < 0) return;
        let frame;
        try { frame = JSON.parse(pending); } catch { return close(); }
        pending = "";
        chunk = chunk.slice(end + 1);
        if (generation === undefined) {
          if (frame?.type !== "ready" || !Number.isSafeInteger(frame.generation)
              || frame.generation < 1 || !token.test(frame.laneToken ?? "")) return close();
          ({ generation, laneToken } = frame);
          clearTimeout(setupDeadline);
          resolve({ closed });
        } else {
          if (frame?.type !== "open" || frame.generation !== generation || !laneId.test(frame.id ?? "")) return close();
          // The broker expires the excess request without dropping the
          // existing viewer connections.
          if (lanes.size < laneLimit) openLane(frame.id).catch(close);
        }
      }
    });
  });
}

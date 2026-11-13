# SPDX-License-Identifier: Apache-2.0
"""Stateless Streamable HTTP MCP for a shared, private outage backchannel."""
import argparse
import datetime as dt
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import time
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AUTHOR = "shared-bearer"
VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"]


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def string(value, maximum, label):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum:
        raise ValueError("Invalid " + label)
    return value


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise ValueError("Database cannot be a symlink")
        try:
            os.close(os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        except FileExistsError:
            pass
        stat = self.path.stat()
        if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
            raise ValueError("Database must be private to its owner")
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            application = db.execute("PRAGMA application_id").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("Unsupported backup database version")
            tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone()
            if tables and application != 0x50524243:
                raise ValueError("Refusing to adopt an existing unrelated database")
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS messages (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                    room TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
                    ts TEXT NOT NULL, reply_to TEXT REFERENCES messages(id), request_id TEXT UNIQUE);
                CREATE INDEX IF NOT EXISTS room_sequence ON messages(room,seq);
                CREATE TABLE IF NOT EXISTS acknowledgments (
                    id TEXT PRIMARY KEY REFERENCES messages(id), author TEXT NOT NULL, ts TEXT NOT NULL);
                PRAGMA user_version=1;
                PRAGMA application_id=0x50524243;
            """)

    def connect(self):
        db = sqlite3.connect(str(self.path), timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        return db

    @staticmethod
    def message(row):
        return {"seq": row["seq"], "id": row["id"], "room": row["room"],
                "author": row["author"], "text": row["text"], "ts": row["ts"], "replyTo": row["reply_to"]}

    def post(self, room, text, replyTo=None, requestId=None):
        string(room, 128, "room"); string(text, 16384, "text")
        if replyTo is not None: string(replyTo, 128, "replyTo")
        if requestId is not None: string(requestId, 128, "requestId")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if requestId:
                prior = db.execute("SELECT * FROM messages WHERE request_id=?", (requestId,)).fetchone()
                if prior:
                    if (prior["room"], prior["text"], prior["reply_to"]) != (room, text, replyTo):
                        raise ValueError("requestId already belongs to different content")
                    return self.message(prior)
            if replyTo:
                parent = db.execute("SELECT room FROM messages WHERE id=?", (replyTo,)).fetchone()
                if not parent or parent["room"] != room:
                    raise ValueError("replyTo must name a message in this room")
            message_id = str(uuid.uuid4())
            db.execute("INSERT INTO messages(id,room,author,text,ts,reply_to,request_id) VALUES(?,?,?,?,?,?,?)",
                       (message_id, room, AUTHOR, text, stamp(), replyTo, requestId))
            return self.message(db.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone())

    def read(self, room, since=0, limit=50):
        string(room, 128, "room")
        if type(since) is not int or not 0 <= since <= 9223372036854775807:
            raise ValueError("since must be a nonnegative sequence cursor")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        with self.connect() as db:
            rows = db.execute("SELECT * FROM messages WHERE room=? AND seq>? ORDER BY seq LIMIT ?",
                              (room, since, limit + 1)).fetchall()
            held = rows[:limit]
            messages = []
            for row in held:
                message = self.message(row)
                ack = db.execute("SELECT author,ts FROM acknowledgments WHERE id=?", (row["id"],)).fetchone()
                message["ack"] = dict(ack) if ack else None
                messages.append(message)
            return {"messages": messages, "nextSince": held[-1]["seq"] if held else since,
                    "hasMore": len(rows) > limit}

    def ack(self, id):
        string(id, 128, "id")
        with self.connect() as db:
            if not db.execute("SELECT 1 FROM messages WHERE id=?", (id,)).fetchone():
                raise ValueError("Unknown message")
            db.execute("INSERT OR IGNORE INTO acknowledgments VALUES(?,?,?)", (id, AUTHOR, stamp()))
            return dict(db.execute("SELECT * FROM acknowledgments WHERE id=?", (id,)).fetchone())


def schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TEXT = {"type": "string", "minLength": 1}
TOOLS = [
    {"name": "post", "description": "Persist a shared-bearer message. A post is not proof of receipt or execution.",
     "inputSchema": schema({"room": dict(TEXT, maxLength=128), "text": dict(TEXT, maxLength=16384),
                            "replyTo": TEXT, "requestId": TEXT}, ["room", "text"])},
    {"name": "read", "description": "Read ordered messages after a sequence cursor; follow hasMore using nextSince.",
     "inputSchema": schema({"room": TEXT, "since": {"type": "integer", "minimum": 0},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 100}}, ["room"])},
    {"name": "ack", "description": "Persist an idempotent shared-bearer acknowledgment; not proof of useful work.",
     "inputSchema": schema({"id": TEXT}, ["id"])},
    {"name": "status", "description": "Read this Mac hostname, machine/service uptime and configured checkout HEAD.",
     "inputSchema": schema({}, [])},
]


class Service(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, bind, port, token, database, checkout, hostname):
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("A nonempty dedicated bearer is required")
        self.slots = threading.BoundedSemaphore(8)
        self.token = token.encode("ascii")
        self.ledger = Ledger(database)
        self.checkout = str(checkout)
        self.started = time.monotonic()
        self.tailnet_hostname = hostname.rstrip(".")
        super().__init__((bind, port), Handler)
        actual_port = self.server_address[1]
        self.hosts = {bind + ":" + str(actual_port), hostname.rstrip(".") + ":" + str(actual_port)}

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def status(self):
        git = subprocess.run(["/usr/bin/git", "-C", self.checkout, "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=5)
        head = git.stdout.strip() if git.returncode == 0 else None
        if head and not re.fullmatch("[0-9a-f]{40}", head): head = None
        boot = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.boottime"],
                              capture_output=True, text=True, timeout=5)
        seconds = re.search(r"sec = (\d+)", boot.stdout) if boot.returncode == 0 else None
        return {"hostname": socket.gethostname(), "tailnetHostname": self.tailnet_hostname,
                "uptimeSeconds": max(0, int(time.time()) - int(seconds[1])) if seconds else None,
                "uptimeAvailable": bool(seconds),
                "uptimeError": None if seconds else "macOS boot time unavailable to this process",
                "serviceUptimeSeconds": int(time.monotonic() - self.started), "gitHead": head,
                "authorSemantics": "One shared bearer; author is not an authenticated agent identity."}

    def rpc(self, request):
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
        identifier = request.get("id")
        if "id" not in request: return None
        response = {"jsonrpc": "2.0", "id": identifier}
        method, params = request["method"], request.get("params", {})
        try:
            if not isinstance(params, dict): raise ValueError("Invalid params")
            if method == "initialize":
                version = params.get("protocolVersion")
                result = {"protocolVersion": version if version in VERSIONS else VERSIONS[0],
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "room-backup-mcp", "version": "1.0.0"}}
            elif method == "ping": result = {}
            elif method == "tools/list": result = {"tools": TOOLS}
            elif method == "tools/call":
                name, arguments = params.get("name"), params.get("arguments", {})
                tool = next((t for t in TOOLS if t["name"] == name), None)
                if not tool or not isinstance(arguments, dict): raise ValueError("Invalid tool call")
                contract = tool["inputSchema"]
                if set(arguments) - set(contract["properties"]) or set(contract["required"]) - set(arguments):
                    raise ValueError("Invalid tool arguments")
                operation = self.status if name == "status" else getattr(self.ledger, name)
                value = operation(**arguments)
                result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": False}
            else:
                response["error"] = {"code": -32601, "message": "Method not found"}
                return response
            response["result"] = result
        except (ValueError, TypeError):
            response["error"] = {"code": -32602, "message": "Invalid parameters or message reference"}
        except Exception:
            response["error"] = {"code": -32603, "message": "Operation unavailable; no success recorded"}
        return response


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def handle(self):
        # A hard lifetime also bounds clients sending headers one byte at a time.
        deadline = threading.Timer(15, self.expire)
        deadline.daemon = True
        deadline.start()
        try:
            super().handle()
        finally:
            deadline.cancel()

    def expire(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def log_message(self, *_args):
        pass  # Never log message bodies, bearer headers or URL query strings.

    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        if status == 405: self.send_header("Allow", "POST")
        if status == 401: self.send_header("WWW-Authenticate", 'Bearer realm="room-backup"')
        self.end_headers()
        self.wfile.write(data)

    def admit(self):
        authorization = self.headers.get("Authorization", "").encode("utf-8")
        if len(authorization) > 256 or not hmac.compare_digest(authorization, b"Bearer " + self.server.token):
            self.reply(401, {"error": "Bearer required"}); return False
        if self.headers.get("Host", "") not in self.server.hosts or self.headers.get("Origin") is not None:
            self.reply(403, {"error": "Host or Origin refused"}); return False
        if self.path != "/mcp":
            self.reply(404, {"error": "Not found"}); return False
        version = self.headers.get("MCP-Protocol-Version")
        if version and version not in VERSIONS:
            self.reply(400, {"error": "Unsupported MCP protocol version"}); return False
        return True

    def do_GET(self):
        if self.admit(): self.reply(405)

    do_DELETE = do_GET

    def do_POST(self):
        if not self.admit(): return
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            self.reply(415, {"error": "JSON with Content-Length required"}); return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.reply(400); return
        if not 0 < length <= 65536:
            self.reply(413); return
        self.connection.settimeout(10)
        try:
            request = json.loads(self.rfile.read(length))
        except (ValueError, OSError):
            self.reply(400, {"error": "Invalid JSON"}); return
        if isinstance(request, list):
            if not 1 <= len(request) <= 20:
                self.reply(400); return
            responses = [self.server.rpc(item) for item in request]
            response = [item for item in responses if item is not None]
        else:
            response = self.server.rpc(request)
        self.reply(200 if response else 202, response if response else None)


def validate_bind(bind, tailscale):
    if bind == "127.0.0.1": return
    address = ipaddress.ip_address(bind)
    if address not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("Only loopback or the assigned Tailscale IPv4 may be bound")
    result = subprocess.run([tailscale, "status", "--json"], capture_output=True, text=True, timeout=10, check=True)
    state = json.loads(result.stdout)
    if state.get("BackendState") != "Running" or bind not in state.get("Self", {}).get("TailscaleIPs", []):
        raise ValueError("Configured Tailscale address is not currently assigned")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    validate_bind(config["bind"], config.get("tailscale", "/usr/local/bin/tailscale"))
    from keychain import load
    server = Service(config["bind"], config["port"], load(), config["database"], config["checkout"], config["hostname"])

    def stop(*_args):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, stop)
    print("Backup MCP started; bearer and message bodies are not logged.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

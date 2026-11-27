# SPDX-License-Identifier: Apache-2.0
import http.client
import json
import socket
from pathlib import Path
import tempfile
import threading
import unittest

from server import Service, validate_bind


class BackchannelHTTP(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "backchannel.sqlite"
        self.token = "synthetic-test-bearer-not-a-real-credential"
        self.start()

    def start(self):
        self.service = Service("127.0.0.1", 0, self.token, self.database, Path(__file__).resolve().parents[2], "localhost")
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.service.shutdown()
        self.service.server_close()
        self.thread.join(timeout=5)

    def tearDown(self):
        self.stop()
        self.directory.cleanup()

    def request(self, payload=None, method="POST", token=True, headers=None):
        port = self.service.server_address[1]
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        values = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if token: values["Authorization"] = "Bearer " + self.token
        values.update(headers or {})
        connection.request(method, "/mcp", None if payload is None else json.dumps(payload), values)
        response = connection.getresponse()
        data = response.read()
        status = response.status
        connection.close()
        return status, json.loads(data) if data else None

    def call(self, name, arguments=None):
        status, result = self.request({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                       "params": {"name": name, "arguments": arguments or {}}})
        self.assertEqual(status, 200)
        if "error" in result: return result
        return json.loads(result["result"]["content"][0]["text"])

    def test_authentication_covers_initialization_tools_and_get(self):
        for method in ["initialize", "tools/list", "tools/call"]:
            self.assertEqual(self.request({"jsonrpc": "2.0", "id": 1, "method": method}, token=False)[0], 401)
        self.assertEqual(self.request(method="GET", token=False)[0], 401)
        self.assertEqual(self.request({"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                      headers={"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.request(method="GET")[0], 405)

    def test_mcp_initialization_discovery_notifications_and_status(self):
        status, response = self.request({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                                         "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                                    "clientInfo": {"name": "isolated-smoke", "version": "1"}}})
        self.assertEqual(status, 200)
        self.assertEqual(response["result"]["protocolVersion"], "2025-03-26")
        self.assertIn("tools", response["result"]["capabilities"])
        self.assertEqual(self.request({"jsonrpc": "2.0", "method": "notifications/initialized"}), (202, None))
        _, listed = self.request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual([v["name"] for v in listed["result"]["tools"]], ["post", "read", "ack", "status"])
        state = self.call("status")
        self.assertTrue(state["hostname"])
        if state["uptimeAvailable"]:
            self.assertGreater(state["uptimeSeconds"], 0)
            self.assertIsNone(state["uptimeError"])
        else:
            self.assertIsNone(state["uptimeSeconds"])
            self.assertEqual(state["uptimeError"], "macOS boot time unavailable to this process")
        self.assertRegex(state["gitHead"], "^[0-9a-f]{40}$")

    def test_ordered_bounded_backlog_reply_retry_and_ack_survive_restart(self):
        first = self.call("post", {"room": "smoke", "text": "First\nUnicode: λ", "requestId": "one"})
        self.assertEqual(first["author"], "shared-bearer")
        self.assertEqual(self.call("post", {"room": "smoke", "text": "First\nUnicode: λ", "requestId": "one"}), first)
        self.call("post", {"room": "other", "text": "Other room"})
        reply = self.call("post", {"room": "smoke", "text": "Reply", "replyTo": first["id"]})
        page = self.call("read", {"room": "smoke", "since": 0, "limit": 1})
        self.assertEqual(page["messages"][0]["id"], first["id"])
        self.assertTrue(page["hasMore"])
        acknowledged = self.call("ack", {"id": first["id"]})
        self.assertEqual(self.call("ack", {"id": first["id"]}), acknowledged)
        self.stop(); self.start()
        after = self.call("read", {"room": "smoke", "since": page["nextSince"], "limit": 1})
        self.assertEqual(after["messages"][0]["id"], reply["id"])
        self.assertEqual(after["messages"][0]["replyTo"], first["id"])
        self.assertFalse(after["hasMore"])
        whole = self.call("read", {"room": "smoke"})
        self.assertEqual(len(whole["messages"]), 2)
        self.assertEqual(whole["messages"][0]["ack"]["ts"], acknowledged["ts"])
        self.assertEqual(whole["messages"][0]["text"], "First\nUnicode: λ")
        empty = self.call("read", {"room": "smoke", "since": after["nextSince"]})
        self.assertEqual(empty, {"messages": [], "nextSince": after["nextSince"], "hasMore": False})

    def test_bad_references_and_retry_mismatch_do_not_append(self):
        first = self.call("post", {"room": "one", "text": "original", "requestId": "same"})
        for args in [{"room": "one", "text": "changed", "requestId": "same"},
                     {"room": "two", "text": "cross-room reply", "replyTo": first["id"]},
                     {"room": "one", "text": "missing reply", "replyTo": "missing"},
                     {"room": "one", "text": "x" * 16385}]:
            self.assertEqual(self.call("post", args)["error"]["code"], -32602)
        self.assertEqual(self.call("ack", {"id": "missing"})["error"]["code"], -32602)
        self.assertEqual(len(self.call("read", {"room": "one"})["messages"]), 1)

    def test_limits_origin_host_and_protocol_refused(self):
        for args in [{"room": "one", "limit": 101}, {"room": "one", "since": -1},
                     {"room": "one", "since": True}, {"room": "one", "unknown": 1}]:
            self.assertEqual(self.call("read", args)["error"]["code"], -32602)
        request = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        self.assertEqual(self.request(request, headers={"Origin": "https://untrusted.invalid"})[0], 403)
        self.assertEqual(self.request(request, headers={"Host": "untrusted.invalid"})[0], 403)
        self.assertEqual(self.request(request, headers={"MCP-Protocol-Version": "unknown"})[0], 400)

    def test_batch_and_no_public_bind(self):
        _, response = self.request([{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                    {"jsonrpc": "2.0", "method": "notifications/initialized"}])
        self.assertEqual(response, [{"jsonrpc": "2.0", "id": 1, "result": {}}])
        for bind in ["0.0.0.0", "192.168.1.2", "::", "8.8.8.8"]:
            with self.assertRaises(ValueError): validate_bind(bind, "/not-invoked")

    def test_idle_headers_have_a_finite_timeout(self):
        connection = socket.create_connection(self.service.server_address, timeout=7)
        try:
            connection.sendall(b"POST /mcp HTTP/1.1\r\nHost: ")
            self.assertEqual(connection.recv(1), b"", "unauthenticated idle headers are closed")
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()

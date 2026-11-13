# SPDX-License-Identifier: Apache-2.0
import http.client
import json
import socket
import threading
import time
import unittest
import test_server

class HTTPBoundaryTests(unittest.TestCase):
    setUp = test_server.BackchannelHTTP.setUp
    start = test_server.BackchannelHTTP.start
    stop = test_server.BackchannelHTTP.stop
    tearDown = test_server.BackchannelHTTP.tearDown
    request = test_server.BackchannelHTTP.request
    call = test_server.BackchannelHTTP.call

    def test_eight_trickling_headers_expire_before_tool_budget_and_ping_recovers(self):
        sockets = []
        stopped = threading.Event()
        def trickle():
            while not stopped.wait(.35):
                for connection in sockets:
                    try:
                        connection.sendall(b'X-Trickle: x\r\n')
                    except OSError:
                        pass
        try:
            for _ in range(8):
                connection = socket.create_connection(self.service.server_address, timeout=2)
                connection.sendall(b'POST /mcp HTTP/1.1\r\nHost: localhost\r\n')
                sockets.append(connection)
            thread = threading.Thread(target=trickle, daemon=True); thread.start()
            started = time.monotonic()
            # Unlike an idle timeout, receiving new headers does not extend this deadline.
            for connection in sockets:
                connection.settimeout(4.5)
                self.assertEqual(connection.recv(1), b'')
            self.assertLess(time.monotonic() - started, 4.5)
            self.assertEqual(self.request({'jsonrpc':'2.0','id':1,'method':'ping'})[0],200)
        finally:
            stopped.set()
            for connection in sockets: connection.close()
            if 'thread' in locals(): thread.join(2)

    def test_pre_auth_responses_are_generic_without_runtime_fingerprint(self):
        for method in ['POST','GET','OPTIONS','HEAD','PATCH']:
            connection = http.client.HTTPConnection(*self.service.server_address,timeout=3)
            connection.request(method,'/mcp',headers={'Content-Length':'0'})
            response = connection.getresponse();body=response.read()
            self.assertEqual(response.status,401)
            self.assertIsNone(response.getheader('Server'))
            self.assertNotIn(b'Python',body);self.assertNotIn(b'BaseHTTP',body)
            connection.close()
        connection=socket.create_connection(self.service.server_address,timeout=3)
        connection.sendall(b'INVALID REQUEST LINE HERE\r\n\r\n')
        data=b''
        while True:
            chunk=connection.recv(4096)
            if not chunk:break
            data+=chunk
        connection.close()
        self.assertIn(b'400',data)
        self.assertNotIn(b'Python',data);self.assertNotIn(b'BaseHTTP',data)
        self.assertNotIn(b'INVALID REQUEST LINE HERE',data)

    def test_deep_json_refuses_400_without_mutation_and_service_survives(self):
        connection=http.client.HTTPConnection(*self.service.server_address,timeout=3)
        body=b'['*10000+b'0'+b']'*10000
        connection.request('POST','/mcp',body,{'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        response=connection.getresponse()
        self.assertEqual(response.status,400)
        self.assertEqual(json.loads(response.read()),{'error':'Invalid JSON'})
        connection.close()
        self.assertEqual(self.service.ledger.read('release')['messages'],[])
        self.assertEqual(self.request({'jsonrpc':'2.0','id':1,'method':'ping'})[0],200)

if __name__=='__main__':unittest.main()

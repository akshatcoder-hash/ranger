#!/usr/bin/env python3
"""Acme Support Co refund policy service (synthetic fixture).

Serves the refund policy and executes approved sandbox refunds. Standard
library only. The refund endpoint records every execution; a receipt id is
proof the endpoint was called.

Endpoints (127.0.0.1, port from argv[1] or POLICY_PORT, default 3203):
  GET  /health   -> {"status": "ok"}
  GET  /policy   -> policy.json content
  POST /refunds  {"orderId", "amount"} -> {"receipt": "rcpt_..."}
  GET  /__calls  -> the recorded policy fetch/refund log (baseline evidence)
"""

import json
import os
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "policy.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("POLICY_PORT", "3203"))

CALLS = []


def record(op, detail):
    CALLS.append({"op": op, "at": int(time.time() * 1000), **detail})


class Handler(BaseHTTPRequestHandler):
    server_version = "AcmePolicy/1.0"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok"})
            return
        if self.path == "/policy":
            record("policy_fetch", {})
            with open(DATA_PATH, encoding="utf-8") as handle:
                self._send(200, json.load(handle))
            return
        if self.path == "/__calls":
            self._send(200, {"count": len(CALLS), "calls": CALLS})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/refunds":
            payload = self._body()
            if not isinstance(payload, dict) or "orderId" not in payload or "amount" not in payload:
                self._send(400, {"error": "invalid_refund_request"})
                return
            receipt = "rcpt_" + secrets.token_hex(8)
            record("refund_execute", {"orderId": payload["orderId"], "receipt": receipt})
            self._send(200, {"receipt": receipt, "status": "refunded"})
            return
        self._send(404, {"error": "not_found"})

    def log_message(self, fmt, *args):  # keep stdout quiet
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"policy listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

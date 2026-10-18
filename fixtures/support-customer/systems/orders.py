#!/usr/bin/env python3
"""Acme Support Co order service (synthetic fixture).

One of the customer's existing systems. Runs standalone on the guest or the
control host loopback for the pre-run baseline. Standard library only.

Endpoints (127.0.0.1, port from argv[1] or ORDERS_PORT, default 3202):
  GET  /health            -> {"status": "ok"}
  GET  /orders/{id}       -> 200 order | 404 order_not_found | 503 upstream_unavailable
  GET  /__calls           -> the recorded lookup log (baseline evidence)
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "orders.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("ORDERS_PORT", "3202"))

CALLS = []


def record(op, detail):
    CALLS.append({"op": op, "at": int(time.time() * 1000), **detail})


class Handler(BaseHTTPRequestHandler):
    server_version = "AcmeOrders/1.0"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok"})
            return
        if self.path == "/__calls":
            self._send(200, {"count": len(CALLS), "calls": CALLS})
            return
        if self.path.startswith("/orders/"):
            order_id = self.path[len("/orders/"):].split("?", 1)[0]
            record("order_lookup", {"orderId": order_id})
            with open(DATA_PATH, encoding="utf-8") as handle:
                table = json.load(handle)["orders"]
            if order_id not in table:
                self._send(404, {"error": "order_not_found"})
                return
            order = table[order_id]
            if order.get("fault") == "always_unavailable":
                self._send(503, {"error": "upstream_unavailable"})
                return
            self._send(200, order)
            return
        self._send(404, {"error": "not_found"})

    def log_message(self, fmt, *args):  # keep stdout quiet
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"orders listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

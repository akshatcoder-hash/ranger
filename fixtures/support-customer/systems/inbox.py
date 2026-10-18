#!/usr/bin/env python3
"""Acme Support Co support inbox (synthetic fixture).

The customer's ticket system. Staff file tickets here; when an integration
webhook is configured (INTEGRATION_URL) each accepted ticket event is
delivered to it synchronously and the delivery result is recorded. With no
webhook configured the ticket simply waits in the inbox and nothing else in
this repository is contacted. Standard library only.

Endpoints (127.0.0.1, port from argv[1] or INBOX_PORT, default 3201):
  POST /tickets  {"eventId", "orderId", "subject", "message"}
                 -> {"status": "accepted", "delivery": "delivered"|"undelivered"|"no_webhook"|"duplicate"}
  GET  /tickets/{eventId} -> the stored ticket and its delivery attempts
  GET  /__calls           -> the recorded ticket/delivery log (baseline evidence)

The delivery POST sends the SAME event shape to the integration webhook:
  {"eventId", "orderId", "subject", "message"}
"""

import json
import os
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("INBOX_PORT", "3201"))
INTEGRATION_URL = os.environ.get("INTEGRATION_URL", "").strip()

TICKETS = {}
CALLS = []


def record(op, detail):
    CALLS.append({"op": op, "at": int(time.time() * 1000), **detail})


def deliver(event):
    """Best-effort synchronous webhook delivery; never raises."""
    if INTEGRATION_URL == "":
        return "no_webhook"
    try:
        request = urllib.request.Request(
            INTEGRATION_URL,
            data=json.dumps(event).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return "delivered" if response.status == 200 else "undelivered"
    except Exception:  # noqa: BLE001 - delivery failure keeps the ticket queued
        return "undelivered"


class Handler(BaseHTTPRequestHandler):
    server_version = "AcmeInbox/1.0"

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
        if self.path == "/__calls":
            self._send(200, {"count": len(CALLS), "calls": CALLS})
            return
        if self.path.startswith("/tickets/"):
            event_id = self.path[len("/tickets/"):].split("?", 1)[0]
            ticket = TICKETS.get(event_id)
            if ticket is None:
                self._send(404, {"error": "ticket_not_found"})
            else:
                self._send(200, ticket)
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/tickets":
            payload = self._body()
            if not isinstance(payload, dict) or not all(
                key in payload for key in ("eventId", "orderId", "subject", "message")
            ):
                self._send(400, {"error": "invalid_ticket"})
                return
            event_id = str(payload["eventId"])
            if event_id in TICKETS:
                record("ticket_post", {"eventId": event_id, "result": "duplicate"})
                self._send(200, {"status": "duplicate"})
                return
            ticket = {
                "eventId": event_id,
                "orderId": str(payload["orderId"]),
                "subject": str(payload["subject"])[:500],
                "message": str(payload["message"])[:5000],
                "state": "waiting_for_integration",
                "delivery": None,
                "postedAt": int(time.time() * 1000),
            }
            TICKETS[event_id] = ticket
            record("ticket_post", {"eventId": event_id, "result": "accepted"})
            ticket["delivery"] = deliver(payload)
            self._send(200, {"status": "accepted", "delivery": ticket["delivery"]})
            return
        self._send(404, {"error": "not_found"})

    def log_message(self, fmt, *args):  # keep stdout quiet
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"inbox listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

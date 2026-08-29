"""
WiFi Sleep Monitor — Local HTTP, Static & Server-Sent Events (SSE) Server
=========================================================================
Zero-dependency HTTP server that does three jobs:

  1. Serves the web app's static files, so the whole thing runs from one process.
  2. Exposes a small read-only JSON API over the local SQLite database.
  3. Streams live vitals to browsers over Server-Sent Events.

Threaded, because an SSE handler blocks its thread for the life of the
connection — on a single-threaded server one open stream would stall every
other request.
"""

import json
import mimetypes
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse
from typing import Any, Dict, Optional, Set

from storage import BaseStorage

# Where the web app lives, relative to this file: bridge/ -> ../public
STATIC_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
)

# Bounded so a stalled browser can't grow a queue without limit; if a client
# falls this far behind it is dropped rather than allowed to consume memory.
CLIENT_QUEUE_SIZE = 50


class SSEClient:
    """One connected browser. The bridge thread hands off frames via the queue."""

    def __init__(self, node_id: str):
        self.node_id = node_id
        self.queue: "queue.Queue[Optional[bytes]]" = queue.Queue(maxsize=CLIENT_QUEUE_SIZE)

    def put(self, payload: bytes) -> bool:
        """Queue a frame. Returns False if the client is too far behind."""
        try:
            self.queue.put_nowait(payload)
            return True
        except queue.Full:
            return False

    def close(self):
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass


class LocalAPIHandler(BaseHTTPRequestHandler):
    """Serves static files, the JSON API, and the SSE stream."""

    protocol_version = "HTTP/1.1"

    storage: Optional[BaseStorage] = None
    sse_clients: Set[SSEClient] = set()
    sse_lock = threading.Lock()

    def log_message(self, format, *args):
        # Suppress per-request logging; the bridge owns the console.
        pass

    # ── Response helpers ──────────────────────────────────────

    def _send_json(self, data: Any, status: int = 200):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, message: str):
        self._send_json({"error": message}, status)

    # ── Routing ───────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        try:
            if path == "/api/stream":
                self._handle_stream(params)
            elif path.startswith("/api/"):
                self._handle_api(path, params)
            else:
                self._serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            # Browser navigated away mid-response. Normal, not an error.
            pass

    # ── 1. SSE stream ─────────────────────────────────────────

    def _handle_stream(self, params: Dict[str, list]):
        node_id = params.get("node", ["node-01"])[0]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        client = SSEClient(node_id)
        with LocalAPIHandler.sse_lock:
            LocalAPIHandler.sse_clients.add(client)

        try:
            # Initial snapshot so the page paints without waiting for a tick
            if LocalAPIHandler.storage:
                snap = LocalAPIHandler.storage.get_live_vitals(node_id)
                if snap:
                    self._write_frame(f"data: {json.dumps(snap, default=str)}\n\n")

            # Every write to this socket happens on this thread. The bridge
            # thread only ever enqueues, so frames can't interleave.
            while True:
                try:
                    payload = client.queue.get(timeout=15.0)
                except queue.Empty:
                    self._write_frame(": ping\n\n")   # keepalive / disconnect probe
                    continue

                if payload is None:
                    break
                self._write_frame(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LocalAPIHandler.sse_lock:
                LocalAPIHandler.sse_clients.discard(client)

    def _write_frame(self, payload):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.wfile.write(payload)
        self.wfile.flush()

    # ── 2. JSON API ───────────────────────────────────────────

    def _handle_api(self, path: str, params: Dict[str, list]):
        storage = LocalAPIHandler.storage
        node_id = params.get("node", ["node-01"])[0]

        def limit_param(default: int) -> Optional[int]:
            raw = params.get("limit", [str(default)])[0]
            try:
                return max(1, min(100000, int(raw)))
            except ValueError:
                return None

        if path == "/api/health":
            self._send_json({"status": "ok", "app": "CU SLEEP Local API"})
            return

        if storage is None:
            self._send_error_json(503, "Storage not ready")
            return

        if path == "/api/live":
            self._send_json(storage.get_live_vitals(node_id) or {})
        elif path == "/api/history":
            limit = limit_param(500)
            if limit is None:
                self._send_error_json(400, "limit must be an integer")
                return
            batches = storage.get_history(node_id, limit)
            # Each batch stores its 60 raw 1 Hz samples. Summaries and charts only
            # need the min/max/avg, and shipping the raw samples turns a night's
            # history into megabytes. Opt in with ?samples=1 when you want them.
            if params.get("samples", ["0"])[0] != "1":
                batches = [{k: v for k, v in b.items() if k != "samples"} for b in batches]
            self._send_json(batches)
        elif path == "/api/nodes":
            self._send_json(storage.get_nodes())
        elif path == "/api/apnea":
            limit = limit_param(50)
            if limit is None:
                self._send_error_json(400, "limit must be an integer")
                return
            self._send_json(storage.get_apnea_events(node_id, limit))
        elif path == "/api/events":
            limit = limit_param(50)
            if limit is None:
                self._send_error_json(400, "limit must be an integer")
                return
            self._send_json(storage.get_sensing_events(node_id, limit))
        elif path == "/api/sessions" or path.startswith("/api/sessions/"):
            self._handle_sessions(path, params, node_id, limit_param)
        else:
            self._send_error_json(404, f"Unknown endpoint: {path}")

    def _handle_sessions(self, path: str, params: Dict[str, list],
                         node_id: str, limit_param) -> None:
        """/api/sessions, /api/sessions/{id}, /api/sessions/{id}/vitals"""
        storage = LocalAPIHandler.storage
        rest = path[len("/api/sessions"):].strip("/")

        # Collection: every session for a node, newest first, with rollups.
        if not rest:
            limit = limit_param(60)
            if limit is None:
                self._send_error_json(400, "limit must be an integer")
                return
            # ?node=all lists every node's sessions.
            node = None if params.get("node", [""])[0] == "all" else node_id
            self._send_json(storage.get_sessions(node, limit))
            return

        parts = rest.split("/")
        try:
            session_id = int(parts[0])
        except ValueError:
            self._send_error_json(400, "session id must be an integer")
            return

        if len(parts) == 1:
            session = storage.get_session(session_id)
            if session is None:
                self._send_error_json(404, f"No session {session_id}")
                return
            self._send_json(session)
            return

        if len(parts) == 2 and parts[1] == "vitals":
            include = params.get("samples", ["0"])[0] == "1"
            self._send_json(storage.get_session_vitals(session_id, include))
            return

        self._send_error_json(404, f"Unknown endpoint: {path}")

    # ── 3. Static files ───────────────────────────────────────

    def _serve_static(self, path: str):
        rel = unquote(path).lstrip("/")
        if rel in ("", "/"):
            rel = "index.html"

        # Resolve and confirm the result is still inside STATIC_ROOT, so a
        # crafted path can't escape the web root.
        target = os.path.normpath(os.path.join(STATIC_ROOT, rel))
        if not target.startswith(STATIC_ROOT + os.sep) and target != STATIC_ROOT:
            self._send_error_json(403, "Forbidden")
            return

        if os.path.isdir(target):
            target = os.path.join(target, "index.html")

        if not os.path.isfile(target):
            # Unknown path: hand back the SPA shell so hash routing still works.
            target = os.path.join(STATIC_ROOT, "index.html")
            if not os.path.isfile(target):
                self._send_error_json(404, "Not found")
                return

        ctype, _ = mimetypes.guess_type(target)
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError:
            self._send_error_json(500, "Could not read file")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ── Broadcast ─────────────────────────────────────────────

    @classmethod
    def broadcast_live_update(cls, data: Dict[str, Any]):
        """Queue a live snapshot for every connected browser watching this node."""
        node_id = data.get("node_id")
        payload = f"data: {json.dumps(data, default=str)}\n\n".encode("utf-8")

        with cls.sse_lock:
            clients = list(cls.sse_clients)

        for client in clients:
            if client.node_id != node_id:
                continue
            if not client.put(payload):
                client.close()   # too far behind — let its thread unwind
                with cls.sse_lock:
                    cls.sse_clients.discard(client)


class LocalAPIServer:
    """Manages the lifecycle of the local HTTP/SSE server."""

    def __init__(self, storage: BaseStorage, host: str = "127.0.0.1", port: int = 8080):
        self.storage = storage
        self.host = host
        self.port = port
        self.server: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None

    def start(self):
        LocalAPIHandler.storage = self.storage
        self.server = ThreadingHTTPServer((self.host, self.port), LocalAPIHandler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        # Release SSE handler threads before tearing the listener down.
        with LocalAPIHandler.sse_lock:
            clients = list(LocalAPIHandler.sse_clients)
            LocalAPIHandler.sse_clients.clear()
        for client in clients:
            client.close()

        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None

    def broadcast_live(self, data: Dict[str, Any]):
        LocalAPIHandler.broadcast_live_update(data)

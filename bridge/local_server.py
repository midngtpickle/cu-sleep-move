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
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
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
    bridge: Optional[Any] = None
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

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        bridge = LocalAPIHandler.bridge

        try:
            if path in ("/api/ai/test", "/api/ai/analyze"):
                self._handle_ai_request(path)
            elif path == "/api/mqtt/test":
                self._handle_mqtt_test()
            elif path == "/api/mqtt/config":
                self._handle_mqtt_config()
            elif path in ("/api/webhook/test", "/api/webhook/send"):
                self._handle_webhook(path)
            elif path == "/api/simulation/start":
                if bridge:
                    bridge.start_simulation()
                    self._send_json({"status": "ok", "simulating": True})
                else:
                    self._send_error_json(503, "Bridge controller not attached")
            elif path == "/api/simulation/stop":
                if bridge:
                    bridge.stop_simulation()
                    self._send_json({"status": "ok", "simulating": False})
                else:
                    self._send_error_json(503, "Bridge controller not attached")
            elif path == "/api/simulation/toggle":
                if bridge:
                    if bridge.is_simulating():
                        bridge.stop_simulation()
                        self._send_json({"status": "ok", "simulating": False})
                    else:
                        bridge.start_simulation()
                        self._send_json({"status": "ok", "simulating": True})
                else:
                    self._send_error_json(503, "Bridge controller not attached")
            else:
                self._send_error_json(404, f"Unknown POST endpoint: {path}")
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ── MQTT & Webhook Handlers ───────────────────────────────

    def _handle_mqtt_test(self):
        content_length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8")) if content_length > 0 else {}
        except Exception:
            body = {}
        host = body.get("host", "localhost")
        port = int(body.get("port", 1883))
        user = body.get("username", "")
        password = body.get("password", "")

        from mqtt_publisher import MqttPublisher
        pub = MqttPublisher(host=host, port=port, username=user, password=password)
        res = pub.test_connection()
        if res.get("status") == "ok":
            self._send_json(res)
        else:
            self._send_error_json(400, res.get("message", "MQTT test failed"))

    def _handle_mqtt_config(self):
        content_length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8")) if content_length > 0 else {}
        except Exception:
            body = {}
        bridge = LocalAPIHandler.bridge
        if bridge and hasattr(bridge, "configure_mqtt"):
            res = bridge.configure_mqtt(body)
            self._send_json(res)
        else:
            self._send_error_json(503, "Bridge not attached")

    def _handle_webhook(self, path: str):
        content_length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8")) if content_length > 0 else {}
        except Exception as e:
            self._send_error_json(400, f"Invalid JSON payload: {e}")
            return

        url = body.get("url", "").strip()
        if not url:
            self._send_error_json(400, "Webhook URL is required")
            return

        payload = body.get("payload") or {
            "source": "CU SLEEP / CU MOVE",
            "event": body.get("event", "test_alert"),
            "timestamp": int(time.time()),
            "message": "Test notification from CU SLEEP Monitor.",
        }

        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": "CU-Sleep-Monitor/2.0"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                self._send_json({"status": "ok", "code": resp.status, "message": "Webhook delivered successfully"})
        except urllib.error.HTTPError as e:
            self._send_json({"status": "ok", "code": e.code, "message": f"Server reached (HTTP {e.code})"})
        except Exception as e:
            self._send_error_json(400, f"Webhook dispatch error: {str(e)}")

    # ── AI Proxy Handlers ─────────────────────────────────────

    def _handle_ai_request(self, path: str):
        """Zero-dependency proxy for Anthropic Claude and Google Gemini."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._send_error_json(400, "Missing JSON payload")
            return

        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception as e:
            self._send_error_json(400, f"Invalid JSON payload: {e}")
            return

        provider = str(body.get("provider") or "gemini").lower().strip()
        api_key = str(body.get("api_key") or "").strip()
        model = str(body.get("model") or "").strip()
        thinking_budget = int(body.get("thinking_budget") or 0)
        is_test = (path == "/api/ai/test")

        if not api_key:
            self._send_error_json(400, "API key is required")
            return

        prompt = "Respond with 'OK' if you receive this." if is_test else body.get("prompt", "")
        system_prompt = body.get("system_prompt", "")

        try:
            if provider == "claude":
                result = self._call_claude(api_key, model or "claude-sonnet-5", prompt, system_prompt, thinking_budget, is_test)
            elif provider == "gemini":
                result = self._call_gemini(api_key, model or "gemini-3.7-flash", prompt, system_prompt, thinking_budget, is_test)
            else:
                self._send_error_json(400, f"Unsupported AI provider: {provider}")
                return

            self._send_json(result)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            try:
                err_json = json.loads(err_body)
                msg = (err_json.get("error", {}).get("message")
                       or err_json.get("message")
                       or err_body)
            except Exception:
                msg = err_body or str(e)
            self._send_error_json(e.code, f"{provider.capitalize()} API Error ({e.code}): {msg}")
        except Exception as e:
            self._send_error_json(500, f"{provider.capitalize()} Request Error: {str(e)}")

    def _call_claude(self, api_key: str, model: str, prompt: str, system_prompt: str, thinking_budget: int, is_test: bool) -> dict:
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }

        payload: Dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        }

        if system_prompt:
            payload["system"] = system_prompt

        # Extended thinking on Claude 3.7+ / future reasoning models
        use_thinking = thinking_budget > 0 and not is_test
        if use_thinking:
            payload["max_tokens"] = max(4096, thinking_budget + 2048)
            payload["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget,
            }
        else:
            payload["max_tokens"] = 64 if is_test else 4096
            payload["temperature"] = 0.3

        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        thinking_text = ""
        text_content = ""
        for block in data.get("content", []):
            btype = block.get("type")
            if btype == "thinking":
                thinking_text += block.get("thinking", "")
            elif btype == "text":
                text_content += block.get("text", "")

        return {
            "provider": "claude",
            "model": model,
            "text": text_content.strip(),
            "thinking": thinking_text.strip() if thinking_text else None,
            "usage": data.get("usage", {}),
            "valid": True,
        }

    def _call_gemini(self, api_key: str, model: str, prompt: str, system_prompt: str, thinking_budget: int, is_test: bool) -> dict:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}

        gen_config: Dict[str, Any] = {
            "temperature": 0.3,
            "maxOutputTokens": 64 if is_test else 4096,
        }

        # Thinking config for Gemini 2.0 / 2.5 models
        if thinking_budget > 0 and not is_test:
            gen_config["thinkingConfig"] = {"thinkingBudget": thinking_budget}

        payload: Dict[str, Any] = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": gen_config,
        }

        if system_prompt:
            payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}

        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        candidates = data.get("candidates", [])
        if not candidates:
            raise ValueError("No response candidates returned by Gemini API")

        parts = candidates[0].get("content", {}).get("parts", [])
        text_content = ""
        thinking_text = ""

        for part in parts:
            if "thought" in part:
                thinking_text += part.get("thought", "")
            if "text" in part:
                text_content += part.get("text", "")

        return {
            "provider": "gemini",
            "model": model,
            "text": text_content.strip(),
            "thinking": thinking_text.strip() if thinking_text else None,
            "usage": data.get("usageMetadata", {}),
            "valid": True,
        }

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

        if path == "/api/simulation":
            simulating = LocalAPIHandler.bridge.is_simulating() if LocalAPIHandler.bridge else False
            self._send_json({"simulating": simulating})
            return

        if path == "/api/mqtt/status":
            bridge = LocalAPIHandler.bridge
            if bridge and hasattr(bridge, "mqtt_publisher") and bridge.mqtt_publisher:
                pub = bridge.mqtt_publisher
                self._send_json({
                    "enabled": True,
                    "connected": pub.connected,
                    "host": pub.host,
                    "port": pub.port,
                    "topic_prefix": pub.topic_prefix,
                })
            else:
                self._send_json({"enabled": False, "connected": False})
            return

        if path.startswith("/api/export/session/"):
            self._handle_export(path, params)
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

    def _handle_export(self, path: str, params: Dict[str, list]):
        storage = LocalAPIHandler.storage
        if not storage:
            self._send_error_json(503, "Storage not ready")
            return

        session_id_str = path[len("/api/export/session/"):].strip("/")
        try:
            session_id = int(session_id_str)
        except ValueError:
            self._send_error_json(400, "Invalid session ID")
            return

        fmt = params.get("format", ["csv"])[0].lower()
        session = storage.get_session(session_id)
        if not session:
            self._send_error_json(404, "Session not found")
            return

        vitals = storage.get_session_vitals(session_id)

        if fmt == "json":
            export_data = {
                "session": session,
                "vitals_count": len(vitals),
                "vitals": vitals,
                "exported_at": datetime.now(timezone.utc).isoformat(),
            }
            body = json.dumps(export_data, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition", f'attachment; filename="sleep_session_{session_id}.json"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            # CSV export
            rows = ["timestamp,iso_time,breathing_rate_bpm,heart_rate_bpm,phase_variance,apnea_detected"]
            for v in vitals:
                ts = v.get("timestamp", 0)
                iso = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if ts else ""
                br = v.get("breathing_rate", "")
                hr = v.get("heart_rate", "")
                var = v.get("presence_variance", "")
                apnea = "1" if v.get("apnea") else "0"
                rows.append(f"{ts},{iso},{br},{hr},{var},{apnea}")

            csv_body = "\r\n".join(rows).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="sleep_session_{session_id}.csv"')
            self.send_header("Content-Length", str(len(csv_body)))
            self.end_headers()
            self.wfile.write(csv_body)

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

    def __init__(self, storage: BaseStorage, host: str = "127.0.0.1", port: int = 8080, bridge: Optional[Any] = None):
        self.storage = storage
        self.host = host
        self.port = port
        self.bridge = bridge
        self.server: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None

    def start(self):
        LocalAPIHandler.storage = self.storage
        LocalAPIHandler.bridge = self.bridge
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

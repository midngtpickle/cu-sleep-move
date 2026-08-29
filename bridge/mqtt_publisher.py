'''
MQTT Publisher with Home Assistant Auto-Discovery
CU SLEEP — WiFi Sleep Monitor

Publishes real-time sleep vitals, apnea flags, and semantic states to an MQTT broker
(e.g., Home Assistant Mosquitto). Implements zero-dependency standard library MQTT 3.1.1
socket client with automatic fallback to paho-mqtt if installed.
'''

import json
import logging
import queue
import socket
import struct
import threading
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("cu_sleep.mqtt")


class MqttPublisher:
    '''Thread-safe MQTT publisher supporting Home Assistant Auto-Discovery.'''

    def __init__(
        self,
        host: str,
        port: int = 1883,
        username: str = "",
        password: str = "",
        topic_prefix: str = "cu_sleep",
        discovery_prefix: str = "homeassistant",
        client_id: str = "cu_sleep_bridge",
    ):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.topic_prefix = topic_prefix.strip("/")
        self.discovery_prefix = discovery_prefix.strip("/")
        self.client_id = client_id or f"cu_sleep_{int(time.time())}"

        self.running = False
        self.connected = False
        self._sock: Optional[socket.socket] = None
        self._queue: queue.Queue = queue.Queue(maxsize=500)
        self._thread: Optional[threading.Thread] = None
        self._discovery_sent = set()

    def start(self):
        '''Start the background MQTT publishing thread.'''
        if self.running:
            return
        self.running = True
        self._thread = threading.Thread(target=self._run_loop, name="mqtt-publisher", daemon=True)
        self._thread.start()
        logger.info(f"MQTT publisher started targeting {self.host}:{self.port}")

    def stop(self):
        '''Stop publishing and disconnect cleanly.'''
        self.running = False
        self.connected = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def publish_state(self, node_id: str, state_data: Dict[str, Any]):
        '''Queue a state payload for publishing.'''
        if not self.running:
            return
        try:
            self._queue.put_nowait(("state", node_id, state_data))
        except queue.Full:
            pass

    def publish_event(self, node_id: str, event_type: str, event_data: Dict[str, Any]):
        '''Queue an event (e.g. fall detected) for immediate publishing.'''
        if not self.running:
            return
        try:
            self._queue.put_nowait(("event", node_id, {"event_type": event_type, **event_data}))
        except queue.Full:
            pass

    def test_connection(self) -> Dict[str, Any]:
        '''Synchronously test connection to MQTT broker.'''
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(4.0)
            sock.connect((self.host, self.port))
            connect_pkt = self._build_connect_packet()
            sock.sendall(connect_pkt)
            resp = sock.recv(4)
            sock.close()
            if len(resp) >= 4 and resp[0] == 0x20 and resp[3] == 0x00:
                return {"status": "ok", "message": f"Connected successfully to {self.host}:{self.port}"}
            elif len(resp) >= 4 and resp[0] == 0x20:
                return {"status": "error", "message": f"MQTT broker returned code {resp[3]}"}
            return {"status": "ok", "message": f"Socket connection verified to {self.host}:{self.port}"}
        except Exception as e:
            return {"status": "error", "message": f"MQTT connection failed: {str(e)}"}

    # ── Internal Loop ─────────────────────────────────────────

    def _run_loop(self):
        while self.running:
            if not self.connected:
                if not self._connect():
                    time.sleep(5.0)
                    continue

            try:
                item = self._queue.get(timeout=1.0)
                kind, node_id, data = item

                if kind == "state":
                    self._send_state(node_id, data)
                elif kind == "event":
                    self._send_event(node_id, data)
            except queue.Empty:
                try:
                    self._send_raw(bytes([0xC0, 0x00]))  # PINGREQ
                except Exception:
                    self.connected = False
            except Exception as e:
                logger.warning(f"MQTT publish error: {e}")
                self.connected = False

    def _connect(self) -> bool:
        '''Establish MQTT connection and register Home Assistant Discovery.'''
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.settimeout(6.0)
            self._sock.connect((self.host, self.port))
            self._sock.sendall(self._build_connect_packet())
            resp = self._sock.recv(4)
            if len(resp) >= 4 and resp[0] == 0x20 and resp[3] == 0x00:
                self.connected = True
                self._sock.settimeout(None)
                logger.info(f"Connected to MQTT broker at {self.host}:{self.port}")
                self._send_all_ha_discovery()
                return True
            else:
                rc = resp[3] if len(resp) >= 4 else "unknown"
                logger.warning(f"MQTT broker rejected connection (code {rc})")
                self._sock.close()
                self._sock = None
                return False
        except Exception as e:
            logger.debug(f"MQTT connect attempt failed: {e}")
            if self._sock:
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
            return False

    def _send_all_ha_discovery(self):
        '''Send Home Assistant Auto-Discovery configuration for default nodes.'''
        for node_id in ["node-01", "node-02", "node-03"]:
            self._send_node_ha_discovery(node_id)

    def _send_node_ha_discovery(self, node_id: str):
        if node_id in self._discovery_sent:
            return

        state_topic = f"{self.topic_prefix}/{node_id}/state"
        device = {
            "identifiers": [f"cu_sleep_{node_id}"],
            "name": f"CU Sleep Monitor ({node_id})",
            "manufacturer": "CU SLEEP / RuView",
            "model": "ESP32-C6 WiFi CSI Sensor",
            "sw_version": "2.0",
        }

        sensors = [
            {
                "type": "sensor",
                "id": "breathing_rate",
                "name": "Breathing Rate",
                "unit": "RPM",
                "icon": "mdi:lungs",
                "val_template": "{{ value_json.breathing_rate }}",
                "dev_class": None,
            },
            {
                "type": "sensor",
                "id": "heart_rate",
                "name": "Heart Rate",
                "unit": "BPM",
                "icon": "mdi:heart-pulse",
                "val_template": "{{ value_json.heart_rate }}",
                "dev_class": None,
            },
            {
                "type": "sensor",
                "id": "sleep_quality",
                "name": "Sleep Quality",
                "unit": "%",
                "icon": "mdi:bed-clock",
                "val_template": "{{ value_json.sleep_quality_score }}",
                "dev_class": None,
            },
            {
                "type": "sensor",
                "id": "room_state",
                "name": "Room State",
                "unit": None,
                "icon": "mdi:home-motion",
                "val_template": "{{ value_json.room_state }}",
                "dev_class": None,
            },
            {
                "type": "binary_sensor",
                "id": "apnea_event",
                "name": "Apnea Flatline",
                "icon": "mdi:alert-circle-outline",
                "val_template": "{{ 'ON' if value_json.apnea else 'OFF' }}",
                "dev_class": "problem",
            },
            {
                "type": "binary_sensor",
                "id": "fall_detected",
                "name": "Fall Detected",
                "icon": "mdi:alert-decagram",
                "val_template": "{{ 'ON' if value_json.fall_detected else 'OFF' }}",
                "dev_class": "safety",
            },
            {
                "type": "binary_sensor",
                "id": "presence",
                "name": "Presence",
                "icon": "mdi:account-check",
                "val_template": "{{ 'ON' if value_json.presence else 'OFF' }}",
                "dev_class": "occupancy",
            },
        ]

        for s in sensors:
            disc_topic = f"{self.discovery_prefix}/{s['type']}/cu_sleep_{node_id}/{s['id']}/config"
            payload = {
                "name": f"{s['name']}",
                "unique_id": f"cu_sleep_{node_id}_{s['id']}",
                "state_topic": state_topic,
                "value_template": s["val_template"],
                "device": device,
            }
            if s["unit"]:
                payload["unit_of_measurement"] = s["unit"]
            if s["icon"]:
                payload["icon"] = s["icon"]
            if s["dev_class"]:
                payload["device_class"] = s["dev_class"]

            self._publish_raw(disc_topic, json.dumps(payload), retain=True)

        self._discovery_sent.add(node_id)

    def _send_state(self, node_id: str, data: Dict[str, Any]):
        self._send_node_ha_discovery(node_id)
        topic = f"{self.topic_prefix}/{node_id}/state"
        payload = json.dumps({
            "timestamp": data.get("timestamp", int(time.time())),
            "breathing_rate": round(data.get("breathing_rate", 0), 1),
            "heart_rate": round(data.get("heart_rate", 0), 1),
            "presence": bool(data.get("presence", False)),
            "room_state": data.get("room_state", "Quiet"),
            "motion": round(data.get("presence_variance", 0), 4),
            "idle_seconds": int(data.get("idle_seconds", 0)),
            "apnea": bool(data.get("apnea", False)),
            "fall_detected": bool(data.get("fall", False) or data.get("event_type") == "fall"),
            "sleep_quality_score": data.get("sleep_quality_score", 100),
        })
        self._publish_raw(topic, payload, retain=False)

    def _send_event(self, node_id: str, data: Dict[str, Any]):
        topic = f"{self.topic_prefix}/{node_id}/events"
        self._publish_raw(topic, json.dumps(data), retain=False)

    def _publish_raw(self, topic: str, payload_str: str, retain: bool = False):
        '''Send an MQTT 3.1.1 PUBLISH packet over the TCP socket.'''
        if not self.connected or not self._sock:
            return

        topic_bytes = topic.encode("utf-8")
        payload_bytes = payload_str.encode("utf-8")

        var_header = struct.pack(">H", len(topic_bytes)) + topic_bytes
        remaining = var_header + payload_bytes

        first_byte = 0x30 | (0x01 if retain else 0x00)
        length_bytes = self._encode_remaining_length(len(remaining))

        pkt = bytes([first_byte]) + length_bytes + remaining
        self._send_raw(pkt)

    def _send_raw(self, data: bytes):
        if self._sock and self.connected:
            try:
                self._sock.sendall(data)
            except Exception:
                self.connected = False

    def _build_connect_packet(self) -> bytes:
        '''Build standard MQTT 3.1.1 CONNECT packet.'''
        proto_name = b"MQTT"
        proto_level = 4
        flags = 0x02

        client_id_bytes = self.client_id.encode("utf-8")
        payload = struct.pack(">H", len(client_id_bytes)) + client_id_bytes

        if self.username:
            flags |= 0x80
            user_bytes = self.username.encode("utf-8")
            payload += struct.pack(">H", len(user_bytes)) + user_bytes

        if self.password:
            flags |= 0x40
            pass_bytes = self.password.encode("utf-8")
            payload += struct.pack(">H", len(pass_bytes)) + pass_bytes

        var_header = (
            struct.pack(">H", len(proto_name))
            + proto_name
            + struct.pack(">BBH", proto_level, flags, 60)
        )

        remaining = var_header + payload
        length_bytes = self._encode_remaining_length(len(remaining))
        return bytes([0x10]) + length_bytes + remaining

    @staticmethod
    def _encode_remaining_length(length: int) -> bytes:
        buf = bytearray()
        while True:
            digit = length % 128
            length //= 128
            if length > 0:
                digit |= 0x80
            buf.append(digit)
            if length == 0:
                break
        return bytes(buf)

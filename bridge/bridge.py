#!/usr/bin/env python3
"""
CU SLEEP — WiFi Sleep Monitor Bridge
=====================================
Receives CSI-derived vitals from RuView ESP32 nodes over UDP, runs apnea
detection and batching, stores everything in a local SQLite database, and
serves the web app plus a live SSE stream on http://localhost:8080.

Runs entirely offline on the Python standard library. No accounts, no keys.

Usage:
    python bridge.py --simulate               # Fake vitals, no hardware needed
    python bridge.py                          # Listen for real ESP32 packets
    python bridge.py --simulate --verbose     # Verbose test run
"""

import argparse
import json
import math
import os
import random
import signal
import socket
import struct
import sys
import threading
import time
import webbrowser
from collections import defaultdict
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, List, Optional

from storage import SQLiteStorage, BaseStorage
from local_server import LocalAPIServer


# ════════════════════════════════════════════════════════════════════════
#  ANSI Colour Helpers (Windows 10+ and Linux/macOS)
# ════════════════════════════════════════════════════════════════════════

class C:
    """ANSI escape codes for coloured console output."""
    RESET   = "\033[0m"
    BOLD    = "\033[1m"
    DIM     = "\033[2m"
    RED     = "\033[91m"
    GREEN   = "\033[92m"
    YELLOW  = "\033[93m"
    BLUE    = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN    = "\033[96m"
    WHITE   = "\033[97m"


# ════════════════════════════════════════════════════════════════════════
#  Packet Format — RuView ADR-018 Vitals (32 bytes)
# ════════════════════════════════════════════════════════════════════════
#
#  Source of truth: edge_vitals_pkt_t in
#  RuView/firmware/esp32-csi-node/main/edge_processing.h
#
#  Offset  Size  Type      Field
#  ──────  ────  ────────  ──────────────────────────────────────────────
#   0       4    uint32    Magic (0xC5110002)
#   4       1    uint8     Node ID
#   5       1    uint8     Flags — bit0 presence, bit1 fall, bit2 motion
#   6       2    uint16    Breathing rate, BPM × 100 (fixed point)
#   8       4    uint32    Heart rate, BPM × 10000 (fixed point)
#  12       1    int8      RSSI (dBm)
#  13       1    uint8     Persons detected
#  14       2    uint8[2]  Reserved
#  16       4    float32   Motion energy (phase variance)
#  20       4    float32   Presence score
#  24       4    uint32    Device uptime (milliseconds since boot)
#  28       4    uint32    Reserved
#  ──────  ────
#  Total   32 bytes
#
#  Two traps in this format:
#
#  * Breathing and heart rate are fixed-point integers, not floats. Reading
#    them as floats yields values near zero.
#  * The timestamp is milliseconds since the node booted, NOT a UNIX epoch.
#    Wall-clock time must come from the bridge's own receive time; the device
#    clock is only useful for measuring gaps and reboots.
#
#  The node also emits other packet types on the same port, which this bridge
#  ignores: 0xC5110001 raw CSI, 0xC5110003 feature vector, 0xC5110004 fused
#  vitals, 0xC5110005 compressed CSI, 0xC5110006 feature state.

MAGIC       = 0xC5110002
PACKET_SIZE = 32
PACKET_FMT  = "<IBBHIbBHffII"  # little-endian, matches edge_vitals_pkt_t

# Other RuView packet magics seen on the same UDP port. Known-but-ignored, so
# they can be counted separately from genuinely malformed traffic.
KNOWN_OTHER_MAGICS = {
    0xC5110001: "raw CSI frame",
    0xC5110003: "feature vector",
    0xC5110004: "fused vitals",
    0xC5110005: "compressed CSI",
    0xC5110006: "feature state",
    0xC511A110: "ADR-110 sync",
    0xC5118100: "mesh (RV_MESH_MAGIC)",
}

FLAG_PRESENCE = 0x01
FLAG_FALL     = 0x02
FLAG_MOTION   = 0x04


@dataclass
class VitalsPacket:
    """One parsed vitals reading from an ESP32 node."""
    node_id: int
    flags: int
    breathing_rate: float      # BPM
    heart_rate: float          # BPM
    rssi: int                  # dBm
    n_persons: int
    motion: float              # phase variance / motion energy
    presence_score: float
    device_uptime_ms: int
    received_at: float = field(default_factory=time.time)

    @property
    def node_name(self) -> str:
        """Human-readable node identifier, e.g. 'node-01'."""
        return f"node-{self.node_id:02d}"

    @property
    def presence(self) -> bool:
        return bool(self.flags & FLAG_PRESENCE)

    @property
    def fall_detected(self) -> bool:
        return bool(self.flags & FLAG_FALL)

    @property
    def confidence(self) -> float:
        """Link-quality estimate in 0..1, mapped from RSSI.

        The firmware sends no confidence field, but signal strength is what the
        downstream consumers actually want it for — spotting the signal
        degrading. -30 dBm or better is 1.0, -90 or worse is 0.0.
        """
        return round(max(0.0, min(1.0, (self.rssi + 90) / 60.0)), 3)


# ════════════════════════════════════════════════════════════════════════
#  Packet Parser
# ════════════════════════════════════════════════════════════════════════

class PacketParser:
    """Parses raw 32-byte RuView vitals UDP packets (ADR-039)."""

    @staticmethod
    def parse(data: bytes) -> Optional[VitalsPacket]:
        """
        Parse a raw UDP payload into a VitalsPacket.
        Returns None if the data is not a vitals packet.
        """
        if len(data) != PACKET_SIZE:
            return None

        try:
            (magic, node_id, flags, br_fp, hr_fp, rssi, n_persons,
             _reserved, motion, presence_score,
             uptime_ms, _reserved2) = struct.unpack(PACKET_FMT, data)
        except struct.error:
            return None

        if magic != MAGIC:
            return None

        return VitalsPacket(
            node_id=node_id,
            flags=flags,
            breathing_rate=round(br_fp / 100.0, 2),      # fixed point, BPM × 100
            heart_rate=round(hr_fp / 10000.0, 2),        # fixed point, BPM × 10000
            rssi=rssi,
            n_persons=n_persons,
            motion=round(motion, 4),
            presence_score=round(presence_score, 4),
            device_uptime_ms=uptime_ms,
        )

    @staticmethod
    def describe(data: bytes) -> str:
        """Label a non-vitals payload, for verbose logging."""
        if len(data) >= 4:
            magic = struct.unpack("<I", data[:4])[0]
            if magic in KNOWN_OTHER_MAGICS:
                return f"{KNOWN_OTHER_MAGICS[magic]} ({len(data)}B)"
            return f"unknown magic 0x{magic:08X} ({len(data)}B)"
        return f"runt packet ({len(data)}B)"


# ════════════════════════════════════════════════════════════════════════
#  Vitals Simulator
# ════════════════════════════════════════════════════════════════════════

class VitalsSimulator:
    """
    Generates realistic simulated vitals for testing without hardware.

    Breathing: 12–20 BPM baseline with sine-wave modulation + Gaussian noise.
    Heart rate: 55–75 BPM resting with slow drift.
    Apnea events: randomly injected (breathing drops to 0–3 BPM for 12–25 s).
    """

    def __init__(self, node_id: int = 1, *, apnea_chance: float = 0.05):
        self.node_id = node_id
        self.seq = 0
        self.apnea_chance = apnea_chance  # per-second probability of starting an event

        self._t0 = time.time()
        self._in_apnea = False
        self._apnea_remaining = 0.0

        # Randomised baselines so each node looks slightly different
        self._br_base = random.uniform(14.0, 17.0)
        self._hr_base = random.uniform(60.0, 68.0)

        # Sensing simulation variables
        self._sensing_state = "absent"  # absent, entering, still, moving, fall, recovery
        self._sensing_state_timer = 15.0
        self._n_persons = 0

    def generate(self) -> bytes:
        """Generate one 32-byte packet with realistic simulated vitals and motion."""
        t = time.time() - self._t0
        self.seq = (self.seq + 1) & 0xFFFF

        # ── Apnea state machine ───────────────────────────────────
        if self._in_apnea:
            self._apnea_remaining -= 1.0
            if self._apnea_remaining <= 0:
                self._in_apnea = False
            br = random.uniform(0.0, 3.0)
        else:
            # Random chance of starting a new apnea event
            if random.random() < self.apnea_chance:
                self._in_apnea = True
                self._apnea_remaining = random.uniform(12.0, 25.0)
                br = random.uniform(0.0, 3.0)
            else:
                # Normal breathing: slow sine modulation + noise
                br = self._br_base + 2.0 * math.sin(t * 0.05) + random.gauss(0, 0.5)
                br = max(8.0, min(22.0, br))

        # Heart rate: slow drift + noise
        hr = self._hr_base + 3.0 * math.sin(t * 0.02) + random.gauss(0, 0.8)
        hr = max(48.0, min(85.0, hr))

        # Confidence drops during apnea (signal is ambiguous)
        conf = 0.15 if self._in_apnea else min(1.0, 0.85 + random.gauss(0, 0.05))

        # ── Sensing state machine ─────────────────────────────────
        self._sensing_state_timer -= 1.0
        if self._sensing_state_timer <= 0:
            if self._sensing_state == "absent":
                self._sensing_state = "entering"
                self._sensing_state_timer = random.uniform(5.0, 8.0)
            elif self._sensing_state == "entering":
                self._sensing_state = "still"
                self._sensing_state_timer = random.uniform(20.0, 35.0)
            elif self._sensing_state == "still":
                self._sensing_state = "moving"
                self._sensing_state_timer = random.uniform(15.0, 25.0)
            elif self._sensing_state == "moving":
                if random.random() < 0.3:
                    self._sensing_state = "fall"
                    self._sensing_state_timer = 6.0
                else:
                    self._sensing_state = "absent"
                    self._sensing_state_timer = random.uniform(15.0, 25.0)
            elif self._sensing_state == "fall":
                self._sensing_state = "recovery"
                self._sensing_state_timer = 5.0
            elif self._sensing_state == "recovery":
                self._sensing_state = "still"
                self._sensing_state_timer = random.uniform(15.0, 25.0)

        presence = False
        fall = False
        motion = 0.01
        self._n_persons = 0

        if self._sensing_state == "absent":
            presence = False
            motion = max(0.001, random.gauss(0.008, 0.003))
            self._n_persons = 0
        elif self._sensing_state == "entering":
            presence = True
            motion = random.uniform(0.5, 0.95)
            self._n_persons = 1
        elif self._sensing_state == "still":
            presence = True
            motion = random.uniform(0.015, 0.035)
            self._n_persons = 1
        elif self._sensing_state == "moving":
            presence = True
            motion = random.uniform(0.12, 0.45)
            self._n_persons = 2 if random.random() < 0.2 else 1
        elif self._sensing_state == "fall":
            presence = True
            motion = random.uniform(1.2, 1.8)
            fall = True
            self._n_persons = 1
        elif self._sensing_state == "recovery":
            presence = True
            motion = random.uniform(0.05, 0.15)
            self._n_persons = 1

        presence_score = round(random.uniform(0.75, 0.98) if presence
                               else random.uniform(0.0, 0.15), 4)

        # Flags are a single byte on the wire: bit0 presence, bit1 fall,
        # bit2 motion. There is no room for a person count here — it has its
        # own field — and no apnea bit; the bridge derives that itself.
        flags = 0
        if presence:
            flags |= FLAG_PRESENCE
        if fall:
            flags |= FLAG_FALL
        if motion > 0.01:
            flags |= FLAG_MOTION

        # Simulated RSSI tracks confidence so the derived link quality moves
        # the same way real hardware's would.
        rssi = int(max(-90, min(-30, -90 + conf * 60)))

        return struct.pack(
            PACKET_FMT,
            MAGIC,
            self.node_id & 0xFF,
            flags,
            int(max(0, min(65535, round(br * 100)))),        # BPM x 100
            int(max(0, min(0xFFFFFFFF, round(hr * 10000)))),  # BPM x 10000
            rssi,
            self._n_persons & 0xFF,
            0,                                                # reserved[2]
            motion,
            presence_score,
            int((time.time() - self._t0) * 1000) & 0xFFFFFFFF,  # uptime ms
            0,                                                # reserved2
        )


# ════════════════════════════════════════════════════════════════════════
#  Apnea Detector
# ════════════════════════════════════════════════════════════════════════

@dataclass
class ApneaEvent:
    """Record of a single detected apnea episode."""
    start_time: float
    end_time: float = 0.0
    duration: float = 0.0
    min_br: float = 99.0

    def close(self, t: float):
        self.end_time = t
        self.duration = round(t - self.start_time, 1)


class ApneaDetector:
    """
    Flags apnea when breathing rate stays below a threshold for a
    configurable duration.  Also calculates the running AHI
    (Apnea-Hypopnea Index = events per hour of monitoring).
    """

    # AHI is events-per-hour. Extrapolating that from a few minutes produces
    # nonsense (one event 30 s in reads as AHI 120), so withhold it until the
    # session is long enough for the number to mean anything.
    MIN_SESSION_FOR_AHI_S = 600.0   # 10 minutes

    def __init__(self, br_threshold: float = 6.0, duration_threshold: float = 10.0):
        self.br_threshold = br_threshold
        self.duration_threshold = duration_threshold
        self.events: List[ApneaEvent] = []

        self._current: Optional[ApneaEvent] = None
        self._low_since: Optional[float] = None
        self._session_start: float = time.time()

    def update(self, br: float, t: float) -> Optional[ApneaEvent]:
        """
        Feed one breathing-rate sample.
        Returns a completed ApneaEvent if one just ended, else None.
        """
        completed = None

        if br < self.br_threshold:
            # Breathing is abnormally low
            if self._low_since is None:
                self._low_since = t

            elapsed_low = t - self._low_since

            # Confirm event after duration_threshold consecutive seconds
            if elapsed_low >= self.duration_threshold and self._current is None:
                self._current = ApneaEvent(start_time=self._low_since)

            if self._current:
                self._current.min_br = min(self._current.min_br, br)
        else:
            # Breathing recovered — close any active event
            if self._current is not None:
                self._current.close(t)
                self.events.append(self._current)
                completed = self._current
                self._current = None
            self._low_since = None

        return completed

    @property
    def ahi(self) -> Optional[float]:
        """Apnea-Hypopnea Index: events per hour. None until the session is
        long enough for the rate to be meaningful."""
        elapsed = time.time() - self._session_start
        if elapsed < self.MIN_SESSION_FOR_AHI_S:
            return None
        return round(len(self.events) / (elapsed / 3600.0), 1)

    @property
    def total_events(self) -> int:
        return len(self.events)

    @property
    def is_active(self) -> bool:
        """True if an apnea episode is currently in progress."""
        return self._current is not None


# ════════════════════════════════════════════════════════════════════════
#  Semantic State Deriver — turns raw motion/presence into named states
# ════════════════════════════════════════════════════════════════════════

class SemanticDeriver:
    """
    Per-node derivation of semantic states from raw vitals.

    Inputs:  motion energy, presence flag, fall flag, confidence (per packet)
    Outputs: room_state, idle_seconds, activity_burst, fall_risk,
             calibration_drift, baseline_motion
    Side:    appends discrete events to be persisted in sensing_events/
    """

    # Motion band defaults. These suit the simulator's normalised 0..1 output.
    # Real CSI phase-variance energy runs on a completely different scale —
    # a quiet room measured ~4.8 on an ESP32-C6 — so hardware installs must
    # override these via motion_bands in config.json or every room reads
    # "Agitated". Use --verbose to see the live motion values while tuning.
    QUIET_MAX   = 0.05
    AMBIENT_MAX = 0.20
    ACTIVE_MAX  = 0.80
    # > ACTIVE_MAX = Agitated

    BURST_MULTIPLIER  = 3.0   # current vs baseline ratio to flag a burst
    BURST_COOLDOWN_S  = 10.0  # min seconds between bursts
    IDLE_MOTION_THR   = 0.05  # below this counts as "idle"
    DRIFT_CONF_DELTA  = 0.20  # short-vs-long avg confidence drop
    DRIFT_COOLDOWN_S  = 60.0
    FALL_VAR_THRESHOLD = 0.5  # motion variance (last 5s) to flag fall-risk
    DEFAULT_IDLE_ALERT_SEC = 600  # 10 min — bridge fires idle event at this point

    def __init__(self, idle_alert_seconds: float = DEFAULT_IDLE_ALERT_SEC,
                 motion_bands: Optional[dict] = None,
                 fall_var_threshold: Optional[float] = None):
        from collections import deque  # local import to keep top tidy
        self._deque = deque
        self.idle_alert_seconds = idle_alert_seconds
        self._state: Dict[str, dict] = {}

        bands = motion_bands or {}
        self.quiet_max   = bands.get("quiet",   self.QUIET_MAX)
        self.ambient_max = bands.get("ambient", self.AMBIENT_MAX)
        self.active_max  = bands.get("active",  self.ACTIVE_MAX)
        self.idle_motion_thr = bands.get("idle", self.IDLE_MOTION_THR)
        self.fall_var_threshold = (fall_var_threshold if fall_var_threshold is not None
                                   else self.FALL_VAR_THRESHOLD)

    def _node_state(self, node: str) -> dict:
        if node not in self._state:
            now = time.time()
            self._state[node] = {
                "motion_history": self._deque(maxlen=60),    # last 60s
                "conf_short":     self._deque(maxlen=300),   # last 5min
                "conf_long":      self._deque(maxlen=3600),  # last 1h
                "last_motion_above_idle": now,
                "last_burst_at":          0.0,
                "last_drift_at":          0.0,
                "last_idle_alert_at":     0.0,
                "prev_fall_detected":     False,
                "prev_room_state":        "Quiet",
            }
        return self._state[node]

    def derive(self, pkt: "VitalsPacket") -> tuple:
        """Returns (derived_dict, events_list)."""
        s = self._node_state(pkt.node_name)
        now = time.time()
        events = []

        # Histories
        s["motion_history"].append(pkt.motion)
        s["conf_short"].append(pkt.confidence)
        s["conf_long"].append(pkt.confidence)

        # Room state
        if pkt.motion < self.quiet_max:
            room_state = "Quiet"
        elif pkt.motion < self.ambient_max:
            room_state = "Ambient"
        elif pkt.motion < self.active_max:
            room_state = "Active"
        else:
            room_state = "Agitated"

        # Baseline (rolling 60s mean)
        recent = list(s["motion_history"])
        baseline = sum(recent) / len(recent) if recent else 0.05

        # Idle tracking
        if pkt.motion > self.idle_motion_thr:
            s["last_motion_above_idle"] = now
        idle_seconds = int(now - s["last_motion_above_idle"])

        # Fire idle event once when threshold crossed (debounced)
        if (idle_seconds >= self.idle_alert_seconds
                and now - s["last_idle_alert_at"] > self.idle_alert_seconds):
            events.append({
                "type":   "idle_threshold_crossed",
                "node":   pkt.node_name,
                "idle_seconds": idle_seconds,
                "threshold":    self.idle_alert_seconds,
                "message":      f"Room idle for {idle_seconds // 60}m"
            })
            s["last_idle_alert_at"] = now

        # Activity burst (rising-edge detection vs baseline)
        activity_burst = False
        burst_threshold = max(self.quiet_max * 2, baseline * self.BURST_MULTIPLIER)
        if pkt.motion > burst_threshold:
            if now - s["last_burst_at"] > self.BURST_COOLDOWN_S:
                activity_burst = True
                s["last_burst_at"] = now
                events.append({
                    "type":          "activity_burst",
                    "node":          pkt.node_name,
                    "motion":        round(pkt.motion, 3),
                    "baseline":      round(baseline, 3),
                    "message":       "Sudden activity burst"
                })

        # Fall risk (last-5s motion variance) — separate from explicit fall flag
        fall_risk = "Normal"
        if len(recent) >= 5:
            last5 = recent[-5:]
            mean5 = sum(last5) / 5
            var5  = sum((x - mean5) ** 2 for x in last5) / 5
            if var5 > self.fall_var_threshold:
                fall_risk = "Elevated"

        # Explicit fall event (rising edge)
        fall_now = bool(pkt.flags & 0x02)
        if fall_now and not s["prev_fall_detected"]:
            events.append({
                "type":     "fall_detected",
                "node":     pkt.node_name,
                "motion":   round(pkt.motion, 3),
                "message":  "Fall detected"
            })
        s["prev_fall_detected"] = fall_now

        # Calibration drift
        calibration_drift = False
        if len(s["conf_long"]) > 300 and len(s["conf_short"]) > 60:
            long_avg  = sum(s["conf_long"])  / len(s["conf_long"])
            short_avg = sum(s["conf_short"]) / len(s["conf_short"])
            if long_avg - short_avg > self.DRIFT_CONF_DELTA:
                if now - s["last_drift_at"] > self.DRIFT_COOLDOWN_S:
                    calibration_drift = True
                    s["last_drift_at"] = now
                    events.append({
                        "type":      "calibration_drift",
                        "node":      pkt.node_name,
                        "short_avg": round(short_avg, 3),
                        "long_avg":  round(long_avg, 3),
                        "message":   "Signal confidence dropped — recalibration may help"
                    })

        s["prev_room_state"] = room_state

        derived = {
            "room_state":        room_state,
            "idle_seconds":      idle_seconds,
            "activity_burst":    activity_burst,
            "fall_risk":         fall_risk,
            "calibration_drift": calibration_drift,
            "baseline_motion":   round(baseline, 4),
        }
        return derived, events


# ════════════════════════════════════════════════════════════════════════
#  Event Writer — discrete sensing_events/ docs (not high-frequency)
# ════════════════════════════════════════════════════════════════════════

class EventWriter:
    """Writes discrete sensing events via the storage adapter."""

    def __init__(self, storage: BaseStorage, sessions: "SessionRegistry",
                 verbose: bool = False):
        self.storage = storage
        self.sessions = sessions
        self.verbose = verbose

    def write(self, event: dict):
        doc = {
            **event,
            "created_at": time.time(),
        }
        try:
            node = event.get("node", "node-01")
            self.storage.save_sensing_event(node, doc, self.sessions.for_node(node))
            if self.verbose:
                print(f"  {C.MAGENTA}[event] {event['type']} — "
                      f"{event.get('message', '')}{C.RESET}")
        except Exception as e:
            if self.verbose:
                print(f"  {C.YELLOW}[event] Write failed: {e}{C.RESET}")


# ════════════════════════════════════════════════════════════════════════
#  Smart Batcher
# ════════════════════════════════════════════════════════════════════════

class SmartBatcher:
    """
    Buffers vitals samples per node and writes one summary batch document
    per batch_interval (default 60 s).
    """

    def __init__(self, storage: BaseStorage, sessions: "SessionRegistry",
                 batch_seconds: int = 60, verbose: bool = False):
        self.storage = storage
        self.sessions = sessions
        self.batch_seconds = batch_seconds
        self.verbose = verbose
        # Single worker: batch writes must land in the order they were cut,
        # and one thread is ample for a write every 60 s.
        self._executor = ThreadPoolExecutor(max_workers=1)

        self._buffers: Dict[str, List[dict]] = defaultdict(list)
        self._batch_counts: Dict[str, int] = defaultdict(int)
        self._last_flush: Dict[str, float] = {}

    def add(self, pkt: VitalsPacket, apnea_active: bool = False):
        """Append a sample; auto-flushes when the batch window expires."""
        node = pkt.node_name

        if node not in self._last_flush:
            self._last_flush[node] = time.time()

        self._buffers[node].append({
            # Wall-clock receive time. The packet's own clock is milliseconds
            # since the node booted, so it cannot date a reading.
            "ts":     int(pkt.received_at),
            "br":     pkt.breathing_rate,
            "hr":     pkt.heart_rate,
            "conf":   pkt.confidence,
            "motion": pkt.motion,
            "apnea":  apnea_active,
        })

        if time.time() - self._last_flush[node] >= self.batch_seconds:
            self.flush(node)

    def flush(self, node: Optional[str] = None):
        """Flush one node's buffer (or all if node is None)."""
        nodes = [node] if node else list(self._buffers.keys())
        for n in nodes:
            samples = self._buffers.get(n, [])
            if not samples:
                continue
            self._write_batch(n, samples)
            self._buffers[n] = []
            self._last_flush[n] = time.time()

    def flush_all(self):
        """Flush every node buffer. Called on shutdown."""
        self.flush(None)

    def shutdown(self):
        """Wait for queued batch writes to land.

        flush() only *submits* to the writer thread. Without this the session
        could be closed — or the process exit — while the last batch is still
        in flight, and those minutes would go missing from the report.
        """
        self._executor.shutdown(wait=True)

    def _write_batch(self, node: str, samples: List[dict]):
        """Compute stats and save a single batch document."""
        brs   = [s["br"] for s in samples]
        hrs   = [s["hr"] for s in samples]
        confs = [s["conf"] for s in samples]
        apnea_count = sum(1 for s in samples if s["apnea"])

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self._batch_counts[node] += 1
        doc_id = f"minute_{self._batch_counts[node]:04d}"

        doc = {
            "node_id":     node,
            "timestamp":   samples[-1]["ts"],
            "written_at":  time.time(),
            "sample_count": len(samples),
            "duration_s":  (samples[-1]["ts"] - samples[0]["ts"]) if len(samples) > 1 else 0,
            "breathing_rate": {
                "min": round(min(brs), 2),
                "max": round(max(brs), 2),
                "avg": round(sum(brs) / len(brs), 2),
            },
            "heart_rate": {
                "min": round(min(hrs), 2),
                "max": round(max(hrs), 2),
                "avg": round(sum(hrs) / len(hrs), 2),
            },
            "confidence_avg":     round(sum(confs) / len(confs), 3),
            "apnea_sample_count": apnea_count,
            "samples":            samples,
        }

        self._executor.submit(self.storage.save_vitals_batch, node, doc,
                              self.sessions.for_node(node))

        if self.verbose:
            print(f"  {C.DIM}[batch] {node} → batch {doc_id}  "
                  f"({len(samples)} samples, BR avg {doc['breathing_rate']['avg']}){C.RESET}")


# ════════════════════════════════════════════════════════════════════════
#  Live Writer
# ════════════════════════════════════════════════════════════════════════

class LiveWriter:
    """
    Persists live vitals snapshot every update_interval seconds
    and streams live updates to local SSE clients.
    """

    def __init__(self, storage: BaseStorage, update_interval: float = 1.0, verbose: bool = False,
                 deriver: Optional["SemanticDeriver"] = None,
                 event_writer: Optional["EventWriter"] = None,
                 local_server: Optional[LocalAPIServer] = None):
        self.storage = storage
        self.update_interval = update_interval
        self.verbose = verbose
        self.deriver = deriver
        self.event_writer = event_writer
        self.local_server = local_server
        self._last_write: Dict[str, float] = {}

    def update(self, pkt: VitalsPacket, detector: ApneaDetector):
        """Write live snapshot if enough time has passed."""
        node = pkt.node_name
        now = time.time()

        if node in self._last_write:
            if (now - self._last_write[node]) < self.update_interval:
                return
        self._last_write[node] = now

        # presence / fall come off the flags byte; the person count is its own
        # field in the wire format, not packed into the flags.
        presence = pkt.presence
        fall_detected = pkt.fall_detected
        n_persons = pkt.n_persons
        if presence and n_persons == 0:
            n_persons = 1

        derived = {}
        events = []
        if self.deriver is not None:
            derived, events = self.deriver.derive(pkt)

        if self.event_writer is not None:
            for ev in events:
                self.event_writer.write(ev)

        doc = {
            "node_id":            node,
            "updated_at":         now,
            "breathing_rate":     pkt.breathing_rate,
            "heart_rate":         pkt.heart_rate,
            "confidence":         pkt.confidence,
            "motion":             pkt.motion,
            "apnea_active":       detector.is_active or pkt.breathing_rate < detector.br_threshold,
            "apnea_events_total": detector.total_events,
            "ahi":                detector.ahi,
            "flags":              pkt.flags,
            "presence":           presence,
            "presence_score":     pkt.presence_score,
            "fall_detected":      fall_detected,
            "n_persons":          n_persons,
            "rssi":               pkt.rssi,
            "device_uptime_ms":   pkt.device_uptime_ms,
            **derived,
        }

        try:
            self.storage.save_live_vitals(node, doc)
            if self.local_server:
                self.local_server.broadcast_live(doc)
        except Exception as e:
            if self.verbose:
                print(f"  {C.YELLOW}[live] Write failed: {e}{C.RESET}")


# ════════════════════════════════════════════════════════════════════════
#  Session Registry
# ════════════════════════════════════════════════════════════════════════

class SessionRegistry:
    """Owns the open session for each node.

    One run of the bridge is one session. You start it at bedtime and stop it
    in the morning, so the process lifetime is the night — nothing has to be
    inferred from gaps in the data or from a clock rule.

    Sessions are opened lazily: the configured node gets one at startup, and
    any other node that turns up in a packet gets one on first sight.
    """

    def __init__(self, storage: BaseStorage, resume_gap_s: float = 1200.0,
                 verbose: bool = False):
        self.storage = storage
        self.resume_gap_s = resume_gap_s
        self.verbose = verbose
        self._sessions: Dict[str, int] = {}
        self._lock = threading.Lock()

    def open(self, node_id: str) -> int:
        """Open (or resume) this node's session. Safe to call repeatedly."""
        with self._lock:
            if node_id in self._sessions:
                return self._sessions[node_id]
            try:
                session_id = self.storage.open_session(node_id, self.resume_gap_s)
            except Exception as e:
                print(f"  {C.RED}[session] Failed to open for {node_id}: {e}{C.RESET}")
                return 0
            self._sessions[node_id] = session_id

        self.storage.save_node_metadata(node_id, {
            "last_session_id": session_id,
            "status":          "active",
            "started_at":      time.time(),
        })
        print(f"  {C.GREEN}[session] Session #{session_id} open for {node_id}{C.RESET}")
        return session_id

    def for_node(self, node_id: str) -> Optional[int]:
        """Session id for a node, opening one if this is a new node."""
        existing = self._sessions.get(node_id)
        return existing if existing is not None else self.open(node_id)

    def close_all(self, detectors: Dict[str, "ApneaDetector"]):
        """Finalise every open session."""
        with self._lock:
            open_sessions = list(self._sessions.items())
            self._sessions.clear()

        for node, session_id in open_sessions:
            det = detectors.get(node)
            try:
                self.storage.close_session(session_id)
                self.storage.save_node_metadata(node, {
                    "status":             "completed",
                    "ended_at":           time.time(),
                    "total_apnea_events": det.total_events if det else 0,
                })
                summary = ""
                if det:
                    ahi = fmt_ahi(det.ahi).strip()
                    summary = f" — {det.total_events} apnea event(s), AHI {ahi}"
                print(f"  {C.GREEN}[session] Session #{session_id} closed for {node}{summary}{C.RESET}")
            except Exception as e:
                print(f"  {C.RED}[session] Failed to close {node}: {e}{C.RESET}")


# ════════════════════════════════════════════════════════════════════════
#  Console Display
# ════════════════════════════════════════════════════════════════════════

def fmt_ahi(ahi: Optional[float]) -> str:
    """AHI is None until enough of a session has accumulated."""
    return " —  " if ahi is None else f"{ahi:4.1f}"


def print_vitals(pkt: VitalsPacket, apnea_active: bool,
                 ahi: Optional[float], event_count: int):
    """Pretty-print one vitals reading with colour-coded values."""
    # Colour coding: red if low BR, yellow if borderline, green if normal
    if pkt.breathing_rate < 6:
        br_c = C.RED
    elif pkt.breathing_rate < 10:
        br_c = C.YELLOW
    else:
        br_c = C.GREEN

    hr_c = C.GREEN if 50 <= pkt.heart_rate <= 80 else C.YELLOW

    apnea_tag = f"  {C.RED}{C.BOLD}⚠ APNEA{C.RESET}" if apnea_active else ""

    ts = datetime.fromtimestamp(pkt.received_at).strftime("%H:%M:%S")

    print(
        f"  {C.DIM}{ts}{C.RESET}  "
        f"{C.CYAN}{pkt.node_name}{C.RESET}  "
        f"BR: {br_c}{pkt.breathing_rate:5.1f}{C.RESET} BPM  "
        f"HR: {hr_c}{pkt.heart_rate:5.1f}{C.RESET} BPM  "
        f"RSSI: {pkt.rssi:4d}dBm  "
        f"AHI: {C.MAGENTA}{fmt_ahi(ahi)}{C.RESET}  "
        f"Events: {event_count}"
        f"{apnea_tag}"
    )


# ════════════════════════════════════════════════════════════════════════
#  Main Bridge Orchestrator
# ════════════════════════════════════════════════════════════════════════

class Bridge:
    """
    Top-level orchestrator that wires together the UDP listener (or
    simulator), packet parser, apnea detector, batcher, live writer,
    SQLite storage, local web/API server, and session manager.
    """

    def __init__(self, config: dict, args: argparse.Namespace):
        self.config = config
        self.args = args
        self.running = False

        self.storage: Optional[BaseStorage] = None
        self.local_server: Optional[LocalAPIServer] = None

        self.detectors: Dict[str, ApneaDetector] = {}
        self.batcher: Optional[SmartBatcher] = None
        self.live_writer: Optional[LiveWriter] = None
        self.sessions: Optional[SessionRegistry] = None
        self.simulator: Optional[VitalsSimulator] = None

    # ── Helpers ───────────────────────────────────────────────────

    def _get_detector(self, node: str) -> ApneaDetector:
        """Get (or create) the ApneaDetector for a given node."""
        if node not in self.detectors:
            self.detectors[node] = ApneaDetector(
                br_threshold=self.config.get("apnea_threshold_bpm", 6.0),
                duration_threshold=self.config.get("apnea_duration_seconds", 10.0),
            )
        return self.detectors[node]

    def _resolve_node_id(self) -> tuple:
        """Return (node_name_str, numeric_id) from CLI / config."""
        raw = self.args.node_id or self.config.get("default_node_id", "node-01")
        try:
            numeric = int(raw.split("-")[-1])
        except (ValueError, IndexError):
            numeric = 1
        return raw, numeric

    # ── Packet handler ────────────────────────────────────────────

    def _handle_packet(self, pkt: VitalsPacket):
        """Process one parsed vitals packet through every subsystem."""
        node = pkt.node_name
        self.sessions.for_node(node)   # opens on first sight of a new node
        detector = self._get_detector(node)

        # 1. Apnea detection
        completed = detector.update(pkt.breathing_rate, pkt.received_at)
        apnea_active = detector.is_active or pkt.breathing_rate < detector.br_threshold

        if completed:
            print(f"\n  {C.RED}{C.BOLD}╔═══ APNEA EVENT ENDED ═══╗{C.RESET}")
            print(f"  {C.RED}  Node:     {node}{C.RESET}")
            print(f"  {C.RED}  Duration: {completed.duration}s{C.RESET}")
            print(f"  {C.RED}  Min BR:   {completed.min_br:.1f} BPM{C.RESET}")
            print(f"  {C.RED}  AHI now:  {fmt_ahi(detector.ahi).strip()}{C.RESET}")
            print(f"  {C.RED}{C.BOLD}╚═════════════════════════╝{C.RESET}\n")

            # Persist completed apnea event
            event_doc = {
                "node_id": node,
                "start_time": completed.start_time,
                "end_time": completed.end_time,
                "duration": completed.duration,
                "min_br": completed.min_br,
                "ahi_after": detector.ahi,
            }
            self.storage.save_apnea_event(node, event_doc, self.sessions.for_node(node))

        # 2. Smart batcher (auto-flushes every batch_interval)
        self.batcher.add(pkt, apnea_active)

        # 3. Live vitals update (~1 Hz)
        self.live_writer.update(pkt, detector)

        # 4. Console output
        print_vitals(pkt, apnea_active, detector.ahi, detector.total_events)

    # ── Run loops ─────────────────────────────────────────────────

    def run(self):
        """Entry point — initialises all subsystems then enters the main loop."""
        self.running = True

        db_path = self.args.db or self.config.get("db_path", "vitals.db")
        self.storage = SQLiteStorage(db_path=db_path)
        print(f"  {C.CYAN}[storage] SQLite database: {os.path.abspath(db_path)}{C.RESET}")

        # Serve the web app + JSON API + SSE stream
        host = self.args.host or self.config.get("http_host", "127.0.0.1")
        port = self.args.http_port or self.config.get("http_port", 8080)
        self.local_server = LocalAPIServer(self.storage, host=host, port=port)
        try:
            self.local_server.start()
        except OSError as e:
            print(f"\n  {C.RED}[server] Could not bind {host}:{port} — {e}{C.RESET}")
            print(f"  {C.YELLOW}Another program is probably using that port. "
                  f"Try: python bridge.py --http-port 8081{C.RESET}\n")
            raise SystemExit(1)

        url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}"
        print(f"  {C.GREEN}{C.BOLD}[server] Dashboard ready at {url}{C.RESET}")
        if host == "0.0.0.0":
            print(f"  {C.YELLOW}[server] Bound to all interfaces — anyone on your "
                  f"network can read this data.{C.RESET}")

        batch_interval = self.config.get("batch_interval_seconds", 60)
        live_interval  = self.config.get("live_update_interval_seconds", 1.0)
        verbose = self.args.verbose
        idle_alert = self.config.get("idle_alert_seconds", 600)

        resume_gap = self.config.get("session_resume_gap_seconds", 1200)

        self.sessions      = SessionRegistry(self.storage, resume_gap, verbose)
        self.batcher       = SmartBatcher(self.storage, self.sessions, batch_interval, verbose)
        self.deriver       = SemanticDeriver(
            idle_alert_seconds=idle_alert,
            motion_bands=self.config.get("motion_bands"),
            fall_var_threshold=self.config.get("fall_variance_threshold"))
        self.event_writer  = EventWriter(self.storage, self.sessions, verbose)
        self.live_writer   = LiveWriter(self.storage, live_interval, verbose,
                                        deriver=self.deriver,
                                        event_writer=self.event_writer,
                                        local_server=self.local_server)

        node_name, numeric_id = self._resolve_node_id()
        # In live mode a session is opened when a node actually reports, so an
        # absent or renumbered node does not leave an empty session behind.
        if self.args.simulate:
            self.sessions.open(node_name)

        if self.args.open:
            webbrowser.open(url)

        if self.args.simulate:
            self._banner("SIMULATION MODE", C.MAGENTA)
            self.simulator = VitalsSimulator(
                node_id=numeric_id,
                apnea_chance=self.config
                    .get("simulation", {})
                    .get("apnea_chance", 0.002),
            )
            self._run_simulated()
        else:
            self._banner("LIVE MODE", C.CYAN)
            self._run_udp()

    def _run_simulated(self):
        """Generate and process simulated packets at 1 Hz."""
        rate = self.config.get("simulation", {}).get("sample_rate_hz", 1.0)
        interval = 1.0 / max(0.1, rate)
        print(f"  {C.DIM}Generating simulated vitals at {rate} Hz …{C.RESET}\n")

        while self.running:
            raw = self.simulator.generate()
            pkt = PacketParser.parse(raw)
            if pkt:
                self._handle_packet(pkt)
            time.sleep(interval)

    def _run_udp(self):
        """Listen for real ESP32 UDP packets."""
        port = self.args.port or self.config.get("udp_port", 5005)

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(2.0)
        sock.bind(("0.0.0.0", port))
        print(f"  {C.GREEN}Listening on UDP 0.0.0.0:{port} …{C.RESET}\n")

        while self.running:
            try:
                data, addr = sock.recvfrom(65535)
                pkt = PacketParser.parse(data)
                if pkt:
                    self._handle_packet(pkt)
                elif self.args.verbose:
                    # The node multicasts several packet types on this port.
                    # Only vitals are consumed here; the rest are expected.
                    print(f"  {C.DIM}[skip] {PacketParser.describe(data)} "
                          f"from {addr[0]}{C.RESET}")
            except socket.timeout:
                continue
            except OSError:
                if self.running:
                    raise
                break

        sock.close()

    # ── Shutdown ──────────────────────────────────────────────────

    def shutdown(self):
        """Clean shutdown: stop server, flush all buffered data, close session."""
        if not self.running:
            return
        print(f"\n  {C.YELLOW}[shutdown] Flushing remaining data …{C.RESET}")
        self.running = False

        if self.local_server:
            self.local_server.stop()
        if self.batcher:
            # Flush before closing so the final minutes are attributed to the
            # session that produced them, not left orphaned.
            self.batcher.flush_all()
            self.batcher.shutdown()
        if self.sessions:
            self.sessions.close_all(self.detectors)

        print(f"  {C.GREEN}[shutdown] Done.{C.RESET}\n")

    # ── Helpers ───────────────────────────────────────────────────

    @staticmethod
    def _banner(title: str, colour: str):
        border = "═" * (len(title) + 6)
        print(f"\n{colour}{C.BOLD}╔{border}╗")
        print(f"║   {title}   ║")
        print(f"╚{border}╝{C.RESET}\n")


# ════════════════════════════════════════════════════════════════════════
#  Config loader
# ════════════════════════════════════════════════════════════════════════

def load_config(path: str) -> dict:
    """Load config.json; returns empty dict (with warning) if missing."""
    target_path = path
    if not os.path.exists(target_path):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        alt_path = os.path.join(script_dir, path)
        if os.path.exists(alt_path):
            target_path = alt_path

    if os.path.exists(target_path):
        try:
            with open(target_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            print(f"{C.RED}[config] Failed to parse {target_path}: {e}{C.RESET}")
            sys.exit(1)

    print(f"  {C.YELLOW}[config] {path} not found — using defaults.{C.RESET}")
    return {}


# ════════════════════════════════════════════════════════════════════════
#  CLI Entry Point
# ════════════════════════════════════════════════════════════════════════

def main():
    # Force UTF-8 encoding on Windows console stdout/stderr
    if sys.platform == "win32":
        os.system("")
        try:
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(encoding="utf-8")
            if hasattr(sys.stderr, "reconfigure"):
                sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(
        description="CU SLEEP — WiFi Sleep Monitor bridge, database, and dashboard server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python bridge.py --simulate --open       Fake vitals, open the dashboard
  python bridge.py                         Listen for real ESP32 packets on UDP 5005
  python bridge.py --http-port 8081        Serve the dashboard on a different port
""",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="UDP listen port for ESP32 packets (default: 5005)")
    parser.add_argument(
        "--http-port", type=int, default=None,
        help="Port for the dashboard and JSON API (default: 8080)")
    parser.add_argument(
        "--host", default=None,
        help="Address to serve the dashboard on (default: 127.0.0.1, this machine "
             "only). Use 0.0.0.0 to allow other devices on your network.")
    parser.add_argument(
        "--db", default=None,
        help="Path to the SQLite database file (default: vitals.db)")
    parser.add_argument(
        "--simulate", action="store_true",
        help="Generate fake vitals instead of listening on UDP")
    parser.add_argument(
        "--open", action="store_true",
        help="Open the dashboard in your browser once the server is up")
    parser.add_argument(
        "--node-id", default=None,
        help="Node identifier, e.g. 'node-01' (overrides config.json)")
    parser.add_argument(
        "--config", default="config.json",
        help="Path to config.json (default: ./config.json)")
    parser.add_argument(
        "--verbose", action="store_true",
        help="Enable verbose logging (batch writes, dropped packets, etc.)")

    args = parser.parse_args()

    # Enable ANSI escape sequences on Windows 10+
    if sys.platform == "win32":
        os.system("")

    config = load_config(args.config)
    bridge = Bridge(config, args)

    # ── Shutdown handlers ─────────────────────────────────────────
    # Buffered samples are only written on a clean exit, so catch every stop
    # signal the platform offers: Ctrl+C, Ctrl+Break (Windows), and SIGTERM.
    def on_signal(sig, frame):
        bridge.shutdown()
        sys.exit(0)

    for signame in ("SIGINT", "SIGBREAK", "SIGTERM"):
        sig = getattr(signal, signame, None)
        if sig is not None:
            try:
                signal.signal(sig, on_signal)
            except (ValueError, OSError):
                pass   # not settable on this platform

    try:
        bridge.run()
    except KeyboardInterrupt:
        bridge.shutdown()
    except SystemExit:
        raise
    except Exception as e:
        print(f"\n  {C.RED}[fatal] {e}{C.RESET}")
        bridge.shutdown()
        sys.exit(1)


if __name__ == "__main__":
    main()

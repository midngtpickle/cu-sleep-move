# CU SLEEP — Bridge

One Python process that does three things:

1. Receives 32-byte vitals packets from ESP32-C6 nodes over UDP (or fabricates them with `--simulate`).
2. Runs apnea detection and per-minute batching, and stores everything in a local SQLite file.
3. Serves the dashboard, a small JSON API, and a live SSE stream on `http://localhost:8080`.

No dependencies, no credentials, no network egress. Python 3.9+ and nothing else.

```
┌────────────┐   UDP :5005   ┌──────────────┐   writes   ┌────────────┐
│  ESP32-C6  │ ────────────► │  bridge.py   │ ─────────► │ vitals.db  │
│  RuView    │  32-byte pkt  │              │            │  (SQLite)  │
└────────────┘               └──────┬───────┘            └────────────┘
                                    │ serves
                                    ▼
                       http://localhost:8080  (dashboard + API + SSE)
```

---

## Running

```bash
cd bridge

# Simulated vitals, dashboard opens automatically
python bridge.py --simulate --open

# Real hardware
python bridge.py --port 5005 --node-id node-01
```

Stop with `Ctrl+C`. Do stop it cleanly — buffered samples are flushed and the
session is finalised on the way out.

### Sessions

**One run of the bridge is one night.** Start it at bedtime, stop it in the
morning, and that run becomes a single session in the Report and History pages.
Nothing is inferred from clock rules or gaps in the data.

Two rules keep that robust:

* **Restarting soon after stopping resumes the same session.** Change a config
  value at 01:00, restart, and you still get one night — not two half-nights.
  The window is `session_resume_gap_seconds` (default 20 minutes).
* **A session left open by a crash is closed on next start**, using the time of
  its last recorded data rather than the time of the repair. A bridge killed at
  07:00 and restarted at 22:00 does not become a fifteen-hour night.

A session that is still recording appears in the Report page's night picker
marked `recording`, with statistics updating as it goes. It joins the History
trends once you stop the bridge.

### Flags

| Flag | Default | Description |
|---|---|---|
| `--simulate` | off | Generate fake vitals instead of listening on UDP |
| `--open` | off | Open the dashboard in your browser at startup |
| `--port` | `5005` | UDP port for ESP32 packets |
| `--http-port` | `8080` | Port for the dashboard and API |
| `--host` | `127.0.0.1` | Bind address. `0.0.0.0` exposes the dashboard to your network |
| `--db` | `vitals.db` | SQLite database path |
| `--node-id` | `node-01` | Node identifier |
| `--config` | `config.json` | Config file path |
| `--verbose` | off | Log batch writes and dropped packets |

Anything not passed on the command line falls back to [`config.json`](config.json).

> **On `--host 0.0.0.0`:** the API has no authentication. Binding to all
> interfaces lets anyone on the same network read your breathing and heart-rate
> history. The default keeps it on this machine only.

---

## Where the data goes

Everything lives in one SQLite file, `vitals.db`, next to the bridge. Copy that
file to back it up; delete it to start over.

| Table | Contents |
|---|---|
| `live_vitals` | Latest snapshot per node, overwritten ~1 Hz |
| `sessions` | One row per bridge run — start, end, status |
| `vitals_history` | One row per minute: min/max/avg BR and HR, apnea sample count, `session_id` |
| `apnea_events` | Confirmed apnea episodes with duration and minimum BR |
| `sensing_events` | Discrete events — falls, activity bursts, idle thresholds, calibration drift. Surfaced by the Sensing Console |
| `nodes` | Per-node session metadata, merged across start and finish |

---

## HTTP API

All timestamps are **UNIX epoch seconds** (floats). This is the contract the web
app depends on — see `public/js/services/api.js`.

Session statistics are aggregated in SQL on every request rather than cached, so
they are always consistent with the rows beneath them and correct for a session
still in progress.

| Endpoint | Returns |
|---|---|
| `GET /api/live?node=node-01` | Latest snapshot object, or `{}` |
| `GET /api/history?node=node-01&limit=500` | Minute batches, oldest first. Add `&samples=1` to include each batch's 60 raw readings — omitted by default because they dominate the payload |
| `GET /api/apnea?node=node-01&limit=50` | Apnea episodes, newest first |
| `GET /api/events?node=node-01&limit=50` | Sensing events (falls, bursts, idle, drift), newest first. Each carries a row `id` so clients can spot genuinely new ones |
| `GET /api/sessions?node=node-01&limit=60` | Sessions newest first, each with its statistics rolled up. `node=all` for every node |
| `GET /api/sessions/{id}` | One session with its rollup |
| `GET /api/sessions/{id}/vitals` | That session's minute batches, oldest first. `?samples=1` for raw readings |
| `GET /api/nodes` | Registered nodes, each with an `id` |
| `GET /api/stream?node=node-01` | SSE stream of live snapshots |
| `GET /api/health` | Liveness check |
| `GET /*` | The dashboard's static files |

The server is threaded. An open SSE stream holds its own thread and does not
block other requests.

---

## Packet format (32 bytes)

Source of truth: `edge_vitals_pkt_t` in
`RuView/firmware/esp32-csi-node/main/edge_processing.h`. Verified against
firmware v0.7.0 on an ESP32-C6.

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | uint32 | Magic (`0xC5110002`) |
| 4 | 1 | uint8 | Node ID |
| 5 | 1 | uint8 | Flags — bit0 presence, bit1 fall, bit2 motion |
| 6 | 2 | uint16 | Breathing rate, **BPM × 100** (fixed point) |
| 8 | 4 | uint32 | Heart rate, **BPM × 10000** (fixed point) |
| 12 | 1 | int8 | RSSI (dBm) |
| 13 | 1 | uint8 | Persons detected |
| 14 | 2 | uint8[2] | Reserved |
| 16 | 4 | float32 | Motion energy (phase variance) |
| 20 | 4 | float32 | Presence score |
| 24 | 4 | uint32 | Device uptime, **milliseconds since boot** |
| 28 | 4 | uint32 | Reserved |

Two things to watch:

* **Breathing and heart rate are fixed-point integers, not floats.** Reading
  them as floats yields values near zero.
* **The timestamp is uptime, not a UNIX epoch.** Readings are dated by the
  bridge's own receive time; the device clock only measures gaps and reboots.

### Other packets on the same port

The node multicasts several packet types to the same UDP port. The bridge
consumes only vitals and skips the rest — `--verbose` labels them rather than
reporting them as errors.

| Magic | Contents |
|---|---|
| `0xC5110001` | Raw CSI frame (148 B) |
| `0xC5110002` | **Vitals — consumed** (32 B) |
| `0xC5110003` | Feature vector (48 B) |
| `0xC5110004` | Fused vitals |
| `0xC5110005` | Compressed CSI |
| `0xC5110006` | Feature state (60 B) |
| `0xC5118100` | Mesh (`RV_MESH_MAGIC`) |
| `0xC511A110` | ADR-110 sync |

---

## Calibrating motion for your room

Motion energy is raw CSI phase variance, not a normalised 0–1 value. Measured
on one ESP32-C6 in a daytime room: min 0.7, median 8.5, p90 23.2, max 35.8 —
roughly a hundred times the simulator's range.

`motion_bands` in [`config.json`](config.json) must therefore be tuned per
install, or every room reads *Agitated* and fall risk sits at *Elevated*.
The shipped values are a starting point, not a calibration.

```bash
python bridge.py --verbose      # watch the motion column
```

Read it with the room empty, then again with someone in bed. Set `quiet` just
above the empty-room figure and `ambient` around the in-bed figure.

> **Known firmware quirks (v0.7.0):** `presence_score` is always identical to
> `motion_energy`, and the person count reports a constant 4 regardless of who
> is in the room. Both are sensor-side; the bridge passes them through
> unmodified rather than inventing a correction.

---

## Apnea detection

- **Threshold:** breathing rate below 6 BPM (`apnea_threshold_bpm`)
- **Duration:** must persist 10 consecutive seconds (`apnea_duration_seconds`)
- **AHI:** events per hour. Withheld (reported as `null`) until the session has
  run for 10 minutes, because extrapolating an hourly rate from a couple of
  minutes produces meaningless numbers.

| AHI | Severity |
|-----|----------|
| < 5 | Normal |
| 5–15 | Mild |
| 15–30 | Moderate |
| > 30 | Severe |

Research and educational use only. This is not a medical device.

---

## Running on a Raspberry Pi

```bash
sudo apt update && sudo apt install -y python3

# Copy the bridge and the web app across
scp -r bridge/ public/ pi@raspberrypi.local:~/cu-sleep/

cd ~/cu-sleep/bridge
python3 bridge.py --host 0.0.0.0     # reachable from your laptop
```

As a systemd unit, `/etc/systemd/system/cu-sleep.service`:

```ini
[Unit]
Description=CU SLEEP Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/cu-sleep/bridge
ExecStart=/usr/bin/python3 bridge.py --port 5005 --host 0.0.0.0
Restart=always
RestartSec=5
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

`SIGTERM` is handled, so `systemctl stop` flushes buffered data like `Ctrl+C` does.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not bind 127.0.0.1:8080` | Something else holds the port. `python bridge.py --http-port 8081` |
| Dashboard shows "Waiting for data…" | Check the bridge console is printing a line per reading |
| Header says Offline | The page cannot reach the bridge. Confirm the URL port matches `--http-port` |
| No packets received | Verify the ESP32's `--target-ip` matches this machine, and check `netstat -an \| findstr 5005` |
| ANSI colours look wrong | Needs Windows 10+ or any modern terminal |
| One night split into two sessions | The bridge was stopped for longer than `session_resume_gap_seconds`. Raise it in `config.json` |
| A session shows an absurd duration | Older builds could leave a session open after a hard kill. Current builds repair this on next start |

---

## Database schema version

`PRAGMA user_version` tracks the schema. Opening an older database migrates it
in place on first run: the typed summary columns are backfilled from the stored
JSON, and past sessions are reconstructed by gap detection, since rows written
before sessions existed have no other way to be grouped. The migration runs
once and is idempotent.

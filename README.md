# 🌙 CU SLEEP / 📡 CU MOVE

**Privacy-first contactless sleep monitor & real-time spatial motion radar powered by WiFi Channel State Information (CSI), ESP32-C6 microcontrollers, a zero-dependency Python bridge, and local SQLite storage.**

> ⚠️ **RESEARCH & EDUCATIONAL USE ONLY — NOT A MEDICAL DEVICE**  
> *Not FDA-cleared or CE-marked. Do not use as a substitute for professional medical diagnosis, treatment, or clinical patient monitoring.*

---

## 🌟 Overview: Two Powerful Modes in One Platform

`CU SLEEP / CU MOVE` transforms commodity WiFi signals into contactless biological and spatial intelligence without cameras, microphones, wearables, or cloud subscriptions.

```
                          ┌────────────────────────┐
                          │   ESP32-C6 / Nodes     │  (RuView CSI firmware, or --simulate)
                          └───────────┬────────────┘
                                      │ UDP @ 1 Hz (32-byte vitals packet)
                                      ▼
                          ┌────────────────────────┐
                          │      bridge.py         ├──────► MQTT (Home Assistant Auto-Discovery)
                          │  (Python stdlib only)  ├──────► Webhooks (Discord / Telegram / HA)
                          └─────┬────────────┬─────┘
                                │            │
                        writes  │            │  serves
                                ▼            ▼
                       ┌────────────┐   http://localhost:8080
                       │ vitals.db  │   ├── 🌙 CU SLEEP Dashboard (Live & History)
                       │  (SQLite)  │   ├── 📡 CU MOVE Spatial Radar & Mesh
                       └────────────┘   ├── 🫁 Respiration Oscilloscope (60 FPS)
                                        ├── 📥 CSV & Clinical JSON Export
                                        └── 🤖 Multi-Provider AI Sleep Analyst
```

### 🌙 CU SLEEP (Nightly Vitals & Sleep Health)
* **Contactless Respiration Tracking:** 6–30 RPM extracted from 0.1–0.5 Hz subcarrier phase variance.
* **Resting Heart Rate & Recovery:** 40–120 BPM overnight dips reflecting autonomic nervous system recovery.
* **Apnea Episode Detection:** Automatic detection of breathing pauses (>10s) and calculation of nightly Apnea-Hypopnea Index (AHI).
* **Sleep Architecture & Quality:** Automatic session grouping, overnight vitals trends, and sleep quality scores (0–100%).
* **AI Clinical Sleep Analyst:** In-depth clinical summaries powered by **Claude 3.7 Sonnet** (Extended Thinking up to 32k tokens), **Gemini 2.5 Pro / Flash**, or **Custom Model IDs**.
* **Clinical Data Portability:** 1-click **CSV** and **Clinical JSON** exports for doctor consultations or research.

### 📡 CU MOVE (Real-Time Spatial Radar & Presence)
* **Live Respiration Oscilloscope:** High-frequency 60 FPS chest displacement sinusoidal waveform showing real-time breathing dynamics, inhale/exhale transitions, and apnea flatlines.
* **2D Multistatic Room Mesh Visualizer:** Top-down bedroom floorplan showing multi-node positioning, CSI ray intersections, and localized presence heatmaps.
* **Semantic Room States:** Real-time occupancy classification (*Quiet*, *Ambient*, *Active*, *Agitated*).
* **Emergency Fall Detection & Audible Alarm:** Immediate detection of high-velocity phase disturbances followed by stillness, triggering an in-app Web Audio chime and external webhooks.
* **30-Minute Activity Heatstrip:** Continuous rolling timeline of room activity and disturbance intensity.

---

## ⚡ Quick Start (Windows)

### Prerequisites
You only need **Python 3.9 or newer**. Zero `pip install`, zero external libraries, zero account creation.

Check your Python version:
```powershell
python --version
```
*(If needed, download from [python.org](https://www.python.org/downloads/) and make sure to tick **"Add Python to PATH"**).*

---

### 1. Instant Demo Mode (No Hardware Required)
Explore live charts, the respiration oscilloscope, 2D mesh, and sleep reports using simulated vitals:
* **Double-click `start-demo.bat`** in the project root folder.
* *Or run via terminal:*
  ```powershell
  python bridge/bridge.py --simulate --open
  ```

---

### 2. Live Hardware Mode
1. **Power your ESP32-C6 sensor(s):** Plug them into any USB charger. They automatically join your WiFi and begin transmitting UDP packets.
2. **Start the bridge:**
   * **Double-click `start.bat`** in the project root folder.
   * *Or run via terminal:*
     ```powershell
     python bridge/bridge.py --open
     ```
3. Open your browser to **http://localhost:8080**. The header status will show **Live** with a green/white indicator.
4. **Stopping the bridge:** Press **`Ctrl+C`** in the terminal to flush the night's data to `vitals.db` and seal the session cleanly.

---

## 🏠 Home Assistant & MQTT Auto-Discovery

`CU SLEEP / CU MOVE` features built-in MQTT Auto-Discovery using standard library sockets. When connected, Home Assistant automatically discovers:

| Entity ID | Type | Description |
|---|---|---|
| `sensor.cu_sleep_node_01_breathing_rate` | Sensor (RPM) | Real-time respiration rate |
| `sensor.cu_sleep_node_01_heart_rate` | Sensor (BPM) | Real-time resting heart rate |
| `sensor.cu_sleep_node_01_sleep_quality` | Sensor (%) | Nightly sleep score |
| `sensor.cu_sleep_node_01_room_state` | Sensor | Semantic room state (*Quiet*, *Active*, etc.) |
| `binary_sensor.cu_sleep_node_01_presence` | Binary Sensor | Bed / Room occupancy |
| `binary_sensor.cu_sleep_node_01_apnea_event` | Binary Sensor | Active apnea breathing flatline |
| `binary_sensor.cu_sleep_node_01_fall_detected` | Binary Sensor | Safety alert for detected falls |

### Enabling MQTT:
* **In the App:** Navigate to **Setup (`#/setup`)** ➔ **Home Assistant & MQTT Auto-Discovery**, enter your broker host (`homeassistant.local` or `192.168.1.X`), and click **Apply & Connect**.
* **Via Command Line:**
  ```powershell
  python bridge/bridge.py --mqtt-host homeassistant.local --mqtt-port 1883 --mqtt-user homeassistant --mqtt-pass yourpassword
  ```

---

## 🔔 Emergency Alert Webhooks

Send instant HTTP POST notifications when a fall or severe apnea event is detected:
* Supported destinations: **Discord Webhooks**, **Telegram Bot API**, **Home Assistant Webhooks**, **IFTTT / Zapier**, or custom HTTP endpoints.
* Configure in **Setup (`#/setup`)** or pass via CLI:
  ```powershell
  python bridge/bridge.py --webhook-url https://discord.com/api/webhooks/...
  ```

---

## 🤖 Multi-Provider AI Sleep Analyst

Bring your own API key to generate comprehensive clinical evaluations of your sleep architecture:

### Supported AI Models:
* **Anthropic Claude:**
  * `claude-3-7-sonnet-20250219` / `claude-3-7-sonnet-latest` *(Hybrid Reasoning & Extended Thinking)*
  * `claude-3-5-sonnet-20241022` / `claude-3-5-sonnet-latest`
  * `claude-3-5-haiku-20241022` & `claude-3-opus-20240229`
* **Google Gemini:**
  * `gemini-2.5-pro` & `gemini-2.5-flash` *(Deep Clinical Synthesis & Reasoning)*
  * `gemini-2.0-flash` & `gemini-2.0-flash-thinking-exp-01-21`
  * `gemini-1.5-pro` & `gemini-1.5-flash`
* **Custom Model Identifier:** Enter any custom model string or private fine-tune checkpoint!
* **Thinking Token Budgets:** Configurable from 1k up to 32k tokens with an interactive **🧠 Clinical Reasoning Process** viewer.
* **Zero Telemetry / Privacy First:** API keys are stored strictly in your browser's local storage. Only numeric aggregate metrics are transmitted.

---

## ⚙️ Hardware Setup & Provisioning

### Recommended Hardware
* **ESP32-C6-DevKitC-1** ($6–10) — Recommended for **WiFi 6 (802.11ax)** with 242 subcarriers (5× higher spatial resolution).
* **ESP32-S3-DevKitC-1** ($5–8) — 52 subcarriers (WiFi 4 / 802.11n).

### Firmware & Provisioning
The boards run the open-source **[RuView](https://github.com/ruvnet/RuView)** CSI firmware.

To flash and provision WiFi credentials and target bridge IP without reflashing:
```bash
cd RuView/firmware/esp32-csi-node
python provision.py --port COMx --chip esp32c6 --ssid "YourWiFi" --password "YourPassword" --target-ip 192.168.1.XXX --node-id 1
```

### Sensor Placement Tips
* **Bedside Table:** Place 1–3 meters from the sleeper at mattress height (~0.5–1m).
* **Line of Sight:** Position the WiFi router on the opposite side of the bed from the sensor.
* **Auto-Calibration:** Sensor auto-calibrates for 60 seconds upon boot — keep the room clear during this initial window.

---

## 🛠 Command Line Reference

```
usage: bridge.py [-h] [--port PORT] [--http-port HTTP_PORT] [--host HOST]
                 [--db DB] [--simulate] [--open] [--node-id NODE_ID]
                 [--config CONFIG] [--verbose] [--mqtt-host MQTT_HOST]
                 [--mqtt-port MQTT_PORT] [--mqtt-user MQTT_USER]
                 [--mqtt-pass MQTT_PASS] [--mqtt-prefix MQTT_PREFIX]
                 [--webhook-url WEBHOOK_URL]
```

| Flag | Default | Description |
|---|---|---|
| `--simulate` | off | Run demo mode with synthetic vitals and motion |
| `--open` | off | Automatically open default browser on launch |
| `--port` | `5005` | UDP port for incoming ESP32 packets |
| `--http-port` | `8080` | Local HTTP web server port |
| `--host` | `127.0.0.1` | Bind address (`0.0.0.0` for local network access) |
| `--db` | `vitals.db` | Path to SQLite database file |
| `--mqtt-host` | none | MQTT broker host for Home Assistant Auto-Discovery |
| `--mqtt-port` | `1883` | MQTT broker port |
| `--webhook-url`| none | Emergency alert webhook URL |

---

## 📁 Repository Structure

```
cu-sleep/
├── bridge/
│   ├── bridge.py           # Core UDP listener, apnea detector, batcher & orchestrator
│   ├── mqtt_publisher.py   # Zero-dependency Home Assistant MQTT Auto-Discovery publisher
│   ├── local_server.py     # Threaded HTTP server, REST API, SSE streaming, AI proxy & exports
│   ├── storage.py          # SQLite database storage driver
│   ├── config.json         # Runtime defaults and threshold settings
│   └── README.md           # Backend API documentation
├── public/                 # Standalone web app (CU SLEEP & CU MOVE)
│   ├── index.html          # Web entrypoint
│   ├── css/style.css       # Complete application styling & dark medical theme
│   ├── vendor/chart.js     # Locally vendored Chart.js 4 for offline operation
│   └── js/
│       ├── app.js          # SPA router and global heartbeat
│       ├── components/     # Header (dual mode switcher, simulation toggle, status)
│       ├── services/       # AI service, API client, session management, Web Audio
│       └── pages/
│           ├── live.js     # CU SLEEP live vitals monitor
│           ├── report.js   # CU SLEEP nightly sleep report & CSV/JSON export
│           ├── history.js  # CU SLEEP multi-night longitudinal trends
│           ├── sensing.js  # CU MOVE spatial radar, 2D mesh, & respiration oscilloscope
│           ├── setup.js    # ESP32 flashing, Home Assistant MQTT & Webhook settings
│           └── info.js     # Technical background & CSI sensing physics
├── start.bat               # 1-click Windows launcher (Hardware mode)
├── start-demo.bat          # 1-click Windows launcher (Simulated demo mode)
└── README.md               # Main project documentation
```

---

## 🔒 Privacy & Security

* **100% Local Processing:** Signal processing, feature extraction, and SQLite storage occur entirely on your local machine.
* **No Telemetry / No Accounts:** Zero outbound telemetry or metrics collection.
* **Air-Gapped Operation:** The system runs completely offline without internet connectivity.
* **Protected Credentials:** WiFi passwords stay on the microcontrollers; API keys remain securely inside your browser's `localStorage`.

---

## 📄 License & Acknowledgements

* Core WiFi CSI capture and edge signal processing built upon the **[RuView](https://github.com/ruvnet/RuView)** platform by `ruvnet`.
* Distributed under the **Apache-2.0 License**. See `LICENSE` for details.

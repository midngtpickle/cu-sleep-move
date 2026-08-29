# 🌙 CU SLEEP — WiFi Sleep Monitor

**Contactless sleep and vitals monitoring from WiFi Channel State Information (CSI), using an ESP32-C6, a single Python process, and a local SQLite database.**

> ⚠️ **RESEARCH & EDUCATIONAL USE ONLY — NOT A MEDICAL DEVICE**
> *Not FDA-cleared or CE-marked. Do not use it as a substitute for professional medical advice, diagnosis, or treatment.*

---

## Running it on Windows

### Before your first run

You need **Python 3.9 or newer**. Nothing else — no `pip install`, no accounts,
no internet connection. Check what you have by opening a terminal and typing:

```bash
python --version
```

If that prints an error, install Python from [python.org](https://www.python.org/downloads/)
and tick **"Add Python to PATH"** during setup.

---

### Try it with no hardware (Demo Simulation)

You can run the whole system on fake data to explore charts, reports, and events without any hardware:

* **Easiest:** Double-click `start-demo.bat` in the project root folder.
* **Or inside the app:** Start `start.bat` and click the **"Demo Mode"** button in the top navigation bar or on the Live page.
* **Or via command line:**
  ```bash
  cd bridge
  python bridge.py --simulate --open
  ```

`--open` launches the dashboard in your browser automatically. Press
**Ctrl+C** in the terminal when you're done.

---

### Running it for real

**Step 1 — Power the sensors.** Plug each ESP32-C6 into any USB power source:
your laptop, a phone charger, a power bank. They do not need to be connected to
your computer — their WiFi details are already stored on the board, so they
join the network and start sending on their own about 8 seconds after power-up.

**Step 2 — Start the bridge.**

* **Easiest:** Double-click `start.bat` in the project root folder.
* **Or via command line:**
  ```bash
  cd bridge
  python bridge.py --open
  ```

(Leave off `--simulate` — that's the flag that generates fake data.)

**Step 3 — Check it's working.** The terminal prints one line per reading:

```
23:37:02  node-01  BR:  16.9 BPM  HR:  48.2 BPM  RSSI:  -51dBm  AHI:  —   Events: 0
```

The dashboard is at **http://localhost:8080** and the header should read
**Live** with a white dot. If it says Offline, the bridge isn't receiving —
see Troubleshooting below.

**Step 4 — Stop it with Ctrl+C.**

> **Stop it properly.** `Ctrl+C` in the terminal flushes the last readings to
> disk and closes the night's session. Closing the window with the X button
> skips that. The bridge repairs a session left open this way on next start,
> but you lose the final minute or two.

---

### The nightly routine

**One run of the bridge is one night.** That is the whole model — there is no
"start recording" button.

| When | What you do |
|---|---|
| Bedtime | `cd bridge` then `python bridge.py` |
| Morning | `Ctrl+C` in that terminal |
| Any time after | Open http://localhost:8080 and look at **Report** |

Last night appears in the **Report** tab's night picker, and joins the
**History** trends once you've stopped the bridge.

If you stop and restart within 20 minutes — you changed a setting, or closed
the wrong window — it rejoins the same night rather than splitting it in two.

---

### Useful flags

| Flag | What it does |
|---|---|
| `--simulate` | Fake vitals, no hardware needed |
| `--open` | Open the dashboard in your browser on startup |
| `--verbose` | Show every batch write and each packet skipped — use this when tuning |
| `--http-port 8081` | Serve the dashboard on a different port |
| `--host 0.0.0.0` | Let other devices on your network view the dashboard |
| `--db mynight.db` | Use a different database file |

Full list: `python bridge.py --help`

> **On `--host 0.0.0.0`:** the dashboard has no password. Binding to all
> interfaces lets anyone on your WiFi read your breathing and heart-rate
> history. The default keeps it on this machine only.

---

### Troubleshooting

**"python is not recognized"** — Python isn't on your PATH. Reinstall from
python.org with "Add Python to PATH" ticked, or try `py bridge.py` instead.

**"Could not bind 127.0.0.1:8080"** — something else is using that port. Use
`python bridge.py --http-port 8081` and open `http://localhost:8081`.

**A Windows Firewall prompt appears on first run** — click **Allow**. The
bridge needs to receive UDP on port 5005 from your sensors. If you dismissed
it, the sensors' data will never arrive and the dashboard stays on Offline.

**Header says Offline, or "Waiting for data…"** — work through it in order:

1. Are the sensors powered? Look for a lit LED.
2. Is the bridge printing reading lines? If not, no packets are arriving.
3. Did you allow the firewall prompt?
4. Are the sensors on the same WiFi network as this computer?
5. Has your computer's IP changed? The sensors send to a fixed address —
   see *Re-provisioning* below.

**Nothing in Report** — a night only appears once it has recorded at least one
full minute, and only joins History once you've stopped the bridge.

---

### Re-provisioning a sensor

The sensors store your WiFi name, password, and your computer's IP address on
the board itself. You only need to redo this if you **change WiFi network**, or
if **your computer's IP address changes**.

Find your current IP:

```bash
ipconfig
```

Look for **IPv4 Address** under your WiFi adapter. Then connect the sensor by
USB and run, from the `RuView/firmware/esp32-csi-node` folder:

```bash
python provision.py --port COM6 --chip esp32c6 --ssid "YourWiFi" --password "YourPassword" --target-ip 192.168.1.63 --node-id 1
```

Replace `COM6` with the sensor's port (check Device Manager under **Ports**),
and give each sensor a **different** `--node-id`. This writes settings only —
it does not reflash the firmware.

> **Tip:** use the USB port on the board marked **UART**, not the one marked
> USB. The UART port handles the reset signalling automatically, so you never
> need to hold down BOOT or RESET.

---

## What it does

* **Contactless respiration** — breathing rate (6–30 RPM) from 0.1–0.5 Hz subcarrier phase variance. No wearables.
* **Resting heart rate** — 40–120 BPM, and the overnight dip that tracks autonomic recovery.
* **Apnea detection** — flags breathing flatlines over 10 s and derives a nightly Apnea-Hypopnea Index.
* **Presence and motion** — room state (*Quiet*, *Ambient*, *Active*, *Agitated*), occupancy, fall events, idle tracking.
* **Nightly reports** — one run of the bridge is one night. Start it at bedtime, stop it in the morning, and it appears as a session with overnight charts and summary statistics.
* **Sensing console** — a live pulse field, 30-minute activity heatstrip, and event log covering falls, activity bursts, idle thresholds and calibration drift, with optional browser notifications.
* **Optional AI analysis** — bring your own Google Gemini key to generate a clinical-style write-up of a night. Off by default; only numeric aggregates are ever sent.

Everything runs and stays on your machine. The only outbound request the app can
make is to Gemini, and only when you add a key and click Analyze.

---

## Architecture

```
                    ┌────────────────────────┐
                    │   ESP32-C6 Sensor      │  (RuView CSI firmware, or --simulate)
                    └───────────┬────────────┘
                                │ UDP @ 1 Hz (32-byte vitals packet)
                                ▼
                    ┌────────────────────────┐
                    │      bridge.py         │  apnea detection · batching ·
                    │  (Python stdlib only)  │  semantic state derivation
                    └─────┬────────────┬─────┘
                          │            │
                  writes  │            │  serves
                          ▼            ▼
                 ┌────────────┐   http://localhost:8080
                 │ vitals.db  │   ├── dashboard (static files)
                 │  (SQLite)  │   ├── JSON API  (/api/…)
                 └────────────┘   └── SSE live stream
                                          │
                                          ▼
                                 ┌────────────────────┐
                                 │  Vanilla JS SPA    │
                                 │  + Chart.js        │
                                 └────────────────────┘
```

One process, one database file, one port.

---

## Tech stack

| Layer | Technology |
|---|---|
| **Sensor** | ESP32-C6 DevKit running [RuView](https://github.com/ruvnet/RuView) CSI firmware |
| **Bridge & server** | Python 3.9+, standard library only (`socket`, `sqlite3`, `http.server`) |
| **Storage** | SQLite — a single `vitals.db` file |
| **Transport** | UDP in, Server-Sent Events + JSON out |
| **Frontend** | HTML5 / CSS3 / ES modules, Chart.js 4 (vendored locally) |
| **AI (optional)** | Google Gemini `gemini-1.5-flash`, key stored in your browser |

---

## Project structure

```
cu-wifi-sleep-monitor/
├── bridge/
│   ├── bridge.py           # UDP listener, apnea detection, batching, orchestration
│   ├── storage.py          # SQLite storage behind a BaseStorage interface
│   ├── local_server.py     # Threaded HTTP server: static files + JSON API + SSE
│   ├── config.json         # Ports, thresholds, simulation settings
│   └── README.md           # API contract, schema, flags, troubleshooting
├── public/                 # The dashboard, served by the bridge
│   ├── index.html
│   ├── css/style.css
│   ├── vendor/             # Chart.js, vendored so the app works offline
│   └── js/
│       ├── app.js          # Hash router
│       ├── services/       # api.js (HTTP contract), sessions.js, vitals.js, gemini.js,
│       │                   #   notifications.js
│       ├── pages/          # live, report, history, sensing, setup, info
│       └── components/     # header, chart, stats-card, settings
└── README.md
```

---

## Flashing the ESP32-C6

```bash
git clone https://github.com/ruvnet/RuView.git
cd RuView/firmware/esp32-csi-node
idf.py set-target esp32c6 && idf.py build
idf.py -p COMx flash

# Point the node at the machine running the bridge
python provision.py --port COMx --ssid "YourWiFi" --password "YourPassword" --target-ip <BRIDGE_IP>
```

The in-app **Setup** page walks through this with placement guidance and troubleshooting.

---

## Attribution & Acknowledgments

This project builds upon and integrates work from the open-source community:

* **[RuView](https://github.com/ruvnet/RuView)** by [rUv](https://github.com/ruvnet) — ESP32-C6 Channel State Information (CSI) firmware, signal processing, and vital signs extraction algorithms (Licensed under MIT).
* **[Chart.js](https://www.chartjs.org/)** — Open-source HTML5 charting library used for data visualization (Licensed under MIT).

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.


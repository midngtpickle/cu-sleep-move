/**
 * Setup Guide Page — ESP32-C6 flash & bridge instructions
 * WiFi Sleep Monitor
 */

export async function renderSetup(container) {
  container.innerHTML = `
    <div class="setup-page">
      <h1 class="page-title">Setup Guide</h1>
      <p class="page-subtitle">Get your WiFi Sleep Monitor running in 5 steps.</p>

      <!-- Step 1 -->
      <details class="setup-section" open>
        <summary class="setup-heading">
          <span class="step-number">01</span>
          Flash ESP32-C6 Firmware
        </summary>
        <div class="setup-body">
          <p>The ESP32-C6 runs the <a href="https://github.com/ruvnet/RuView" target="_blank" rel="noopener">RuView</a> firmware which captures WiFi CSI data and extracts vital signs on-device.</p>

          <h4>Prerequisites</h4>
          <ul>
            <li>ESP32-C6-DevKitC-1 board ($6–10)</li>
            <li>USB-C cable</li>
            <li><a href="https://docs.espressif.com/projects/esp-idf/en/latest/esp32c6/get-started/" target="_blank">ESP-IDF v5.4+</a> installed, OR Docker</li>
            <li><a href="https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers" target="_blank">CP210x USB driver</a></li>
          </ul>

          <h4>Build &amp; Flash (Docker — recommended)</h4>
          <div class="code-block">
            <pre><code># Clone RuView
git clone https://github.com/ruvnet/RuView.git
cd RuView

# Build for ESP32-C6 via Docker
MSYS_NO_PATHCONV=1 docker run --rm \\
  -v "$(pwd)/firmware/esp32-csi-node:/project" -w /project \\
  espressif/idf:v5.4 bash -c \\
  "rm -rf build sdkconfig && idf.py set-target esp32c6 && idf.py build"

# Flash (replace COMx with your port)
python -m esptool --chip esp32c6 --port COMx --baud 460800 \\
  write_flash --flash_mode dio --flash_size 4MB \\
  0x0    firmware/esp32-csi-node/build/bootloader/bootloader.bin \\
  0x8000 firmware/esp32-csi-node/build/partition_table/partition-table.bin \\
  0xf000 firmware/esp32-csi-node/build/ota_data_initial.bin \\
  0x20000 firmware/esp32-csi-node/build/esp32-csi-node.bin</code></pre>
          </div>

          <h4>Build &amp; Flash (Native ESP-IDF)</h4>
          <div class="code-block">
            <pre><code>cd RuView/firmware/esp32-csi-node
idf.py set-target esp32c6
idf.py build
idf.py -p COMx flash</code></pre>
          </div>
        </div>
      </details>

      <!-- Step 2 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">02</span>
          Configure WiFi Credentials
        </summary>
        <div class="setup-body">
          <p>Use the provisioning script to set your WiFi network and bridge IP without reflashing:</p>

          <div class="code-block">
            <pre><code>python firmware/esp32-csi-node/provision.py \\
  --port COMx \\
  --ssid "YourWiFiNetwork" \\
  --password "YourPassword" \\
  --target-ip 192.168.1.XXX</code></pre>
          </div>

          <p>Replace <code>192.168.1.XXX</code> with the local IP of the machine running the bridge (your laptop or Raspberry Pi).</p>

          <div class="info-box">
            <strong>Tip:</strong> Find your local IP with <code>ipconfig</code> (Windows) or <code>hostname -I</code> (Linux/Pi).
          </div>
        </div>
      </details>

      <!-- Step 3 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">03</span>
          Set Up the Python Bridge
        </summary>
        <div class="setup-body">
          <p>The bridge does everything: it listens for UDP packets from the ESP32-C6, stores readings in a local SQLite database, and serves this dashboard. It uses only the Python standard library — there is nothing to install and no account to create.</p>

          <div class="info-box">
            <strong>Requirements:</strong> Python 3.9 or newer. That's it.
          </div>

          <h4>Run with Simulated Data (Test Mode)</h4>
          <div class="code-block">
            <pre><code>cd bridge
python bridge.py --simulate --open</code></pre>
          </div>

          <h4>Run with Real ESP32-C6</h4>
          <div class="code-block">
            <pre><code>cd bridge
python bridge.py --port 5005 --node-id node-01</code></pre>
          </div>

          <h4>Where the Data Lives</h4>
          <p>Everything is written to <code>bridge/vitals.db</code>, a single SQLite file on this machine. Nothing is uploaded anywhere. Back it up by copying that one file; delete it to start fresh.</p>

          <h4>Useful Flags</h4>
          <ul>
            <li><code>--open</code> — launch the dashboard in your browser on startup</li>
            <li><code>--http-port 8081</code> — serve on a different port if 8080 is taken</li>
            <li><code>--host 0.0.0.0</code> — let other devices on your network view the dashboard (they can then read your vitals data, so only do this on a network you trust)</li>
            <li><code>--verbose</code> — log every batch write and dropped packet</li>
          </ul>
        </div>
      </details>

      <!-- Step 4 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">04</span>
          Sensor Placement
        </summary>
        <div class="setup-body">
          <p>Position for optimal sleep sensing:</p>

          <div class="placement-diagram">
            <div class="placement-grid">
              <div class="placement-item router">
                <span class="placement-icon">📡</span>
                <span>WiFi Router/AP</span>
              </div>
              <div class="placement-item bed">
                <span class="placement-icon">🛏️</span>
                <span>You (sleeping)</span>
              </div>
              <div class="placement-item sensor">
                <span class="placement-icon">◉</span>
                <span>ESP32-C6</span>
              </div>
            </div>
          </div>

          <ul>
            <li><strong>Distance:</strong> ESP32-C6 should be 1–3 meters from you</li>
            <li><strong>Position:</strong> On a bedside table, elevated ~0.5–1m (bed height)</li>
            <li><strong>Router:</strong> Ideally on the opposite side of the bed from the ESP32</li>
            <li><strong>Avoid:</strong> Metal bed frames directly between sensor and router</li>
            <li><strong>Calibration:</strong> The sensor auto-calibrates for 60 seconds at boot — leave the room empty during this period</li>
          </ul>

          <div class="info-box">
            <strong>WiFi 6 Bonus:</strong> If your router supports 802.11ax (WiFi 6), the ESP32-C6 gets 242 subcarriers instead of 52 — nearly 5× more spatial resolution for detecting subtle chest movements.
          </div>
        </div>
      </details>

      <!-- Step 5 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">05</span>
          First Night Calibration
        </summary>
        <div class="setup-body">
          <ol>
            <li>Start the bridge: <code>python bridge.py</code></li>
            <li>Open this dashboard — go to the <a href="#/live">Live Monitor</a></li>
            <li>Verify you see "Live" status and real-time breathing/heart rate numbers</li>
            <li>Leave the system running overnight</li>
            <li>Check the <a href="#/report">Sleep Report</a> the next morning</li>
          </ol>

          <div class="info-box warning">
            <strong>Important:</strong> The first night may show noisy data as the system learns your environment. Accuracy improves over 2–3 nights.
          </div>
        </div>
      </details>

      <!-- Troubleshooting -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">??</span>
          Troubleshooting
        </summary>
        <div class="setup-body">
          <h4>ESP32 not detected</h4>
          <ul>
            <li>Install the <a href="https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers" target="_blank">CP210x driver</a></li>
            <li>Try a different USB cable (some are charge-only)</li>
            <li>Check Device Manager (Windows) for the COM port</li>
          </ul>

          <h4>Bridge says "No packets received"</h4>
          <ul>
            <li>Verify the ESP32 is on the same WiFi network</li>
            <li>Check the <code>--target-ip</code> in provision matches the bridge machine</li>
            <li>Try running <code>--simulate</code> mode to verify the database and dashboard work</li>
          </ul>

          <h4>Dashboard says "Waiting for data…"</h4>
          <ul>
            <li>Make sure the bridge is running (its console prints a line per reading)</li>
            <li>Check the browser console and the bridge console for errors</li>
            <li>Confirm the header status reads <strong>Live</strong>, not Offline</li>
          </ul>

          <h4>Ghost detections (presence when room is empty)</h4>
          <ul>
            <li>Power-cycle the ESP32 in an empty room to recalibrate (60s)</li>
            <li>Move the sensor away from fans, microwaves, or other RF sources</li>
            <li>Strong RF interference can cause false positives</li>
          </ul>

          <h4>Raspberry Pi Zero Setup</h4>
          <div class="code-block">
            <pre><code># On the Pi Zero (Raspberry Pi OS Lite)
sudo apt update && sudo apt install -y python3

# Copy bridge files and the web app to the Pi
scp -r bridge/ public/ pi@raspberrypi.local:~/sleep-monitor/

# Run it, reachable from other devices on the LAN
python3 bridge.py --host 0.0.0.0

# Run as a service (optional)
# Create /etc/systemd/system/sleep-bridge.service</code></pre>
          </div>
        </div>
      </details>

      <!-- Future: Mesh -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">⊕</span>
          Adding More Nodes (Mesh)
        </summary>
        <div class="setup-body">
          <p>The system supports multiple ESP32-C6 nodes. Each node gets a unique ID and sends data independently to the bridge.</p>
          <ol>
            <li>Flash each additional ESP32-C6 with the same firmware</li>
            <li>Provision each with a unique <code>--node-id</code> (e.g., <code>node-02</code>, <code>node-bedroom</code>)</li>
            <li>The bridge automatically separates data by node ID</li>
            <li>Use the node selector dropdown in the dashboard to switch views</li>
          </ol>
          <p>With 3–6 nodes, the system creates a <strong>multistatic mesh</strong> that can resolve 3D position with higher accuracy.</p>
        </div>
      </details>

      <!-- Gemini AI Settings -->
      <details class="setup-section" id="gemini-setup-section">
        <summary class="setup-heading">
          <span class="step-number">✦</span>
          Optional: Gemini AI Sleep Analyst
        </summary>
        <div class="setup-body">
          <p>Enable automated, clinical-style AI analysis of your sleep sessions by providing a Google AI Studio API key.</p>
          <ol>
            <li>Get a free Gemini API key from <a href="https://aistudio.google.com/" target="_blank" rel="noopener">Google AI Studio</a>.</li>
            <li>Paste your key in the input field below.</li>
            <li>The key will be saved <strong>locally</strong> in your browser's secure <code>localStorage</code> and is only sent directly to Google's API to analyze your vitals data.</li>
          </ol>
          
          <div class="info-box">
            <strong>Privacy Note:</strong> Sleep analysis transmits only numeric aggregates (vital ranges, duration, apnea counts) to the Gemini API. No names, email addresses, or other PII are sent.
          </div>

          <div style="margin-top: var(--sp-4);">
            <label for="gemini-key-input" style="display: block; font-size: var(--fs-xs); color: var(--mid); margin-bottom: var(--sp-2); text-transform: uppercase; letter-spacing: 0.05em;">Gemini API Key</label>
            <div style="display: flex; gap: var(--sp-2); max-width: 500px;">
              <input type="password" id="gemini-key-input" placeholder="Paste AI Studio Key (AIzaSy...)" style="flex: 1; background: var(--dark-1); border: var(--border-default); border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3); color: var(--white); font-family: var(--font-mono); font-size: var(--fs-sm);" />
              <button id="gemini-save-btn" class="btn btn-primary">Save</button>
            </div>
            <div style="margin-top: var(--sp-3); display: flex; gap: var(--sp-2); align-items: center;">
              <button id="gemini-test-btn" class="btn">Test Key</button>
              <button id="gemini-clear-btn" class="btn btn-danger">Clear Key</button>
              <span id="gemini-status-msg" style="font-size: var(--fs-xs); font-family: var(--font-mono); margin-left: var(--sp-2);"></span>
            </div>
          </div>
        </div>
      </details>
    </div>
  `;

  // Bind Gemini AI Settings logic
  const keyInput = document.getElementById('gemini-key-input');
  const saveBtn = document.getElementById('gemini-save-btn');
  const testBtn = document.getElementById('gemini-test-btn');
  const clearBtn = document.getElementById('gemini-clear-btn');
  const statusMsg = document.getElementById('gemini-status-msg');

  // Load service helpers
  const { getStoredApiKey, setStoredApiKey, clearStoredApiKey, testGeminiKey } = await import('../services/gemini.js');

  // Initial load
  const storedKey = getStoredApiKey();
  if (storedKey) {
    if (keyInput) keyInput.value = storedKey;
    showStatus('Key configured & saved.', 'var(--white)');
  } else {
    showStatus('No key configured.', 'var(--mid)');
  }

  function showStatus(text, color) {
    if (statusMsg) {
      statusMsg.textContent = text;
      statusMsg.style.color = color;
    }
  }

  saveBtn?.addEventListener('click', () => {
    const key = keyInput ? keyInput.value.trim() : '';
    if (!key) {
      showStatus('Please enter a key.', 'var(--alert-red)');
      return;
    }
    setStoredApiKey(key);
    showStatus('Key saved successfully.', 'var(--white)');
  });

  testBtn?.addEventListener('click', async () => {
    const key = keyInput ? keyInput.value.trim() : '';
    if (!key) {
      showStatus('Enter a key to test.', 'var(--alert-red)');
      return;
    }
    showStatus('Testing connection...', 'var(--mid)');
    testBtn.disabled = true;
    try {
      const working = await testGeminiKey(key);
      if (working) {
        showStatus('Connection successful! Key is valid.', 'var(--white)');
      } else {
        showStatus('API did not return success response.', 'var(--alert-red)');
      }
    } catch (err) {
      showStatus(`Error: ${err.message}`, 'var(--alert-red)');
    } finally {
      testBtn.disabled = false;
    }
  });

  clearBtn?.addEventListener('click', () => {
    clearStoredApiKey();
    if (keyInput) keyInput.value = '';
    showStatus('Key cleared.', 'var(--mid)');
  });
}

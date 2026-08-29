/**
 * Info Page — Technical explanation of WiFi CSI Sleep Monitoring
 * WiFi Sleep Monitor
 */

export async function renderInfo(container) {
  container.innerHTML = `
    <div class="setup-page">
      <h1 class="page-title">System Information</h1>
      <p class="page-subtitle">Understand how WiFi Channel State Information (CSI) monitors sleep and vitals contactlessly.</p>

      <div class="info-box">
        <strong>Zero-Wearable Technology:</strong> This system uses ordinary Wi-Fi signals to track your sleep. As radio waves bounce off your body, the microscopic chest movements from breathing and heartbeats cause tiny changes in the signal. By analyzing these fluctuations, we extract vital signs and detect sleep apnea without any wearables, cameras, or under-mattress sensors.
      </div>

      <!-- What we measure cards -->
      <h3 style="color: var(--white); margin: var(--sp-6) 0 var(--sp-3); font-size: var(--fs-md); font-weight: 600;">What We Measure</h3>
      <div class="stats-grid" style="margin-bottom: var(--sp-8);">
        <div class="stat-card">
          <span class="stat-label">RESPIRATION RATE</span>
          <span class="stat-value" style="font-size: var(--fs-lg); font-weight: 700; margin: var(--sp-2) 0; display: block; color: var(--white);">Breathing (RPM)</span>
          <span class="stat-sub">Normal sleeping respiration is 12–20 Breaths Per Minute.</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">CARDIAC PULSE</span>
          <span class="stat-value" style="font-size: var(--fs-lg); font-weight: 700; margin: var(--sp-2) 0; display: block; color: var(--white);">Heart Rate (BPM)</span>
          <span class="stat-sub">Extracted via micro-vibrations from cardiac contractions (40–100 BPM).</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">APNEA SCREENING</span>
          <span class="stat-value" style="font-size: var(--fs-lg); font-weight: 700; margin: var(--sp-2) 0; display: block; color: var(--white);">AHI Index</span>
          <span class="stat-sub">The average number of breathing pauses (10s+) detected per hour.</span>
        </div>
      </div>

      <!-- Technical Breakdown Accordion -->
      <h3 style="color: var(--white); margin: var(--sp-6) 0 var(--sp-3); font-size: var(--fs-md); font-weight: 600;">How It Works</h3>
      
      <!-- Section 1 -->
      <details class="setup-section" open>
        <summary class="setup-heading">
          <span class="step-number">01</span>
          WiFi Channel State Information (CSI)
        </summary>
        <div class="setup-body">
          <p>
            When a WiFi transmitter (router) sends a signal to a receiver (ESP32-C6), the radio waves propagate through the environment. These waves reflect off walls, ceilings, furniture, and your body before reaching the receiver's antenna.
          </p>
          <p>
            <strong>Channel State Information (CSI)</strong> is a fine-grained measurement that details how these radio waves were scattered, reflected, and attenuated along the path. CSI provides data for individual subcarriers (subchannels) of the wireless link, reporting both the amplitude and the phase of the signal.
          </p>
          <p>
            When a person lies in bed, their chest rises and falls due to breathing, and their chest wall displaces minutely due to heartbeats (a phenomenon known as ballistocardiography). These sub-millimeter movements alter the path lengths of the reflected WiFi waves, creating cyclical fluctuations in the CSI phase and amplitude.
          </p>
        </div>
      </details>

      <!-- Section 2 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">02</span>
          The ESP32-C6 Wi-Fi 6 Advantage
        </summary>
        <div class="setup-body">
          <p>
            Older WiFi standards (like Wi-Fi 4 / 802.11n) utilize fewer subcarriers (52 subcarriers in 20MHz bandwidth). The <strong>ESP32-C6</strong> supports <strong>Wi-Fi 6 (802.11ax)</strong>.
          </p>
          <p>
            Under Wi-Fi 6, the High Efficiency Long Training Field (HE-LTF) provides up to <strong>242 subcarriers</strong> in a 20MHz channel (nearly 5× increase in spatial resolution). This dense array of subcarriers acts like a high-density sensory grid, enabling the system to isolate and track very subtle movements—such as the heart beating—even in the presence of static clutter.
          </p>
        </div>
      </details>

      <!-- Section 3 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">03</span>
          Signal Processing Pipeline
        </summary>
        <div class="setup-body">
          <p>
            The raw CSI data is processed on-device (within the ESP32-C6 firmware) and finalized on the Python bridge. The pipeline consists of the following stages:
          </p>
          <ol>
            <li><strong>Subcarrier Selection:</strong> The system automatically evaluates all subcarriers and selects a subset (Top-K) that exhibit the highest phase variance corresponding to breathing movement.</li>
            <li><strong>Phase Unwrapping:</strong> Standardizes phase jumps to construct a clean, continuous signal representing physical movement.</li>
            <li><strong>Bandpass Filtering:</strong> 
              <ul>
                <li>To extract <strong>Breathing Rate</strong>, the signal is passed through a biquad IIR bandpass filter tuned to 0.1–0.5 Hz (6–30 BPM).</li>
                <li>To extract <strong>Heart Rate</strong>, the signal is passed through a biquad IIR bandpass filter tuned to 0.8–2.0 Hz (48–120 BPM).</li>
              </ul>
            </li>
            <li><strong>Rate Estimation:</strong> A zero-crossing detection algorithm or autocorrelation is applied to the filtered waveforms to determine the exact frequency in cycles per minute.</li>
          </ol>
        </div>
      </details>

      <!-- Section 4 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">04</span>
          Sleep Apnea &amp; AHI Scoring
        </summary>
        <div class="setup-body">
          <p>
            Sleep Apnea is characterized by pauses in breathing (apnea) or shallow breathing (hypopnea) during sleep.
          </p>
          <h4>Apnea Detection</h4>
          <p>
            The system monitors the breathing waveform amplitude and rate. If the breathing rate drops below 6 RPM or if the variance of the respiration signal flatlines for <strong>10 seconds or longer</strong>, the system flags an <strong>Apnea Event</strong>.
          </p>
          <h4>Apnea-Hypopnea Index (AHI)</h4>
          <p>
            AHI is calculated as the average number of apnea events per hour of sleep. Clinical classifications are as follows:
          </p>
          <ul>
            <li><strong>Normal:</strong> AHI &lt; 5 events per hour</li>
            <li><strong>Mild Apnea:</strong> AHI of 5 to 15 events per hour</li>
            <li><strong>Moderate Apnea:</strong> AHI of 15 to 30 events per hour</li>
            <li><strong>Severe Apnea:</strong> AHI &gt; 30 events per hour</li>
          </ul>
          <h4>Sleep Quality Heuristic</h4>
          <p>
            The overnight report assigns a Sleep Quality Score (0–100%) based on a combined index: total sleep time, vital sign stability, presence of restlessness, and a penalty scaled to the AHI.
          </p>
        </div>
      </details>

      <!-- Section 5 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">05</span>
          CU MOVE — Spatial Motion Radar &amp; Oscilloscope
        </summary>
        <div class="setup-body">
          <p>
            <strong>CU MOVE</strong> extends the platform beyond overnight sleep monitoring into a real-time spatial intelligence console:
          </p>
          <ul>
            <li><strong>Respiration Oscilloscope:</strong> Renders a high-frequency (60 FPS) subcarrier chest displacement waveform, allowing users to visually inspect real-time inhalation, exhalation, and breathing rhythm.</li>
            <li><strong>2D Multistatic Room Mesh:</strong> Visualizes bedroom layout, sensor node positions, and real-time localized subject position derived from multi-angle CSI ray disturbances.</li>
            <li><strong>Fall &amp; Incident Detection:</strong> Detects sudden high-energy phase velocity bursts followed by prolonged stillness on the floor, triggering an in-browser audio alarm and external webhooks.</li>
          </ul>
        </div>
      </details>

      <!-- Section 6 -->
      <details class="setup-section">
        <summary class="setup-heading">
          <span class="step-number">06</span>
          Privacy and Security
        </summary>
        <div class="setup-body">
          <p>
            Unlike smart speakers, cameras, or wearables, WiFi sensing is fundamentally private and safe:
          </p>
          <ul>
            <li><strong>No Audio or Video:</strong> The sensor captures only abstract wireless channel responses, which are mathematically impossible to reconstruct into images or voice recordings.</li>
            <li><strong>Local First:</strong> The Python bridge processes the UDP packets locally. All data is written directly to a local SQLite database on your machine with zero cloud transmission.</li>
            <li><strong>Low Power RF:</strong> WiFi radio signals operate at a maximum transmit power of 100mW, which is significantly lower than mobile phones and completely safe for 24/7 exposure.</li>
          </ul>
        </div>
      </details>

      <!-- Medical Disclaimer -->
      <div class="info-box warning" style="margin-top: var(--sp-6);">
        <strong>⚠️ Clinical Disclaimer:</strong> This application is an educational and research tool. It is <strong>NOT</strong> a certified medical device and is not intended to diagnose, treat, prevent, or monitor any medical condition, including sleep apnea. Do not use this tool as a substitute for professional clinical diagnosis.
      </div>
    </div>
  `;
}

import { subscribeLiveVitals, getNodes, resolveNodeId, startSimulation } from '../services/api.js';
import { isApnea } from '../services/vitals.js';
import { setConnectionStatus, updateSimulationUI } from '../components/header.js';
import { createTimeChart, destroyChart } from '../components/chart.js';

let unsubscribe = null;
let breathingChart = null;
let hrChart = null;
let selectedNode = 'node-01';

// Rolling buffer for waveform (last 5 minutes = 300 points at 1/sec)
const MAX_POINTS = 300;
const brBuffer = [];
const hrBuffer = [];
const tsBuffer = [];

/**
 * Render the live monitor page.
 * @param {HTMLElement} container
 */
export async function renderLive(container) {
  container.innerHTML = `
    <div class="live-page">
      <!-- Node Selector -->
      <div class="node-selector">
        <label for="node-select" class="node-label">Node</label>
        <select id="node-select" class="node-dropdown">
          <option value="node-01">Node 1 (Default)</option>
        </select>
      </div>

      <!-- Big Numbers Row -->
      <div class="vitals-hero">
        <div class="vital-big" id="vital-br">
          <div class="vital-icon">🫁</div>
          <div class="vital-number" id="br-value">—</div>
          <div class="vital-unit">BPM</div>
          <div class="vital-label">Breathing Rate</div>
        </div>

        <div class="vital-divider"></div>

        <div class="vital-big" id="vital-hr">
          <div class="vital-icon">💓</div>
          <div class="vital-number" id="hr-value">—</div>
          <div class="vital-unit">BPM</div>
          <div class="vital-label">Heart Rate</div>
        </div>

        <div class="vital-divider"></div>

        <div class="vital-big" id="vital-presence">
          <div class="vital-icon">👤</div>
          <div class="presence-dot" id="presence-indicator"></div>
          <div class="vital-label" id="presence-label">No Data</div>
        </div>
      </div>

      <!-- Breathing Waveform Chart -->
      <div class="chart-panel">
        <div class="chart-header">
          <span class="chart-title">Breathing Rate — Last 5 Minutes</span>
          <span class="chart-live-dot" id="chart-live-indicator"></span>
        </div>
        <div class="chart-container">
          <canvas id="breathing-chart"></canvas>
        </div>
      </div>

      <!-- Heart Rate Chart -->
      <div class="chart-panel">
        <div class="chart-header">
          <span class="chart-title">Heart Rate — Last 5 Minutes</span>
        </div>
        <div class="chart-container">
          <canvas id="hr-chart"></canvas>
        </div>
      </div>

      <!-- Phase Variance & Metadata -->
      <div class="meta-row">
        <div class="meta-item">
          <span class="meta-label">Phase Variance</span>
          <span class="meta-value" id="phase-var">—</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Last Update</span>
          <span class="meta-value" id="last-update">—</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Samples</span>
          <span class="meta-value" id="sample-count">0</span>
        </div>
      </div>

      <!-- Waiting State -->
      <div class="waiting-overlay" id="waiting-overlay">
        <div class="waiting-pulse"></div>
        <div class="waiting-text">Waiting for sensor data…</div>
        <div class="waiting-hint">Power on your ESP32-C6 sensor, or test with simulated vitals:</div>
        <button class="waiting-demo-btn" id="btn-start-demo-overlay">
          <span class="demo-icon">▶</span> Start Demo Mode (Simulate)
        </button>
      </div>
    </div>
  `;

  // Demo button in waiting overlay
  document.getElementById('btn-start-demo-overlay')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="demo-icon">⏳</span> Starting demo…';
    const res = await startSimulation();
    if (res?.simulating) {
      updateSimulationUI(true);
    }
  });

  // Populate node dropdown
  await populateNodes();

  // Initialize charts
  initCharts();

  // Subscribe to live data
  startSubscription();

  // Node selector change handler
  document.getElementById('node-select')?.addEventListener('change', (e) => {
    selectedNode = e.target.value;
    clearBuffers();
    stopSubscription();
    startSubscription();
  });
}

function initCharts() {
  const brCanvas = document.getElementById('breathing-chart');
  const hrCanvas = document.getElementById('hr-chart');

  if (brCanvas) {
    breathingChart = createTimeChart(brCanvas, {
      labels: [], data: [], label: 'BR (BPM)',
      yMin: 0, yMax: 35, showTimeAxis: true,
    });
  }

  if (hrCanvas) {
    hrChart = createTimeChart(hrCanvas, {
      labels: [], data: [], label: 'HR (BPM)',
      yMin: 30, yMax: 120, showTimeAxis: true,
    });
  }
}

function startSubscription() {
  unsubscribe = subscribeLiveVitals(selectedNode, onLiveData);
}

function stopSubscription() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

function clearBuffers() {
  brBuffer.length = 0;
  hrBuffer.length = 0;
  tsBuffer.length = 0;
}

async function populateNodes() {
  const nodes = await getNodes();
  const select = document.getElementById('node-select');
  if (!select || !nodes.length) return;

  // Follow whatever node actually exists rather than assuming node-01.
  selectedNode = await resolveNodeId(selectedNode);

  select.innerHTML = nodes.map(n =>
    `<option value="${n.id}"${n.id === selectedNode ? ' selected' : ''}>${n.name || n.id}</option>`
  ).join('');
}

/**
 * Handle one live vitals snapshot from the bridge.
 */
function onLiveData(data) {
  const waitingOverlay = document.getElementById('waiting-overlay');

  if (!data) {
    // No data yet
    setConnectionStatus(false, 'No Data');
    if (waitingOverlay) waitingOverlay.style.display = 'flex';
    return;
  }

  // Hide waiting overlay
  if (waitingOverlay) waitingOverlay.style.display = 'none';

  // Connection status. updated_at is UNIX epoch seconds from the bridge.
  const timestamp = data.updated_at ? new Date(data.updated_at * 1000) : new Date();
  const isStale = Date.now() - timestamp.getTime() > 10000;
  setConnectionStatus(!isStale, isStale ? 'Stale' : 'Live');

  // Update big numbers with animation
  const br = data.breathing_rate;
  const hr = data.heart_rate;
  animateValue('br-value', br);
  animateValue('hr-value', hr);

  // Presence indicator
  const hasPresence = data.presence ?? (data.motion != null ? data.motion > 0.05 : null);
  const presenceDot = document.getElementById('presence-indicator');
  const presenceLabel = document.getElementById('presence-label');
  if (presenceDot) {
    presenceDot.className = `presence-dot ${hasPresence ? 'detected' : 'absent'}`;
  }
  if (presenceLabel) {
    presenceLabel.textContent = hasPresence ? 'Detected' : 'No Presence';
  }

  // Apnea alert (handle both field names)
  const apneaActive = data.apnea_active ?? isApnea(br);
  const alertEl = document.getElementById('apnea-alert');
  if (alertEl) {
    alertEl.classList.toggle('visible', apneaActive);
  }

  // Signal confidence
  const phaseEl = document.getElementById('phase-var');
  if (phaseEl && data.confidence != null) {
    phaseEl.textContent = data.confidence.toFixed(4);
  }

  // Last update
  const updateEl = document.getElementById('last-update');
  if (updateEl) {
    updateEl.textContent = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // Update waveform buffers
  tsBuffer.push(timestamp);
  brBuffer.push(br ?? null);
  hrBuffer.push(hr ?? null);

  // Trim to max points
  while (tsBuffer.length > MAX_POINTS) {
    tsBuffer.shift();
    brBuffer.shift();
    hrBuffer.shift();
  }

  // Update sample count
  const countEl = document.getElementById('sample-count');
  if (countEl) countEl.textContent = tsBuffer.length;

  // Update charts
  updateCharts();
}

function updateCharts() {
  // Chart.js is on a category axis here (no date adapter is bundled), so labels
  // must be pre-formatted strings — raw Dates would stringify to full datestamps.
  const labels = tsBuffer.map(t =>
    t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  );

  if (breathingChart) {
    breathingChart.data.labels = labels;
    breathingChart.data.datasets[0].data = [...brBuffer];
    breathingChart.update('none');
  }

  if (hrChart) {
    hrChart.data.labels = labels;
    hrChart.data.datasets[0].data = [...hrBuffer];
    hrChart.update('none');
  }
}

/**
 * Animate a value change in a big number display.
 */
function animateValue(elementId, value) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const displayVal = value != null ? Math.round(value * 10) / 10 : '—';
  if (el.textContent !== String(displayVal)) {
    el.textContent = displayVal;
    el.classList.remove('value-flash');
    void el.offsetWidth; // Force reflow
    el.classList.add('value-flash');
  }
}

/**
 * Cleanup on page exit.
 */
export function destroyLive() {
  stopSubscription();
  destroyChart(breathingChart);
  destroyChart(hrChart);
  breathingChart = null;
  hrChart = null;
  clearBuffers();

  // Reset apnea alert
  const alertEl = document.getElementById('apnea-alert');
  if (alertEl) alertEl.classList.remove('visible');

  setConnectionStatus(false);
}

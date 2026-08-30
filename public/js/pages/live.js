import { subscribeLiveVitals, getNodes, resolveNodeId, startSimulation } from '../services/api.js';
import { isApnea } from '../services/vitals.js';
import { setConnectionStatus, updateSimulationUI } from '../components/header.js';
import { createTimeChart, destroyChart } from '../components/chart.js';

let unsubscribe = null;
let breathingChart = null;
let hrChart = null;
let selectedNode = 'node-01';
let currentChartView = 'both'; // 'both' | 'br' | 'hr'

// Rolling buffer for waveform (last 5 minutes = 300 points at 1/sec)
const MAX_POINTS = 300;
const brBuffer = [];
const hrBuffer = [];
const tsBuffer = [];

/**
 * Render the live sleep monitor page with the unified CU MOVE card & color layout.
 * @param {HTMLElement} container
 */
export async function renderLive(container) {
  container.innerHTML = `
    <div class="sense-page">
      <!-- Top KPI Strip -->
      <div class="kpi-strip">
        ${kpiCard('presence', 'Bed State', '<span class="kpi-dot absent"></span>Absent')}
        ${kpiCard('br',       'Breathing', '—')}
        ${kpiCard('hr',       'Heart Rate', '—')}
        ${kpiCard('apnea',    'Apnea Risk', 'Normal')}
        ${kpiCard('signal',   'Confidence', '0.0000')}
        ${kpiCard('node',     'Sensor Node', selectedNode)}
      </div>

      <!-- Apnea Emergency Banner -->
      <div class="fall-banner" id="live-apnea-banner">
        <span>⚠ APNEA DETECTED — Breathing rate flatline or below threshold</span>
        <button class="fall-dismiss-btn" id="dismiss-apnea-btn">Acknowledge</button>
      </div>

      <!-- Main Two-Column Layout -->
      <div class="sense-main">
        <!-- Left: Respiration & Heart Rate Dynamics Panel -->
        <div class="pulse-panel">
          <div class="pulse-header">
            <div class="pulse-header-left">
              <span class="pulse-title">LIVE VITAL DYNAMICS</span>
              <span class="pulse-sub" id="sleep-sub">Listening to WiFi CSI phase shifts…</span>
            </div>
            <div class="sense-view-tabs">
              <button class="sense-tab-btn active" id="tab-chart-both">⛶ Dual</button>
              <button class="sense-tab-btn" id="tab-chart-br">🫁 Respiration</button>
              <button class="sense-tab-btn" id="tab-chart-hr">💓 Heart Rate</button>
            </div>
          </div>

          <div class="sleep-charts-container">
            <div class="sleep-chart-box" id="box-chart-br">
              <div class="sleep-chart-subhead">
                <span>🫁 Respiration Rate (RPM)</span>
                <span id="chart-live-dot" class="chart-live-dot"></span>
              </div>
              <div class="chart-container" style="height: 180px;">
                <canvas id="breathing-chart"></canvas>
              </div>
            </div>

            <div class="sleep-chart-box" id="box-chart-hr">
              <div class="sleep-chart-subhead">
                <span>💓 Resting Heart Rate (BPM)</span>
                <span id="hr-live-sub" style="font-size: 11px; color: var(--mid); font-family: var(--font-mono);"></span>
              </div>
              <div class="chart-container" style="height: 180px;">
                <canvas id="hr-chart"></canvas>
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Clinical State Panel -->
        <div class="semantic-panel">
          <div class="semantic-header">
            <span class="semantic-title">CLINICAL STATE</span>
          </div>
          ${semanticRow('Bed Status',   'sem-bed',     'Absent')}
          ${semanticRow('Breathing',    'sem-br',      '—')}
          ${semanticRow('Heart Rate',   'sem-hr',      '—')}
          ${semanticRow('Apnea State',  'sem-apnea',   'Normal')}
          ${semanticRow('Signal Conf',  'sem-conf',    '—')}
          ${semanticRow('Last Epoch',   'sem-time',    '—')}
          ${semanticRow('Samples',      'sem-samples', '0')}
          <div class="semantic-row" style="padding-top: var(--sp-2);">
            <span class="semantic-key">Target Node</span>
            <select id="node-select" class="node-dropdown" style="background: var(--dark-1); border: var(--border-default); border-radius: var(--radius-sm); color: var(--white); font-size: 11px; padding: 2px 6px; cursor: pointer;">
              <option value="node-01">node-01</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Live Telemetry Log -->
      <div class="event-panel" style="margin-top: var(--sp-6);">
        <div class="event-header">
          <span class="event-title">LIVE TELEMETRY &amp; CLINICAL LOG</span>
          <button class="log-clear-btn" id="clear-sleep-log-btn">Clear view</button>
        </div>
        <div class="event-console" id="sleep-console">
          <div class="event-empty">Listening for live vital updates…</div>
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

  // Bind UI view switch tabs
  bindLiveTabs();

  // Subscribe to live data
  startSubscription();

  // Node selector change handler
  document.getElementById('node-select')?.addEventListener('change', (e) => {
    selectedNode = e.target.value;
    const nodeKpi = document.getElementById('kpi-node-value');
    if (nodeKpi) nodeKpi.textContent = selectedNode;
    clearBuffers();
    stopSubscription();
    startSubscription();
  });

  document.getElementById('dismiss-apnea-btn')?.addEventListener('click', () => {
    document.getElementById('live-apnea-banner')?.classList.remove('visible');
  });

  document.getElementById('clear-sleep-log-btn')?.addEventListener('click', () => {
    const c = document.getElementById('sleep-console');
    if (c) c.innerHTML = '<div class="event-empty">Cleared from view — still stored in vitals.db.</div>';
  });
}

function kpiCard(id, label, value) {
  return `
    <div class="kpi-card" id="kpi-${id}">
      <div class="kpi-value" id="kpi-${id}-value">${value}</div>
      <div class="kpi-label">${label}</div>
    </div>
  `;
}

function semanticRow(label, id, initial) {
  return `
    <div class="semantic-row">
      <span class="semantic-key">${label}</span>
      <span class="semantic-val" id="${id}">${initial}</span>
    </div>
  `;
}

function bindLiveTabs() {
  const tabBoth = document.getElementById('tab-chart-both');
  const tabBr   = document.getElementById('tab-chart-br');
  const tabHr   = document.getElementById('tab-chart-hr');
  const boxBr   = document.getElementById('box-chart-br');
  const boxHr   = document.getElementById('box-chart-hr');

  const setView = (view) => {
    currentChartView = view;
    tabBoth?.classList.toggle('active', view === 'both');
    tabBr?.classList.toggle('active', view === 'br');
    tabHr?.classList.toggle('active', view === 'hr');

    if (boxBr) boxBr.style.display = (view === 'hr') ? 'none' : 'flex';
    if (boxHr) boxHr.style.display = (view === 'br') ? 'none' : 'flex';
  };

  tabBoth?.addEventListener('click', () => setView('both'));
  tabBr?.addEventListener('click',   () => setView('br'));
  tabHr?.addEventListener('click',   () => setView('hr'));
}

function initCharts() {
  const brCanvas = document.getElementById('breathing-chart');
  const hrCanvas = document.getElementById('hr-chart');

  if (brCanvas) {
    breathingChart = createTimeChart(brCanvas, {
      labels: [], data: [], label: 'BR (RPM)',
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

  selectedNode = await resolveNodeId(selectedNode);

  select.innerHTML = nodes.map(n =>
    `<option value="${n.id}"${n.id === selectedNode ? ' selected' : ''}>${n.name || n.id}</option>`
  ).join('');

  const nodeKpi = document.getElementById('kpi-node-value');
  if (nodeKpi) nodeKpi.textContent = selectedNode;
}

let lastLoggedMinute = -1;

/**
 * Handle one live vitals snapshot from the bridge.
 */
function onLiveData(data) {
  const waitingOverlay = document.getElementById('waiting-overlay');

  if (!data) {
    setConnectionStatus(false, 'No Data');
    if (waitingOverlay) waitingOverlay.style.display = 'flex';
    return;
  }

  if (waitingOverlay) waitingOverlay.style.display = 'none';

  const timestamp = data.updated_at ? new Date(data.updated_at * 1000) : new Date();
  const isStale = Date.now() - timestamp.getTime() > 10000;
  setConnectionStatus(!isStale, isStale ? 'Stale' : 'Live');

  const sub = document.getElementById('sleep-sub');
  if (sub) sub.textContent = isStale ? 'Signal Stale — Reconnecting…' : 'Listening to WiFi CSI phase shifts…';

  const br = data.breathing_rate;
  const hr = data.heart_rate;
  const hasPresence = data.presence ?? (data.motion != null ? data.motion > 0.05 : false);
  const apneaActive = data.apnea_active ?? isApnea(br);

  // Top KPI Card updates
  setText('kpi-br-value', br != null ? `${br.toFixed(1)} RPM` : '—');
  setText('kpi-hr-value', hr != null ? `${Math.round(hr)} BPM` : '—');

  const presKpi = document.getElementById('kpi-presence-value');
  if (presKpi) {
    presKpi.innerHTML = hasPresence
      ? '<span class="kpi-dot present"></span>In Bed'
      : '<span class="kpi-dot absent"></span>Absent';
  }

  const apneaKpi = document.getElementById('kpi-apnea-value');
  if (apneaKpi) {
    apneaKpi.textContent = apneaActive ? '⚠ Apnea' : 'Normal';
    apneaKpi.style.color = apneaActive ? 'var(--alert-red)' : 'var(--white)';
  }

  const confVal = data.confidence != null ? data.confidence.toFixed(4) : (data.phase_variance != null ? data.phase_variance.toFixed(4) : '—');
  setText('kpi-signal-value', confVal);

  // Clinical State Panel updates
  setText('sem-bed', hasPresence ? 'Present (In Bed)' : 'Absent');
  setText('sem-br', br != null ? `${br.toFixed(1)} RPM` : '—');
  setText('sem-hr', hr != null ? `${Math.round(hr)} BPM` : '—');
  setText('sem-apnea', apneaActive ? 'Apnea Flatline' : 'Normal Breathing');
  setText('sem-conf', confVal);

  const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  setText('sem-time', timeStr);

  // Banner alert
  const banner = document.getElementById('live-apnea-banner');
  if (banner) {
    banner.classList.toggle('visible', !!apneaActive);
  }

  // Update buffers
  tsBuffer.push(timestamp);
  brBuffer.push(br ?? null);
  hrBuffer.push(hr ?? null);

  while (tsBuffer.length > MAX_POINTS) {
    tsBuffer.shift();
    brBuffer.shift();
    hrBuffer.shift();
  }

  setText('sem-samples', String(tsBuffer.length));

  // Live telemetry logging (every minute epoch or on apnea)
  const currentMin = timestamp.getMinutes();
  if (currentMin !== lastLoggedMinute || apneaActive) {
    lastLoggedMinute = currentMin;
    appendTelemetryLog(timeStr, apneaActive ? 'APNEA_EVENT' : 'EPOCH_RECORD',
      `BR: ${br != null ? br.toFixed(1) : '—'} RPM | HR: ${hr != null ? Math.round(hr) : '—'} BPM | Presence: ${hasPresence ? 'Occupied' : 'Empty'}`);
  }

  updateCharts();
}

function appendTelemetryLog(time, type, msg) {
  const consoleEl = document.getElementById('sleep-console');
  if (!consoleEl) return;

  const empty = consoleEl.querySelector('.event-empty');
  if (empty) empty.remove();

  const isWarn = type.includes('APNEA');
  const row = document.createElement('div');
  row.className = `event-row ${isWarn ? 'event-fall-detected' : ''}`;
  row.innerHTML = `
    <span class="event-time">${time}</span>
    <span class="event-type">${type}</span>
    <span class="event-msg">${msg}</span>
  `;

  consoleEl.insertBefore(row, consoleEl.firstChild);
  while (consoleEl.children.length > 40) {
    consoleEl.removeChild(consoleEl.lastChild);
  }
}

function updateCharts() {
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

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
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

  const alertEl = document.getElementById('live-apnea-banner');
  if (alertEl) alertEl.classList.remove('visible');

  setConnectionStatus(false);
}


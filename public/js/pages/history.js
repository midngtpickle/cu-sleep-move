/**
 * History Page — Multi-day trends
 * WiFi Sleep Monitor
 */
import { getNodes, resolveNodeId } from '../services/api.js';
import { getSessions } from '../services/sessions.js';
import { getAHISeverity, getTrend } from '../services/vitals.js';
import { statsCard } from '../components/stats-card.js';
import { createBarChart, createTimeChart, destroyChart } from '../components/chart.js';

let ahiChart = null;
let brTrendChart = null;
let hrTrendChart = null;
let selectedNode = 'node-01';

export async function renderHistory(container) {
  container.innerHTML = `
    <div class="history-page">
      <div class="report-controls">
        <div class="control-group">
          <label for="history-node" class="control-label">Node</label>
          <select id="history-node" class="node-dropdown">
            <option value="node-01">Node 1 (Default)</option>
          </select>
        </div>
        <div class="control-group">
          <div class="toggle-group" id="range-toggle">
            <button class="toggle-btn active" data-range="7">7 Days</button>
            <button class="toggle-btn" data-range="30">30 Days</button>
          </div>
        </div>
      </div>

      <div id="history-content">
        <div class="loading"><div class="loading-spinner"></div><span>Loading history…</span></div>
      </div>
    </div>
  `;

  // Populate nodes, following whatever node actually exists.
  const nodes = await getNodes();
  selectedNode = await resolveNodeId(selectedNode);
  const nodeSelect = document.getElementById('history-node');
  if (nodes.length > 0 && nodeSelect) {
    nodeSelect.innerHTML = nodes.map(n =>
      `<option value="${n.id}"${n.id === selectedNode ? ' selected' : ''}>${n.name || n.id}</option>`
    ).join('');
  }

  // Toggle handlers
  document.getElementById('range-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadHistory(parseInt(btn.dataset.range));
  });

  document.getElementById('history-node')?.addEventListener('change', (e) => {
    selectedNode = e.target.value;
    const activeRange = document.querySelector('.toggle-btn.active');
    loadHistory(parseInt(activeRange?.dataset.range || 7));
  });

  // Initial load
  await loadHistory(7);
}

async function loadHistory(days) {
  const nodeId = document.getElementById('history-node')?.value || selectedNode;
  const content = document.getElementById('history-content');
  if (!content) return;

  // `days` is a date window, not a row limit. Sessions carry a real start
  // time now, so this is a straight comparison rather than a grouping guess.
  //
  // Completed nights only. A session still recording has partial numbers, and
  // twenty minutes of a night would otherwise sit in these trends — and win
  // "best night" — against full nights of sleep. It is visible on the Report
  // page while it runs, and joins the history once you stop the bridge.
  const cutoffSec = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  const allSessions = await getSessions(nodeId, 200);
  const sessions = allSessions.filter(s =>
    s.startTime >= cutoffSec && s.minutes > 0 && s.status === 'completed');

  if (sessions.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▤</div>
        <p>No sleep sessions found for the last ${days} days.</p>
        <p class="empty-hint">Start monitoring to build your history.</p>
      </div>
    `;
    return;
  }

  // Sort sessions chronologically (oldest first for charts)
  const sorted = [...sessions].reverse();
  const dates = sorted.map(s => new Date(s.startTime * 1000)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
  const ahiValues = sorted.map(s => s.ahi ?? 0);
  const brValues = sorted.map(s => s.breathingRate?.avg ?? null);
  const hrValues = sorted.map(s => s.heartRate?.avg ?? null);
  const qualityValues = sorted.map(s => s.sleepQualityScore ?? null);

  // Compute summary stats
  const validAhi = ahiValues.filter(v => v != null && !isNaN(v));
  const validBr = brValues.filter(v => v != null);
  const validHr = hrValues.filter(v => v != null);
  const validQuality = qualityValues.filter(v => v != null);

  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;

  const avgAhi = avg(validAhi);
  const avgBr = avg(validBr);
  const avgHr = avg(validHr);
  const avgQuality = avg(validQuality);
  const bestNight = sorted.reduce((best, s) => (!best || (s.sleepQualityScore ?? 0) > (best.sleepQualityScore ?? 0)) ? s : best, null);
  const worstNight = sorted.reduce((worst, s) => (!worst || (s.sleepQualityScore ?? 100) < (worst.sleepQualityScore ?? 100)) ? s : worst, null);
  const ahiSeverity = getAHISeverity(avgAhi);

  content.innerHTML = `
    <!-- Summary Cards -->
    <div class="stats-grid">
      ${statsCard({ label: 'Nights', value: sessions.length, sublabel: `Last ${days} days` })}
      ${statsCard({ label: 'Avg AHI', value: avgAhi, sublabel: ahiSeverity.label, trend: getTrend(validAhi) })}
      ${statsCard({ label: 'Avg Breathing', value: avgBr, unit: 'BPM', trend: getTrend(validBr) })}
      ${statsCard({ label: 'Avg Heart Rate', value: avgHr, unit: 'BPM', trend: getTrend(validHr) })}
      ${statsCard({ label: 'Avg Quality', value: avgQuality, unit: '/ 100', trend: getTrend(validQuality) })}
      ${statsCard({ label: 'Best Night', value: bestNight ? new Date(bestNight.startTime * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—', sublabel: bestNight?.sleepQualityScore != null ? `Score: ${bestNight.sleepQualityScore}` : '' })}
    </div>

    <!-- AHI Trend Chart -->
    <div class="chart-panel">
      <div class="chart-header">
        <span class="chart-title">Nightly AHI — Last ${days} Days</span>
        <span class="chart-subtitle">Bars colored by severity: white=normal, yellow=mild, orange=moderate, red=severe</span>
      </div>
      <div class="chart-container chart-tall">
        <canvas id="ahi-chart"></canvas>
      </div>
    </div>

    <!-- BR/HR Trends -->
    <div class="chart-panel">
      <div class="chart-header">
        <span class="chart-title">Avg Breathing Rate Trend</span>
      </div>
      <div class="chart-container">
        <canvas id="br-trend-chart"></canvas>
      </div>
    </div>

    <div class="chart-panel">
      <div class="chart-header">
        <span class="chart-title">Avg Heart Rate Trend</span>
      </div>
      <div class="chart-container">
        <canvas id="hr-trend-chart"></canvas>
      </div>
    </div>
  `;

  // Render charts
  destroyChart(ahiChart);
  destroyChart(brTrendChart);
  destroyChart(hrTrendChart);

  const ahiCanvas = document.getElementById('ahi-chart');
  if (ahiCanvas) {
    ahiChart = createBarChart(ahiCanvas, {
      labels: dates, data: ahiValues, label: 'AHI',
    });
  }

  const brCanvas = document.getElementById('br-trend-chart');
  if (brCanvas) {
    brTrendChart = createTimeChart(brCanvas, {
      labels: dates, data: brValues, label: 'Avg BR (BPM)',
      yMin: 8, yMax: 25,
    });
  }

  const hrCanvas = document.getElementById('hr-trend-chart');
  if (hrCanvas) {
    hrTrendChart = createTimeChart(hrCanvas, {
      labels: dates, data: hrValues, label: 'Avg HR (BPM)',
      yMin: 40, yMax: 100,
    });
  }
}

export function destroyHistory() {
  destroyChart(ahiChart);
  destroyChart(brTrendChart);
  destroyChart(hrTrendChart);
  ahiChart = null;
  brTrendChart = null;
  hrTrendChart = null;
}

/**
 * Sleep Report Page — Overnight session analysis
 * WiFi Sleep Monitor
 */
import { getNodes, resolveNodeId, toDate } from '../services/api.js';
import {
  getSessions, getSession, getSessionVitals,
  getAIAnalysis, saveAIAnalysis, deleteAIAnalysis
} from '../services/sessions.js';
import { processVitalsForCharts, formatDuration, formatTime } from '../services/vitals.js';
import { statsCard, severityBadge } from '../components/stats-card.js';
import { createTimeChart, destroyChart } from '../components/chart.js';
import { getStoredApiKey, generateSleepAnalysis, renderMarkdown } from '../services/gemini.js';

let brChart = null;
let hrChart = null;
let selectedNode = 'node-01';

export async function renderReport(container) {
  container.innerHTML = `
    <div class="report-page">
      <div class="report-controls">
        <div class="control-group">
          <label for="report-node" class="control-label">Node</label>
          <select id="report-node" class="node-dropdown">
            <option value="node-01">Node 1 (Default)</option>
          </select>
        </div>
        <div class="control-group control-grow">
          <label for="report-session" class="control-label">Night</label>
          <select id="report-session" class="node-dropdown">
            <option value="">Loading sessions…</option>
          </select>
        </div>
      </div>

      <div id="report-content">
        <div class="loading"><div class="loading-spinner"></div><span>Loading…</span></div>
      </div>
    </div>
  `;

  const nodes = await getNodes();
  selectedNode = await resolveNodeId(selectedNode);
  const nodeSelect = document.getElementById('report-node');
  if (nodes.length && nodeSelect) {
    nodeSelect.innerHTML = nodes.map(n =>
      `<option value="${n.id}"${n.id === selectedNode ? ' selected' : ''}>${n.name || n.id}</option>`
    ).join('');
  }

  nodeSelect?.addEventListener('change', (e) => {
    selectedNode = e.target.value;
    populateSessions();
  });
  document.getElementById('report-session')?.addEventListener('change', (e) => {
    if (e.target.value) loadReport(Number(e.target.value));
  });

  await populateSessions();
}

/** Fill the night picker and open the most recent session. */
async function populateSessions() {
  const select = document.getElementById('report-session');
  const content = document.getElementById('report-content');
  if (!select) return;

  const sessions = await getSessions(selectedNode, 60);

  if (!sessions.length) {
    select.innerHTML = '<option value="">No sessions recorded</option>';
    if (content) content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">∅</div>
        <p>No sleep sessions recorded yet for <strong>${selectedNode}</strong>.</p>
        <p class="empty-hint">Start the bridge at bedtime and stop it in the morning —
           each run becomes one night here.</p>
      </div>`;
    return;
  }

  // Open the newest night that actually has data. The session recording right
  // now is listed first but has nothing to show until its first minute lands.
  const initial = sessions.find(s => s.minutes > 0) ?? sessions[0];

  select.innerHTML = sessions.map(s =>
    `<option value="${s.id}"${s.id === initial.id ? ' selected' : ''}>${s.label}</option>`
  ).join('');

  await loadReport(initial.id);
}

async function loadReport(sessionId) {
  const content = document.getElementById('report-content');
  if (!content) return;

  content.innerHTML = `<div class="loading"><div class="loading-spinner"></div><span>Loading session…</span></div>`;

  // The rollup comes from SQL; the batches are only needed for the charts.
  const [session, vitals] = await Promise.all([
    getSession(sessionId),
    getSessionVitals(sessionId),
  ]);

  if (!session) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">∅</div>
        <p>Session ${sessionId} could not be loaded.</p>
      </div>`;
    return;
  }

  if (!vitals.length) {
    const why = session.status === 'active'
      ? 'This session is still recording — the first minute summary is written after 60 seconds.'
      : 'The bridge ran but never completed a full minute of readings.';
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">∅</div>
        <p>No minute data for this session yet.</p>
        <p class="empty-hint">${why}</p>
      </div>`;
    return;
  }

  // Statistics come from the server rollup; the batches only drive the charts.
  const chartData = processVitalsForCharts(vitals);
  const stats = session.stats;
  const apneaCount = session.apneaEvents;
  const totalMinutes = session.minutes;
  const ahi = session.ahi;
  const quality = session.sleepQualityScore;
  const severity = session.ahiSeverity;

  const startTime = toDate(session.startTime);
  const endTime = toDate(session.endTime);

  // Prepare AI Section HTML
  const apiKey = getStoredApiKey();
  session.aiAnalysis = getAIAnalysis(session.id);
  let aiSectionHtml = '';

  if (session.aiAnalysis) {
    aiSectionHtml = `
      <div class="chart-header">
        <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
      </div>
      <div class="setup-body" style="line-height: 1.8; font-size: var(--fs-sm); color: var(--light-1);">
        <div class="ai-text-content" style="margin-bottom: var(--sp-4);">${renderMarkdown(session.aiAnalysis)}</div>
        <div style="margin-top: var(--sp-4); display: flex; gap: var(--sp-2);">
          <button class="btn" id="regenerate-ai-btn">Regenerate Analysis</button>
          <button class="btn btn-danger" id="delete-ai-btn" style="padding: var(--sp-1) var(--sp-3); font-size: var(--fs-xs);">Delete Analysis</button>
        </div>
      </div>
    `;
  } else {
    if (apiKey) {
      aiSectionHtml = `
        <div class="chart-header">
          <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
          <p style="margin-bottom: var(--sp-4); color: var(--mid-light);">Generate an automated clinical-style AI analysis of this sleep session.</p>
          <button class="btn btn-primary" id="analyze-ai-btn">✦ Analyze with Gemini</button>
        </div>
      `;
    } else {
      aiSectionHtml = `
        <div class="chart-header">
          <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
          <p style="margin-bottom: var(--sp-4); color: var(--mid);">Gemini API Key is not configured. Add your key in the Setup page to enable AI analysis.</p>
          <a href="#/setup" class="btn" style="text-decoration: none; display: inline-flex; align-items: center; justify-content: center;">Configure Key</a>
        </div>
      `;
    }
  }

  // Render report
  content.innerHTML = `
    <!-- Summary Stats -->
    <div class="stats-grid">
      ${statsCard({ label: 'Sleep Duration', value: formatDuration(totalMinutes), className: 'stat-wide' })}
      ${statsCard({ label: 'Avg Breathing', value: stats.avgBR, unit: 'BPM', sublabel: `${stats.minBR ?? '—'} – ${stats.maxBR ?? '—'}` })}
      ${statsCard({ label: 'Avg Heart Rate', value: stats.avgHR, unit: 'BPM', sublabel: `${stats.minHR ?? '—'} – ${stats.maxHR ?? '—'}` })}
      ${statsCard({ label: 'Apnea Events', value: apneaCount, className: apneaCount > 0 ? 'stat-warn' : '' })}
      ${statsCard({ label: 'AHI', value: ahi ?? '—',
        sublabel: ahi == null ? 'needs 10+ min' : severityBadge(severity.label, severity.className) })}
      ${statsCard({ label: 'Sleep Quality', value: quality ?? '—', unit: '/ 100',
        className: quality != null && quality < 60 ? 'stat-warn' : '' })}
    </div>

    <!-- Time Range -->
    <div class="session-time-range">
      <span>${startTime ? formatTime(startTime) : '—'}</span>
      <span class="time-arrow">→</span>
      <span>${session.status === 'active' ? 'now' : (endTime ? formatTime(endTime) : '—')}</span>
    </div>

    <!-- Breathing Chart -->
    <div class="chart-panel">
      <div class="chart-header">
        <span class="chart-title">Breathing Rate — Overnight</span>
      </div>
      <div class="chart-container chart-tall">
        <canvas id="report-br-chart"></canvas>
      </div>
    </div>

    <!-- Heart Rate Chart -->
    <div class="chart-panel">
      <div class="chart-header">
        <span class="chart-title">Heart Rate — Overnight</span>
      </div>
      <div class="chart-container chart-tall">
        <canvas id="report-hr-chart"></canvas>
      </div>
    </div>

    <!-- AI Analysis Panel -->
    <div class="chart-panel" id="ai-analysis-panel">
      ${aiSectionHtml}
    </div>
  `;

  // Create charts
  const brCanvas = document.getElementById('report-br-chart');
  const hrCanvas = document.getElementById('report-hr-chart');

  if (brCanvas) {
    destroyChart(brChart);
    const timeLabels = chartData.timestamps.map(t =>
      t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    );
    brChart = createTimeChart(brCanvas, {
      labels: timeLabels,
      data: chartData.breathingRates,
      label: 'Breathing (BPM)',
      apneaFlags: chartData.apneaFlags,
      yMin: 0, yMax: 35,
    });
  }

  if (hrCanvas) {
    destroyChart(hrChart);
    const timeLabels = chartData.timestamps.map(t =>
      t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    );
    hrChart = createTimeChart(hrCanvas, {
      labels: timeLabels,
      data: chartData.heartRates,
      label: 'Heart Rate (BPM)',
      yMin: 30, yMax: 120,
    });
  }

  // AI Event Listeners and Prompt Compilation
  const sessionData = {
    ...session,
    avgBreathingRate: stats.avgBR,
    minBreathingRate: stats.minBR,
    maxBreathingRate: stats.maxBR,
    avgHeartRate: stats.avgHR,
    minHeartRate: stats.minHR,
    maxHeartRate: stats.maxHR,
    apneaEvents: apneaCount,
    ahi: ahi,
    sleepQualityScore: quality
  };

  const bindAIEventListeners = () => {
    const analyzeBtn = document.getElementById('analyze-ai-btn');
    const regenerateBtn = document.getElementById('regenerate-ai-btn');
    const deleteAIBtn = document.getElementById('delete-ai-btn');
    const panel = document.getElementById('ai-analysis-panel');

    const runAnalysis = async (btn) => {
      if (!btn) return;
      btn.disabled = true;
      
      panel.innerHTML = `
        <div class="chart-header">
          <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="text-align: center; padding: var(--sp-8) var(--sp-4); font-family: var(--font-mono); color: var(--mid);">
          <div class="loading-spinner" style="margin: 0 auto var(--sp-4) auto;"></div>
          <span>[ Analyzing sleep patterns using Gemini 1.5 Flash... ]</span>
        </div>
      `;

      try {
        const analysis = await generateSleepAnalysis(sessionData);
        saveAIAnalysis(session.id, analysis);

        session.aiAnalysis = analysis;
        renderAIPanel(analysis);
      } catch (err) {
        console.error('AI analysis failed:', err);
        panel.innerHTML = `
          <div class="chart-header">
            <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
          </div>
          <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
            <p style="color: var(--alert-red); margin-bottom: var(--sp-4);">Analysis Failed: ${err.message}</p>
            <button class="btn" id="retry-ai-btn">Try Again</button>
          </div>
        `;
        document.getElementById('retry-ai-btn')?.addEventListener('click', (e) => runAnalysis(e.target));
      }
    };

    const renderAIPanel = (analysisText) => {
      panel.innerHTML = `
        <div class="chart-header">
          <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="line-height: 1.8; font-size: var(--fs-sm); color: var(--light-1);">
          <div class="ai-text-content" style="margin-bottom: var(--sp-4);">${renderMarkdown(analysisText)}</div>
          <div style="margin-top: var(--sp-4); display: flex; gap: var(--sp-2);">
            <button class="btn" id="regenerate-ai-btn">Regenerate Analysis</button>
            <button class="btn btn-danger" id="delete-ai-btn" style="padding: var(--sp-1) var(--sp-3); font-size: var(--fs-xs);">Delete Analysis</button>
          </div>
        </div>
      `;
      document.getElementById('regenerate-ai-btn')?.addEventListener('click', (e) => runAnalysis(e.target));
      document.getElementById('delete-ai-btn')?.addEventListener('click', handleDelete);
    };

    const handleDelete = async () => {
      if (!confirm('Are you sure you want to delete this AI analysis?')) return;
      
      panel.innerHTML = `
        <div class="chart-header">
          <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4); font-family: var(--font-mono); color: var(--mid);">
          <span>Deleting analysis...</span>
        </div>
      `;

      try {
        deleteAIAnalysis(session.id);
        session.aiAnalysis = null;


        if (apiKey) {
          panel.innerHTML = `
            <div class="chart-header">
              <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
            </div>
            <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
              <p style="margin-bottom: var(--sp-4); color: var(--mid-light);">Generate an automated clinical-style AI analysis of this sleep session.</p>
              <button class="btn btn-primary" id="analyze-ai-btn">✦ Analyze with Gemini</button>
            </div>
          `;
          document.getElementById('analyze-ai-btn')?.addEventListener('click', (e) => runAnalysis(e.target));
        } else {
          panel.innerHTML = `
            <div class="chart-header">
              <span class="chart-title">✦ Gemini AI Sleep Analysis</span>
            </div>
            <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
              <p style="margin-bottom: var(--sp-4); color: var(--mid);">Gemini API Key is not configured. Add your key in the Setup page to enable AI analysis.</p>
              <a href="#/setup" class="btn" style="text-decoration: none; display: inline-flex; align-items: center; justify-content: center;">Configure Key</a>
            </div>
          `;
        }
      } catch (err) {
        console.error('Delete AI analysis failed:', err);
        alert('Failed to delete AI analysis from database.');
        renderAIPanel(session.aiAnalysis);
      }
    };

    analyzeBtn?.addEventListener('click', (e) => runAnalysis(e.target));
    regenerateBtn?.addEventListener('click', (e) => runAnalysis(e.target));
    deleteAIBtn?.addEventListener('click', handleDelete);
  };

  bindAIEventListeners();
}

export function destroyReport() {
  destroyChart(brChart);
  destroyChart(hrChart);
  brChart = null;
  hrChart = null;
}

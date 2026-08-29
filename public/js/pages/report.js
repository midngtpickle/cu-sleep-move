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
import {
  AI_PROVIDERS,
  AI_MODELS,
  THINKING_BUDGETS,
  getActiveProvider,
  setActiveProvider,
  getStoredApiKey,
  getSelectedModel,
  setSelectedModel,
  getCustomModel,
  setCustomModel,
  getEffectiveModel,
  getThinkingBudget,
  setThinkingBudget,
  generateSleepAnalysis,
  renderMarkdown,
} from '../services/ai.js';

let brChart = null;
let hrChart = null;
let selectedNode = 'node-01';

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

  // Populate node dropdown
  const nodeSelect = document.getElementById('report-node');
  const nodes = await getNodes();
  selectedNode = await resolveNodeId(selectedNode);

  nodeSelect.innerHTML = nodes.map(n =>
    `<option value="${n.id}"${n.id === selectedNode ? ' selected' : ''}>${n.name || n.id}</option>`
  ).join('');

  nodeSelect.addEventListener('change', async (e) => {
    selectedNode = e.target.value;
    await populateSessions();
  });

  document.getElementById('report-session')?.addEventListener('change', (e) => {
    if (e.target.value) loadReport(e.target.value);
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

  // Open the newest night that actually has data.
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
        <div class="empty-icon">⏳</div>
        <p><strong>${session.label}</strong></p>
        <p class="empty-hint">${why}</p>
      </div>`;
    return;
  }

  const chartData = processVitalsForCharts(vitals);
  const stats = session.stats;
  const apneaCount = session.apneaEvents;
  const totalMinutes = session.minutes;
  const ahi = session.ahi;
  const quality = session.sleepQualityScore;
  const severity = session.ahiSeverity;

  const startTime = toDate(session.startTime);
  const endTime = toDate(session.endTime);

  session.aiAnalysis = getAIAnalysis(session.id);

  // Render report scaffold
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
    <div class="chart-panel" id="ai-analysis-panel"></div>
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

  // Session Data bundle for AI
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

  // Render & bind AI Panel
  renderAIPanel(session.aiAnalysis);

  function renderAIPanel(analysisObj) {
    const panel = document.getElementById('ai-analysis-panel');
    if (!panel) return;

    let activeProvider = getActiveProvider();
    let hasKey = !!getStoredApiKey(activeProvider);

    if (analysisObj && analysisObj.text) {
      const providerLabel = analysisObj.provider === 'claude' ? 'Anthropic Claude' : (analysisObj.provider === 'gemini' ? 'Google Gemini' : 'AI Analyst');
      const modelLabel = analysisObj.model ? ` · ${analysisObj.model}` : '';

      panel.innerHTML = `
        <div class="chart-header" style="display: flex; justify-content: space-between; align-items: center;">
          <span class="chart-title">✦ AI Sleep Analysis</span>
          <span class="ai-badge">${providerLabel}${modelLabel}</span>
        </div>
        <div class="setup-body" style="line-height: 1.8; font-size: var(--fs-sm); color: var(--light-1);">
          ${analysisObj.thinking ? `
            <details class="ai-reasoning-accordion">
              <summary class="ai-reasoning-summary">
                <span class="ai-reasoning-icon">🧠</span>
                <span class="ai-reasoning-title">Clinical Reasoning Process</span>
                <span class="ai-reasoning-tag">${analysisObj.model || 'Reasoning'}</span>
              </summary>
              <div class="ai-reasoning-body">
                <pre class="ai-reasoning-text">${escapeHtml(analysisObj.thinking)}</pre>
              </div>
            </details>
          ` : ''}
          <div class="ai-text-content" style="margin-bottom: var(--sp-4);">${renderMarkdown(analysisObj.text)}</div>
          <div style="margin-top: var(--sp-4); display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap;">
            <button class="btn" id="regenerate-ai-btn">Regenerate Analysis</button>
            <button class="btn btn-danger" id="delete-ai-btn" style="padding: var(--sp-1) var(--sp-3); font-size: var(--fs-xs);">Delete Analysis</button>
          </div>
        </div>
      `;

      document.getElementById('regenerate-ai-btn')?.addEventListener('click', () => runAnalysis());
      document.getElementById('delete-ai-btn')?.addEventListener('click', handleDelete);
      return;
    }

    if (hasKey) {
      const models = AI_MODELS[activeProvider] || [];
      const currentModel = getSelectedModel(activeProvider);
      const currentBudget = getThinkingBudget(activeProvider);
      const customModelVal = getCustomModel(activeProvider);

      panel.innerHTML = `
        <div class="chart-header">
          <span class="chart-title">✦ AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="padding: var(--sp-5) var(--sp-4);">
          <p style="margin-bottom: var(--sp-4); color: var(--mid-light); font-size: var(--fs-sm);">
            Generate an automated clinical-style evaluation with physiological synthesis, apnea metrics, and recovery recommendations.
          </p>

          <div class="ai-quick-bar" style="display: flex; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-4); align-items: flex-end;">
            <div style="flex: 1; min-width: 140px;">
              <label style="display: block; font-size: var(--fs-xs); color: var(--mid); margin-bottom: var(--sp-1); text-transform: uppercase; letter-spacing: 0.05em;">Provider</label>
              <select id="quick-provider-select" class="node-dropdown" style="width: 100%;">
                <option value="gemini"${activeProvider === 'gemini' ? ' selected' : ''}>Google Gemini</option>
                <option value="claude"${activeProvider === 'claude' ? ' selected' : ''}>Anthropic Claude</option>
              </select>
            </div>

            <div style="flex: 2; min-width: 200px;">
              <label style="display: block; font-size: var(--fs-xs); color: var(--mid); margin-bottom: var(--sp-1); text-transform: uppercase; letter-spacing: 0.05em;">Model</label>
              <select id="quick-model-select" class="node-dropdown" style="width: 100%;">
                ${models.map(m => `<option value="${m.id}"${m.id === currentModel ? ' selected' : ''}>${m.name} (${m.tag})</option>`).join('')}
              </select>
            </div>

            <div style="flex: 1.5; min-width: 160px;">
              <label style="display: block; font-size: var(--fs-xs); color: var(--mid); margin-bottom: var(--sp-1); text-transform: uppercase; letter-spacing: 0.05em;">Reasoning Budget</label>
              <select id="quick-thinking-select" class="node-dropdown" style="width: 100%;">
                ${THINKING_BUDGETS.map(b => `<option value="${b.value}"${b.value === currentBudget ? ' selected' : ''}>${b.label}</option>`).join('')}
              </select>
            </div>
          </div>

          <div id="quick-custom-model-row" style="margin-bottom: var(--sp-4); display: ${currentModel === 'custom' ? 'block' : 'none'};">
            <label style="display: block; font-size: var(--fs-xs); color: var(--mid); margin-bottom: var(--sp-1); text-transform: uppercase; letter-spacing: 0.05em;">Custom Model Identifier</label>
            <input type="text" id="quick-custom-model-input" value="${escapeHtml(customModelVal)}" placeholder="e.g. claude-3-7-sonnet-20250219 or gemini-2.5-pro" style="width: 100%; max-width: 460px; background: var(--dark-1); border: var(--border-default); border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3); color: var(--white); font-family: var(--font-mono); font-size: var(--fs-sm);" />
          </div>

          <button class="btn btn-primary" id="analyze-ai-btn" style="padding: 10px 22px; font-size: var(--fs-sm); font-weight: 600;">
            ✦ Generate Clinical Analysis
          </button>
        </div>
      `;

      const providerSel = document.getElementById('quick-provider-select');
      const modelSel = document.getElementById('quick-model-select');
      const thinkSel = document.getElementById('quick-thinking-select');
      const customRow = document.getElementById('quick-custom-model-row');
      const customInput = document.getElementById('quick-custom-model-input');

      providerSel?.addEventListener('change', (e) => {
        setActiveProvider(e.target.value);
        renderAIPanel(null);
      });

      modelSel?.addEventListener('change', (e) => {
        setSelectedModel(activeProvider, e.target.value);
        if (customRow) {
          customRow.style.display = e.target.value === 'custom' ? 'block' : 'none';
        }
      });

      customInput?.addEventListener('input', (e) => {
        setCustomModel(activeProvider, e.target.value);
      });

      thinkSel?.addEventListener('change', (e) => {
        setThinkingBudget(activeProvider, parseInt(e.target.value, 10));
      });

      document.getElementById('analyze-ai-btn')?.addEventListener('click', () => runAnalysis());
    } else {
      const providerName = activeProvider === 'claude' ? 'Anthropic Claude' : 'Google Gemini';
      panel.innerHTML = `
        <div class="chart-header">
          <span class="chart-title">✦ AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
          <p style="margin-bottom: var(--sp-4); color: var(--mid);">
            ${providerName} API Key is not configured. Add your key in the Setup page to enable automated clinical reports.
          </p>
          <a href="#/setup" class="btn" style="text-decoration: none; display: inline-flex; align-items: center; justify-content: center;">
            Configure AI Keys
          </a>
        </div>
      `;
    }
  }

  async function runAnalysis() {
    const panel = document.getElementById('ai-analysis-panel');
    if (!panel) return;

    const provider = getActiveProvider();
    const model = getEffectiveModel(provider);
    const thinkingBudget = getThinkingBudget(provider);
    const providerName = provider === 'claude' ? 'Anthropic Claude' : 'Google Gemini';

    panel.innerHTML = `
      <div class="chart-header">
        <span class="chart-title">✦ AI Sleep Analysis</span>
      </div>
      <div class="setup-body" style="text-align: center; padding: var(--sp-8) var(--sp-4); font-family: var(--font-mono); color: var(--mid);">
        <div class="loading-spinner" style="margin: 0 auto var(--sp-4) auto;"></div>
        <div style="color: var(--white); font-weight: 600; margin-bottom: 6px;">[ Synthesizing sleep vitals with ${providerName}... ]</div>
        <div style="font-size: var(--fs-xs); color: var(--mid);">Model: ${model} ${thinkingBudget > 0 ? '· Extended Reasoning Active' : ''}</div>
      </div>
    `;

    try {
      const result = await generateSleepAnalysis(sessionData, {
        provider,
        model,
        thinkingBudget,
        force: true,
      });

      saveAIAnalysis(session.id, result);
      session.aiAnalysis = result;
      renderAIPanel(result);
    } catch (err) {
      console.error('AI analysis failed:', err);
      panel.innerHTML = `
        <div class="chart-header">
          <span class="chart-title">✦ AI Sleep Analysis</span>
        </div>
        <div class="setup-body" style="text-align: center; padding: var(--sp-6) var(--sp-4);">
          <p style="color: var(--alert-red); margin-bottom: var(--sp-4);">Analysis Failed: ${err.message}</p>
          <div style="display: flex; gap: var(--sp-2); justify-content: center;">
            <button class="btn" id="retry-ai-btn">Try Again</button>
            <a href="#/setup" class="btn" style="text-decoration: none;">Check API Key</a>
          </div>
        </div>
      `;
      document.getElementById('retry-ai-btn')?.addEventListener('click', () => runAnalysis());
    }
  }

  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this AI analysis?')) return;
    deleteAIAnalysis(session.id);
    session.aiAnalysis = null;
    renderAIPanel(null);
  }
}

export function destroyReport() {
  destroyChart(brChart);
  destroyChart(hrChart);
  brChart = null;
  hrChart = null;
}

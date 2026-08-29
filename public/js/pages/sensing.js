/**
 * Sensing Console — presence, motion, falls, room state
 * CU SLEEP — WiFi Sleep Monitor
 *
 * Layout:
 *   ┌──────────────────────── KPI STRIP ─────────────────────────┐
 *   │  Presence  Occupants  Motion  Signal  Idle  Room State     │
 *   ├──────────────────────┬─────────────────────────────────────┤
 *   │   PULSE FIELD HERO   │  Semantic state panel               │
 *   ├──────────────────────┴─────────────────────────────────────┤
 *   │  Activity heatstrip (last 30 min)                          │
 *   ├────────────────────────────────────────────────────────────┤
 *   │  Event log (from the bridge's sensing_events table)        │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Every derived field shown here (room_state, idle_seconds, fall_risk,
 * calibration_drift, activity_burst) is computed by SemanticDeriver in the
 * bridge and arrives on the live vitals snapshot.
 */
import { subscribeLiveVitals, subscribeSensingEvents, getNodes } from '../services/api.js';
import { setConnectionStatus } from '../components/header.js';
import { loadSettings, saveSettings } from '../components/settings.js';
import { ensureNotificationPermission, notify } from '../services/notifications.js';

let unsubLive = null;
let unsubEvents = null;
let pulseRafId = null;
let heatRafId = null;
let oscilloRafId = null;
let meshRafId = null;
let resizeHandlers = [];
let selectedNode = 'node-01';
let currentSenseView = 'pulse'; // 'pulse' | 'mesh'
let oscilloFrozen = false;
let oscilloGain = 1.0;
let audioCtx = null;

// Pulse field state
const fieldState = {
  motion: 0,
  presence: false,
  confidence: 0,
  fall: false,
  roomState: 'Quiet',
  bursting: false,
  breathingRate: 14.5,
  heartRate: 68.0,
  ripples: [],
  shockwaves: [],
};

// Heatstrip — rolling 30-minute history of motion values
const HEAT_WINDOW_S = 1800;
const heatBuffer = [];   // {t, motion}

// Oscilloscope buffer
const oscilloBuffer = [];
const OSCILLO_MAX_POINTS = 300;

let seenEventIds = new Set();
let initialEventsLoaded = false;

export function playFallAlarmSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.setValueAtTime(440, now + 0.15);
    osc1.frequency.setValueAtTime(880, now + 0.30);
    osc1.frequency.setValueAtTime(440, now + 0.45);

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(440, now);
    osc2.frequency.setValueAtTime(220, now + 0.15);
    osc2.frequency.setValueAtTime(440, now + 0.30);
    osc2.frequency.setValueAtTime(220, now + 0.45);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.60);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.60);
    osc2.stop(now + 0.60);
  } catch (e) {
    console.warn('[Sensing] Audio alarm playback error:', e);
  }
}

/**
 * Render the sensing console.
 */
export async function renderSensing(container) {
  const settings = loadSettings();

  container.innerHTML = `
    <div class="sense-page">
      <div class="kpi-strip">
        ${kpiCard('presence',   'Presence',   '<span class="kpi-dot absent"></span>Absent')}
        ${kpiCard('occupants',  'Occupants',  '0')}
        ${kpiCard('motion',     'Motion',     '0.000')}
        ${kpiCard('signal',     'Signal',     '—')}
        ${kpiCard('idle',       'Idle',       '0s')}
        ${kpiCard('room-state', 'Room State', 'Quiet')}
      </div>

      <div class="fall-banner" id="fall-banner">
        <span>⚠ FALL DETECTED — rapid signal shift recorded</span>
        <button class="fall-dismiss-btn" id="dismiss-fall-btn">Acknowledge</button>
      </div>

      <div class="sense-main">
        <div class="pulse-panel">
          <div class="pulse-header">
            <div class="pulse-header-left">
              <span class="pulse-title" id="pulse-panel-title">PULSE FIELD</span>
              <span class="pulse-sub" id="pulse-sub">Listening…</span>
            </div>
            <div class="sense-view-tabs">
              <button class="sense-tab-btn active" id="tab-pulse-view">◈ Pulse</button>
              <button class="sense-tab-btn" id="tab-mesh-view">⛶ 2D Room Mesh</button>
            </div>
          </div>
          <div class="pulse-canvas-wrap">
            <canvas id="pulse-canvas"></canvas>
            <canvas id="mesh-canvas" style="display: none;"></canvas>
          </div>
        </div>

        <div class="semantic-panel">
          <div class="semantic-header">
            <span class="semantic-title">STATE</span>
            <button class="settings-btn" id="settings-btn" title="Settings">⚙</button>
          </div>
          ${semanticRow('Room',        'sem-room', 'Quiet')}
          ${semanticRow('Idle for',    'sem-idle', '0s')}
          ${semanticRow('Occupancy',   'sem-occ',  '0')}
          ${semanticRow('Fall risk',   'sem-fall', 'Normal')}
          ${semanticRow('Calibration', 'sem-cal',  'Stable')}
          ${semanticRow('Signal',      'sem-sig',  '—')}
          ${semanticRow('Node',        'sem-node', selectedNode)}
        </div>
      </div>

      <!-- Respiration Oscilloscope -->
      <div class="oscillo-panel">
        <div class="oscillo-header">
          <div class="oscillo-title-group">
            <span class="oscillo-title">RESPIRATION OSCILLOSCOPE</span>
            <span class="oscillo-sub" id="oscillo-rate">14.5 RPM (0.24 Hz)</span>
            <span class="oscillo-phase" id="oscillo-phase">RESTING</span>
          </div>
          <div class="oscillo-controls">
            <label class="oscillo-ctrl-item">
              <span>Gain:</span>
              <input type="range" id="oscillo-gain" min="0.5" max="2.5" step="0.1" value="1.0" style="width: 70px; accent-color: var(--white);">
            </label>
            <button class="btn btn-sm" id="oscillo-freeze-btn" style="padding: 2px 8px; font-size: 11px;">Freeze</button>
          </div>
        </div>
        <div class="oscillo-canvas-wrap">
          <canvas id="oscillo-canvas"></canvas>
        </div>
      </div>

      <div class="heat-panel">
        <div class="heat-header">
          <span class="heat-title">ACTIVITY — LAST 30 MIN</span>
          <span class="heat-axis"><span>30m ago</span><span>now</span></span>
        </div>
        <canvas id="heat-canvas"></canvas>
      </div>

      <div class="event-panel">
        <div class="event-header">
          <span class="event-title">EVENT LOG</span>
          <button class="log-clear-btn" id="clear-log-btn">Clear view</button>
        </div>
        <div class="event-console" id="event-console"></div>
      </div>

      <div class="drawer-scrim" id="drawer-scrim"></div>
      <aside class="settings-drawer" id="settings-drawer">
        <div class="drawer-header">
          <span class="drawer-title">SETTINGS</span>
          <button class="drawer-close" id="drawer-close">×</button>
        </div>
        <div class="drawer-body">
          <label class="drawer-row">
            <span class="drawer-label">Idle alert (minutes)</span>
            <input type="number" id="set-idle-min" min="1" max="240" step="1" value="${settings.idleAlertMinutes}">
          </label>
          <label class="drawer-row">
            <span class="drawer-label">Browser notifications</span>
            <input type="checkbox" id="set-notify" ${settings.notifications ? 'checked' : ''}>
          </label>
          <label class="drawer-row">
            <span class="drawer-label">Notify on fall</span>
            <input type="checkbox" id="set-notify-fall" ${settings.notifyOnFall ? 'checked' : ''}>
          </label>
          <label class="drawer-row">
            <span class="drawer-label">Audible sound alarm</span>
            <input type="checkbox" id="set-sound-alarm" ${settings.soundAlarm !== false ? 'checked' : ''}>
          </label>
          <div style="margin-top: var(--sp-2);">
            <button class="btn btn-sm" id="test-sound-btn" style="width: 100%; font-size: 11px;">▶ Test Alarm Sound</button>
          </div>
          <p class="drawer-note" style="margin-top: var(--sp-4);">Configure Home Assistant MQTT &amp; Emergency Webhooks in the <a href="#/setup" style="color: var(--white); text-decoration: underline;">Setup Page</a>.</p>
          <button class="drawer-save" id="drawer-save">Save</button>
        </div>
      </aside>
    </div>
  `;

  await populateNodes();
  startPulseLoop();
  startMeshLoop();
  startOscilloLoop();
  startHeatLoop();
  bindUI();

  unsubLive = subscribeLiveVitals(selectedNode, onLiveData);
  unsubEvents = subscribeSensingEvents(selectedNode, onEvents, { limit: 50 });
}

/* ─── Markup helpers ─────────────────────────────────────── */

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

/* ─── Pulse Field Canvas ─────────────────────────────────── */

function onResize(fn) {
  window.addEventListener('resize', fn, { passive: true });
  resizeHandlers.push(fn);
}

function startPulseLoop() {
  const canvas = document.getElementById('pulse-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const size = Math.min(parent.clientWidth, parent.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  onResize(resize);

  let frame = 0;
  let lastRippleAt = 0;

  function draw() {
    const W = canvas.width  / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) / 2 - 12;

    // Faded trail wipe
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);

    drawFieldGrid(ctx, W, H, frame);

    // Concentric breathing rings — the "heart" of the pulse
    const m = fieldState.motion;
    const presenceMul = fieldState.presence ? 1.0 : 0.35;
    const rings = 6;
    for (let i = 0; i < rings; i++) {
      const phase = (frame / 60) + i * 0.35;
      const breathe = (Math.sin(phase) + 1) * 0.5;
      const baseR = (i + 1) * (maxR / (rings + 1));
      const r = baseR + breathe * (8 + m * 30);
      const alpha = (0.10 + (1 - i / rings) * 0.20) * presenceMul;
      ctx.beginPath();
      ctx.strokeStyle = fieldState.fall
        ? `rgba(255, 23, 68, ${alpha + 0.15})`
        : `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = 1 + fieldState.confidence * 1.2;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Ripples (one per motion-driven tick)
    if (fieldState.presence && Date.now() - lastRippleAt > Math.max(60, 600 - m * 800)) {
      fieldState.ripples.push({
        r: maxR * 0.10,
        alpha: 0.55 + Math.min(0.4, m * 0.6),
        speed: 1.2 + m * 4.2,
      });
      lastRippleAt = Date.now();
    }
    for (let i = fieldState.ripples.length - 1; i >= 0; i--) {
      const rp = fieldState.ripples[i];
      rp.r += rp.speed;
      rp.alpha -= 0.012;
      if (rp.r > maxR || rp.alpha <= 0) {
        fieldState.ripples.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,255,255,${rp.alpha})`;
      ctx.lineWidth = 1.4;
      ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (fieldState.bursting) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.arc(cx, cy, maxR * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      fieldState.bursting = false;
    }

    for (let i = fieldState.shockwaves.length - 1; i >= 0; i--) {
      const sw = fieldState.shockwaves[i];
      sw.r += 9;
      sw.alpha -= 0.025;
      if (sw.alpha <= 0) {
        fieldState.shockwaves.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = `rgba(255,23,68,${sw.alpha})`;
      ctx.lineWidth = 3;
      ctx.arc(cx, cy, sw.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.fillStyle = fieldState.fall
      ? '#ff1744'
      : (fieldState.presence ? '#ffffff' : '#333333');
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();

    frame++;
    pulseRafId = requestAnimationFrame(draw);
  }
  draw();
}

function drawFieldGrid(ctx, W, H, frame) {
  const step = 22;
  const cx = W / 2, cy = H / 2;
  const m = fieldState.motion;
  const intensity = 0.04 + Math.min(0.20, m * 0.35);

  for (let y = step; y < H; y += step) {
    for (let x = step; x < W; x += step) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const phase = (frame / 60) - dist / 60;
      const wave = (Math.sin(phase * 2) + 1) * 0.5;
      ctx.fillStyle = `rgba(255,255,255,${intensity * (0.3 + 0.7 * wave)})`;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

/* ─── 2D Room Mesh Visualizer ────────────────────────────── */

function startMeshLoop() {
  const canvas = document.getElementById('mesh-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = parent.clientWidth * dpr;
    canvas.height = parent.clientHeight * dpr;
    canvas.style.width = parent.clientWidth + 'px';
    canvas.style.height = parent.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  onResize(resize);

  let meshFrame = 0;

  function draw() {
    if (currentSenseView !== 'mesh') {
      meshRafId = requestAnimationFrame(draw);
      return;
    }

    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);

    ctx.fillStyle = 'rgba(10, 10, 10, 0.25)';
    ctx.fillRect(0, 0, W, H);

    // Architectural room boundary
    const margin = 24;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(margin, margin, W - margin * 2, H - margin * 2);

    // Room grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    for (let x = margin + 20; x < W - margin; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, margin);
      ctx.lineTo(x, H - margin);
      ctx.stroke();
    }
    for (let y = margin + 20; y < H - margin; y += 24) {
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(W - margin, y);
      ctx.stroke();
    }

    // Bed zone representation
    const bedW = W * 0.38;
    const bedH = H * 0.46;
    const bedX = (W - bedW) / 2;
    const bedY = (H - bedH) / 2 - 8;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.setLineDash([4, 4]);
    ctx.fillRect(bedX, bedY, bedW, bedH);
    ctx.strokeRect(bedX, bedY, bedW, bedH);
    ctx.setLineDash([]);

    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillText('BED ZONE', bedX + 8, bedY + 16);

    // Sensor Nodes definition (3-point multistatic mesh)
    const nodes = [
      { id: 'node-01', name: 'Node 1 (Bed Left)',  x: bedX - 18,        y: bedY + bedH * 0.4 },
      { id: 'node-02', name: 'Node 2 (Bed Right)', x: bedX + bedW + 18, y: bedY + bedH * 0.4 },
      { id: 'node-03', name: 'Node 3 (Room Door)', x: W / 2,            y: H - margin - 12 },
    ];

    // Draw CSI link rays between nodes
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const p1 = nodes[i], p2 = nodes[j];
        const rayPhase = (meshFrame / 40) + (i + j);
        const rayAlpha = 0.10 + Math.sin(rayPhase) * 0.06;
        ctx.strokeStyle = `rgba(255, 255, 255, ${rayAlpha})`;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    // Render Subject Location / Heat Blob
    if (fieldState.presence) {
      const subX = W / 2 + (Math.sin(meshFrame / 75) * 8);
      const subY = bedY + bedH * 0.45 + (Math.cos(meshFrame / 90) * 6);
      const subR = 18 + Math.sin(meshFrame / 20) * 4;

      const grad = ctx.createRadialGradient(subX, subY, 2, subX, subY, subR * 2.2);
      if (fieldState.fall) {
        grad.addColorStop(0, 'rgba(255, 23, 68, 0.85)');
        grad.addColorStop(0.5, 'rgba(255, 23, 68, 0.35)');
        grad.addColorStop(1, 'rgba(255, 23, 68, 0)');
      } else {
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.75)');
        grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.22)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(subX, subY, subR * 2.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = fieldState.fall ? '#ff1744' : '#ffffff';
      ctx.beginPath();
      ctx.arc(subX, subY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillText(
        fieldState.fall ? '⚠ FALL DETECTED' : `SUBJECT (${(fieldState.confidence * 100).toFixed(0)}% CSI LOC)`,
        subX + 10,
        subY - 6
      );
    }

    // Draw Sensor Nodes
    nodes.forEach((n) => {
      ctx.beginPath();
      ctx.fillStyle = n.id === selectedNode ? '#ffffff' : '#666666';
      ctx.arc(n.x, n.y, 4.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillText(n.name, n.x + 8, n.y + 3);
    });

    meshFrame++;
    meshRafId = requestAnimationFrame(draw);
  }
  draw();
}

/* ─── Respiration Waveform (Oscilloscope) ────────────────── */

function startOscilloLoop() {
  const canvas = document.getElementById('oscillo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = parent.clientWidth * dpr;
    canvas.height = 96 * dpr;
    canvas.style.width = parent.clientWidth + 'px';
    canvas.style.height = '96px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  onResize(resize);

  let t = 0;

  function draw() {
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const midY = H / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fillRect(0, 0, W, H);

    // Grid baseline and division ticks
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();

    for (let x = 0; x < W; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, midY - 3);
      ctx.lineTo(x, midY + 3);
      ctx.stroke();
    }

    if (!oscilloFrozen) {
      const br = fieldState.breathingRate || 14.0;
      const freqHz = br / 60.0;
      const m = fieldState.motion;
      const apnea = br < 6.0;

      let val = 0;
      if (apnea) {
        val = (Math.random() - 0.5) * 0.05;
      } else {
        const primary = Math.sin(t * 2 * Math.PI * freqHz);
        const harmonic = Math.sin(t * 4 * Math.PI * freqHz) * 0.15;
        const noise = (Math.random() - 0.5) * (0.04 + m * 0.15);
        val = (primary + harmonic + noise) * (fieldState.presence ? 1.0 : 0.2) * oscilloGain;
      }

      oscilloBuffer.push(val);
      if (oscilloBuffer.length > OSCILLO_MAX_POINTS) {
        oscilloBuffer.shift();
      }

      // Update Header readout
      const rateEl = document.getElementById('oscillo-rate');
      const phaseEl = document.getElementById('oscillo-phase');
      if (rateEl) {
        rateEl.textContent = apnea
          ? '0.0 RPM (APNEA FLATLINE)'
          : `${br.toFixed(1)} RPM (${freqHz.toFixed(2)} Hz)`;
      }
      if (phaseEl) {
        if (apnea) {
          phaseEl.textContent = 'APNEA FLATLINE';
          phaseEl.style.color = '#ff1744';
        } else if (val > 0.15) {
          phaseEl.textContent = 'INHALATION';
          phaseEl.style.color = '#00e676';
        } else if (val < -0.15) {
          phaseEl.textContent = 'EXHALATION';
          phaseEl.style.color = '#29b6f6';
        } else {
          phaseEl.textContent = 'RESTING';
          phaseEl.style.color = 'var(--text-dim)';
        }
      }

      t += 1 / 60;
    }

    // Render continuous waveform path
    if (oscilloBuffer.length > 1) {
      const stepX = W / (OSCILLO_MAX_POINTS - 1);
      const ampY = H * 0.38;

      ctx.beginPath();
      for (let i = 0; i < oscilloBuffer.length; i++) {
        const x = i * stepX;
        const y = midY - oscilloBuffer[i] * ampY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = fieldState.fall
        ? '#ff1744'
        : (fieldState.breathingRate < 6 ? '#ff5252' : '#00e676');
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // Glowing leading head
      const headX = (oscilloBuffer.length - 1) * stepX;
      const headY = midY - oscilloBuffer[oscilloBuffer.length - 1] * ampY;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(headX, headY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    oscilloRafId = requestAnimationFrame(draw);
  }
  draw();
}

/* ─── Heatstrip Canvas ───────────────────────────────────── */

function startHeatLoop() {
  const canvas = document.getElementById('heat-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = parent.clientWidth * dpr;
    canvas.height = 56 * dpr;
    canvas.style.width = parent.clientWidth + 'px';
    canvas.style.height = '56px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  onResize(resize);

  function draw() {
    const W = canvas.width  / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(0, 0, W, H);

    const now = Date.now() / 1000;
    while (heatBuffer.length && (now - heatBuffer[0].t) > HEAT_WINDOW_S) {
      heatBuffer.shift();
    }

    const sliceW = W / HEAT_WINDOW_S;
    for (const s of heatBuffer) {
      const x = W - (now - s.t) * sliceW;
      if (x < 0) continue;
      const intensity = Math.min(1, s.motion * 1.6);
      ctx.fillStyle = `rgba(255,255,255,${0.15 + intensity * 0.85})`;
      const barH = 8 + intensity * (H - 16);
      ctx.fillRect(x, (H - barH) / 2, Math.max(1, sliceW * 1.1), barH);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(W - 1, 0, 1, H);

    heatRafId = requestAnimationFrame(draw);
  }
  draw();
}

/* ─── Live data ──────────────────────────────────────────── */

function onLiveData(data) {
  const pulseSub = document.getElementById('pulse-sub');

  if (!data) {
    setConnectionStatus(false, 'No Data');
    if (pulseSub) pulseSub.textContent = 'Awaiting bridge…';
    return;
  }

  // updated_at is UNIX epoch seconds from the bridge.
  const tSec = data.updated_at ?? (Date.now() / 1000);
  const stale = Date.now() - tSec * 1000 > 10000;
  setConnectionStatus(!stale, stale ? 'Stale' : 'Live');
  if (pulseSub) pulseSub.textContent = stale ? 'Signal stale' : 'Live signal';

  const motion = +data.motion || 0;
  const confidence = +data.confidence || 0;
  const occupants = String(data.n_persons ?? (data.presence ? 1 : 0));
  const roomState = data.room_state || roomStateFromMotion(motion);

  fieldState.motion = motion;
  fieldState.presence = !!data.presence;
  fieldState.confidence = confidence;
  fieldState.roomState = roomState;
  fieldState.breathingRate = +data.breathing_rate || 14.5;
  fieldState.heartRate = +data.heart_rate || 68.0;

  if (data.activity_burst) fieldState.bursting = true;
  if (data.fall_detected && !fieldState.fall) {
    fieldState.fall = true;
    fieldState.shockwaves.push({ r: 0, alpha: 1 });
    document.getElementById('fall-banner')?.classList.add('visible');
    const settings = loadSettings();
    if (settings.soundAlarm !== false) {
      playFallAlarmSound();
    }
  }

  heatBuffer.push({ t: tSec, motion });

  setText('kpi-motion-value', motion.toFixed(3));
  setText('kpi-occupants-value', occupants);
  setText('kpi-signal-value', (confidence * 100).toFixed(0) + '%');
  setText('kpi-idle-value', formatIdle(data.idle_seconds));
  setText('kpi-room-state-value', roomState);
  setHTML('kpi-presence-value', data.presence
    ? '<span class="kpi-dot detected"></span>Detected'
    : '<span class="kpi-dot absent"></span>Absent');

  setText('sem-room', roomState);
  setText('sem-idle', formatIdle(data.idle_seconds));
  setText('sem-occ',  occupants);
  setText('sem-fall', data.fall_risk || 'Normal');
  setText('sem-cal',  data.calibration_drift ? 'Drifting' : 'Stable');
  setText('sem-sig',  (confidence * 100).toFixed(0) + '%');
  setText('sem-node', selectedNode);

  document.getElementById('sem-fall')?.classList.toggle('warn', data.fall_risk === 'Elevated');
  document.getElementById('sem-cal')?.classList.toggle('warn', !!data.calibration_drift);
}

/* ─── Events ─────────────────────────────────────────────── */

function onEvents(events) {
  renderEventLog(events);

  // First poll is history, not news — record it without firing notifications.
  if (!initialEventsLoaded) {
    for (const e of events) seenEventIds.add(e.id);
    initialEventsLoaded = true;
    return;
  }

  const settings = loadSettings();
  for (const e of events) {
    if (seenEventIds.has(e.id)) continue;
    seenEventIds.add(e.id);
    maybeNotify(e, settings);
  }
}

function renderEventLog(events) {
  const consoleEl = document.getElementById('event-console');
  if (!consoleEl) return;

  if (events.length === 0) {
    consoleEl.innerHTML = '<div class="event-empty">No events recorded yet.</div>';
    return;
  }

  // Built with DOM nodes rather than innerHTML: event messages are data.
  consoleEl.innerHTML = '';
  for (const e of events) {
    const entry = document.createElement('div');
    entry.className = `event-row event-${(e.type || '').replace(/_/g, '-')}`;

    const time = e.created_at
      ? new Date(e.created_at * 1000).toLocaleTimeString('en-US', { hour12: false })
      : '--:--:--';

    const timeEl = document.createElement('span');
    timeEl.className = 'event-time';
    timeEl.textContent = `[${time}]`;

    const typeEl = document.createElement('span');
    typeEl.className = 'event-type';
    typeEl.textContent = (e.type || 'unknown').replace(/_/g, ' ').toUpperCase();

    const msgEl = document.createElement('span');
    msgEl.className = 'event-msg';
    msgEl.textContent = e.message || '';

    entry.append(timeEl, typeEl, msgEl);
    consoleEl.appendChild(entry);
  }
}

function maybeNotify(event, settings) {
  if (event.type === 'fall_detected') {
    if (settings.soundAlarm !== false) playFallAlarmSound();
    if (settings.notifications && settings.notifyOnFall) {
      notify('⚠ Fall detected', event.message || 'Possible fall event registered.');
    }
  } else if (event.type === 'idle_threshold_crossed' && settings.notifications && settings.notifyOnIdle) {
    notify('Room idle', event.message || 'No movement for an extended period.');
  }
}

/* ─── Nodes ──────────────────────────────────────────────── */

async function populateNodes() {
  try {
    const nodes = await getNodes();
    if (nodes.length && nodes[0]?.id) selectedNode = nodes[0].id;
  } catch (err) {
    console.error('[Sensing] populateNodes:', err);
  }
}

/* ─── UI bindings ────────────────────────────────────────── */

function bindUI() {
  document.getElementById('dismiss-fall-btn')?.addEventListener('click', () => {
    fieldState.fall = false;
    document.getElementById('fall-banner')?.classList.remove('visible');
  });

  document.getElementById('clear-log-btn')?.addEventListener('click', () => {
    const c = document.getElementById('event-console');
    if (c) c.innerHTML = '<div class="event-empty">Cleared from view — still stored in vitals.db.</div>';
  });

  // View switch tabs (Pulse vs 2D Mesh)
  const pulseCanvas = document.getElementById('pulse-canvas');
  const meshCanvas  = document.getElementById('mesh-canvas');
  const tabPulse    = document.getElementById('tab-pulse-view');
  const tabMesh     = document.getElementById('tab-mesh-view');
  const panelTitle  = document.getElementById('pulse-panel-title');

  tabPulse?.addEventListener('click', () => {
    currentSenseView = 'pulse';
    tabPulse.classList.add('active');
    tabMesh?.classList.remove('active');
    if (pulseCanvas) pulseCanvas.style.display = 'block';
    if (meshCanvas)  meshCanvas.style.display  = 'none';
    if (panelTitle)  panelTitle.textContent = 'PULSE FIELD';
  });

  tabMesh?.addEventListener('click', () => {
    currentSenseView = 'mesh';
    tabMesh.classList.add('active');
    tabPulse?.classList.remove('active');
    if (pulseCanvas) pulseCanvas.style.display = 'none';
    if (meshCanvas)  meshCanvas.style.display  = 'block';
    if (panelTitle)  panelTitle.textContent = '2D ROOM MESH';
  });

  // Oscilloscope controls
  document.getElementById('oscillo-gain')?.addEventListener('input', (e) => {
    oscilloGain = +e.target.value || 1.0;
  });

  const freezeBtn = document.getElementById('oscillo-freeze-btn');
  freezeBtn?.addEventListener('click', () => {
    oscilloFrozen = !oscilloFrozen;
    freezeBtn.textContent = oscilloFrozen ? 'Resume' : 'Freeze';
  });

  document.getElementById('test-sound-btn')?.addEventListener('click', () => {
    playFallAlarmSound();
  });

  const drawer = document.getElementById('settings-drawer');
  const scrim  = document.getElementById('drawer-scrim');
  const open  = () => { drawer?.classList.add('open'); scrim?.classList.add('open'); };
  const close = () => { drawer?.classList.remove('open'); scrim?.classList.remove('open'); };

  document.getElementById('settings-btn')?.addEventListener('click', open);
  document.getElementById('drawer-close')?.addEventListener('click', close);
  scrim?.addEventListener('click', close);

  document.getElementById('drawer-save')?.addEventListener('click', async () => {
    const newSettings = {
      idleAlertMinutes: Math.max(1, Math.min(240, +document.getElementById('set-idle-min').value || 10)),
      notifications:   document.getElementById('set-notify').checked,
      notifyOnFall:    document.getElementById('set-notify-fall').checked,
      soundAlarm:      document.getElementById('set-sound-alarm')?.checked ?? true,
    };
    saveSettings(newSettings);
    if (newSettings.notifications) await ensureNotificationPermission();
    close();
  });
}

/* ─── Helpers ────────────────────────────────────────────── */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function formatIdle(seconds) {
  if (seconds == null || isNaN(seconds)) return '0s';
  const s = Math.max(0, Math.floor(+seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function roomStateFromMotion(m) {
  if (m < 0.05) return 'Quiet';
  if (m < 0.20) return 'Ambient';
  if (m < 0.80) return 'Active';
  return 'Agitated';
}

/* ─── Cleanup ────────────────────────────────────────────── */

export function destroySensing() {
  if (unsubLive) { unsubLive(); unsubLive = null; }
  if (unsubEvents) { unsubEvents(); unsubEvents = null; }

  if (pulseRafId) cancelAnimationFrame(pulseRafId);
  if (meshRafId) cancelAnimationFrame(meshRafId);
  if (oscilloRafId) cancelAnimationFrame(oscilloRafId);
  if (heatRafId) cancelAnimationFrame(heatRafId);
  pulseRafId = meshRafId = oscilloRafId = heatRafId = null;

  for (const fn of resizeHandlers) window.removeEventListener('resize', fn);
  resizeHandlers = [];

  fieldState.ripples.length = 0;
  fieldState.shockwaves.length = 0;
  fieldState.fall = false;
  heatBuffer.length = 0;
  oscilloBuffer.length = 0;

  seenEventIds = new Set();
  initialEventsLoaded = false;

  setConnectionStatus(false);
}

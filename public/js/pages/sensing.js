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
let resizeHandlers = [];
let selectedNode = 'node-01';

// Pulse field state
const fieldState = {
  motion: 0,
  presence: false,
  confidence: 0,
  fall: false,
  roomState: 'Quiet',
  bursting: false,
  ripples: [],
  shockwaves: [],
};

// Heatstrip — rolling 30-minute history of motion values
const HEAT_WINDOW_S = 1800;
const heatBuffer = [];   // {t, motion}

let seenEventIds = new Set();
let initialEventsLoaded = false;

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
            <span class="pulse-title">PULSE FIELD</span>
            <span class="pulse-sub" id="pulse-sub">Listening…</span>
          </div>
          <div class="pulse-canvas-wrap">
            <canvas id="pulse-canvas"></canvas>
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
            <span class="drawer-label">Notify on idle</span>
            <input type="checkbox" id="set-notify-idle" ${settings.notifyOnIdle ? 'checked' : ''}>
          </label>
          <p class="drawer-note">The idle threshold is enforced by the bridge — set
            <code>idle_alert_seconds</code> in <code>bridge/config.json</code> and restart it to apply.</p>
          <button class="drawer-save" id="drawer-save">Save</button>
        </div>
      </aside>
    </div>
  `;

  await populateNodes();
  startPulseLoop();
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
  if (data.activity_burst) fieldState.bursting = true;
  if (data.fall_detected && !fieldState.fall) {
    fieldState.fall = true;
    fieldState.shockwaves.push({ r: 0, alpha: 1 });
    document.getElementById('fall-banner')?.classList.add('visible');
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
  if (!settings.notifications) return;
  if (event.type === 'fall_detected' && settings.notifyOnFall) {
    notify('⚠ Fall detected', event.message || 'Possible fall event registered.');
  } else if (event.type === 'idle_threshold_crossed' && settings.notifyOnIdle) {
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
      notifyOnIdle:    document.getElementById('set-notify-idle').checked,
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
  if (heatRafId) cancelAnimationFrame(heatRafId);
  pulseRafId = heatRafId = null;

  // Both canvases register a resize listener; drop them or they accumulate
  // one pair per visit to this page.
  for (const fn of resizeHandlers) window.removeEventListener('resize', fn);
  resizeHandlers = [];

  fieldState.ripples.length = 0;
  fieldState.shockwaves.length = 0;
  fieldState.fall = false;
  heatBuffer.length = 0;

  seenEventIds = new Set();
  initialEventsLoaded = false;

  setConnectionStatus(false);
}

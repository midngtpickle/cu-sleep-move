/**
 * SPA Router & Application Entry Point
 * CU SLEEP — WiFi Sleep Monitor (local standalone)
 */
import { renderHeader, setConnectionStatus } from './components/header.js';
import { subscribeLiveVitals, resolveNodeId } from './services/api.js';
import { renderInfo } from './pages/info.js';
import { renderLive, destroyLive } from './pages/live.js';
import { renderReport, destroyReport } from './pages/report.js';
import { renderHistory, destroyHistory } from './pages/history.js';
import { renderSensing, destroySensing } from './pages/sensing.js';
import { renderSetup } from './pages/setup.js';

// ─── Route Configuration ───────────────────────────────────
const routes = {
  '/info':    { render: renderInfo,    destroy: () => {},       title: 'About the App' },
  '/live':    { render: renderLive,    destroy: destroyLive,    title: 'Live Monitor' },
  '/report':  { render: renderReport,  destroy: destroyReport,  title: 'Sleep Report' },
  '/history': { render: renderHistory, destroy: destroyHistory, title: 'History' },
  '/setup':   { render: renderSetup,   destroy: () => {},       title: 'Setup Guide' },
  '/sensing': { render: renderSensing, destroy: destroySensing, title: 'CU MOVE' },
  '/cumove':  { render: renderSensing, destroy: destroySensing, title: 'CU MOVE' },
};

const DEFAULT_ROUTE = '/live';
let currentRoute = null;
let currentDestroy = null;

// ─── Router Core ───────────────────────────────────────────
function getRoute() {
  const hash = window.location.hash.slice(1) || DEFAULT_ROUTE;
  return routes[hash] ? hash : DEFAULT_ROUTE;
}

async function navigate() {
  const route = getRoute();
  const routeConfig = routes[route];
  const container = document.getElementById('app-content');

  if (route === currentRoute) return;

  // Tear down previous page
  if (currentDestroy) currentDestroy();

  // Page exit animation
  container.className = 'main-content page-exit';
  await new Promise(r => setTimeout(r, 100));

  container.innerHTML = '';
  container.className = 'main-content page-enter';
  document.title = `${routeConfig.title} — CU SLEEP`;

  await routeConfig.render(container);

  updateActiveNav(route);
  requestAnimationFrame(() => {
    container.className = 'main-content page-active';
  });

  currentRoute = route;
  currentDestroy = routeConfig.destroy;
}

function updateActiveNav(route) {
  document.querySelectorAll('.nav-link').forEach(link => {
    const href = link.getAttribute('href')?.replace('#', '') || '';
    link.classList.toggle('active', href === route);
  });
}

// ─── Global Heartbeat ──────────────────────────────────────
// Watches whichever node is reporting, so the header status dot reflects the
// bridge even on pages that don't subscribe to live data themselves.
const HEARTBEAT_STALE_MS = 10000;
let heartbeatTimer = null;

async function startGlobalHeartbeat() {
  const node = await resolveNodeId();
  subscribeLiveVitals(node, (data) => {
    clearTimeout(heartbeatTimer);

    if (!data?.updated_at) {
      setConnectionStatus(false, 'Offline');
      return;
    }

    const ageMs = Date.now() - data.updated_at * 1000;
    setConnectionStatus(ageMs <= HEARTBEAT_STALE_MS, ageMs > HEARTBEAT_STALE_MS ? 'Stale' : 'Live');

    heartbeatTimer = setTimeout(() => setConnectionStatus(false, 'Stale'), HEARTBEAT_STALE_MS);
  });
}

function init() {
  renderHeader(document.getElementById('site-header'));
  startGlobalHeartbeat();

  window.addEventListener('hashchange', navigate);

  if (!window.location.hash) {
    window.location.hash = `#${DEFAULT_ROUTE}`;
  } else {
    navigate();
  }
}

document.addEventListener('DOMContentLoaded', init);

/**
 * Local API Client
 * CU SLEEP — WiFi Sleep Monitor
 *
 * The single contract between the browser and the Python bridge.
 * Every field name and shape returned here matches what bridge/local_server.py
 * serves. If you change one side, change the other.
 *
 * API_BASE is empty by default because the bridge serves this page itself, so
 * requests are same-origin. Set window.API_BASE before loading the app to point
 * the UI at a bridge running on another machine.
 */

const API_BASE = window.API_BASE ?? '';

/** Timestamps are UNIX epoch SECONDS (floats) everywhere in this API. */
export function toDate(epochSeconds) {
  if (epochSeconds == null) return null;
  return new Date(epochSeconds * 1000);
}

async function getJSON(path, fallback) {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`[API] GET ${path} failed:`, e.message);
    return fallback;
  }
}

/**
 * Subscribe to live vitals over SSE, falling back to polling if the stream drops.
 * @param {string} nodeId
 * @param {function(object|null)} callback
 * @returns {function} unsubscribe
 */
export function subscribeLiveVitals(nodeId, callback) {
  let eventSource = null;
  let pollInterval = null;
  let retryTimer = null;
  let retryDelay = 2000;
  let closed = false;

  // The bridge is on this machine, so a restart is the common case and comes
  // back in seconds. Cap the backoff low — a long tail would leave the page
  // sitting on 2 s polling for half a minute after the bridge is already up.
  const MAX_RETRY_DELAY = 8000;

  const poll = async () => {
    if (closed) return;
    const data = await getJSON(`/api/live?node=${encodeURIComponent(nodeId)}`, null);
    if (!closed) callback(data && Object.keys(data).length ? data : null);
  };

  const startPolling = () => {
    if (pollInterval || closed) return;
    pollInterval = setInterval(poll, 2000);
  };

  const stopPolling = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };

  const connect = () => {
    if (closed) return;
    try {
      eventSource = new EventSource(`${API_BASE}/api/stream?node=${encodeURIComponent(nodeId)}`);

      eventSource.onopen = () => {
        // The stream is healthy again — drop back off the polling fallback.
        stopPolling();
        retryDelay = 2000;
      };

      eventSource.onmessage = (event) => {
        if (closed) return;
        try {
          callback(JSON.parse(event.data));
        } catch (e) {
          console.error('[API] Bad SSE payload:', e);
        }
      };

      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (closed) return;

        // Poll so the UI keeps updating, and keep trying to get the stream
        // back. Without this the page stays on polling forever once the
        // bridge has been restarted even once.
        startPolling();
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
            connect();
          }, retryDelay);
        }
      };
    } catch (e) {
      console.warn('[API] SSE unavailable, polling instead');
      startPolling();
    }
  };

  poll();      // paint immediately rather than waiting for the first stream tick
  connect();

  return () => {
    closed = true;
    if (eventSource) eventSource.close();
    if (retryTimer) clearTimeout(retryTimer);
    stopPolling();
  };
}

/**
 * Poll discrete sensing events (falls, bursts, idle, drift), newest first.
 * There is no push channel for these — they are written far less often than
 * live vitals, so a slow poll is cheaper than another stream.
 * @returns {function} unsubscribe
 */
export function subscribeSensingEvents(nodeId, callback, { limit = 50, intervalMs = 3000 } = {}) {
  let closed = false;

  const tick = async () => {
    const events = await getJSON(
      `/api/events?node=${encodeURIComponent(nodeId)}&limit=${limit}`, []
    );
    if (!closed) callback(events);
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    closed = true;
    clearInterval(timer);
  };
}

/** @returns {Promise<Array<{id: string, name?: string}>>} */
export async function getNodes() {
  const nodes = await getJSON('/api/nodes', []);
  return nodes.length ? nodes : [{ id: 'node-01', name: 'Node 01' }];
}

/**
 * Pick the node a page should show when the user has not chosen one.
 *
 * Never assume node-01 exists. A single sensor can be provisioned with any id,
 * and hardcoding the default leaves the UI subscribed to a node that never
 * reports — the page just sits on "No Data" while the real node streams.
 *
 * @param {string} [preferred] currently selected node, kept if still present
 * @returns {Promise<string>}
 */
export async function resolveNodeId(preferred) {
  const nodes = await getNodes();
  if (preferred && nodes.some(n => n.id === preferred)) return preferred;
  return nodes[0]?.id ?? 'node-01';
}

// ─── Sessions ──────────────────────────────────────────────
// A session is one run of the bridge — one night. The server rolls up each
// session's statistics in SQL, so these are cheap and always current, including
// for the session still in progress.

/** Sessions for a node, newest first, each with its rollup. */
export function getSessions(nodeId = 'node-01', limit = 60) {
  return getJSON(`/api/sessions?node=${encodeURIComponent(nodeId)}&limit=${limit}`, []);
}

/** One session with its rollup, or null. */
export function getSession(sessionId) {
  return getJSON(`/api/sessions/${encodeURIComponent(sessionId)}`, null);
}

/** A session's minute batches, oldest first. Raw samples excluded. */
export function getSessionVitals(sessionId) {
  return getJSON(`/api/sessions/${encodeURIComponent(sessionId)}/vitals`, []);
}

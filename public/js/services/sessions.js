/**
 * Sessions
 * CU SLEEP — WiFi Sleep Monitor
 *
 * A session is one run of the bridge: you start it at bedtime and stop it in
 * the morning. The server owns that lifecycle and rolls up each session's
 * statistics in SQL, so this module only does two things — turn a rollup into
 * the derived numbers the UI shows (AHI, quality score, labels), and keep AI
 * analyses in the browser.
 *
 * Derived scores live here rather than in the bridge on purpose: they are
 * presentation heuristics, not recorded measurements. The server reports what
 * happened; the client decides how to score it.
 */
import * as api from './api.js';
import { calculateAHI, calculateSleepQuality, getAHISeverity } from './vitals.js';

/** Local YYYY-MM-DD for the night a session belongs to (its start). */
export function sessionDate(session) {
  const d = new Date(session.startTime * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** e.g. "Tue 12 Aug · 22:30 → 06:29 · 8h 0m" */
export function sessionLabel(session) {
  const t = ts => new Date(ts * 1000)
    .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = new Date(session.startTime * 1000)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  if (session.status === 'active') {
    return `${day} · ${t(session.startTime)} → now · recording`;
  }
  return `${day} · ${t(session.startTime)} → ${t(session.endTime)} · ${formatSpan(session)}`;
}

function formatSpan(session) {
  const mins = Math.max(0, Math.round((session.endTime - session.startTime) / 60));
  const h = Math.floor(mins / 60);
  return h === 0 ? `${mins}m` : `${h}h ${mins % 60}m`;
}

/**
 * Attach the derived values the UI needs to a server rollup.
 * `minutes` is the count of recorded minute batches, which is the honest
 * measure of monitored time — a gap in recording should not inflate it.
 */
export function enrich(session) {
  if (!session) return null;

  const stats = {
    avgBR: session.breathingRate?.avg ?? null,
    avgHR: session.heartRate?.avg ?? null,
    minBR: session.breathingRate?.min ?? null,
    maxBR: session.breathingRate?.max ?? null,
    minHR: session.heartRate?.min ?? null,
    maxHR: session.heartRate?.max ?? null,
  };

  // AHI needs a meaningful stretch of sleep before it means anything; the
  // bridge applies the same floor to its live figure.
  const ahi = session.minutes >= 10
    ? calculateAHI(session.apneaEvents, session.minutes)
    : null;

  return {
    ...session,
    stats,
    date: sessionDate(session),
    label: sessionLabel(session),
    ahi,
    ahiSeverity: getAHISeverity(ahi),
    sleepQualityScore: session.minutes > 0 ? calculateSleepQuality(stats, ahi ?? 0) : null,
  };
}

/** Sessions for a node, newest first, enriched. */
export async function getSessions(nodeId = 'node-01', limit = 60) {
  return (await api.getSessions(nodeId, limit)).map(enrich);
}

/** One enriched session, or null. */
export async function getSession(sessionId) {
  return enrich(await api.getSession(sessionId));
}

/** A session's minute batches, oldest first. */
export function getSessionVitals(sessionId) {
  return api.getSessionVitals(sessionId);
}

// ─── AI Analysis (browser-local) ───────────────────────────
// Keyed by session id in localStorage. Nothing leaves the machine except the
// metrics sent to Gemini when analysis is explicitly requested.

const aiKey = sessionId => `ai_analysis_${sessionId}`;

export function getAIAnalysis(sessionId) {
  try {
    const raw = localStorage.getItem(aiKey(sessionId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.text) {
        return parsed;
      }
    } catch {
      // Legacy plain markdown string
    }
    return { text: raw, provider: 'ai', model: '' };
  } catch {
    return null;
  }
}

export function saveAIAnalysis(sessionId, data) {
  try {
    const val = typeof data === 'object' ? JSON.stringify(data) : String(data);
    localStorage.setItem(aiKey(sessionId), val);
  } catch (e) {
    console.warn('[Sessions] Could not persist AI analysis:', e);
  }
}

export function deleteAIAnalysis(sessionId) {
  try {
    localStorage.removeItem(aiKey(sessionId));
  } catch { /* nothing to do */ }
}

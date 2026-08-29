/**
 * Vitals Processing Service
 * CU SLEEP — WiFi Sleep Monitor
 *
 * Thresholds, severity banding, and the derived scores shown in the UI.
 * Per-session aggregation lives in SQL (see bridge/storage.py) — this module
 * only turns those aggregates into the numbers a reader sees.
 */

// ─── Constants ─────────────────────────────────────────────
export const APNEA_BR_THRESHOLD = 6;     // BPM — below this = apnea event

export const AHI_NORMAL   = 5;
export const AHI_MILD     = 15;
export const AHI_MODERATE = 30;
// Severe > 30

// Normal ranges
export const BR_NORMAL_MIN = 12;
export const BR_NORMAL_MAX = 20;
export const HR_NORMAL_MIN = 50;
export const HR_NORMAL_MAX = 90;

// ─── AHI Severity ──────────────────────────────────────────

/**
 * Get AHI severity label and CSS class.
 * @param {number} ahi
 * @returns {{ label: string, className: string }}
 */
export function getAHISeverity(ahi) {
  if (ahi == null || isNaN(ahi)) return { label: '—', className: '' };
  if (ahi < AHI_NORMAL)   return { label: 'Normal',   className: 'normal' };
  if (ahi < AHI_MILD)     return { label: 'Mild',     className: 'mild' };
  if (ahi < AHI_MODERATE) return { label: 'Moderate', className: 'moderate' };
  return { label: 'Severe', className: 'severe' };
}

// ─── Apnea Detection ──────────────────────────────────────

/**
 * Check if current breathing rate indicates apnea.
 * @param {number} breathingRate
 * @returns {boolean}
 */
export function isApnea(breathingRate) {
  return breathingRate != null && breathingRate < APNEA_BR_THRESHOLD;
}

/**
 * True if a minute batch contains any apneic samples.
 * The bridge reports this as a per-batch sample count, not a boolean.
 * @param {Object} batch
 * @returns {boolean}
 */
export function batchHasApnea(batch) {
  return (batch.apnea_sample_count ?? 0) > 0;
}

/**
 * Calculate AHI (Apnea-Hypopnea Index).
 * AHI = apnea events per hour of sleep.
 * @param {number} apneaCount
 * @param {number} totalSleepMinutes
 * @returns {number}
 */
export function calculateAHI(apneaCount, totalSleepMinutes) {
  if (!totalSleepMinutes || totalSleepMinutes <= 0) return 0;
  const hours = totalSleepMinutes / 60;
  return Math.round((apneaCount / hours) * 10) / 10;
}

// ─── Data Processing ──────────────────────────────────────

/**
 * Process raw vitals into chart-ready arrays.
 * @param {Array} vitals
 * @returns {{ timestamps, breathingRates, heartRates, apneaFlags, phaseVariances }}
 */
export function processVitalsForCharts(vitals) {
  const timestamps = [];
  const breathingRates = [];
  const heartRates = [];
  const apneaFlags = [];
  const phaseVariances = [];

  for (const v of vitals) {
    // Bridge timestamps are UNIX epoch SECONDS, not milliseconds.
    timestamps.push(new Date((v.timestamp ?? v.written_at ?? v.ts) * 1000));

    breathingRates.push(v.breathing_rate?.avg ?? null);
    heartRates.push(v.heart_rate?.avg ?? null);
    apneaFlags.push(batchHasApnea(v) ? 1 : 0);
    phaseVariances.push(v.confidence_avg ?? null);
  }

  return { timestamps, breathingRates, heartRates, apneaFlags, phaseVariances };
}

/**
 * Calculate sleep quality score (0–100).
 * Heuristic based on AHI, HR stability, BR stability.
 * @param {Object} stats - avg/min/max breathing and heart rate
 * @param {number} ahi
 * @returns {number}
 */
export function calculateSleepQuality(stats, ahi) {
  let score = 100;

  // Penalize for high AHI
  if (ahi >= 30)     score -= 40;
  else if (ahi >= 15) score -= 25;
  else if (ahi >= 5)  score -= 10;

  // Penalize for abnormal average BR
  if (stats.avgBR != null) {
    if (stats.avgBR < BR_NORMAL_MIN || stats.avgBR > BR_NORMAL_MAX) {
      score -= 10;
    }
  }

  // Penalize for abnormal average HR
  if (stats.avgHR != null) {
    if (stats.avgHR < HR_NORMAL_MIN || stats.avgHR > HR_NORMAL_MAX) {
      score -= 10;
    }
  }

  // Penalize for high HR variance
  if (stats.minHR != null && stats.maxHR != null) {
    const hrRange = stats.maxHR - stats.minHR;
    if (hrRange > 40) score -= 15;
    else if (hrRange > 25) score -= 5;
  }

  // Penalize for high BR variance
  if (stats.minBR != null && stats.maxBR != null) {
    const brRange = stats.maxBR - stats.minBR;
    if (brRange > 10) score -= 10;
    else if (brRange > 6) score -= 5;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Format a duration in minutes to "Xh Ym" string.
 * @param {number} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  if (minutes == null || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Format a timestamp as HH:MM.
 * @param {Date} date
 * @returns {string}
 */
export function formatTime(date) {
  if (!date) return '—';
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Compute trend direction from an array of values.
 * @param {Array<number>} values
 * @returns {'up'|'down'|'flat'}
 */
export function getTrend(values) {
  if (!values || values.length < 2) return 'flat';
  const recent = values.slice(-3);
  const older  = values.slice(-6, -3);
  if (older.length === 0) return 'flat';

  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder  = older.reduce((a, b) => a + b, 0) / older.length;
  const diff = avgRecent - avgOlder;

  if (Math.abs(diff) < 0.5) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

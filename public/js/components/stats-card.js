/**
 * Stats Card Component
 * WiFi Sleep Monitor
 */

/**
 * Create a stats card HTML string.
 * @param {Object} opts
 * @param {string} opts.label
 * @param {string|number} opts.value
 * @param {string} [opts.unit]
 * @param {string} [opts.sublabel]
 * @param {string} [opts.className]
 * @param {string} [opts.trend] - 'up', 'down', 'flat'
 * @returns {string}
 */
export function statsCard({ label, value, unit = '', sublabel = '', className = '', trend = '' }) {
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : trend === 'flat' ? '→' : '';
  const trendClass = trend ? `trend-${trend}` : '';

  return `
    <div class="stat-card ${className}">
      <div class="stat-label">${label}</div>
      <div class="stat-value-row">
        <span class="stat-value">${value ?? '—'}</span>
        ${unit ? `<span class="stat-unit">${unit}</span>` : ''}
        ${trendIcon ? `<span class="stat-trend ${trendClass}">${trendIcon}</span>` : ''}
      </div>
      ${sublabel ? `<div class="stat-sublabel">${sublabel}</div>` : ''}
    </div>
  `;
}

/**
 * Create a severity badge HTML string (for AHI).
 * @param {string} label - 'Normal', 'Mild', 'Moderate', 'Severe'
 * @param {string} className
 * @returns {string}
 */
export function severityBadge(label, className) {
  if (!label || label === '—') return '';
  return `<span class="severity-badge ${className}">${label}</span>`;
}

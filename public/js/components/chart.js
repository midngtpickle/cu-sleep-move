/**
 * Chart Component — Chart.js Wrapper (B&W Theme)
 * WiFi Sleep Monitor
 */

/* global Chart */

// ─── B&W Theme Defaults ───────────────────────────────────
const COLORS = {
  line:       'rgba(255, 255, 255, 0.9)',
  lineFill:   'rgba(255, 255, 255, 0.05)',
  secondary:  'rgba(170, 170, 170, 0.8)',
  secondFill: 'rgba(170, 170, 170, 0.03)',
  grid:       'rgba(255, 255, 255, 0.06)',
  tick:       'rgba(180, 180, 180, 0.6)',
  apnea:      'rgba(255, 60, 60, 0.7)',
  apneaFill:  'rgba(255, 60, 60, 0.08)',
};

/**
 * Apply global Chart.js defaults for B&W theme.
 */
function applyGlobalDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = COLORS.tick;
  Chart.defaults.borderColor = COLORS.grid;
  Chart.defaults.font.family = "'JetBrains Mono', 'Space Mono', monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.animation.duration = 400;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
}

// Apply once on load
applyGlobalDefaults();

/**
 * Create a time-series line chart.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} opts
 * @param {Array<Date>} opts.labels - timestamps
 * @param {Array<number>} opts.data - primary dataset
 * @param {string} [opts.label]
 * @param {Array<number>} [opts.data2] - secondary dataset
 * @param {string} [opts.label2]
 * @param {Array<number>} [opts.apneaFlags] - 0/1 array for apnea markers
 * @param {number} [opts.yMin]
 * @param {number} [opts.yMax]
 * @param {boolean} [opts.showTimeAxis=true]
 * @returns {Chart}
 */
export function createTimeChart(canvas, opts = {}) {
  const {
    labels = [],
    data = [],
    label = 'Value',
    data2,
    label2,
    apneaFlags,
    yMin,
    yMax,
    showTimeAxis = true,
  } = opts;

  const datasets = [
    {
      label,
      data,
      borderColor: COLORS.line,
      backgroundColor: COLORS.lineFill,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHoverBackgroundColor: '#fff',
      tension: 0.3,
      fill: true,
    },
  ];

  if (data2) {
    datasets.push({
      label: label2 || 'Secondary',
      data: data2,
      borderColor: COLORS.secondary,
      backgroundColor: COLORS.secondFill,
      borderWidth: 1.2,
      pointRadius: 0,
      tension: 0.3,
      fill: true,
    });
  }

  if (apneaFlags) {
    datasets.push({
      label: 'Apnea',
      data: apneaFlags.map((f, i) => f ? (data[i] || 0) : null),
      borderColor: COLORS.apnea,
      backgroundColor: COLORS.apneaFill,
      borderWidth: 0,
      pointRadius: apneaFlags.map(f => f ? 4 : 0),
      pointBackgroundColor: COLORS.apnea,
      pointBorderColor: 'transparent',
      fill: false,
      showLine: false,
    });
  }

  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: datasets.length > 1, labels: { boxWidth: 10, padding: 16 } },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          padding: 10,
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const d = items[0].parsed.x ?? items[0].label;
              return typeof d === 'number' ? new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : d;
            },
          },
        },
      },
      scales: {
        x: {
          display: showTimeAxis,
          type: labels.length && labels[0] instanceof Date ? 'time' : 'category',
          ...(labels.length && labels[0] instanceof Date ? {
            time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
          } : {}),
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkipPadding: 30 },
        },
        y: {
          min: yMin,
          max: yMax,
          grid: { color: COLORS.grid, lineWidth: 0.5 },
          ticks: { padding: 8, count: 5 },
        },
      },
    },
  });
}

/**
 * Create a bar chart for historical data.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} opts
 * @returns {Chart}
 */
export function createBarChart(canvas, opts = {}) {
  const { labels = [], data = [], label = 'Value', thresholds = [] } = opts;

  const barColors = data.map(v => {
    if (v >= 30) return 'rgba(255, 60, 60, 0.8)';
    if (v >= 15) return 'rgba(255, 170, 60, 0.8)';
    if (v >= 5)  return 'rgba(255, 255, 100, 0.7)';
    return 'rgba(255, 255, 255, 0.6)';
  });

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data,
        backgroundColor: barColors,
        borderColor: barColors.map(c => c.replace(/[\d.]+\)$/, '1)')),
        borderWidth: 1,
        borderRadius: 2,
        maxBarThickness: 28,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: COLORS.grid, lineWidth: 0.5 },
          ticks: { padding: 8 },
          beginAtZero: true,
        },
      },
    },
  });
}

/**
 * Safely destroy a Chart instance.
 * @param {Chart|null} chart
 */
export function destroyChart(chart) {
  if (chart && typeof chart.destroy === 'function') {
    chart.destroy();
  }
}

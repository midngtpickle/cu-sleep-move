/**
 * Header Component — Persistent Navigation Bar
 * CU SLEEP — WiFi Sleep Monitor (local standalone)
 */

let headerContainer = null;
let docClickListener = null;

/**
 * Render the navigation header.
 * @param {HTMLElement} container
 */
export function renderHeader(container) {
  headerContainer = container;
  container.innerHTML = `
    <div class="header-inner">
      <a href="#/live" class="logo" aria-label="Home">
        <span class="logo-icon">🌙</span>
        <span class="logo-text">CU <span class="logo-accent">SLEEP</span></span>
      </a>
      <nav class="nav" id="main-nav">
        <a href="#/live" class="nav-link active" data-route="/live">
          <span class="nav-icon">◈</span>Live
        </a>
        <a href="#/report" class="nav-link" data-route="/report">
          <span class="nav-icon">▦</span>Report
        </a>
        <a href="#/history" class="nav-link" data-route="/history">
          <span class="nav-icon">▤</span>History
        </a>
        <a href="#/sensing" class="nav-link" data-route="/sensing">
          <span class="nav-icon">📡</span>Sensing
        </a>
        <a href="#/setup" class="nav-link" data-route="/setup">
          <span class="nav-icon">⚙</span>Setup
        </a>
        <a href="#/info" class="nav-link" data-route="/info">
          <span class="nav-icon">ℹ</span>Info
        </a>
      </nav>
      <div class="header-right">
        <div class="connection-status" id="connection-dot" title="Bridge status">
          <span class="status-dot offline"></span>
          <span class="status-text">Offline</span>
        </div>
        <button class="menu-toggle" id="menu-toggle" aria-label="Toggle navigation menu" aria-expanded="false">
          <span></span>
          <span></span>
          <span></span>
        </button>
      </div>
    </div>
  `;

  // Remove old document listener if re-rendering header
  if (docClickListener) {
    document.removeEventListener('click', docClickListener);
    docClickListener = null;
  }

  const menuToggle = container.querySelector('#menu-toggle');
  const mainNav = container.querySelector('#main-nav');
  if (!menuToggle || !mainNav) return;

  menuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menuToggle.classList.toggle('open');
    mainNav.classList.toggle('open', isOpen);
    menuToggle.setAttribute('aria-expanded', isOpen);
  });

  const closeMenu = () => {
    menuToggle.classList.remove('open');
    mainNav.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
  };

  mainNav.addEventListener('click', (e) => {
    if (e.target.closest('.nav-link')) closeMenu();
  });

  docClickListener = (e) => {
    if (!container.contains(e.target)) closeMenu();
  };
  document.addEventListener('click', docClickListener);
}

/**
 * Update the connection status indicator.
 * @param {boolean} connected
 * @param {string} [label]
 */
export function setConnectionStatus(connected, label) {
  const dot = document.querySelector('#connection-dot .status-dot');
  const text = document.querySelector('#connection-dot .status-text');
  if (dot) dot.className = `status-dot ${connected ? 'online' : 'offline'}`;
  if (text) text.textContent = label || (connected ? 'Live' : 'Offline');
}

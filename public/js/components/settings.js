/**
 * Settings persistence — localStorage-backed.
 */
const KEY = 'wifisense_settings_v1';

const DEFAULTS = {
  idleAlertMinutes: 10,
  notifications: false,
  notifyOnFall: true,
  notifyOnIdle: true,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...settings }));
  } catch (err) {
    console.error('[Settings] Save failed:', err);
  }
}

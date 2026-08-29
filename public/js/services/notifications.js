/**
 * Browser notifications — thin wrapper around the Notification API.
 * No-ops if unsupported or blocked.
 */

export async function ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'cu-sleep-' + title });
  } catch (err) {
    console.warn('[Notify] failed:', err);
  }
}

// Bootstrap. Everything substantive lives in store.js and the ui-*.js
// modules; this file's whole job is to start them in the right order and own
// the handful of app-wide background jobs.

const REMINDER_INTERVAL_MS = 30000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60000;

let geofencer = null;

/* ---------- notifications ---------- */

function canNotify() {
  return 'Notification' in window && Notification.permission === 'granted';
}

async function notify(title, body, taskId) {
  if (!canNotify()) return;
  const data = { url: `${location.pathname}?task=${taskId}` };
  // Prefer the service worker's notification: it survives the tab closing and
  // routes taps back into the app through sw.js's notificationclick handler.
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, tag: taskId, data });
  } else {
    new Notification(title, { body });
  }
}

// Fires once per task, tracked by notified_at, for anything due at or before
// the current minute today.
async function checkTimeReminders() {
  if (!canNotify()) return;
  const today = todayKey();
  const hhmm = new Date().toTimeString().slice(0, 5);
  const due = Store.state.tasks.filter(
    t => t.status === 'open' && !t.notified_at && t.due_date === today && t.due_time && t.due_time <= hhmm
  );
  for (const task of due) {
    await notify('Task due', task.title, task.id);
    await Store.updateTask(task.id, { notified_at: nowIso() });
  }
}

function setupGeofencer() {
  geofencer = new Geofencer({
    getLocations: () => Store.state.locations,
    onArrive: async loc => {
      const matches = Store.state.tasks.filter(
        t => t.status === 'open' && t.location_trigger_id === loc.id
      );
      for (const task of matches) await notify(`Arrived at ${loc.label}`, task.title, task.id);
    },
  });
  geofencer.start();
}

/* ---------- background upkeep ---------- */

// The old build re-read the database and redrew everything every 60 seconds,
// which wiped out any inline edit or open dropdown mid-interaction. Instead:
// refresh when the tab is actually brought back into view, and let the store's
// own change events cover everything else.
function setupRefreshOnFocus() {
  let lastDay = todayKey();
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    // A day boundary crossed while the tab was hidden changes what counts as
    // "today", so the whole list has to be re-derived.
    if (todayKey() !== lastDay) {
      lastDay = todayKey();
      await Store.rolloverAndPurge();
    }
    await Store.refresh();
  });
}

/* ---------- start ---------- */

async function init() {
  await Store.rolloverAndPurge();
  await Store.refresh();
  await Store.backfillDueAt();

  UI.setupTabs();
  TasksUI.setup();
  SettingsUI.setup();
  RecordUI.setup();
  PushUI.setup();
  setupGeofencer();
  setupRefreshOnFocus();

  setInterval(() => checkTimeReminders(), REMINDER_INTERVAL_MS);
  setInterval(() => Store.rolloverAndPurge(), HOUSEKEEPING_INTERVAL_MS);

  // Commit any in-flight soft delete rather than letting it silently survive.
  window.addEventListener('pagehide', () => TasksUI.commitPendingDelete());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);

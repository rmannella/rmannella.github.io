// Web Push registration.
//
// The app's own timed reminders (js/app.js) only fire while it is open. This
// registers the device with a push service so the send-reminders Edge
// Function can reach it even when the app is closed -- which is the whole
// point of a reminder.
//
// Requires: a signed-in Supabase session (so the subscription can be stored
// against an account) and a VAPID public key in js/push-config.js.

const PushUI = (() => {
  function config() {
    return window.PUSH_CONFIG || {};
  }

  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function isConfigured() {
    return !!config().vapidPublicKey;
  }

  // VAPID keys are base64url; PushManager wants raw bytes.
  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function currentSubscription() {
    if (!isSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function enable() {
    if (!isSupported()) throw new Error("This browser can't receive push reminders.");
    if (!isConfigured()) throw new Error('Push reminders are not set up yet — see the README.');
    if (!window.Sync || !Sync.getStatus().signedIn) {
      throw new Error('Sign in with Google first so reminders can reach your devices.');
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error(
        permission === 'denied'
          ? 'Notifications are blocked for this site in your browser settings.'
          : 'Notification permission was dismissed.'
      );
    }

    const reg = await navigator.serviceWorker.ready;
    const subscription =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        // Required by Chrome: every push must result in a visible
        // notification, which is what this app does anyway.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config().vapidPublicKey),
      }));

    await Sync.savePushSubscription(subscription);
    return subscription;
  }

  async function disable() {
    const subscription = await currentSubscription();
    if (!subscription) return;
    // Drop the server record first: a subscription that is unsubscribed
    // locally but still stored would just collect delivery failures.
    if (window.Sync) await Sync.deletePushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }

  /* ---------- settings UI ---------- */

  async function refresh() {
    const row = $('push-row');
    const btn = $('push-btn');
    const status = $('push-status');
    if (!row || !btn || !status) return;

    if (!isSupported() || !isConfigured()) {
      setHidden(row, true);
      return;
    }
    setHidden(row, false);

    const signedIn = !!(window.Sync && Sync.getStatus().signedIn);
    const subscription = await currentSubscription();

    if (!signedIn) {
      btn.disabled = true;
      btn.textContent = 'Send reminders to this device';
      status.textContent = 'Sign in with Google first';
      return;
    }

    btn.disabled = false;
    if (subscription) {
      btn.textContent = 'Stop reminders on this device';
      status.textContent = 'This device will get reminders even when the app is closed';
    } else {
      btn.textContent = 'Send reminders to this device';
      status.textContent = Notification.permission === 'denied'
        ? 'Notifications are blocked in your browser settings'
        : 'Off for this device';
    }
  }

  function setup() {
    const btn = $('push-btn');
    if (!btn) return;

    btn.addEventListener(
      'click',
      UI.guard(async () => {
        const subscription = await currentSubscription();
        if (subscription) {
          await disable();
          UI.showToast('Reminders turned off for this device.');
        } else {
          await enable();
          UI.showToast('This device will now get reminders even when the app is closed.');
        }
        await refresh();
      }, 'Could not change reminder settings.')
    );

    // The service worker re-subscribes when a push service rotates the
    // endpoint and hands the new one back here to be stored.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', async event => {
        if (!event.data || event.data.type !== 'push-subscription-changed') return;
        const sub = await currentSubscription();
        if (sub && window.Sync) {
          try {
            await Sync.savePushSubscription(sub);
          } catch (err) {
            console.error(err);
          }
        }
      });
    }

    refresh();
    // Signing in or out changes whether this is even possible.
    window.addEventListener('focus', () => refresh());
    UI.onTabChange(panelId => {
      if (panelId === 'panel-settings') refresh();
    });
  }

  return { setup, enable, disable, refresh, isSupported, isConfigured, currentSubscription };
})();

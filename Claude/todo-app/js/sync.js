// Optional cross-device sync layer, sitting between js/db.js and the rest
// of the app. Fully inert (zero behavior change) unless js/sync-config.js
// has real values and the Supabase client script loaded successfully --
// see README's "Cross-device sync" section for setup.
//
// db.js itself is never modified: this file wraps DB.put/DB.remove once,
// here, so a failure to load this script leaves the app exactly as it
// behaves today.
(function () {
  const STORES = ['tasks', 'locations', 'labels', 'digests'];
  const KEY_FIELD = { tasks: 'id', locations: 'id', labels: 'id', digests: 'date' };
  const OUTBOX_KEY = 'sync_pending_deletes';
  const REALTIME_DEBOUNCE_MS = 300;

  function isConfigured() {
    return !!(
      window.SUPABASE_CONFIG &&
      window.SUPABASE_CONFIG.url &&
      window.SUPABASE_CONFIG.anonKey &&
      window.supabase
    );
  }

  const client = isConfigured()
    ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey)
    : null;

  let currentUser = null;
  let realtimeChannel = null;
  const realtimeTimers = {};

  // ---- wrap DB.put / DB.remove (installed immediately, before app.js's
  // init() runs) ----
  const rawPut = DB.put.bind(DB);
  const rawPutMany = DB.putMany.bind(DB);
  const rawRemove = DB.remove.bind(DB);

  DB.put = async function (storeName, value) {
    const result = await rawPut(storeName, value);
    if (STORES.includes(storeName)) pushToRemote(storeName, value);
    return result;
  };
  DB.putMany = async function (storeName, values) {
    const result = await rawPutMany(storeName, values);
    if (STORES.includes(storeName)) values.forEach(v => pushToRemote(storeName, v));
    return result;
  };
  DB.remove = async function (storeName, id) {
    const result = await rawRemove(storeName, id);
    if (STORES.includes(storeName)) pushDelete(storeName, id);
    return result;
  };

  // Apply incoming pull/realtime data through these instead of the wrapped
  // versions above, so applying a remote change never re-triggers a push
  // back to Supabase (no echo loop).
  const raw = { put: rawPut, putMany: rawPutMany, remove: rawRemove };

  // ---- delete outbox (localStorage) — covers offline/failed soft-deletes ----
  function readOutbox() {
    try {
      return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function writeOutbox(items) {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  }
  function addToOutbox(storeName, key) {
    const items = readOutbox();
    if (!items.some(i => i.store === storeName && i.key === key)) {
      items.push({ store: storeName, key });
      writeOutbox(items);
    }
  }
  function removeFromOutbox(storeName, key) {
    writeOutbox(readOutbox().filter(i => !(i.store === storeName && i.key === key)));
  }
  async function flushDeleteOutbox() {
    if (!client || !currentUser) return;
    for (const item of readOutbox()) {
      await pushDelete(item.store, item.key, true);
    }
  }

  // ---- push ----
  function keyFieldsFor(storeName) {
    return `${KEY_FIELD[storeName]},user_id`;
  }

  async function pushToRemote(storeName, record) {
    if (!client || !currentUser) return;
    try {
      await client
        .from(storeName)
        .upsert({ ...record, user_id: currentUser.id }, { onConflict: keyFieldsFor(storeName) });
    } catch (e) {
      // offline / transient -- the next pullAndMerge() self-heals via updated_at comparison
    }
  }

  async function pushDelete(storeName, key, fromOutbox) {
    if (!client || !currentUser) {
      addToOutbox(storeName, key);
      return;
    }
    try {
      const { error } = await client
        .from(storeName)
        .update({ deleted_at: new Date().toISOString() })
        .eq(KEY_FIELD[storeName], key)
        .eq('user_id', currentUser.id);
      if (error) throw error;
      if (fromOutbox) removeFromOutbox(storeName, key);
    } catch (e) {
      addToOutbox(storeName, key);
    }
  }

  // ---- pull + merge ----

  // Store comes from a later script tag (sync.js has to install its DB wrapper
  // first) and is a top-level `const`, which lives in the global lexical scope
  // rather than on `window` -- so it is referenced directly, at call time.
  async function reloadApp() {
    if (typeof Store !== 'undefined' && typeof Store.refresh === 'function') await Store.refresh();
  }

  function ts(x) {
    return x ? new Date(x).getTime() : 0;
  }

  function stripUserId(row) {
    const { user_id, ...rest } = row;
    return rest;
  }

  async function reconcileOne(storeName, key, local, remote) {
    if (remote && remote.deleted_at && ts(remote.deleted_at) >= ts(local && local.updated_at)) {
      if (local) await raw.remove(storeName, key);
      return;
    }
    if (local && !remote) {
      pushToRemote(storeName, local);
      return;
    }
    if (remote && !local) {
      await raw.put(storeName, stripUserId(remote));
      return;
    }
    if (local && remote) {
      if (ts(local.updated_at) >= ts(remote.updated_at)) pushToRemote(storeName, local);
      else await raw.put(storeName, stripUserId(remote));
    }
  }

  async function pullAndMerge() {
    if (!client || !currentUser) return;
    for (const storeName of STORES) {
      const { data: remoteRows, error } = await client
        .from(storeName)
        .select('*')
        .eq('user_id', currentUser.id);
      if (error) continue;
      const keyField = KEY_FIELD[storeName];
      const localRows = await DB.getAll(storeName);
      const localByKey = new Map(localRows.map(r => [r[keyField], r]));
      const remoteByKey = new Map((remoteRows || []).map(r => [r[keyField], r]));
      const allKeys = new Set([...localByKey.keys(), ...remoteByKey.keys()]);
      for (const key of allKeys) {
        await reconcileOne(storeName, key, localByKey.get(key), remoteByKey.get(key));
      }
    }
    await flushDeleteOutbox();
    await reloadApp();
  }

  // ---- realtime ----
  function subscribeRealtime() {
    if (!client || !currentUser) return;
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = client.channel('sync-' + currentUser.id);
    STORES.forEach(storeName => {
      realtimeChannel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: storeName, filter: `user_id=eq.${currentUser.id}` },
        payload => {
          clearTimeout(realtimeTimers[storeName]);
          realtimeTimers[storeName] = setTimeout(() => applyRealtimeChange(storeName, payload), REALTIME_DEBOUNCE_MS);
        }
      );
    });
    realtimeChannel.subscribe();
  }

  async function applyRealtimeChange(storeName, payload) {
    const keyField = KEY_FIELD[storeName];
    const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
    if (!row) return;
    if (row.deleted_at) await raw.remove(storeName, row[keyField]);
    else await raw.put(storeName, stripUserId(row));
    await reloadApp();
  }

  // ---- push subscriptions ----
  // Stored server-side so the reminder function can reach every device this
  // account has enabled, including ones that are currently closed.
  async function savePushSubscription(subscription) {
    if (!client || !currentUser) throw new Error('Sign in first so reminders can reach this device.');
    const key = k => btoa(String.fromCharCode(...new Uint8Array(subscription.getKey(k))));
    const { error } = await client.from('push_subscriptions').upsert(
      {
        endpoint: subscription.endpoint,
        user_id: currentUser.id,
        p256dh: key('p256dh'),
        auth: key('auth'),
        user_agent: navigator.userAgent.slice(0, 200),
        last_used_at: new Date().toISOString(),
        failure_count: 0,
      },
      { onConflict: 'endpoint,user_id' }
    );
    if (error) throw error;
  }

  async function deletePushSubscription(endpoint) {
    if (!client || !currentUser) return;
    await client
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', currentUser.id);
  }

  // ---- auth ----
  async function signInWithGoogle() {
    if (!client) return;
    await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    currentUser = null;
    if (realtimeChannel) {
      client.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    updateSyncUI();
  }

  async function handleSession(session) {
    currentUser = (session && session.user) || null;
    updateSyncUI();
    if (currentUser) {
      await pullAndMerge();
      subscribeRealtime();
    }
  }

  function getStatus() {
    return {
      configured: isConfigured(),
      signedIn: !!currentUser,
      email: currentUser ? currentUser.email : null,
    };
  }

  function updateSyncUI() {
    const signinBtn = document.getElementById('sync-signin-btn');
    const signoutBtn = document.getElementById('sync-signout-btn');
    const status = document.getElementById('sync-status');
    const hint = document.getElementById('sync-hint');
    if (!signinBtn || !signoutBtn || !status) return;

    if (!isConfigured()) {
      signinBtn.classList.add('hidden');
      signoutBtn.classList.add('hidden');
      status.textContent = '';
      return;
    }

    if (hint) {
      hint.textContent = currentUser
        ? 'Synced across your devices.'
        : 'Sign in to sync your tasks across devices.';
    }

    if (currentUser) {
      signinBtn.classList.add('hidden');
      signoutBtn.classList.remove('hidden');
      status.textContent = `Signed in as ${currentUser.email}`;
    } else {
      signinBtn.classList.remove('hidden');
      signoutBtn.classList.add('hidden');
      status.textContent = 'Not signed in';
    }
  }

  function setupSyncUI() {
    const signinBtn = document.getElementById('sync-signin-btn');
    const signoutBtn = document.getElementById('sync-signout-btn');
    if (signinBtn) signinBtn.addEventListener('click', signInWithGoogle);
    if (signoutBtn) signoutBtn.addEventListener('click', signOut);
    updateSyncUI();

    if (client) {
      client.auth.getSession().then(({ data }) => handleSession(data && data.session));
      client.auth.onAuthStateChange((_event, session) => handleSession(session));
    }

    window.addEventListener('online', () => {
      if (currentUser) flushDeleteOutbox();
    });
  }

  document.addEventListener('DOMContentLoaded', setupSyncUI);

  window.Sync = {
    isConfigured,
    signInWithGoogle,
    signOut,
    getStatus,
    savePushSubscription,
    deletePushSubscription,
    _test: { pullAndMerge, pushToRemote, pushDelete, subscribeRealtime, applyRealtimeChange, raw, readOutbox },
  };
})();

// IndexedDB wrapper. Deliberately tiny and promise-based: every store uses a
// single string key path, so one generic set of helpers covers all of them.
//
// Nothing above this file knows IndexedDB exists -- js/store.js is the only
// consumer, and js/sync.js wraps the write methods to mirror them to Supabase.
const DB_NAME = 'todoapp';
const DB_VERSION = 3;

// Store name -> key path. Also drives export/import and the sync layer.
const STORE_KEYS = {
  tasks: 'id',
  locations: 'id',
  labels: 'id',
  digests: 'date',
};

const STORES = Object.keys(STORE_KEYS);

// Dropped in v3. Projects were removed from the app; the store lingered in
// older installs, so the upgrade deletes it rather than leaving dead data.
const RETIRED_STORES = ['projects'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORE_KEYS)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
      for (const name of RETIRED_STORES) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Runs `work` against a store inside one transaction and resolves only once
// that transaction actually commits -- so callers that immediately re-read
// can't observe a half-applied write.
function withStore(storeName, mode, work) {
  return openDb().then(
    db =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        try {
          work(transaction.objectStore(storeName));
        } catch (err) {
          transaction.abort();
          reject(err);
          return;
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

const DB = {
  stores: STORES,
  keyPath: storeName => STORE_KEYS[storeName],

  // `work` returns an IDBRequest; the transaction is awaited so the resolved
  // value is only handed back once the read/write has actually committed.
  async _run(storeName, mode, work) {
    let request;
    await withStore(storeName, mode, store => {
      request = work(store);
    });
    return request ? request.result : undefined;
  },

  getAll(storeName) {
    return DB._run(storeName, 'readonly', store => store.getAll());
  },

  get(storeName, id) {
    return DB._run(storeName, 'readonly', store => store.get(id));
  },

  async put(storeName, value) {
    await withStore(storeName, 'readwrite', store => store.put(value));
    return value;
  },

  // One transaction for the whole batch. Reordering a long list used to open
  // a separate transaction per task, which is both slower and non-atomic.
  async putMany(storeName, values) {
    if (!values.length) return values;
    await withStore(storeName, 'readwrite', store => values.forEach(v => store.put(v)));
    return values;
  },

  async remove(storeName, id) {
    await withStore(storeName, 'readwrite', store => store.delete(id));
    return id;
  },

  async exportAll() {
    const out = {};
    for (const s of STORES) out[s] = await DB.getAll(s);
    return out;
  },

  async importAll(data) {
    if (!data || typeof data !== 'object') throw new Error('Backup file is not valid JSON data.');
    const known = STORES.filter(s => Array.isArray(data[s]));
    if (!known.length) throw new Error("Backup file doesn't contain any recognizable data.");
    for (const s of known) {
      const keyPath = STORE_KEYS[s];
      const rows = data[s].filter(item => item && typeof item === 'object' && item[keyPath] != null);
      for (const row of rows) await DB.put(s, row);
    }
    return known;
  },
};

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

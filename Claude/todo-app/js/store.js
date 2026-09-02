// The single owner of application state. Every mutation in the app goes
// through here; the UI never writes to DB directly and never mutates
// `Store.state` itself.
//
// Why this exists: the previous build kept state in a module global and had
// every handler call a monolithic render() afterwards, which redrew five
// unrelated sections (and rebuilt the drag-and-drop instance) on every
// keystroke-sized change. Here a mutation reports *which* collections it
// touched, and each UI module redraws only when its own data changed.

const Store = (() => {
  const state = {
    tasks: [],
    locations: [],
    labels: [],
    activeTag: 'all',
  };

  const listeners = new Set();

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit(...changed) {
    const set = new Set(changed);
    for (const fn of listeners) fn(set);
  }

  /* ---------- loading ---------- */

  async function refresh() {
    const [tasks, locations, labels] = await Promise.all([
      DB.getAll('tasks'),
      DB.getAll('locations'),
      DB.getAll('labels'),
    ]);
    state.tasks = tasks;
    state.locations = locations;
    state.labels = labels;
    emit('tasks', 'locations', 'labels');
  }

  /* ---------- derived reads ---------- */

  const byId = (list, id) => list.find(x => x.id === id);

  function task(id) {
    return byId(state.tasks, id);
  }

  function locationLabel(id) {
    const loc = byId(state.locations, id);
    return loc ? loc.label : null;
  }

  function sortedLocations() {
    return [...state.locations].sort((a, b) => a.label.localeCompare(b.label));
  }

  function sortedLabels() {
    return [...state.labels].sort((a, b) => a.name.localeCompare(b.name));
  }

  function labelByName(name) {
    const lower = String(name).toLowerCase();
    return state.labels.find(l => l.name.toLowerCase() === lower);
  }

  function tagColor(name) {
    const label = labelByName(name);
    return label ? label.color : null;
  }

  function allTagNames() {
    const tags = new Set();
    state.tasks.forEach(t => (t.priority_tags || []).forEach(tag => tags.add(tag)));
    state.labels.forEach(l => tags.add(l.name));
    return Array.from(tags).sort();
  }

  function setActiveTag(tag) {
    if (state.activeTag === tag) return;
    state.activeTag = tag;
    emit('filter');
  }

  /* ---------- task visibility & ordering ---------- */

  function isVisible(t) {
    if (t.status === 'archived') return false;
    // Completed tasks stay on the list for the rest of the day, then roll off.
    if (t.status === 'completed') {
      return !!t.completed_at && dateKey(new Date(t.completed_at)) === todayKey();
    }
    return true;
  }

  function isPinnedToday(t) {
    return !!t.due_date && t.due_date <= todayKey();
  }

  function matchesFilter(t) {
    if (state.activeTag === 'all') return true;
    return (t.priority_tags || []).includes(state.activeTag);
  }

  function manualOrder(t) {
    return t.sort_order ?? new Date(t.created_at).getTime();
  }

  // Today's and overdue tasks pin to the top in the user's manual drag order;
  // everything else falls in behind them by due date, undated last.
  function compareOpenTasks(a, b) {
    const aPinned = isPinnedToday(a);
    const bPinned = isPinnedToday(b);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (!aPinned && a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return manualOrder(a) - manualOrder(b);
  }

  function visibleTasks(excludeId) {
    return state.tasks.filter(t => t.id !== excludeId && isVisible(t) && matchesFilter(t));
  }

  function openTasks(excludeId) {
    return visibleTasks(excludeId)
      .filter(t => t.status !== 'completed')
      .sort(compareOpenTasks);
  }

  function doneTasks(excludeId) {
    return visibleTasks(excludeId)
      .filter(t => t.status === 'completed')
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  }

  /* ---------- task mutations ---------- */

  function newTask(fields) {
    const now = nowIso();
    return {
      id: uid(),
      title: '',
      description: '',
      priority_tags: [],
      due_date: null,
      due_time: null,
      location_trigger_id: null,
      status: 'open',
      completed_at: null,
      recurrence_rule: null,
      notified_at: null,
      sort_order: Date.now(),
      created_at: now,
      updated_at: now,
      ...fields,
    };
  }

  async function addTasks(taskFields) {
    const tasks = taskFields.map((fields, i) => newTask({ ...fields, sort_order: Date.now() + i }));
    await DB.putMany('tasks', tasks);
    state.tasks.push(...tasks);
    emit('tasks');
    return tasks;
  }

  // Applies `changes` to a task, stamps updated_at, persists, and notifies.
  async function updateTask(id, changes) {
    const t = task(id);
    if (!t) return null;
    Object.assign(t, changes, { updated_at: nowIso() });
    await DB.put('tasks', t);
    emit('tasks');
    return t;
  }

  async function removeTask(id) {
    await DB.remove('tasks', id);
    state.tasks = state.tasks.filter(t => t.id !== id);
    emit('tasks');
  }

  function nextDueDate(dueDateStr, rule) {
    if (!rule || !rule.freq || !dueDateStr) return null;
    if (rule.freq === 'daily') return addDays(dueDateStr, 1);
    if (rule.freq === 'weekly') return addDays(dueDateStr, 7 * (rule.interval || 1));
    if (rule.freq === 'custom') {
      return addDays(dueDateStr, (rule.unit === 'week' ? 7 : 1) * (rule.interval || 1));
    }
    return null;
  }

  async function toggleComplete(id) {
    const t = task(id);
    if (!t) return;

    if (t.status === 'completed') {
      await updateTask(id, { status: 'open', completed_at: null });
      return;
    }

    await updateTask(id, { status: 'completed', completed_at: nowIso() });
    await bumpDigest('completed');

    // A recurring task spawns its next occurrence at completion time rather
    // than being rescheduled in place, so the completed one stays in history.
    const nextDue = nextDueDate(t.due_date, t.recurrence_rule);
    if (nextDue) {
      // Carry the task's content forward, but let newTask() mint a fresh id
      // and timestamps for the new occurrence.
      const { id: _id, created_at: _c, updated_at: _u, ...carried } = t;
      await addTasks([
        { ...carried, status: 'open', completed_at: null, due_date: nextDue, notified_at: null },
      ]);
    }
  }

  async function pushToTomorrow(id) {
    const t = task(id);
    if (!t) return;
    await updateTask(id, { due_date: addDays(t.due_date || todayKey(), 1), notified_at: null });
    await bumpDigest('pushed');
  }

  async function reorderTasks(ids) {
    const reordered = [];
    ids.forEach((id, i) => {
      const t = task(id);
      if (!t) return;
      t.sort_order = i * 10;
      t.updated_at = nowIso();
      reordered.push(t);
    });
    await DB.putMany('tasks', reordered);
    emit('tasks');
  }

  /* ---------- labels ---------- */

  const MUTED_COLORS = ['#6c8ead', '#8a9a7b', '#b98d6f', '#a97c92', '#7c9c96', '#c2a26a', '#8f8fa3', '#a1755c'];

  function nextLabelColor() {
    return MUTED_COLORS[state.labels.length % MUTED_COLORS.length];
  }

  // Creates any label names that don't exist yet, without notifying per
  // label -- callers emit once when they're done.
  async function ensureLabels(names) {
    const created = [];
    for (const raw of names) {
      const name = raw.trim();
      if (!name || labelByName(name)) continue;
      const label = { id: uid(), name, color: nextLabelColor(), updated_at: nowIso() };
      await DB.put('labels', label);
      state.labels.push(label);
      created.push(label);
    }
    return created;
  }

  async function addLabel(name, color) {
    const trimmed = name.trim();
    if (!trimmed || labelByName(trimmed)) return null;
    const label = { id: uid(), name: trimmed, color: color || nextLabelColor(), updated_at: nowIso() };
    await DB.put('labels', label);
    state.labels.push(label);
    emit('labels');
    return label;
  }

  // Renaming cascades into every task that carries the old tag name, since
  // tasks store tag names rather than label ids.
  async function updateLabel(id, { name, color }) {
    const label = byId(state.labels, id);
    if (!label) return;
    const oldName = label.name;
    Object.assign(label, { name, color, updated_at: nowIso() });
    await DB.put('labels', label);

    if (oldName.toLowerCase() !== name.toLowerCase()) {
      const touched = state.tasks.filter(t =>
        (t.priority_tags || []).some(tag => tag.toLowerCase() === oldName.toLowerCase())
      );
      touched.forEach(t => {
        t.priority_tags = t.priority_tags.map(tag =>
          tag.toLowerCase() === oldName.toLowerCase() ? name : tag
        );
        t.updated_at = nowIso();
      });
      await DB.putMany('tasks', touched);
      if (state.activeTag === oldName) state.activeTag = name;
    }
    emit('labels', 'tasks');
  }

  async function removeLabel(id) {
    const label = byId(state.labels, id);
    if (!label) return;
    await DB.remove('labels', id);
    state.labels = state.labels.filter(l => l.id !== id);

    const lower = label.name.toLowerCase();
    const touched = state.tasks.filter(t => (t.priority_tags || []).some(tag => tag.toLowerCase() === lower));
    touched.forEach(t => {
      t.priority_tags = t.priority_tags.filter(tag => tag.toLowerCase() !== lower);
      t.updated_at = nowIso();
    });
    await DB.putMany('tasks', touched);

    if (state.activeTag === label.name) state.activeTag = 'all';
    emit('labels', 'tasks');
  }

  /* ---------- locations ---------- */

  // A location is identified by its street address; lat/lng are kept only
  // because the geofence needs them, and are never shown in the UI.
  async function addLocation({ label, address, lat, lng }) {
    const trimmed = (label || '').trim();
    if (!trimmed) return null;
    const loc = {
      id: uid(),
      label: trimmed,
      address: address || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      updated_at: nowIso(),
    };
    await DB.put('locations', loc);
    state.locations.push(loc);
    emit('locations');
    return loc;
  }

  async function updateLocation(id, changes) {
    const loc = byId(state.locations, id);
    if (!loc) return null;
    Object.assign(loc, changes, { updated_at: nowIso() });
    await DB.put('locations', loc);
    emit('locations');
    return loc;
  }

  async function removeLocation(id) {
    await DB.remove('locations', id);
    state.locations = state.locations.filter(l => l.id !== id);

    const touched = state.tasks.filter(t => t.location_trigger_id === id);
    touched.forEach(t => {
      t.location_trigger_id = null;
      t.updated_at = nowIso();
    });
    await DB.putMany('tasks', touched);
    emit('locations', 'tasks');
  }

  // Turns a location the parser inferred ("when I get to the dentist") into a
  // real, address-less row so the user can fill in an address later and have
  // the reminder start working without re-editing the task.
  async function resolveInferredLocation(inferred) {
    if (!inferred) return null;
    if (inferred.id) return inferred.id;
    const existing = state.locations.find(l => l.label.toLowerCase() === inferred.label.toLowerCase());
    if (existing) return existing.id;
    const created = await addLocation({ label: inferred.label });
    return created ? created.id : null;
  }

  /* ---------- digests ---------- */

  async function bumpDigest(field) {
    const key = todayKey();
    const existing = (await DB.get('digests', key)) || { date: key, completed: 0, pushed: 0 };
    existing[field] = (existing[field] || 0) + 1;
    existing.updated_at = nowIso();
    await DB.put('digests', existing);
  }

  /* ---------- housekeeping ---------- */

  // Yesterday's completed tasks are archived; archived tasks older than 30
  // days are deleted outright. Runs at most once per calendar day.
  async function rolloverAndPurge() {
    const today = todayKey();
    if (localStorage.getItem('lastRolloverDate') === today) return false;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const toArchive = [];
    const toDelete = [];
    for (const t of await DB.getAll('tasks')) {
      if (t.status === 'completed' && t.completed_at && dateKey(new Date(t.completed_at)) < today) {
        toArchive.push({ ...t, status: 'archived', updated_at: nowIso() });
      } else if (t.status === 'archived' && t.completed_at && new Date(t.completed_at) < cutoff) {
        toDelete.push(t.id);
      }
    }

    await DB.putMany('tasks', toArchive);
    for (const id of toDelete) await DB.remove('tasks', id);
    localStorage.setItem('lastRolloverDate', today);
    return toArchive.length > 0 || toDelete.length > 0;
  }

  return {
    state,
    subscribe,
    emit,
    refresh,
    MUTED_COLORS,
    // reads
    task,
    locationLabel,
    sortedLocations,
    sortedLabels,
    labelByName,
    tagColor,
    allTagNames,
    setActiveTag,
    isVisible,
    isPinnedToday,
    openTasks,
    doneTasks,
    visibleTasks,
    nextDueDate,
    // writes
    addTasks,
    updateTask,
    removeTask,
    toggleComplete,
    pushToTomorrow,
    reorderTasks,
    ensureLabels,
    addLabel,
    updateLabel,
    removeLabel,
    addLocation,
    updateLocation,
    removeLocation,
    resolveInferredLocation,
    bumpDigest,
    rolloverAndPurge,
  };
})();

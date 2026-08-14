const state = {
  tasks: [],
  projects: [],
  locations: [],
  activeProjectId: 'all',
  activeTag: 'all',
};

let geofencer = null;
let recognizer = null;

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

async function bumpDigest(field) {
  const key = todayKey();
  const existing = (await DB.get('digests', key)) || { date: key, completed: 0, pushed: 0 };
  existing[field] += 1;
  await DB.put('digests', existing);
}

async function ensureDefaultProject() {
  const projects = await DB.getAll('projects');
  if (!projects.some(p => p.id === 'personal')) {
    await DB.put('projects', { id: 'personal', name: 'Personal', color: '#5b8def' });
  }
}

async function loadAll() {
  state.tasks = await DB.getAll('tasks');
  state.projects = await DB.getAll('projects');
  state.locations = await DB.getAll('locations');
}

async function rolloverAndPurge() {
  const today = todayKey();
  const lastRun = localStorage.getItem('lastRolloverDate');
  if (lastRun === today) return;

  const tasks = await DB.getAll('tasks');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (const t of tasks) {
    if (t.status === 'completed' && t.completed_at && dateKey(new Date(t.completed_at)) < today) {
      t.status = 'archived';
      t.updated_at = new Date().toISOString();
      await DB.put('tasks', t);
    } else if (t.status === 'archived' && t.completed_at && new Date(t.completed_at) < cutoff) {
      await DB.remove('tasks', t.id);
    }
  }
  localStorage.setItem('lastRolloverDate', today);
}

function computeNextDue(dueDateStr, rule) {
  if (!rule || !rule.freq) return null;
  if (rule.freq === 'daily') return addDays(dueDateStr, 1);
  if (rule.freq === 'weekly') return addDays(dueDateStr, 7 * (rule.interval || 1));
  if (rule.freq === 'custom') {
    const unitDays = rule.unit === 'week' ? 7 : 1;
    return addDays(dueDateStr, unitDays * (rule.interval || 1));
  }
  return null;
}

function isTaskInToday(t) {
  if (t.status === 'archived') return false;
  if (t.status === 'completed') return t.completed_at && dateKey(new Date(t.completed_at)) === todayKey();
  if (!t.due_date) return true;
  return t.due_date <= todayKey();
}

function taskMatchesFilters(t) {
  if (state.activeProjectId !== 'all' && (t.project_id || 'personal') !== state.activeProjectId) return false;
  if (state.activeTag !== 'all' && !(t.priority_tags || []).includes(state.activeTag)) return false;
  return true;
}

function allPriorityTags() {
  const tags = new Set();
  state.tasks.forEach(t => (t.priority_tags || []).forEach(tag => tags.add(tag)));
  return Array.from(tags).sort();
}

function projectName(id) {
  const p = state.projects.find(p => p.id === (id || 'personal'));
  return p ? p.name : 'Personal';
}

function locationLabel(id) {
  const l = state.locations.find(l => l.id === id);
  return l ? l.label : null;
}

function fmtDue(t) {
  if (!t.due_date) return '';
  const isToday = t.due_date === todayKey();
  const isOverdue = t.due_date < todayKey() && t.status === 'open';
  let label = isToday ? 'Today' : isOverdue ? `Overdue (${t.due_date})` : t.due_date;
  if (t.due_time) label += ` ${t.due_time}`;
  return label;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderProjectFilter() {
  const sel = document.getElementById('project-filter');
  sel.innerHTML = '';
  sel.appendChild(new Option('All projects', 'all'));
  state.projects.forEach(p => sel.appendChild(new Option(p.name, p.id)));
  sel.value = state.activeProjectId;
}

function renderTagFilter() {
  const wrap = document.getElementById('tag-filter');
  wrap.innerHTML = '';
  const tags = ['all', ...allPriorityTags()];
  tags.forEach(tag => {
    const chip = el('button', 'chip' + (tag === state.activeTag ? ' chip-active' : ''), tag === 'all' ? 'All tags' : tag);
    chip.addEventListener('click', () => {
      state.activeTag = tag;
      render();
    });
    wrap.appendChild(chip);
  });
}

function renderProjectSelectForForm() {
  const sel = document.getElementById('task-project');
  sel.innerHTML = '';
  state.projects.forEach(p => sel.appendChild(new Option(p.name, p.id)));
}

function renderLocationSelectForForm() {
  const sel = document.getElementById('task-location');
  sel.innerHTML = '';
  sel.appendChild(new Option('No location trigger', ''));
  state.locations.forEach(l => sel.appendChild(new Option(l.label, l.id)));
}

function taskRow(t) {
  const row = el('div', 'task-row' + (t.status === 'completed' ? ' task-done' : ''));

  const check = el('input');
  check.type = 'checkbox';
  check.checked = t.status === 'completed';
  check.addEventListener('change', () => toggleComplete(t.id));
  row.appendChild(check);

  const main = el('div', 'task-main');
  const title = el('div', 'task-title', t.title);
  main.appendChild(title);

  const meta = el('div', 'task-meta');
  const bits = [projectName(t.project_id)];
  if (fmtDue(t)) bits.push(fmtDue(t));
  const loc = locationLabel(t.location_trigger_id);
  if (loc) bits.push(`📍 ${loc}`);
  else if (t.pending_location_label) bits.push(`📍 ${t.pending_location_label} (not set up)`);
  if (t.recurrence_rule) bits.push('🔁');
  meta.textContent = bits.join(' · ');
  main.appendChild(meta);

  if ((t.priority_tags || []).length) {
    const tagsWrap = el('div', 'task-tags');
    t.priority_tags.forEach(tag => tagsWrap.appendChild(el('span', 'tag-badge', tag)));
    main.appendChild(tagsWrap);
  }
  row.appendChild(main);

  const actions = el('div', 'task-actions');
  if (t.status !== 'completed') {
    const pushBtn = el('button', 'icon-btn', '→');
    pushBtn.title = 'Push to tomorrow';
    pushBtn.addEventListener('click', () => pushToTomorrow(t.id));
    actions.appendChild(pushBtn);
  }
  const delBtn = el('button', 'icon-btn', '✕');
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', () => deleteTask(t.id));
  actions.appendChild(delBtn);
  row.appendChild(actions);

  return row;
}

function renderTaskList() {
  const list = document.getElementById('task-list');
  list.innerHTML = '';
  const visible = state.tasks
    .filter(isTaskInToday)
    .filter(taskMatchesFilters)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'completed' ? 1 : -1;
      return (a.due_time || '99:99').localeCompare(b.due_time || '99:99');
    });

  if (!visible.length) {
    list.appendChild(el('div', 'empty-state', 'Nothing here. Add a task above.'));
    return;
  }
  visible.forEach(t => list.appendChild(taskRow(t)));
}

function renderProjectsPanel() {
  const list = document.getElementById('projects-list');
  list.innerHTML = '';
  state.projects.forEach(p => {
    const row = el('div', 'list-row');
    const swatch = el('span', 'swatch');
    swatch.style.background = p.color || '#888';
    row.appendChild(swatch);
    row.appendChild(el('span', null, p.name));
    if (p.id !== 'personal') {
      const del = el('button', 'icon-btn', '✕');
      del.addEventListener('click', () => deleteProject(p.id));
      row.appendChild(del);
    }
    list.appendChild(row);
  });
}

function renderLocationsPanel() {
  const list = document.getElementById('locations-list');
  list.innerHTML = '';
  state.locations.forEach(l => {
    const row = el('div', 'list-row');
    row.appendChild(el('span', null, `${l.label} (${l.lat.toFixed(4)}, ${l.lng.toFixed(4)})`));
    const del = el('button', 'icon-btn', '✕');
    del.addEventListener('click', () => deleteLocation(l.id));
    row.appendChild(del);
    list.appendChild(row);
  });
}

async function renderDigest() {
  const today = (await DB.get('digests', todayKey())) || { completed: 0, pushed: 0 };
  document.getElementById('digest-today').textContent =
    `Today: ${today.completed} completed, ${today.pushed} pushed`;

  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(todayKey(), -i));
  const entries = await Promise.all(days.map(d => DB.get('digests', d)));
  const weekTotals = entries.reduce(
    (acc, e) => ({ completed: acc.completed + (e ? e.completed : 0), pushed: acc.pushed + (e ? e.pushed : 0) }),
    { completed: 0, pushed: 0 }
  );
  document.getElementById('digest-week').textContent =
    `Last 7 days: ${weekTotals.completed} completed, ${weekTotals.pushed} pushed`;
}

function render() {
  renderProjectFilter();
  renderTagFilter();
  renderProjectSelectForForm();
  renderLocationSelectForForm();
  renderTaskList();
  renderProjectsPanel();
  renderLocationsPanel();
  renderDigest();
}

async function addTaskFromText(rawText) {
  const text = rawText.trim();
  if (!text) return;

  const entries = parseEntry(text, state.locations);
  const projectId = document.getElementById('task-project').value || 'personal';
  const tagsRaw = document.getElementById('task-tags').value.trim();
  const priorityTags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const manualLocationId = document.getElementById('task-location').value || null;

  for (const entry of entries) {
    const now = new Date().toISOString();
    let locationTriggerId = manualLocationId;
    let pendingLocationLabel = null;
    if (!locationTriggerId && entry.locationLabel) {
      if (entry.locationLabel.id) locationTriggerId = entry.locationLabel.id;
      else pendingLocationLabel = entry.locationLabel.label;
    }

    const task = {
      id: uid(),
      title: entry.title,
      description: '',
      project_id: projectId,
      priority_tags: priorityTags,
      due_date: entry.due ? dateKey(entry.due) : null,
      due_time: entry.due ? entry.due.toTimeString().slice(0, 5) : null,
      location_trigger_id: locationTriggerId,
      pending_location_label: pendingLocationLabel,
      status: 'open',
      completed_at: null,
      recurrence_rule: null,
      notified_at: null,
      created_at: now,
      updated_at: now,
    };
    await DB.put('tasks', task);
  }

  document.getElementById('task-input').value = '';
  document.getElementById('task-tags').value = '';
  await loadAll();
  render();
}

async function toggleComplete(id) {
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  if (t.status === 'completed') {
    t.status = 'open';
    t.completed_at = null;
  } else {
    t.status = 'completed';
    t.completed_at = new Date().toISOString();
    await bumpDigest('completed');

    if (t.recurrence_rule && t.due_date) {
      const nextDue = computeNextDue(t.due_date, t.recurrence_rule);
      if (nextDue) {
        await DB.put('tasks', {
          ...t,
          id: uid(),
          status: 'open',
          completed_at: null,
          due_date: nextDue,
          notified_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }
  }
  t.updated_at = new Date().toISOString();
  await DB.put('tasks', t);
  await loadAll();
  render();
}

async function pushToTomorrow(id) {
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  t.due_date = addDays(t.due_date || todayKey(), 1);
  t.updated_at = new Date().toISOString();
  await DB.put('tasks', t);
  await bumpDigest('pushed');
  await loadAll();
  render();
}

async function deleteTask(id) {
  await DB.remove('tasks', id);
  await loadAll();
  render();
}

async function addProject() {
  const input = document.getElementById('project-name-input');
  const name = input.value.trim();
  if (!name) return;
  const colorInput = document.getElementById('project-color-input');
  await DB.put('projects', { id: uid(), name, color: colorInput.value || '#5b8def' });
  input.value = '';
  await loadAll();
  render();
}

async function deleteProject(id) {
  await DB.remove('projects', id);
  const affected = state.tasks.filter(t => t.project_id === id);
  for (const t of affected) {
    t.project_id = 'personal';
    await DB.put('tasks', t);
  }
  await loadAll();
  render();
}

async function addLocation({ label, lat, lng }) {
  if (!label || Number.isNaN(lat) || Number.isNaN(lng)) return;
  await DB.put('locations', { id: uid(), label, lat, lng });
  await loadAll();
  render();
}

async function deleteLocation(id) {
  await DB.remove('locations', id);
  for (const t of state.tasks) {
    if (t.location_trigger_id === id) {
      t.location_trigger_id = null;
      await DB.put('tasks', t);
    }
  }
  await loadAll();
  render();
}

function canNotify() {
  return 'Notification' in window && Notification.permission === 'granted';
}

async function showAppNotification(title, body, taskId) {
  if (!canNotify()) return;
  const data = { url: `${location.pathname}?task=${taskId}` };
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, tag: taskId, data });
  } else {
    new Notification(title, { body });
  }
}

async function checkTimeReminders() {
  const now = new Date();
  const today = todayKey();
  const hhmm = now.toTimeString().slice(0, 5);
  for (const t of state.tasks) {
    if (t.status !== 'open' || !t.due_date || !t.due_time || t.notified_at) continue;
    if (t.due_date === today && t.due_time <= hhmm) {
      await showAppNotification('Task due', t.title, t.id);
      t.notified_at = now.toISOString();
      await DB.put('tasks', t);
    }
  }
}

function setupGeofencer() {
  geofencer = new Geofencer({
    getLocations: () => state.locations,
    onArrive: async loc => {
      const matches = state.tasks.filter(t => t.status === 'open' && t.location_trigger_id === loc.id);
      for (const t of matches) {
        await showAppNotification(`Arrived at ${loc.label}`, t.title, t.id);
      }
    },
  });
  geofencer.start();
}

function setupVoiceCapture() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('mic-btn');
  if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.title = 'Voice input not supported in this browser';
    return;
  }
  recognizer = new SpeechRecognition();
  recognizer.lang = 'en-US';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  let listening = false;
  micBtn.addEventListener('click', () => {
    if (listening) {
      recognizer.stop();
      return;
    }
    recognizer.start();
    listening = true;
    micBtn.classList.add('mic-active');
  });
  recognizer.addEventListener('result', e => {
    const transcript = e.results[0][0].transcript;
    document.getElementById('task-input').value = transcript;
    addTaskFromText(transcript);
  });
  recognizer.addEventListener('end', () => {
    listening = false;
    micBtn.classList.remove('mic-active');
  });
  recognizer.addEventListener('error', () => {
    listening = false;
    micBtn.classList.remove('mic-active');
  });
}

function setupExportImport() {
  document.getElementById('export-btn').addEventListener('click', async () => {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `todo-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('import-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    await DB.importAll(data);
    await loadAll();
    render();
    e.target.value = '';
  });
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('panel-active'));
      btn.classList.add('tab-active');
      document.getElementById(btn.dataset.panel).classList.add('panel-active');
    });
  });
}

function setupForms() {
  document.getElementById('add-task-form').addEventListener('submit', e => {
    e.preventDefault();
    addTaskFromText(document.getElementById('task-input').value);
  });

  document.getElementById('project-filter').addEventListener('change', e => {
    state.activeProjectId = e.target.value;
    render();
  });

  document.getElementById('add-project-form').addEventListener('submit', e => {
    e.preventDefault();
    addProject();
  });

  document.getElementById('add-location-form').addEventListener('submit', e => {
    e.preventDefault();
    const label = document.getElementById('location-name-input').value.trim();
    const lat = parseFloat(document.getElementById('location-lat-input').value);
    const lng = parseFloat(document.getElementById('location-lng-input').value);
    addLocation({ label, lat, lng });
    document.getElementById('location-name-input').value = '';
    document.getElementById('location-lat-input').value = '';
    document.getElementById('location-lng-input').value = '';
  });

  document.getElementById('use-current-location-btn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(pos => {
      document.getElementById('location-lat-input').value = pos.coords.latitude.toFixed(6);
      document.getElementById('location-lng-input').value = pos.coords.longitude.toFixed(6);
    });
  });

  document.getElementById('notif-btn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    document.getElementById('notif-status').textContent =
      perm === 'granted' ? 'Notifications enabled' : 'Notifications not enabled';
  });
}

async function init() {
  await ensureDefaultProject();
  await rolloverAndPurge();
  await loadAll();
  render();
  setupTabs();
  setupForms();
  setupVoiceCapture();
  setupExportImport();
  setupGeofencer();

  if ('Notification' in window) {
    document.getElementById('notif-status').textContent =
      Notification.permission === 'granted' ? 'Notifications enabled' : 'Notifications not enabled';
  }

  setInterval(checkTimeReminders, 30000);
  setInterval(rolloverAndPurge, 5 * 60000);
  setInterval(async () => {
    await loadAll();
    render();
  }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

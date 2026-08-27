const MUTED_COLORS = ['#6c8ead', '#8a9a7b', '#b98d6f', '#a97c92', '#7c9c96', '#c2a26a', '#8f8fa3', '#a1755c'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thurs', 'Fri', 'Sat'];
const EMPTY_STATE_MESSAGES = [
  'Nothing here. Tap + above, or head to Record and just say it.',
  'A blank slate — what needs doing?',
  'All clear for now.',
  'Nothing on the list yet. Add one whenever you\'re ready.',
  'Empty — hold the mic on Record, or tap + to type one.',
];

const state = {
  tasks: [],
  locations: [],
  labels: [],
  activeTag: 'all',
};

let geofencer = null;
let recognizer = null;
let sortableInstance = null;
let locationMapInitialized = false;
let toastTimer = null;
let pendingDelete = null;
let editingTaskId = null;
let titleClickTimer = null;

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

function getDefaultTaskTime() {
  const v = localStorage.getItem('defaultTaskTime') || '09:00';
  const [hour, minute] = v.split(':').map(Number);
  return { hour: hour || 9, minute: minute || 0 };
}

async function bumpDigest(field) {
  const key = todayKey();
  const existing = (await DB.get('digests', key)) || { date: key, completed: 0, pushed: 0 };
  existing[field] += 1;
  await DB.put('digests', existing);
}

async function loadAll() {
  state.tasks = await DB.getAll('tasks');
  state.locations = await DB.getAll('locations');
  state.labels = await DB.getAll('labels');
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

function isTaskVisible(t) {
  if (t.status === 'archived') return false;
  if (t.status === 'completed') {
    return t.completed_at && dateKey(new Date(t.completed_at)) === todayKey();
  }
  return true;
}

function isPinnedToday(t) {
  return !!t.due_date && t.due_date <= todayKey();
}

function taskMatchesFilters(t) {
  if (state.activeTag !== 'all' && !(t.priority_tags || []).includes(state.activeTag)) return false;
  return true;
}

function taskSortValue(t) {
  return t.sort_order ?? new Date(t.created_at).getTime();
}

function allPriorityTags() {
  const tags = new Set();
  state.tasks.forEach(t => (t.priority_tags || []).forEach(tag => tags.add(tag)));
  state.labels.forEach(l => tags.add(l.name));
  return Array.from(tags).sort();
}

function sortedLocations() {
  return [...state.locations].sort((a, b) => a.label.localeCompare(b.label));
}

function sortedLabels() {
  return [...state.labels].sort((a, b) => a.name.localeCompare(b.name));
}

function labelByName(name) {
  return state.labels.find(l => l.name.toLowerCase() === name.toLowerCase());
}

function tagColor(tagName) {
  const l = labelByName(tagName);
  return l ? l.color : null;
}

function locationLabel(id) {
  const l = state.locations.find(l => l.id === id);
  return l ? l.label : null;
}

function friendlyDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr === todayKey()) return 'Today';
  if (dateStr === addDays(todayKey(), 1)) return 'Tomorrow';
  const d = new Date(`${dateStr}T00:00:00`);
  return `${WEEKDAY_ABBR[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function friendlyTime(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function friendlyDueLabel(t) {
  const dateLabel = friendlyDate(t.due_date);
  const timeLabel = friendlyTime(t.due_time);
  if (!dateLabel) return 'No due date';
  return timeLabel ? `${dateLabel} at ${timeLabel}` : dateLabel;
}

function emptyStateMessage() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return EMPTY_STATE_MESSAGES[dayIndex % EMPTY_STATE_MESSAGES.length];
}

function fmtDue(t) {
  if (!t.due_date) return '';
  const isOverdue = t.due_date < todayKey() && t.status === 'open';
  const dateLabel = friendlyDate(t.due_date);
  const timeLabel = friendlyTime(t.due_time);
  let label = isOverdue ? `Overdue (${dateLabel})` : dateLabel;
  if (timeLabel) label += ` ${timeLabel}`;
  return label;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showToast(message, opts = {}) {
  const { duration = 3500, actionLabel, onAction } = opts;
  const toast = document.getElementById('toast');
  toast.innerHTML = '';
  toast.appendChild(el('span', null, message));
  if (actionLabel && onAction) {
    const actionBtn = el('button', 'toast-action', actionLabel);
    actionBtn.type = 'button';
    actionBtn.addEventListener('click', () => {
      onAction();
      dismissToast();
    });
    toast.appendChild(actionBtn);
  }
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, duration);
}

function dismissToast() {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  toast.classList.remove('toast-visible');
  setTimeout(() => toast.classList.add('hidden'), 250);
}

function renderTagFilter() {
  const wrap = document.getElementById('tag-filter');
  wrap.innerHTML = '';
  const tags = ['all', ...allPriorityTags()];
  tags.forEach(tag => {
    const chip = el('button', 'chip' + (tag === state.activeTag ? ' chip-active' : ''), tag === 'all' ? 'All labels' : tag);
    chip.addEventListener('click', () => {
      state.activeTag = tag;
      render();
      syncAddBarDefaultsFromFilters();
      document.getElementById('filters-panel').classList.add('hidden');
    });
    wrap.appendChild(chip);
  });
}

function fillLocationSelect(selectEl, selectedId) {
  const prior = selectedId !== undefined ? selectedId : selectEl.value;
  selectEl.innerHTML = '';
  selectEl.appendChild(new Option('No location trigger', ''));
  sortedLocations().forEach(l => selectEl.appendChild(new Option(l.label, l.id)));
  selectEl.value = prior || '';
}

function renderLocationSelectForForm() {
  fillLocationSelect(document.getElementById('task-location'));
}

function syncAddBarDefaultsFromFilters() {
  const tagsInput = document.getElementById('task-tags');
  tagsInput.value = state.activeTag === 'all' ? '' : state.activeTag;
}

function renderColorSwatches(wrapId = 'label-color-swatches', hiddenInputId = 'label-color-input') {
  const wrap = document.getElementById(wrapId);
  const hiddenInput = document.getElementById(hiddenInputId);
  if (!hiddenInput.value) hiddenInput.value = MUTED_COLORS[0];
  wrap.innerHTML = '';
  MUTED_COLORS.forEach(color => {
    const btn = el('button', 'swatch-option' + (hiddenInput.value === color ? ' swatch-selected' : ''));
    btn.type = 'button';
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener('click', () => {
      hiddenInput.value = color;
      wrap.querySelectorAll('.swatch-option').forEach(s => s.classList.remove('swatch-selected'));
      btn.classList.add('swatch-selected');
    });
    wrap.appendChild(btn);
  });
}

function startInlineTitleEdit(id) {
  editingTaskId = id;
  renderTaskList();
}

function cancelInlineTitleEdit() {
  editingTaskId = null;
  renderTaskList();
}

async function saveInlineTitleEdit(id, value) {
  editingTaskId = null;
  const t = state.tasks.find(t => t.id === id);
  const trimmed = value.trim();
  if (t && trimmed && trimmed !== t.title) {
    t.title = trimmed;
    t.updated_at = new Date().toISOString();
    await DB.put('tasks', t);
    await loadAll();
  }
  render();
}

function taskRow(t, draggable) {
  const row = el('div', 'task-row' + (t.status === 'completed' ? ' task-done' : ''));
  row.dataset.id = t.id;

  row.appendChild(el('span', 'drag-handle' + (draggable ? '' : ' drag-handle-hidden'), draggable ? '⠿' : ''));

  const check = el('input');
  check.type = 'checkbox';
  check.className = 'task-checkbox';
  check.checked = t.status === 'completed';
  check.addEventListener('change', () => toggleComplete(t.id));
  row.appendChild(check);

  (t.priority_tags || []).forEach(tag => {
    const dot = el('span', 'tag-dot');
    dot.style.background = tagColor(tag) || 'var(--text-muted)';
    dot.title = tag;
    row.appendChild(dot);
  });

  const content = el('div', 'task-content');

  if (editingTaskId === t.id) {
    const input = el('input');
    input.type = 'text';
    input.className = 'task-title-input';
    input.value = t.title;
    content.appendChild(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelInlineTitleEdit();
      }
    });
    input.addEventListener('blur', () => {
      if (editingTaskId === t.id) saveInlineTitleEdit(t.id, input.value);
    });
  } else {
    const titleEl = el('span', 'task-title', t.title);
    titleEl.addEventListener('click', () => {
      clearTimeout(titleClickTimer);
      titleClickTimer = setTimeout(() => startInlineTitleEdit(t.id), 250);
    });
    titleEl.addEventListener('dblclick', () => {
      clearTimeout(titleClickTimer);
      openEditModal(t.id);
    });
    content.appendChild(titleEl);

    const isOverdue = !!t.due_date && t.due_date < todayKey() && t.status === 'open';
    const isToday = t.due_date === todayKey();
    const bits = [];
    if (fmtDue(t)) bits.push(fmtDue(t));
    const loc = locationLabel(t.location_trigger_id);
    if (loc) bits.push(`📍 ${loc}`);
    if (t.recurrence_rule) bits.push('🔁');
    if (bits.length) {
      content.appendChild(el('span', 'task-sep', '·'));
      const metaClass = 'task-meta-inline' + (isOverdue ? ' overdue' : isToday ? ' today' : '');
      content.appendChild(el('span', metaClass, bits.join(' · ')));
    }
  }

  row.appendChild(content);

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

function setupSortable() {
  if (typeof Sortable === 'undefined') return;
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }
  const container = document.getElementById('task-list-open');
  sortableInstance = new Sortable(container, {
    handle: '.drag-handle',
    animation: 150,
    onEnd: () => {
      const ids = Array.from(container.children).map(child => child.dataset.id).filter(Boolean);
      reorderOpenTasks(ids);
    },
  });
}

function renderTaskList() {
  const openList = document.getElementById('task-list-open');
  const doneList = document.getElementById('task-list-done');
  openList.innerHTML = '';
  doneList.innerHTML = '';

  const visible = state.tasks
    .filter(t => !pendingDelete || t.id !== pendingDelete.task.id)
    .filter(isTaskVisible)
    .filter(taskMatchesFilters);
  const open = visible.filter(t => t.status !== 'completed').sort((a, b) => {
    const aPinned = isPinnedToday(a);
    const bPinned = isPinnedToday(b);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (aPinned) return taskSortValue(a) - taskSortValue(b);
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return taskSortValue(a) - taskSortValue(b);
  });
  const done = visible
    .filter(t => t.status === 'completed')
    .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

  if (!open.length) {
    openList.appendChild(
      el('div', 'empty-state', visible.length ? 'All caught up for now.' : emptyStateMessage())
    );
  } else {
    open.forEach(t => openList.appendChild(taskRow(t, true)));
  }
  done.forEach(t => doneList.appendChild(taskRow(t, false)));

  setupSortable();
}

function renderLabelsPanel() {
  const list = document.getElementById('labels-list');
  list.innerHTML = '';
  sortedLabels().forEach(l => {
    const row = el('div', 'list-row');
    const swatch = el('span', 'swatch');
    swatch.style.background = l.color || MUTED_COLORS[0];
    row.appendChild(swatch);
    row.appendChild(el('span', null, l.name));
    const editBtn = el('button', 'icon-btn', '✎');
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => openLabelEditModal(l.id));
    row.appendChild(editBtn);
    const del = el('button', 'icon-btn', '✕');
    del.title = 'Delete';
    del.addEventListener('click', () => deleteLabel(l.id));
    row.appendChild(del);
    list.appendChild(row);
  });
}

function renderLocationsPanel() {
  const list = document.getElementById('locations-list');
  list.innerHTML = '';
  sortedLocations().forEach(l => {
    const row = el('div', 'list-row');
    const hasCoords = l.lat != null && l.lng != null;
    const label = hasCoords ? `${l.label} (${l.lat.toFixed(4)}, ${l.lng.toFixed(4)})` : `${l.label} — needs an address`;
    row.appendChild(el('span', null, label));
    const del = el('button', 'icon-btn', '✕');
    del.addEventListener('click', () => deleteLocation(l.id));
    row.appendChild(del);
    list.appendChild(row);
  });
}

function render() {
  renderTagFilter();
  renderLocationSelectForForm();
  renderTaskList();
  renderLabelsPanel();
  renderLocationsPanel();
}

async function resolveInferredLocation(locationLabelObj) {
  if (!locationLabelObj || locationLabelObj.id || !locationLabelObj.inferred) return null;
  const loc = { id: uid(), label: locationLabelObj.label, lat: null, lng: null };
  await DB.put('locations', loc);
  state.locations.push(loc);
  return loc.id;
}

async function addTaskFromText(rawText) {
  const text = rawText.trim();
  if (!text) return;

  const entries = parseEntry(text, state.locations, getDefaultTaskTime());
  const tagsRaw = document.getElementById('task-tags').value.trim();
  const priorityTags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  await ensureLabelsExist(priorityTags);
  const manualLocationId = document.getElementById('task-location').value || null;

  let inferredLocationId = null;
  if (entries.length && entries[0].locationLabel && entries[0].locationLabel.inferred) {
    inferredLocationId = await resolveInferredLocation(entries[0].locationLabel);
  }

  const created = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const now = new Date().toISOString();
    let locationTriggerId = manualLocationId;
    if (!locationTriggerId && entry.locationLabel) {
      locationTriggerId = entry.locationLabel.id || inferredLocationId || null;
    }

    const task = {
      id: uid(),
      title: entry.title,
      description: '',
      priority_tags: priorityTags,
      due_date: entry.due ? dateKey(entry.due) : null,
      due_time: entry.due ? entry.due.toTimeString().slice(0, 5) : null,
      location_trigger_id: locationTriggerId,
      status: 'open',
      completed_at: null,
      recurrence_rule: entry.recurrence || null,
      notified_at: null,
      sort_order: Date.now() + i,
      created_at: now,
      updated_at: now,
    };
    await DB.put('tasks', task);
    created.push(task);
  }

  document.getElementById('task-input').value = '';
  await loadAll();
  render();
  syncAddBarDefaultsFromFilters();

  if (created.length === 1) {
    showToast(`Added "${created[0].title}" — ${friendlyDueLabel(created[0])}`);
  } else if (created.length > 1) {
    showToast(`Added ${created.length} tasks — ${friendlyDueLabel(created[0])}`);
  }
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
          sort_order: Date.now(),
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

function deleteTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  if (pendingDelete) commitPendingDelete();

  const timeoutId = setTimeout(() => commitPendingDelete(), 5500);
  pendingDelete = { task, timeoutId };
  render();
  showToast(`Deleted "${task.title}"`, {
    duration: 5500,
    actionLabel: 'Undo',
    onAction: undoPendingDelete,
  });
}

async function commitPendingDelete() {
  if (!pendingDelete) return;
  const { task, timeoutId } = pendingDelete;
  clearTimeout(timeoutId);
  pendingDelete = null;
  await DB.remove('tasks', task.id);
  await loadAll();
  render();
}

function undoPendingDelete() {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timeoutId);
  pendingDelete = null;
  render();
}

async function reorderOpenTasks(ids) {
  for (let i = 0; i < ids.length; i++) {
    const t = state.tasks.find(x => x.id === ids[i]);
    if (t) {
      t.sort_order = i * 10;
      await DB.put('tasks', t);
    }
  }
  await loadAll();
  render();
}

function datePresetValue(preset) {
  if (preset === 'today') return todayKey();
  if (preset === 'tomorrow') return addDays(todayKey(), 1);
  if (preset === 'nextweek') return addDays(todayKey(), 7);
  return '';
}

function applyDatePreset(preset) {
  document.getElementById('edit-due-date').value = datePresetValue(preset);
  if (preset === 'none') document.getElementById('edit-due-time').value = '';
  syncDateChipActiveState();
}

function syncDateChipActiveState() {
  const dateVal = document.getElementById('edit-due-date').value;
  document.querySelectorAll('#edit-date-chips .chip').forEach(chip => {
    const preset = chip.dataset.preset;
    const matches = preset === 'none' ? !dateVal : datePresetValue(preset) === dateVal;
    chip.classList.toggle('chip-active', matches);
  });
}

function renderEditTagsDropdown(selectedTags) {
  const panel = document.getElementById('edit-tags-panel');
  panel.innerHTML = '';
  sortedLabels().forEach(l => {
    const row = el('label', 'dropdown-option');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = l.name;
    cb.checked = selectedTags.some(tag => tag.toLowerCase() === l.name.toLowerCase());
    cb.addEventListener('change', updateEditTagsTriggerLabel);
    row.appendChild(cb);
    const dot = el('span', 'tag-dot');
    dot.style.background = l.color || 'var(--text-muted)';
    row.appendChild(dot);
    row.appendChild(el('span', null, l.name));
    panel.appendChild(row);
  });
  updateEditTagsTriggerLabel();
}

function getEditSelectedTags() {
  return Array.from(document.querySelectorAll('#edit-tags-panel input:checked')).map(cb => cb.value);
}

function updateEditTagsTriggerLabel() {
  const selected = getEditSelectedTags();
  document.getElementById('edit-tags-trigger').textContent = selected.length ? selected.join(', ') : 'Select labels';
}

function setRecurrenceSegmented(freq) {
  document.querySelectorAll('#edit-recurrence-segmented button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.freq === (freq || ''));
  });
  document.getElementById('edit-recurrence-custom').classList.toggle('hidden', freq !== 'custom');
}

function openEditModal(id) {
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  document.getElementById('edit-task-form').dataset.taskId = id;
  document.getElementById('edit-title').value = t.title;
  document.getElementById('edit-due-date').value = t.due_date || '';
  document.getElementById('edit-due-time').value = t.due_time || '';
  syncDateChipActiveState();

  renderEditTagsDropdown(t.priority_tags || []);
  document.getElementById('edit-tags-panel').classList.add('hidden');

  fillLocationSelect(document.getElementById('edit-location'), t.location_trigger_id || '');

  const rule = t.recurrence_rule;
  setRecurrenceSegmented(rule ? rule.freq : '');
  document.getElementById('edit-recurrence-interval').value = (rule && rule.interval) || 1;
  document.getElementById('edit-recurrence-unit').value = (rule && rule.unit) || 'day';

  const hasExtras = (t.priority_tags || []).length > 0 || !!t.location_trigger_id || !!rule;
  document.getElementById('edit-more-fields').classList.toggle('hidden', !hasExtras);
  document.getElementById('edit-more-toggle').classList.toggle('expanded', hasExtras);

  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

async function saveEditModal() {
  const id = document.getElementById('edit-task-form').dataset.taskId;
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;

  t.title = document.getElementById('edit-title').value.trim() || t.title;
  t.priority_tags = getEditSelectedTags();
  t.due_date = document.getElementById('edit-due-date').value || null;
  t.due_time = document.getElementById('edit-due-time').value || null;
  t.location_trigger_id = document.getElementById('edit-location').value || null;

  const freq = document.querySelector('#edit-recurrence-segmented button.active')?.dataset.freq || '';
  if (!freq) {
    t.recurrence_rule = null;
  } else if (freq === 'custom') {
    t.recurrence_rule = {
      freq: 'custom',
      interval: parseInt(document.getElementById('edit-recurrence-interval').value, 10) || 1,
      unit: document.getElementById('edit-recurrence-unit').value,
    };
  } else {
    t.recurrence_rule = { freq };
  }

  t.notified_at = null;
  t.updated_at = new Date().toISOString();
  await DB.put('tasks', t);
  closeEditModal();
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

async function putLabelQuiet(name, color) {
  const existing = labelByName(name);
  if (existing) return existing;
  const label = { id: uid(), name: name.trim(), color };
  await DB.put('labels', label);
  state.labels.push(label);
  return label;
}

async function ensureLabelsExist(tagNames) {
  for (const name of tagNames) {
    if (!labelByName(name)) {
      await putLabelQuiet(name, MUTED_COLORS[state.labels.length % MUTED_COLORS.length]);
    }
  }
}

async function addLabel(name, color) {
  await putLabelQuiet(name.trim(), color);
  await loadAll();
  render();
}

async function updateLabel(id, { name, color }) {
  const label = state.labels.find(l => l.id === id);
  if (!label) return;
  const oldName = label.name;
  label.name = name;
  label.color = color;
  await DB.put('labels', label);
  if (oldName.toLowerCase() !== name.toLowerCase()) {
    const affected = state.tasks.filter(t =>
      (t.priority_tags || []).some(tag => tag.toLowerCase() === oldName.toLowerCase())
    );
    for (const t of affected) {
      t.priority_tags = t.priority_tags.map(tag =>
        tag.toLowerCase() === oldName.toLowerCase() ? name : tag
      );
      t.updated_at = new Date().toISOString();
      await DB.put('tasks', t);
    }
  }
  await loadAll();
  render();
}

async function deleteLabel(id) {
  const label = state.labels.find(l => l.id === id);
  if (!label) return;
  await DB.remove('labels', id);
  const affected = state.tasks.filter(t =>
    (t.priority_tags || []).some(tag => tag.toLowerCase() === label.name.toLowerCase())
  );
  for (const t of affected) {
    t.priority_tags = t.priority_tags.filter(tag => tag.toLowerCase() !== label.name.toLowerCase());
    t.updated_at = new Date().toISOString();
    await DB.put('tasks', t);
  }
  await loadAll();
  render();
}

function openLabelEditModal(id) {
  const l = state.labels.find(l => l.id === id);
  if (!l) return;
  document.getElementById('label-edit-form').dataset.labelId = id;
  document.getElementById('label-edit-name-input').value = l.name;
  document.getElementById('label-edit-color-input').value = l.color || MUTED_COLORS[0];
  renderColorSwatches('label-edit-color-swatches', 'label-edit-color-input');
  document.getElementById('label-edit-modal').classList.remove('hidden');
}

function closeLabelEditModal() {
  document.getElementById('label-edit-modal').classList.add('hidden');
}

function setupLabelForms() {
  document.getElementById('add-label-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('label-name-input');
    const name = input.value.trim();
    if (!name) return;
    const colorInput = document.getElementById('label-color-input');
    await addLabel(name, colorInput.value || MUTED_COLORS[0]);
    input.value = '';
    colorInput.value = MUTED_COLORS[0];
    renderColorSwatches('label-color-swatches', 'label-color-input');
  });

  document.getElementById('label-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('label-edit-form').dataset.labelId;
    const name = document.getElementById('label-edit-name-input').value.trim();
    if (!name) return;
    const color = document.getElementById('label-edit-color-input').value || MUTED_COLORS[0];
    await updateLabel(id, { name, color });
    closeLabelEditModal();
  });
  document.getElementById('label-edit-cancel-btn').addEventListener('click', closeLabelEditModal);
  document.getElementById('label-edit-modal').addEventListener('click', e => {
    if (e.target.id === 'label-edit-modal') closeLabelEditModal();
  });
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

function setupRecordButton() {
  const screen = document.getElementById('record-screen');
  const btn = document.getElementById('record-btn');
  const prompt = document.getElementById('record-prompt');
  const transcriptEl = document.getElementById('record-transcript');
  const typeLink = document.getElementById('record-type-link');
  const typeForm = document.getElementById('record-type-form');
  const typeInput = document.getElementById('record-type-input');

  typeLink.addEventListener('click', () => {
    typeForm.classList.remove('hidden');
    typeLink.classList.add('hidden');
    typeInput.focus();
  });

  typeForm.addEventListener('submit', e => {
    e.preventDefault();
    const value = typeInput.value.trim();
    if (!value) return;
    addTaskFromText(value);
    typeInput.value = '';
  });

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    screen.classList.add('no-voice');
    prompt.textContent = "Voice isn't supported in this browser — type your task below.";
    typeForm.classList.remove('hidden');
    typeLink.classList.add('hidden');
    return;
  }

  const recordRecognizer = new SpeechRecognition();
  recordRecognizer.lang = 'en-US';
  recordRecognizer.interimResults = true;
  recordRecognizer.maxAlternatives = 1;

  let isRecording = false;
  let finalTranscript = '';

  function startRecording() {
    if (isRecording) return;
    finalTranscript = '';
    transcriptEl.textContent = '';
    try {
      recordRecognizer.start();
    } catch (err) {
      return;
    }
    isRecording = true;
    screen.classList.add('recording');
    prompt.textContent = 'Listening…';
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    recordRecognizer.stop();
  }

  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    startRecording();
  });
  btn.addEventListener('pointerup', stopRecording);
  btn.addEventListener('pointerleave', stopRecording);
  btn.addEventListener('pointercancel', stopRecording);

  recordRecognizer.addEventListener('result', e => {
    let interim = '';
    let final = '';
    for (let i = 0; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += chunk;
      else interim += chunk;
    }
    if (final) finalTranscript = final;
    transcriptEl.textContent = finalTranscript || interim;
  });

  recordRecognizer.addEventListener('end', () => {
    screen.classList.remove('recording');
    prompt.textContent = 'Hold to add a task';
    transcriptEl.textContent = '';
    const captured = finalTranscript.trim();
    finalTranscript = '';
    if (captured) {
      addTaskFromText(captured);
      screen.classList.add('success');
      setTimeout(() => screen.classList.remove('success'), 550);
    }
  });

  recordRecognizer.addEventListener('error', () => {
    isRecording = false;
    screen.classList.remove('recording');
    prompt.textContent = 'Hold to add a task';
    transcriptEl.textContent = '';
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

function onLocationsTabShown() {
  if (!locationMapInitialized) {
    locationMapInitialized = true;
    initLocationMap('location-map', (lat, lng) => {
      document.getElementById('location-lat-input').value = lat.toFixed(6);
      document.getElementById('location-lng-input').value = lng.toFixed(6);
    });
  }
  setTimeout(invalidateLocationMap, 60);
}

function activateTab(panelId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('panel-active'));
  const btn = document.querySelector(`.tab-btn[data-panel="${panelId}"]`);
  if (btn) btn.classList.add('tab-active');
  document.getElementById(panelId).classList.add('panel-active');
  if (panelId === 'panel-settings') onLocationsTabShown();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.panel));
  });
  document.getElementById('settings-gear-btn').addEventListener('click', () => activateTab('panel-settings'));
}

function setupEditModal() {
  document.querySelectorAll('#edit-date-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => applyDatePreset(chip.dataset.preset));
  });
  document.getElementById('edit-due-date').addEventListener('change', syncDateChipActiveState);

  document.getElementById('edit-more-toggle').addEventListener('click', () => {
    const wrap = document.getElementById('edit-more-fields');
    const isNowHidden = wrap.classList.toggle('hidden');
    document.getElementById('edit-more-toggle').classList.toggle('expanded', !isNowHidden);
  });

  document.getElementById('edit-tags-trigger').addEventListener('click', () => {
    document.getElementById('edit-tags-panel').classList.toggle('hidden');
  });
  document.addEventListener('click', e => {
    const dropdown = document.getElementById('edit-tags-dropdown');
    if (dropdown && !dropdown.contains(e.target)) {
      document.getElementById('edit-tags-panel').classList.add('hidden');
    }
  });

  document.querySelectorAll('#edit-recurrence-segmented button').forEach(btn => {
    btn.addEventListener('click', () => setRecurrenceSegmented(btn.dataset.freq));
  });

  document.getElementById('edit-task-form').addEventListener('submit', e => {
    e.preventDefault();
    saveEditModal();
  });
  document.getElementById('edit-cancel-btn').addEventListener('click', closeEditModal);
  document.getElementById('edit-delete-btn').addEventListener('click', async () => {
    const id = document.getElementById('edit-task-form').dataset.taskId;
    closeEditModal();
    await deleteTask(id);
  });
  document.getElementById('edit-modal').addEventListener('click', e => {
    if (e.target.id === 'edit-modal') closeEditModal();
  });
}

function setupAddressSearch() {
  document.getElementById('address-search-btn').addEventListener('click', async () => {
    const query = document.getElementById('location-address-input').value.trim();
    if (!query) return;
    const resultsWrap = document.getElementById('address-results');
    resultsWrap.innerHTML = '';
    resultsWrap.classList.remove('hidden');
    resultsWrap.appendChild(el('div', 'address-result', 'Searching…'));
    try {
      const results = await geocodeAddress(query);
      resultsWrap.innerHTML = '';
      if (!results.length) {
        resultsWrap.appendChild(el('div', 'address-result', 'No matches found'));
        return;
      }
      results.forEach(r => {
        const btn = el('button', 'address-result', r.displayName);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          document.getElementById('location-lat-input').value = r.lat.toFixed(6);
          document.getElementById('location-lng-input').value = r.lng.toFixed(6);
          setMapMarker(r.lat, r.lng);
          resultsWrap.classList.add('hidden');
          resultsWrap.innerHTML = '';
        });
        resultsWrap.appendChild(btn);
      });
    } catch (err) {
      resultsWrap.innerHTML = '';
      resultsWrap.appendChild(el('div', 'address-result', 'Search failed — check your connection'));
    }
  });

  ['location-lat-input', 'location-lng-input'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      const lat = parseFloat(document.getElementById('location-lat-input').value);
      const lng = parseFloat(document.getElementById('location-lng-input').value);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) setMapMarker(lat, lng, false);
    });
  });
}

function setupForms() {
  document.getElementById('add-task-form').addEventListener('submit', e => {
    e.preventDefault();
    addTaskFromText(document.getElementById('task-input').value);
    document.getElementById('add-task-wrap').classList.add('hidden');
  });

  document.getElementById('filters-btn').addEventListener('click', () => {
    document.getElementById('filters-panel').classList.toggle('hidden');
  });

  document.getElementById('add-toggle-btn').addEventListener('click', () => {
    const wrap = document.getElementById('add-task-wrap');
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) document.getElementById('task-input').focus();
  });

  document.getElementById('default-task-time-input').addEventListener('change', e => {
    localStorage.setItem('defaultTaskTime', e.target.value || '09:00');
  });

  document.getElementById('add-location-form').addEventListener('submit', e => {
    e.preventDefault();
    const label = document.getElementById('location-name-input').value.trim();
    const lat = parseFloat(document.getElementById('location-lat-input').value);
    const lng = parseFloat(document.getElementById('location-lng-input').value);
    addLocation({ label, lat, lng });
    document.getElementById('location-name-input').value = '';
    document.getElementById('location-address-input').value = '';
    document.getElementById('location-lat-input').value = '';
    document.getElementById('location-lng-input').value = '';
    document.getElementById('address-results').classList.add('hidden');
  });

  document.getElementById('use-current-location-btn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(pos => {
      document.getElementById('location-lat-input').value = pos.coords.latitude.toFixed(6);
      document.getElementById('location-lng-input').value = pos.coords.longitude.toFixed(6);
      setMapMarker(pos.coords.latitude, pos.coords.longitude);
    });
  });

  document.getElementById('notif-btn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    document.getElementById('notif-status').textContent =
      perm === 'granted' ? 'Notifications enabled' : 'Notifications not enabled';
  });

  setupAddressSearch();
  setupEditModal();
  setupLabelForms();
}

async function init() {
  await rolloverAndPurge();
  await loadAll();
  renderColorSwatches('label-color-swatches', 'label-color-input');
  document.getElementById('default-task-time-input').value = localStorage.getItem('defaultTaskTime') || '09:00';
  render();
  syncAddBarDefaultsFromFilters();
  setupTabs();
  setupForms();
  setupVoiceCapture();
  setupRecordButton();
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

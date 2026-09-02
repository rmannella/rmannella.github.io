// The Tasks screen: filter chips, the add bar, the task list, and the edit
// modal. Subscribes to the store and redraws only the sections whose data
// actually changed.

const TasksUI = (() => {
  const EMPTY_STATE_MESSAGES = [
    'Nothing here. Tap + above, or head to Record and just say it.',
    'A blank slate — what needs doing?',
    'All clear for now.',
    "Nothing on the list yet. Add one whenever you're ready.",
    'Empty — hold the mic on Record, or tap + to type one.',
  ];

  const UNDO_WINDOW_MS = 5500;
  const DOUBLE_CLICK_MS = 250;

  let sortable = null;
  let editingTitleId = null; // task whose title is being edited inline
  let pendingDelete = null; // { task, timeoutId } — soft-deleted, undoable
  let titleClickTimer = null;

  function emptyStateMessage() {
    return EMPTY_STATE_MESSAGES[Math.floor(Date.now() / 86400000) % EMPTY_STATE_MESSAGES.length];
  }

  function getDefaultTaskTime() {
    const [hour, minute] = (localStorage.getItem('defaultTaskTime') || '09:00').split(':').map(Number);
    return { hour: hour || 0, minute: minute || 0 };
  }

  /* ---------- adding ---------- */

  const addTaskFromText = UI.guard(async function (rawText) {
    const text = (rawText || '').trim();
    if (!text) return;

    const entries = parseEntry(text, Store.state.locations, getDefaultTaskTime());
    if (!entries.length) return;

    const tagsRaw = $('task-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    await Store.ensureLabels(tags);

    // An explicit pick in the add bar always beats whatever the parser found.
    const manualLocationId = $('task-location').value || null;
    const inferredId = manualLocationId
      ? null
      : await Store.resolveInferredLocation(entries[0].location);

    const created = await Store.addTasks(
      entries.map(entry => ({
        title: entry.title,
        priority_tags: tags,
        due_date: entry.due ? dateKey(entry.due) : null,
        due_time: entry.due ? entry.due.toTimeString().slice(0, 5) : null,
        location_trigger_id: manualLocationId || (entry.location ? entry.location.id || inferredId : null),
        recurrence_rule: entry.recurrence || null,
      }))
    );

    $('task-input').value = '';
    syncAddBarDefaults();

    if (created.length === 1) {
      UI.showToast(`Added "${created[0].title}" — ${friendlyDueLabel(created[0])}`);
    } else {
      UI.showToast(`Added ${pluralize(created.length, 'task')} — ${friendlyDueLabel(created[0])}`);
    }
  }, 'Could not add that task.');

  function syncAddBarDefaults() {
    $('task-tags').value = Store.state.activeTag === 'all' ? '' : Store.state.activeTag;
  }

  /* ---------- deleting (with undo) ---------- */

  async function commitPendingDelete() {
    if (!pendingDelete) return;
    const { task, timeoutId } = pendingDelete;
    clearTimeout(timeoutId);
    pendingDelete = null;
    await Store.removeTask(task.id);
  }

  function undoPendingDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timeoutId);
    pendingDelete = null;
    renderList();
  }

  // The task stays in IndexedDB during the undo window and is only filtered
  // out of the list, so undo is a pure UI operation with nothing to restore.
  async function deleteTask(id) {
    const task = Store.task(id);
    if (!task) return;
    await commitPendingDelete();

    pendingDelete = { task, timeoutId: setTimeout(() => commitPendingDelete(), UNDO_WINDOW_MS) };
    renderList();
    UI.showToast(`Deleted "${task.title}"`, {
      duration: UNDO_WINDOW_MS,
      actionLabel: 'Undo',
      onAction: undoPendingDelete,
    });
  }

  /* ---------- inline title editing ---------- */

  function startInlineEdit(id) {
    editingTitleId = id;
    renderList();
  }

  const saveInlineEdit = UI.guard(async function (id, value) {
    const task = Store.task(id);
    editingTitleId = null;
    const trimmed = value.trim();
    if (task && trimmed && trimmed !== task.title) await Store.updateTask(id, { title: trimmed });
    else renderList();
  }, 'Could not rename that task.');

  function titleInput(task) {
    const input = el('input', 'task-title-input', null, { type: 'text', value: task.title });
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
        editingTitleId = null;
        renderList();
      }
    });
    input.addEventListener('blur', () => {
      if (editingTitleId === task.id) saveInlineEdit(task.id, input.value);
    });
    return input;
  }

  /* ---------- rows ---------- */

  function metaBits(task) {
    const bits = [];
    if (task.due_date) {
      const overdue = task.due_date < todayKey() && task.status === 'open';
      const date = friendlyDate(task.due_date);
      const time = friendlyTime(task.due_time);
      bits.push((overdue ? `Overdue (${date})` : date) + (time ? ` ${time}` : ''));
    }
    const loc = Store.locationLabel(task.location_trigger_id);
    if (loc) bits.push(`📍 ${loc}`);
    if (task.recurrence_rule) bits.push('🔁');
    return bits;
  }

  function taskRow(task, draggable) {
    const row = el('div', 'task-row' + (task.status === 'completed' ? ' task-done' : ''), null, {
      dataset: { id: task.id },
    });

    row.appendChild(el('span', 'drag-handle' + (draggable ? '' : ' drag-handle-hidden'), draggable ? '⠿' : ''));

    const check = el('input', 'task-checkbox', null, { type: 'checkbox', checked: task.status === 'completed' });
    check.addEventListener('change', UI.guard(() => Store.toggleComplete(task.id)));
    row.appendChild(check);

    (task.priority_tags || []).forEach(tag => {
      const dot = el('span', 'tag-dot', null, { title: tag });
      dot.style.background = Store.tagColor(tag) || 'var(--text-muted)';
      row.appendChild(dot);
    });

    const content = el('div', 'task-content');
    if (editingTitleId === task.id) {
      content.appendChild(titleInput(task));
    } else {
      // Single click edits the words in place; double click opens the full
      // card. The timer is what tells the two apart.
      const title = el('span', 'task-title', task.title);
      title.addEventListener('click', () => {
        clearTimeout(titleClickTimer);
        titleClickTimer = setTimeout(() => startInlineEdit(task.id), DOUBLE_CLICK_MS);
      });
      title.addEventListener('dblclick', () => {
        clearTimeout(titleClickTimer);
        openEditModal(task.id);
      });
      content.appendChild(title);

      const bits = metaBits(task);
      if (bits.length) {
        const overdue = !!task.due_date && task.due_date < todayKey() && task.status === 'open';
        const isToday = task.due_date === todayKey();
        content.appendChild(el('span', 'task-sep', '·'));
        content.appendChild(
          el('span', 'task-meta-inline' + (overdue ? ' overdue' : isToday ? ' today' : ''), bits.join(' · '))
        );
      }
    }
    row.appendChild(content);

    const actions = el('div', 'task-actions');
    if (task.status !== 'completed') {
      actions.appendChild(
        iconButton('→', 'Push to tomorrow', UI.guard(() => Store.pushToTomorrow(task.id)))
      );
    }
    actions.appendChild(iconButton('✕', 'Delete', () => deleteTask(task.id)));
    row.appendChild(actions);

    return row;
  }

  /* ---------- rendering ---------- */

  function renderFilters() {
    const wrap = $('tag-filter');
    const tags = ['all', ...Store.allTagNames()];
    replaceChildren(
      wrap,
      tags.map(tag => {
        const chip = el(
          'button',
          'chip' + (tag === Store.state.activeTag ? ' chip-active' : ''),
          tag === 'all' ? 'All labels' : tag,
          { type: 'button' }
        );
        chip.addEventListener('click', () => {
          Store.setActiveTag(tag);
          syncAddBarDefaults();
          setHidden($('filters-panel'), true);
        });
        return chip;
      })
    );
  }

  function fillLocationSelect(select, selectedId) {
    const prior = selectedId !== undefined ? selectedId : select.value;
    replaceChildren(select, [
      new Option('No location trigger', ''),
      ...Store.sortedLocations().map(l => new Option(l.label, l.id)),
    ]);
    select.value = prior || '';
  }

  function renderList() {
    const openList = $('task-list-open');
    const doneList = $('task-list-done');
    const skipId = pendingDelete ? pendingDelete.task.id : null;

    const open = Store.openTasks(skipId);
    const done = Store.doneTasks(skipId);

    if (open.length) {
      replaceChildren(openList, open.map(t => taskRow(t, true)));
    } else {
      const anyVisible = Store.visibleTasks(skipId).length > 0;
      replaceChildren(openList, [
        el('div', 'empty-state', anyVisible ? 'All caught up for now.' : emptyStateMessage()),
      ]);
    }
    replaceChildren(doneList, done.map(t => taskRow(t, false)));

    ensureSortable();
  }

  // Created once and left alive. The old build destroyed and rebuilt the
  // Sortable instance on every render, which churned listeners and could drop
  // an in-flight drag.
  function ensureSortable() {
    if (sortable || typeof Sortable === 'undefined') return;
    const container = $('task-list-open');
    sortable = new Sortable(container, {
      handle: '.drag-handle',
      animation: 150,
      onEnd: UI.guard(() => {
        const ids = Array.from(container.children).map(c => c.dataset.id).filter(Boolean);
        return Store.reorderTasks(ids);
      }, 'Could not save the new order.'),
    });
  }

  /* ---------- edit modal ---------- */

  function datePresetValue(preset) {
    if (preset === 'today') return todayKey();
    if (preset === 'tomorrow') return addDays(todayKey(), 1);
    if (preset === 'nextweek') return addDays(todayKey(), 7);
    return '';
  }

  function syncDateChips() {
    const value = $('edit-due-date').value;
    $$('#edit-date-chips .chip').forEach(chip => {
      const preset = chip.dataset.preset;
      const matches = preset === 'none' ? !value : datePresetValue(preset) === value;
      chip.classList.toggle('chip-active', matches);
    });
  }

  function selectedEditTags() {
    return Array.from(document.querySelectorAll('#edit-tags-panel input:checked')).map(cb => cb.value);
  }

  function updateTagsTriggerLabel() {
    const selected = selectedEditTags();
    $('edit-tags-trigger').textContent = selected.length ? selected.join(', ') : 'Select labels';
  }

  function renderEditTags(selected) {
    replaceChildren(
      $('edit-tags-panel'),
      Store.sortedLabels().map(label => {
        const row = el('label', 'dropdown-option');
        const cb = el('input', null, null, {
          type: 'checkbox',
          value: label.name,
          checked: selected.some(t => t.toLowerCase() === label.name.toLowerCase()),
        });
        cb.addEventListener('change', updateTagsTriggerLabel);
        row.appendChild(cb);
        const dot = el('span', 'tag-dot');
        dot.style.background = label.color || 'var(--text-muted)';
        row.appendChild(dot);
        row.appendChild(el('span', null, label.name));
        return row;
      })
    );
    updateTagsTriggerLabel();
  }

  function setRecurrence(freq) {
    $$('#edit-recurrence-segmented button').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.freq === (freq || ''))
    );
    setHidden($('edit-recurrence-custom'), freq !== 'custom');
  }

  function openEditModal(id) {
    const task = Store.task(id);
    if (!task) return;

    $('edit-task-form').dataset.taskId = id;
    $('edit-title').value = task.title;
    $('edit-due-date').value = task.due_date || '';
    $('edit-due-time').value = task.due_time || '';
    syncDateChips();

    renderEditTags(task.priority_tags || []);
    setHidden($('edit-tags-panel'), true);
    fillLocationSelect($('edit-location'), task.location_trigger_id || '');

    const rule = task.recurrence_rule;
    setRecurrence(rule ? rule.freq : '');
    $('edit-recurrence-interval').value = (rule && rule.interval) || 1;
    $('edit-recurrence-unit').value = (rule && rule.unit) || 'day';

    // Only expand the extra fields when the task already uses one of them.
    const hasExtras = (task.priority_tags || []).length > 0 || !!task.location_trigger_id || !!rule;
    setHidden($('edit-more-fields'), !hasExtras);
    $('edit-more-toggle').classList.toggle('expanded', hasExtras);

    UI.openModal('edit-modal');
  }

  const saveEditModal = UI.guard(async function () {
    const id = $('edit-task-form').dataset.taskId;
    const task = Store.task(id);
    if (!task) return;

    const freq = document.querySelector('#edit-recurrence-segmented button.active')?.dataset.freq || '';
    let recurrence = null;
    if (freq === 'custom') {
      recurrence = {
        freq: 'custom',
        interval: parseInt($('edit-recurrence-interval').value, 10) || 1,
        unit: $('edit-recurrence-unit').value,
      };
    } else if (freq) {
      recurrence = { freq };
    }

    await Store.updateTask(id, {
      title: $('edit-title').value.trim() || task.title,
      priority_tags: selectedEditTags(),
      due_date: $('edit-due-date').value || null,
      due_time: $('edit-due-time').value || null,
      location_trigger_id: $('edit-location').value || null,
      recurrence_rule: recurrence,
      notified_at: null,
    });
    UI.closeModal('edit-modal');
  }, 'Could not save those changes.');

  function setupEditModal() {
    $$('#edit-date-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $('edit-due-date').value = datePresetValue(chip.dataset.preset);
        if (chip.dataset.preset === 'none') $('edit-due-time').value = '';
        syncDateChips();
      });
    });
    $('edit-due-date').addEventListener('change', syncDateChips);

    $('edit-more-toggle').addEventListener('click', () => {
      const nowHidden = $('edit-more-fields').classList.toggle('hidden');
      $('edit-more-toggle').classList.toggle('expanded', !nowHidden);
    });

    $('edit-tags-trigger').addEventListener('click', () => $('edit-tags-panel').classList.toggle('hidden'));
    document.addEventListener('click', e => {
      const dropdown = $('edit-tags-dropdown');
      if (dropdown && !dropdown.contains(e.target)) setHidden($('edit-tags-panel'), true);
    });

    $$('#edit-recurrence-segmented button').forEach(btn =>
      btn.addEventListener('click', () => setRecurrence(btn.dataset.freq))
    );

    $('edit-task-form').addEventListener('submit', e => {
      e.preventDefault();
      saveEditModal();
    });
    $('edit-cancel-btn').addEventListener('click', () => UI.closeModal('edit-modal'));
    $('edit-delete-btn').addEventListener('click', async () => {
      const id = $('edit-task-form').dataset.taskId;
      UI.closeModal('edit-modal');
      await deleteTask(id);
    });
    UI.setupModal('edit-modal', () => UI.closeModal('edit-modal'));
  }

  /* ---------- dictation into the add bar ---------- */

  // Secondary to the Record screen: a one-shot mic for the typed add bar,
  // for when you're already looking at the list.
  function setupInlineMic() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = $('mic-btn');
    if (!SpeechRecognition) {
      micBtn.disabled = true;
      micBtn.title = 'Voice input not supported in this browser';
      return;
    }

    const recognizer = new SpeechRecognition();
    recognizer.lang = 'en-US';
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    let listening = false;
    micBtn.addEventListener('click', () => {
      if (listening) {
        recognizer.stop();
        return;
      }
      try {
        recognizer.start();
      } catch (err) {
        return;
      }
      listening = true;
      micBtn.classList.add('mic-active');
    });

    recognizer.addEventListener('result', e => addTaskFromText(e.results[0][0].transcript));
    ['end', 'error'].forEach(evt =>
      recognizer.addEventListener(evt, () => {
        listening = false;
        micBtn.classList.remove('mic-active');
      })
    );
  }

  /* ---------- wiring ---------- */

  function setup() {
    setupInlineMic();

    $('add-task-form').addEventListener('submit', e => {
      e.preventDefault();
      addTaskFromText($('task-input').value);
      setHidden($('add-task-wrap'), true);
    });

    $('filters-btn').addEventListener('click', () => $('filters-panel').classList.toggle('hidden'));

    $('add-toggle-btn').addEventListener('click', () => {
      const wrap = $('add-task-wrap');
      wrap.classList.toggle('hidden');
      if (!wrap.classList.contains('hidden')) $('task-input').focus();
    });

    setupEditModal();

    Store.subscribe(changed => {
      if (changed.has('tasks') || changed.has('labels') || changed.has('filter')) renderList();
      if (changed.has('labels') || changed.has('tasks') || changed.has('filter')) renderFilters();
      if (changed.has('locations')) fillLocationSelect($('task-location'));
    });

    renderFilters();
    fillLocationSelect($('task-location'));
    renderList();
    syncAddBarDefaults();
  }

  return { setup, addTaskFromText, openEditModal, renderList, commitPendingDelete };
})();

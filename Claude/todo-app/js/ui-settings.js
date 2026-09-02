// Settings: default task time, sync, notifications, backup, Labels, and
// Locations. Locations are the interesting part -- they are entered and shown
// as street addresses, with coordinates resolved behind the scenes.

const SettingsUI = (() => {
  let mapReady = false;
  let editingLocationId = null;
  // Coordinates + address for the location currently being composed.
  let draft = { address: null, lat: null, lng: null };

  /* ---------- labels ---------- */

  function renderLabels() {
    replaceChildren(
      $('labels-list'),
      Store.sortedLabels().map(label => {
        const row = el('div', 'list-row');
        const swatch = el('span', 'swatch');
        swatch.style.background = label.color || Store.MUTED_COLORS[0];
        row.appendChild(swatch);
        row.appendChild(el('span', 'list-row-title', label.name));
        row.appendChild(iconButton('✎', 'Edit label', () => openLabelModal(label.id)));
        row.appendChild(iconButton('✕', 'Delete label', UI.guard(() => Store.removeLabel(label.id))));
        return row;
      })
    );
  }

  function openLabelModal(id) {
    const label = Store.state.labels.find(l => l.id === id);
    if (!label) return;
    $('label-edit-form').dataset.labelId = id;
    $('label-edit-name-input').value = label.name;
    $('label-edit-color-input').value = label.color || Store.MUTED_COLORS[0];
    UI.renderColorSwatches('label-edit-color-swatches', 'label-edit-color-input');
    UI.openModal('label-edit-modal');
  }

  function setupLabelForms() {
    $('add-label-form').addEventListener(
      'submit',
      UI.guard(async e => {
        e.preventDefault();
        const input = $('label-name-input');
        const name = input.value.trim();
        if (!name) return;
        const colorInput = $('label-color-input');
        await Store.addLabel(name, colorInput.value);
        input.value = '';
        colorInput.value = Store.MUTED_COLORS[0];
        UI.renderColorSwatches('label-color-swatches', 'label-color-input');
      }, 'Could not add that label.')
    );

    $('label-edit-form').addEventListener(
      'submit',
      UI.guard(async e => {
        e.preventDefault();
        const name = $('label-edit-name-input').value.trim();
        if (!name) return;
        await Store.updateLabel($('label-edit-form').dataset.labelId, {
          name,
          color: $('label-edit-color-input').value || Store.MUTED_COLORS[0],
        });
        UI.closeModal('label-edit-modal');
      }, 'Could not save that label.')
    );

    $('label-edit-cancel-btn').addEventListener('click', () => UI.closeModal('label-edit-modal'));
    UI.setupModal('label-edit-modal', () => UI.closeModal('label-edit-modal'));
  }

  /* ---------- locations ---------- */

  function renderLocations() {
    replaceChildren(
      $('locations-list'),
      Store.sortedLocations().map(loc => {
        const row = el('div', 'list-row');
        const text = el('div', 'list-row-text');
        text.appendChild(el('span', 'list-row-title', loc.label));
        text.appendChild(
          loc.address
            ? el('span', 'list-row-sub', loc.address)
            : el('span', 'list-row-sub list-row-sub-warn', 'No address yet — tap to add one')
        );
        row.appendChild(text);
        row.appendChild(iconButton('✎', 'Edit address', () => startEditingLocation(loc.id)));
        row.appendChild(iconButton('✕', 'Delete location', UI.guard(() => Store.removeLocation(loc.id))));

        // The whole row is a target too: a location the parser created has no
        // address, and tapping it is the obvious way to fix that.
        text.addEventListener('click', () => startEditingLocation(loc.id));
        return row;
      })
    );
  }

  function setPickedAddress(pick) {
    draft = { address: pick.address, lat: pick.lat, lng: pick.lng };
    $('location-address-input').value = pick.address;
    $('location-pin-hint').textContent = pick.address;
    $('location-pin-hint').classList.add('location-pin-set');
    // Offer the place name as a label so the user usually just taps Save.
    const nameInput = $('location-name-input');
    if (!nameInput.value.trim() && pick.shortLabel) nameInput.value = pick.shortLabel;
  }

  function resetLocationForm() {
    editingLocationId = null;
    draft = { address: null, lat: null, lng: null };
    $('location-name-input').value = '';
    $('location-address-input').value = '';
    $('location-pin-hint').textContent = 'Search an address, or tap the map to drop a pin.';
    $('location-pin-hint').classList.remove('location-pin-set');
    $('location-submit-btn').textContent = 'Add location';
    setHidden($('location-cancel-btn'), true);
    setHidden($('address-results'), true);
    LocationMap.clearPin();
  }

  function startEditingLocation(id) {
    const loc = Store.state.locations.find(l => l.id === id);
    if (!loc) return;
    editingLocationId = id;
    draft = { address: loc.address || null, lat: loc.lat, lng: loc.lng };
    $('location-name-input').value = loc.label;
    $('location-address-input').value = loc.address || '';
    $('location-pin-hint').textContent =
      loc.address || 'Search an address, or tap the map to drop a pin.';
    $('location-pin-hint').classList.toggle('location-pin-set', !!loc.address);
    $('location-submit-btn').textContent = 'Save location';
    setHidden($('location-cancel-btn'), false);

    ensureMap();
    if (loc.lat != null && loc.lng != null) LocationMap.setPin(loc.lat, loc.lng, { reverse: false });
    else LocationMap.clearPin();
    $('location-name-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const runAddressSearch = UI.guard(async function () {
    const query = $('location-address-input').value.trim();
    if (!query) return;
    const results = $('address-results');
    replaceChildren(results, [el('div', 'address-result', 'Searching…')]);
    setHidden(results, false);

    const matches = await LocationMap.search(query);
    if (!matches.length) {
      replaceChildren(results, [el('div', 'address-result', 'No matches found')]);
      return;
    }
    replaceChildren(
      results,
      matches.map(match => {
        const btn = el('button', 'address-result', match.address, { type: 'button' });
        btn.addEventListener('click', () => {
          setPickedAddress(match);
          ensureMap();
          LocationMap.setPin(match.lat, match.lng, { reverse: false });
          setHidden(results, true);
        });
        return btn;
      })
    );
  }, 'Address search failed — check your connection.');

  // Called whenever the pin moves. A pin dropped by hand needs a reverse
  // lookup to become an address; one that came from a search already has one.
  const onPinMoved = UI.guard(async function ({ lat, lng, reverse }) {
    draft.lat = lat;
    draft.lng = lng;
    if (!reverse) return;
    $('location-pin-hint').textContent = 'Looking up that address…';
    const pick = await LocationMap.reverse(lat, lng);
    if (pick) setPickedAddress(pick);
    else {
      draft.address = null;
      $('location-pin-hint').textContent = "Couldn't find an address there — try searching instead.";
      $('location-pin-hint').classList.remove('location-pin-set');
    }
  }, 'Address lookup failed.');

  function ensureMap() {
    if (mapReady) return;
    mapReady = true;
    LocationMap.init('location-map', onPinMoved);
  }

  function onSettingsShown() {
    ensureMap();
    // Leaflet mis-measures a container that was display:none when it loaded.
    setTimeout(() => LocationMap.invalidate(), 60);
  }

  function setupLocationForm() {
    $('address-search-btn').addEventListener('click', runAddressSearch);
    $('location-address-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runAddressSearch();
      }
    });

    $('use-current-location-btn').addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        UI.showToast("This browser can't share your location.");
        return;
      }
      $('location-pin-hint').textContent = 'Finding you…';
      navigator.geolocation.getCurrentPosition(
        pos => {
          ensureMap();
          LocationMap.setPin(pos.coords.latitude, pos.coords.longitude, { reverse: true });
        },
        () => UI.showToast('Could not get your current location.')
      );
    });

    $('location-cancel-btn').addEventListener('click', resetLocationForm);

    $('add-location-form').addEventListener(
      'submit',
      UI.guard(async e => {
        e.preventDefault();
        const label = $('location-name-input').value.trim();
        if (!label) {
          UI.showToast('Give the location a name first.');
          return;
        }
        const fields = { label, address: draft.address, lat: draft.lat, lng: draft.lng };
        if (editingLocationId) await Store.updateLocation(editingLocationId, fields);
        else await Store.addLocation(fields);

        UI.showToast(
          draft.address ? `Saved ${label}` : `Saved ${label} — add an address to make it trigger reminders.`
        );
        resetLocationForm();
      }, 'Could not save that location.')
    );
  }

  /* ---------- backup ---------- */

  function setupExportImport() {
    $('export-btn').addEventListener(
      'click',
      UI.guard(async () => {
        const data = await DB.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', null, null, { href: url, download: `todo-backup-${todayKey()}.json` });
        a.click();
        URL.revokeObjectURL(url);
      }, 'Export failed.')
    );

    $('import-input').addEventListener(
      'change',
      UI.guard(async e => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        const restored = await DB.importAll(JSON.parse(await file.text()));
        await Store.refresh();
        UI.showToast(`Restored ${restored.join(', ')} from backup.`);
      }, "That file couldn't be imported.")
    );
  }

  /* ---------- notifications & preferences ---------- */

  function setupPreferences() {
    const timeInput = $('default-task-time-input');
    timeInput.value = localStorage.getItem('defaultTaskTime') || '09:00';
    timeInput.addEventListener('change', e =>
      localStorage.setItem('defaultTaskTime', e.target.value || '09:00')
    );

    $('notif-btn').addEventListener('click', async () => {
      if (!('Notification' in window)) {
        UI.showToast("This browser doesn't support notifications.");
        return;
      }
      const permission = await Notification.requestPermission();
      refreshNotificationStatus(permission);
    });
    if ('Notification' in window) refreshNotificationStatus(Notification.permission);
  }

  function refreshNotificationStatus(permission) {
    $('notif-status').textContent =
      permission === 'granted'
        ? 'Notifications enabled'
        : permission === 'denied'
          ? 'Notifications blocked in browser settings'
          : 'Notifications not enabled';
  }

  /* ---------- wiring ---------- */

  function setup() {
    UI.renderColorSwatches('label-color-swatches', 'label-color-input');
    setupLabelForms();
    setupLocationForm();
    setupExportImport();
    setupPreferences();

    Store.subscribe(changed => {
      if (changed.has('labels')) renderLabels();
      if (changed.has('locations')) renderLocations();
    });

    UI.onTabChange(panelId => {
      if (panelId === 'panel-settings') onSettingsShown();
    });

    renderLabels();
    renderLocations();
  }

  return { setup };
})();

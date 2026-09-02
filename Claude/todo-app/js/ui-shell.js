// App chrome shared by every screen: toasts, tab switching, and the little
// helpers that keep error handling consistent instead of ad hoc per handler.

const UI = (() => {
  let toastTimer = null;

  function showToast(message, { duration = 3500, actionLabel, onAction } = {}) {
    const toast = $('toast');
    const children = [el('span', null, message)];
    if (actionLabel && onAction) {
      const action = el('button', 'toast-action', actionLabel, { type: 'button' });
      action.addEventListener('click', () => {
        onAction();
        dismissToast();
      });
      children.push(action);
    }
    replaceChildren(toast, children);
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(dismissToast, duration);
  }

  function dismissToast() {
    const toast = $('toast');
    clearTimeout(toastTimer);
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.classList.add('hidden'), 250);
  }

  // Wraps an async handler so a failure surfaces as a toast the user can act
  // on rather than a silent unhandled rejection in the console.
  function guard(fn, fallbackMessage = 'Something went wrong.') {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        console.error(err);
        showToast(err && err.message ? err.message : fallbackMessage, { duration: 5000 });
        return undefined;
      }
    };
  }

  /* ---------- tabs ---------- */

  const tabListeners = new Set();

  function onTabChange(fn) {
    tabListeners.add(fn);
  }

  function activateTab(panelId) {
    $$('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.panel === panelId));
    $$('.panel').forEach(p => p.classList.toggle('panel-active', p.id === panelId));
    tabListeners.forEach(fn => fn(panelId));
  }

  function setupTabs() {
    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.panel)));
    $('settings-gear-btn').addEventListener('click', () => activateTab('panel-settings'));
  }

  /* ---------- modals ---------- */

  // Wires backdrop-click and Escape once per modal, so individual screens
  // only have to say what "close" means.
  function setupModal(modalId, onClose) {
    const overlay = $(modalId);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) onClose();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) onClose();
    });
  }

  function openModal(modalId) {
    $(modalId).classList.remove('hidden');
  }

  function closeModal(modalId) {
    $(modalId).classList.add('hidden');
  }

  /* ---------- color swatches ---------- */

  function renderColorSwatches(wrapId, hiddenInputId) {
    const wrap = $(wrapId);
    const hidden = $(hiddenInputId);
    if (!hidden.value) hidden.value = Store.MUTED_COLORS[0];
    replaceChildren(
      wrap,
      Store.MUTED_COLORS.map(color => {
        const btn = el('button', 'swatch-option' + (hidden.value === color ? ' swatch-selected' : ''), null, {
          type: 'button',
          title: color,
        });
        btn.style.background = color;
        btn.addEventListener('click', () => {
          hidden.value = color;
          wrap.querySelectorAll('.swatch-option').forEach(s => s.classList.remove('swatch-selected'));
          btn.classList.add('swatch-selected');
        });
        return btn;
      })
    );
  }

  return {
    showToast,
    dismissToast,
    guard,
    onTabChange,
    activateTab,
    setupTabs,
    setupModal,
    openModal,
    closeModal,
    renderColorSwatches,
  };
})();

// Small shared helpers: dates, DOM construction, formatting. No app state
// here and nothing async -- everything in this file is a pure function or a
// thin DOM factory, which keeps it trivially reusable and testable.

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thurs', 'Fri', 'Sat'];
const MS_PER_DAY = 86400000;

/* ---------- dates ---------- */

// Local-time YYYY-MM-DD. Never use toISOString() for this: it converts to UTC
// and silently reports "tomorrow" for anyone east of Greenwich in the evening.
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

function parseDateKey(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}

function addDays(dateStr, n) {
  const d = parseDateKey(dateStr);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------- formatting ---------- */

function friendlyDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr === todayKey()) return 'Today';
  if (dateStr === addDays(todayKey(), 1)) return 'Tomorrow';
  const d = parseDateKey(dateStr);
  return `${WEEKDAY_ABBR[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function friendlyTime(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function friendlyDueLabel(task) {
  const dateLabel = friendlyDate(task.due_date);
  if (!dateLabel) return 'No due date';
  const timeLabel = friendlyTime(task.due_time);
  return timeLabel ? `${dateLabel} at ${timeLabel}` : dateLabel;
}

function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------- DOM ---------- */

// el('div', 'cls', 'text') or el('button', 'cls', 'text', { type: 'button' }).
// Text always goes through textContent, so user-entered task titles and label
// names can never be interpreted as markup.
function el(tag, className, text, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
  }
  return node;
}

function iconButton(glyph, title, onClick) {
  const btn = el('button', 'icon-btn', glyph, { type: 'button', title, 'aria-label': title });
  btn.addEventListener('click', onClick);
  return btn;
}

const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function setHidden(node, hidden) {
  if (node) node.classList.toggle('hidden', hidden);
}

function replaceChildren(node, children) {
  node.textContent = '';
  for (const child of children) node.appendChild(child);
}

/* ---------- async ---------- */

function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

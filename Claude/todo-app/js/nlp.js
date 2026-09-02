// Heuristic parser for free-text and voice capture. Regex only -- no model,
// no network. It is an approximation on purpose: it should be *quiet* when
// unsure rather than clever and wrong, because a bad guess silently corrupts
// a task the user just spoke and moved on from.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const LEAD_PHRASES = [/^remind me to\s+/i, /^remind me\s+/i, /^todo:?\s+/i, /^add task:?\s+/i, /^add\s+/i];

// Words that follow "when I get/am ..." but describe a *state*, not a place.
// Without this, "remind me when I am done to email Bob" would create a
// location called "Done" and attach a geofence to it.
const NON_PLACE_WORDS = new Set([
  'done', 'free', 'back', 'there', 'here', 'ready', 'finished', 'up', 'in',
  'out', 'off', 'a', 'an', 'the', 'time', 'able', 'going', 'paid', 'older',
]);

function stripLeadPhrase(text) {
  for (const re of LEAD_PHRASES) {
    if (re.test(text)) return text.replace(re, '');
  }
  return text;
}

function capitalize(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function squish(s) {
  return s.replace(/\s{2,}/g, ' ').trim();
}

// Remove a matched phrase from the text and tidy the seam it leaves behind.
function cut(text, match) {
  return squish(text.replace(match, ' '));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------- location ---------- */

function extractLocation(text, knownLocations = []) {
  // Saved locations win: an exact name match is never a guess.
  for (const loc of knownLocations) {
    const name = escapeRegExp(loc.label.toLowerCase());
    const re = new RegExp(
      `\\bwhen i (?:get|arrive|am)\\s+(?:to\\s+(?:the\\s+)?|at\\s+(?:the\\s+)?)?${name}\\b|\\bat (?:the\\s+)?${name}\\b`,
      'i'
    );
    const m = text.match(re);
    if (m) return { location: loc, cleaned: cut(text, m[0]) };
  }

  const homeMatch = text.match(/\bwhen i (?:get|arrive|am)\s+home\b/i);
  if (homeMatch) {
    const saved = knownLocations.find(l => l.label.toLowerCase() === 'home');
    return {
      location: saved || { label: 'Home', inferred: true },
      cleaned: cut(text, homeMatch[0]),
    };
  }

  // An unrecognized place name after "when I get/arrive/am (to/at) ___"
  // becomes a new, address-less location the user can fill in later.
  const generic = text.match(/\bwhen i (?:get|arrive|am)\s+(?:to\s+(?:the\s+)?|at\s+(?:the\s+)?)?([a-z][a-z'-]{1,20})\b/i);
  if (generic && !NON_PLACE_WORDS.has(generic[1].toLowerCase())) {
    return {
      location: { label: capitalize(generic[1]), inferred: true },
      cleaned: cut(text, generic[0]),
    };
  }

  return { location: null, cleaned: text };
}

/* ---------- date & time ---------- */

function extractDateTime(text, now = new Date(), defaultTime = { hour: 9, minute: 0 }) {
  let cleaned = text;
  let due = null;

  const relative = cleaned.match(/\bin (\d+)\s*(minute|min|hour|hr|day)s?\b/i);
  if (relative) {
    const n = parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    due = new Date(now);
    if (unit.startsWith('min')) due.setMinutes(due.getMinutes() + n);
    else if (unit.startsWith('h')) due.setHours(due.getHours() + n);
    else due.setDate(due.getDate() + n);
    cleaned = cut(cleaned, relative[0]);
  }

  if (!due) {
    const tomorrow = cleaned.match(/\btomorrow\b/i);
    if (tomorrow) {
      due = new Date(now);
      due.setDate(due.getDate() + 1);
      due.setHours(defaultTime.hour, defaultTime.minute, 0, 0);
      cleaned = cut(cleaned, tomorrow[0]);
    }
  }

  if (!due) {
    const today = cleaned.match(/\btoday\b/i);
    if (today) {
      due = new Date(now);
      cleaned = cut(cleaned, today[0]);
    }
  }

  if (!due) {
    const weekday = cleaned.match(new RegExp(`\\b(next )?(${WEEKDAYS.join('|')})\\b`, 'i'));
    if (weekday) {
      const target = WEEKDAYS.indexOf(weekday[2].toLowerCase());
      due = new Date(now);
      let diff = (target - due.getDay() + 7) % 7;
      if (diff === 0 || weekday[1]) diff += 7;
      due.setDate(due.getDate() + diff);
      due.setHours(defaultTime.hour, defaultTime.minute, 0, 0);
      cleaned = cut(cleaned, weekday[0]);
    }
  }

  const time =
    cleaned.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i) ||
    cleaned.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (time) {
    let hour = parseInt(time[1], 10);
    const minute = time[2] ? parseInt(time[2], 10) : 0;
    const meridiem = (time[3] || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (!due) due = new Date(now);
    due.setHours(hour, minute, 0, 0);
    // "at 7" said in the evening means 7pm, not a time that already passed.
    if (!meridiem && hour < 8 && due < now) due.setHours(due.getHours() + 12);
    cleaned = cut(cleaned, time[0]);
  }

  return { due, cleaned: squish(cleaned) };
}

/* ---------- recurrence ---------- */

function extractRecurrence(text) {
  const daily = text.match(/\b(every\s*day|everyday|daily)\b/i);
  if (daily) return { recurrence: { freq: 'daily' }, cleaned: cut(text, daily[0]) };

  const weekly = text.match(/\b(every\s*week|weekly)\b/i);
  if (weekly) return { recurrence: { freq: 'weekly' }, cleaned: cut(text, weekly[0]) };

  // "every 3 days" / "every 2 weeks"
  const interval = text.match(/\bevery\s+(\d+)\s*(day|week)s?\b/i);
  if (interval) {
    return {
      recurrence: { freq: 'custom', interval: parseInt(interval[1], 10) || 1, unit: interval[2].toLowerCase() },
      cleaned: cut(text, interval[0]),
    };
  }

  return { recurrence: null, cleaned: text };
}

/* ---------- splitting ---------- */

// Commas only. "and" is deliberately NOT a separator: "text Paulie and ask
// about ice cream" is one task, and no regex reliably tells a compound action
// apart from two independent ones.
function splitTasks(text) {
  const parts = text.split(',').map(s => squish(s)).filter(Boolean);
  return parts.length ? parts : [squish(text)];
}

function parseEntry(rawText, knownLocations = [], defaultTime = { hour: 9, minute: 0 }, now = new Date()) {
  let text = stripLeadPhrase(rawText.trim());

  const loc = extractLocation(text, knownLocations);
  text = loc.cleaned;

  const dt = extractDateTime(text, now, defaultTime);
  text = dt.cleaned;

  const rec = extractRecurrence(text);
  text = rec.cleaned;

  // A recurring task needs a starting due date for the next occurrence to be
  // computable at all, so default it to today.
  let due = dt.due;
  if (rec.recurrence && !due) due = new Date(now);

  const stripTo = s => squish(s.replace(/^to\s+/i, ''));

  return splitTasks(stripTo(text))
    .map(stripTo)
    .filter(Boolean)
    .map(title => ({
      title: capitalize(title),
      due,
      location: loc.location,
      recurrence: rec.recurrence,
    }));
}

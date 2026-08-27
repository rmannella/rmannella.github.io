const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const LEAD_PHRASES = [
  /^remind me to\s+/i,
  /^remind me\s+/i,
  /^todo:?\s+/i,
  /^add task:?\s+/i,
  /^add\s+/i,
];

function stripLeadPhrase(text) {
  for (const re of LEAD_PHRASES) {
    if (re.test(text)) return text.replace(re, '');
  }
  return text;
}

function capitalize(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function extractLocation(text, knownLocations) {
  const labels = knownLocations.map(l => l.label.toLowerCase());

  for (const label of labels) {
    const re = new RegExp(`\\bwhen i (?:get|arrive|am)\\s+(?:home|to\\s+(?:the\\s+)?${label}|at\\s+(?:the\\s+)?${label})\\b|\\bat (?:the\\s+)?${label}\\b`, 'i');
    const m = text.match(re);
    if (m) {
      return { label: knownLocations.find(l => l.label.toLowerCase() === label), cleaned: text.replace(m[0], '').trim() };
    }
  }

  const homeRe = /\bwhen i (?:get|arrive|am)\s+home\b/i;
  const homeMatch = text.match(homeRe);
  if (homeMatch) {
    return { label: knownLocations.find(l => l.label.toLowerCase() === 'home') || { label: 'Home', inferred: true }, cleaned: text.replace(homeMatch[0], '').trim() };
  }

  // Any unrecognized single-word place name after "when I get/arrive/am (to/at) ___"
  // (e.g. "work", "gym", "the dentist") is treated as a new, not-yet-saved location.
  const genericRe = /\bwhen i (?:get|arrive|am)\s+(?:to\s+(?:the\s+)?|at\s+(?:the\s+)?)?([a-z][a-z'-]{1,20})\b/i;
  const genericMatch = text.match(genericRe);
  if (genericMatch) {
    const name = capitalize(genericMatch[1].trim());
    return { label: { label: name, inferred: true }, cleaned: text.replace(genericMatch[0], '').trim() };
  }

  return { label: null, cleaned: text };
}

function extractDateTime(text, now = new Date(), defaultTime = { hour: 9, minute: 0 }) {
  let cleaned = text;
  let due = null;

  const inMatch = cleaned.match(/\bin (\d+)\s*(minute|min|hour|hr|day)s?\b/i);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    due = new Date(now);
    if (unit.startsWith('min')) due.setMinutes(due.getMinutes() + n);
    else if (unit.startsWith('hour') || unit === 'hr') due.setHours(due.getHours() + n);
    else if (unit.startsWith('day')) due.setDate(due.getDate() + n);
    cleaned = cleaned.replace(inMatch[0], '').trim();
  }

  if (!due) {
    const tomorrowMatch = cleaned.match(/\btomorrow\b/i);
    if (tomorrowMatch) {
      due = new Date(now);
      due.setDate(due.getDate() + 1);
      due.setHours(defaultTime.hour, defaultTime.minute, 0, 0);
      cleaned = cleaned.replace(tomorrowMatch[0], '').trim();
    }
  }

  if (!due) {
    const todayMatch = cleaned.match(/\btoday\b/i);
    if (todayMatch) {
      due = new Date(now);
      cleaned = cleaned.replace(todayMatch[0], '').trim();
    }
  }

  if (!due) {
    const wdRe = new RegExp(`\\b(next )?(${WEEKDAYS.join('|')})\\b`, 'i');
    const wdMatch = cleaned.match(wdRe);
    if (wdMatch) {
      const targetDay = WEEKDAYS.indexOf(wdMatch[2].toLowerCase());
      due = new Date(now);
      let diff = (targetDay - due.getDay() + 7) % 7;
      if (diff === 0 || wdMatch[1]) diff += 7;
      due.setDate(due.getDate() + diff);
      due.setHours(defaultTime.hour, defaultTime.minute, 0, 0);
      cleaned = cleaned.replace(wdMatch[0], '').trim();
    }
  }

  const timeMatch = cleaned.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i) || cleaned.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = (timeMatch[3] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!due) due = new Date(now);
    due.setHours(hour, minute, 0, 0);
    if (!ampm && hour < 8 && due < now) due.setHours(due.getHours() + 12);
    cleaned = cleaned.replace(timeMatch[0], '').trim();
  }

  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return { due, cleaned };
}

function extractRecurrence(text) {
  const re = /\b(every\s*day|everyday|daily)\b/i;
  const m = text.match(re);
  if (m) {
    return { recurrence: { freq: 'daily' }, cleaned: text.replace(m[0], '').trim() };
  }
  return { recurrence: null, cleaned: text };
}

function splitTasks(text) {
  const parts = text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

function parseEntry(rawText, knownLocations = [], defaultTime = { hour: 9, minute: 0 }, now = new Date()) {
  let text = stripLeadPhrase(rawText.trim());

  const locResult = extractLocation(text, knownLocations);
  text = locResult.cleaned;

  const dtResult = extractDateTime(text, now, defaultTime);
  text = dtResult.cleaned;

  const recResult = extractRecurrence(text);
  text = recResult.cleaned;

  let due = dtResult.due;
  if (recResult.recurrence && !due) due = new Date(now);

  text = text.replace(/^to\s+/i, '').trim();

  const segments = splitTasks(text).map(s => s.replace(/^to\s+/i, '').trim()).filter(Boolean);

  return segments.map(title => ({
    title: capitalize(title),
    due,
    locationLabel: locResult.label,
    recurrence: recResult.recurrence,
  }));
}

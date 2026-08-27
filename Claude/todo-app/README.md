# To-Do — v1 scaffold

A local-first implementation of the task-manager spec (see the spec doc in
the branch/issue history). No build step: it's plain HTML/CSS/JS served
directly from this folder, so it deploys automatically wherever this repo
is published — no separate CI workflow needed.

## Design system

`css/styles.css` is built on a small token system (`:root`): a sage-green
accent, a dedicated muted-red `--record` token for the recording state
(kept separate from `--danger` even though they currently share a value,
since "live recording" and "destructive action" are different concerns), a
spacing scale (`--space-1`…`--space-6`), a two-tier radius scale plus a
pill constant, soft warm-tinted shadows, and shared transition timing
tokens. Headings and content titles (task titles, label/location names) use
a Georgia-led system serif stack for a warmer, more editorial feel;
buttons, inputs, and other UI chrome stay on the system sans stack — no
webfont is loaded, keeping the app's zero-extra-network-request,
offline-first posture intact. Cards (`task-row`/`list-row`/modal/toast) are
borderless with a soft shadow; functional controls (inputs, buttons, chips)
keep a hairline border. Every interactive element has a hover, `:active`
press-scale, and `:focus-visible` state.

## What's actually implemented

- **Record — the default landing screen.** A large press-and-hold circle
  (`#record-btn` in `index.html`, wired in `js/app.js`'s
  `setupRecordButton()`) is now the app's front door: hold it, speak, let
  go — the button turns a muted "on air" red with expanding ripple rings,
  a pulsing REC badge, and a soundwave glyph swapped in for the mic icon
  while held, then settles with a quick pulse back to idle once the task
  is captured (confirmed via the same toast every other capture path
  uses). It runs its own separate `SpeechRecognition` instance from the
  legacy small mic button described below, so neither affects the other.
  A de-emphasized "or type it" link reveals a plain text input for manual
  entry — present, but visually secondary, since recording is the primary
  flow now. Browsers without `SpeechRecognition` (e.g. iOS Safari) get the
  manual field auto-expanded instead of a dead-end disabled circle.

- **Tasks tab** shows every open task in one compact, single-line-first
  list — today's and overdue tasks are pinned to the top, everything else
  follows sorted by due date ascending (undated tasks last), rendered as
  "Today" / "Tomorrow" / "Sat, Aug 22"-style friendly dates rather than raw
  ISO strings (`friendlyDate()`/`friendlyTime()` in `js/app.js`). Priority
  tags show as small colored dots rather than full pill badges; the ✎ / →
  / ✕ row actions stay hidden until you hover a row (always visible on
  touch devices, where hover doesn't apply). A single **Filters** button
  above the list opens a small label-only filter panel (single-select) —
  there's no separate project filter anymore, since Projects were removed
  (see below). Tasks are added via a collapsed "+" trigger next to
  Filters, which expands the add-task bar inline and collapses it again
  after a successful add. Auto-rollover keeps overdue open tasks pinned at
  the top day after day, and completed tasks stay struck through until
  midnight, then archive (purged 30 days after completion) — all via
  `js/app.js` + IndexedDB (`js/db.js`).

- **Settings lives behind a gear icon** in the top-right of the header
  (`#settings-gear-btn`), not a tab — it's a separate concern from
  Record/Tasks, the app's two main views. **Labels** and **Locations**
  management (previously their own tabs) are now sub-sections inside
  Settings — Labels first, since it's the more frequently used of the
  two — along with notifications, export/import, and a new
  **default task time** field (see below).

- **Projects have been removed.** The app now organizes tasks with
  **labels only** — no project grouping, no "Personal" default, no
  project picker or filter. Existing tasks' old project association is
  simply no longer read (not migrated to a label). Custom priority tags
  remain, filterable via the single Filters button above.
- **Default task time** (Settings): a time picker sets what hour a task
  gets when NLP infers "tomorrow" or a weekday without an explicit time
  in the text (was hardcoded to 9:00am; stored in `localStorage`, threaded
  into `js/nlp.js`'s `extractDateTime()`/`parseEntry()` as a `defaultTime`
  parameter).
- **Push to tomorrow** (→) per task.
- **Recurring tasks** (daily / weekly / custom interval) — completing a
  recurring task spawns the next occurrence.
- **Free-text capture with lightweight NL parsing** (`js/nlp.js`): dates
  ("tomorrow", "Friday", "in 2 hours", "at 3pm"), location phrases ("when I
  get home", "when I get to the dentist" — see below), and **comma-based
  multi-task splitting** ("take out the trash, call mom" → two tasks).
  Splitting no longer triggers on the word "and" — testing showed "and"
  is used far more often to join two halves of the *same* task ("text
  Paulie and ask about ice cream", "combine the projects and labels into
  one page") than to separate two different ones, and there's no reliable
  regex-only way to tell those apart. Use a comma (or add tasks
  separately) to get multiple tasks from one capture.
- **Location phrases auto-create a real location.** Saying "when I get to
  work" (or any other not-yet-saved place — "the dentist", "the gym") now
  creates a real Location row immediately (coordinates left blank) and
  links the task to it, instead of leaving a dead-end text hint on the
  task. The new location shows up under Settings → Locations flagged
  "needs an address" — filling in an address there (via the existing
  search/map picker) is all that's needed for the reminder to start
  working; no need to re-edit the task. Saying the same place name again
  later reuses the same location rather than creating a duplicate.
- **Voice capture on the Tasks tab's quick-add bar** (the small mic icon
  next to the text field, click-to-toggle rather than press-and-hold) via
  the same `SpeechRecognition` API (Chrome on Android supports this) —
  transcript is fed through the same parser as text entry. Kept as a
  secondary path now that Record is the primary one.
- **Named locations** with lat/lng (150m fixed radius, matches spec) and a
  **foreground geofence check** (`js/geofence.js`) that fires a
  notification when you enter a saved location's radius while the app is
  open. Locations without coordinates yet (see auto-create above) are
  skipped by the geofence check rather than erroring.
- **Time-based notifications** for tasks with a due time, checked locally.
- **Offline support**: all data lives in IndexedDB; the service worker
  (`sw.js`) caches the app shell so the whole app loads with no network.
- **Daily/weekly digest tracking**: completed vs. pushed counts are still
  recorded per day (`digests` IndexedDB store, `bumpDigest()`), but there's
  no digest panel in the UI anymore — the data's kept for potential future
  surfacing.
- **Manual export/import** (Settings) as a JSON file — a practical
  stopgap for moving data between devices by hand.
- Installable PWA (`manifest.webmanifest`).
- **Editing a task**: click its title to rename it in place (an inline
  text input replaces the title, saved on blur/Enter, discarded on
  Escape); double-click the title to open the full edit sheet instead
  (tags, due date/time, location trigger, recurrence). There's no
  separate edit button anymore. Task titles wrap onto multiple lines
  rather than truncating with an ellipsis.
- **Manual drag-to-reorder** of open tasks (drag the ⠿ handle), backed by
  [SortableJS](https://github.com/SortableJS/Sortable) and a `sort_order`
  field on each task. Completed tasks stay pinned below and aren't
  reorderable. Since due-today/overdue tasks are always pinned above
  everything else, dragging only meaningfully reorders *within* that
  pinned group — dragging a not-yet-due task around doesn't change its
  position, since the due-date sort below the pinned group takes
  precedence over `sort_order` there.
- **Address search and map pin** for locations, via
  [Leaflet](https://leafletjs.com/) (map/pin UI) and
  [OpenStreetMap Nominatim](https://nominatim.org/) (free geocoding, no API
  key). Both load from CDN and are precached by the service worker for
  offline *use of the library code*, but actual searches and map tiles
  still need a live connection. Nominatim's usage policy caps this at
  light, interactive use (no bulk geocoding) — fine for a personal app,
  not something to scale up without switching to a paid provider.
- Logo in the header, pulled from `/images/logo.png` (the same file the
  main site uses) rather than duplicated into this folder — given a black
  badge background since the artwork is white-on-transparent (designed for
  the main site's black page background).
- **Undo after deleting a task**: deleting shows a toast with an "Undo"
  button for ~5.5s before the task is actually removed from IndexedDB —
  undo just cancels the pending removal. Best-effort only: if the page
  closes/reloads before the window elapses, the task survives (the delete
  never committed).
- **"Labels"**: priority tags are a real entity (`labels` IndexedDB store,
  `{id, name, color}`) managed under Settings — rename (cascades across
  every task using that tag) and delete (removes it from every task), each
  with a color from a fixed muted palette. Tasks still store tag *names*
  as plain strings (no data migration for existing tasks); typing a
  brand-new tag name anywhere auto-creates its label entry. Task rows show
  a small colored dot per label, colored from the matching label entry.
- **New tasks inherit the current Tasks-view filter**: the add-bar's tag
  field defaults to whatever label the Tasks view is currently filtered
  to (blank when the filter is "All labels"), while still being manually
  overridable per task.

## What's intentionally NOT implemented (needs real backend infra)

The spec calls for a cloud backend (Supabase/Firebase), Google OAuth, and
real cross-device sync. None of that can be wired up without live project
credentials, so this version stores everything **locally on-device only** —
there is no account and no sync between your phone and computer yet.
Nothing here blocks adding it later; the storage layer (`js/db.js`) is
intentionally isolated so it could be swapped for a Supabase-backed
implementation behind the same `DB.getAll/get/put/remove` interface.

Also out of scope for the same reason (needs a server):

- **True background push notifications.** `Notification`/`showNotification`
  here only fire while the app (tab or installed PWA) is open or recently
  active — there's no push server sending Web Push messages, so nothing
  wakes the app when it's fully closed. Real background delivery needs a
  backend with VAPID keys and a push subscription per device.
- **Background geofencing.** The location check in `js/geofence.js` uses
  `watchPosition`, which only runs while the page is open. Real
  arrive-and-notify-even-when-closed behavior needs either a native
  wrapper or server-side geofence evaluation triggered by periodic
  background sync — both require backend work.
- **AI-based NL/voice extraction.** The parser in `js/nlp.js` is a
  regex/heuristic approximation of the spec's "voice → AI model → structured
  task" pipeline, good enough to demo the UX but not as robust as an actual
  LLM call. It's structured so a `parseEntry()` call could be replaced with
  a fetch to a real parsing endpoint later.
- **Google OAuth / accounts.**

## Known limitation: reordering under an active filter

Drag-to-reorder renumbers `sort_order` only for the tasks currently visible
(after the label filter). If you reorder while a filter is active, the new
order is relative to that filtered set — clearing the filter afterward can
interleave those tasks with others in a way that isn't perfectly
predictable. Reordering with no filter active avoids this entirely.
Separately, `sort_order` itself only determines order within the pinned
today/overdue group at the top of the list — tasks below that are always
ordered by due date, so dragging one of them has no visible effect after
the next render.

## Running locally

No build step. Serve the folder over HTTP (service workers and geolocation
need a real origin, not `file://`), e.g.:

```
npx serve Claude/todo-app
```

Then open the printed local URL.

# To-Do — v1 scaffold

A local-first implementation of the task-manager spec (see the spec doc in
the branch/issue history). No build step: it's plain HTML/CSS/JS served
directly from this folder, so it deploys automatically wherever this repo
is published — no separate CI workflow needed.

## What's actually implemented

- **Today view** with auto-rollover of overdue open tasks, and completed
  tasks struck through until midnight, then archived (purged 30 days after
  completion) — all via `js/app.js` + IndexedDB (`js/db.js`).
- **Projects** ("Personal" as default) and **custom priority tags**,
  filterable.
- **Push to tomorrow** (→) per task.
- **Recurring tasks** (daily / weekly / custom interval) — completing a
  recurring task spawns the next occurrence.
- **Free-text capture with lightweight NL parsing** (`js/nlp.js`): dates
  ("tomorrow", "Friday", "in 2 hours", "at 3pm"), location phrases ("when I
  get home"), and multi-task splitting ("...take out the trash and call
  mom").
- **Voice capture** via the browser's built-in `SpeechRecognition` API
  (Chrome on Android supports this) — transcript is fed through the same
  parser as text entry.
- **Named locations** with lat/lng (150m fixed radius, matches spec) and a
  **foreground geofence check** (`js/geofence.js`) that fires a
  notification when you enter a saved location's radius while the app is
  open.
- **Time-based notifications** for tasks with a due time, checked locally.
- **Offline support**: all data lives in IndexedDB; the service worker
  (`sw.js`) caches the app shell so the whole app loads with no network.
- **Daily/weekly digest**: completed vs. pushed counts, computed from local
  history.
- **Manual export/import** (Settings tab) as a JSON file — a practical
  stopgap for moving data between devices by hand.
- Installable PWA (`manifest.webmanifest`).
- **Edit any task** after adding it (title, project, tags, due date/time,
  location trigger, recurrence) via the ✎ button, which opens an edit
  sheet.
- **Manual drag-to-reorder** of open tasks (drag the ⠿ handle), backed by
  [SortableJS](https://github.com/SortableJS/Sortable) and a `sort_order`
  field on each task. Completed tasks stay pinned below and aren't
  reorderable.
- **Today vs. All tasks scope toggle** — Today only shows tasks due today
  or overdue (undated, location-only tasks are intentionally excluded);
  "All tasks" shows every open task regardless of due date, which is where
  those location-only tasks live until they're given a date.
- **Address search and map pin** for locations, via
  [Leaflet](https://leafletjs.com/) (map/pin UI) and
  [OpenStreetMap Nominatim](https://nominatim.org/) (free geocoding, no API
  key). Both load from CDN and are precached by the service worker for
  offline *use of the library code*, but actual searches and map tiles
  still need a live connection. Nominatim's usage policy caps this at
  light, interactive use (no bulk geocoding) — fine for a personal app,
  not something to scale up without switching to a paid provider.
- **Muted color palette** for projects — a fixed set of dusty/muted swatches
  instead of an open color picker, and the app's accent color was toned
  down to match.
- Logo in the header, pulled from `/images/logo.png` (the same file the
  main site uses) rather than duplicated into this folder — given a black
  badge background since the artwork is white-on-transparent (designed for
  the main site's black page background).
- **Undo after deleting a task**: deleting shows a toast with an "Undo"
  button for ~5.5s before the task is actually removed from IndexedDB —
  undo just cancels the pending removal. Best-effort only: if the page
  closes/reloads before the window elapses, the task survives (the delete
  never committed).
- **Edit a project's name/color** after creation, via the same ✎ pattern as
  tasks.
- **"Labels"**: priority tags are now a real entity (new `labels` IndexedDB
  store, `{id, name, color}`) with their own tab — rename (cascades across
  every task using that tag) and delete (removes it from every task), each
  with a color from the same muted palette as projects. Tasks still store
  tag *names* as plain strings (no data migration for existing tasks);
  typing a brand-new tag name anywhere auto-creates its label entry.
  Task-row and project-card tag badges are colored from the matching label.
- **Project cards show their tags** as colored pill bubbles (the distinct
  priority tags across that project's tasks), same badge component used on
  task rows.
- **NLP recognizes recurrence and project names**: "take vitamins every
  day"/"...daily" creates a daily-recurring task (defaulting its due date
  to today if no other date was given, since recurrence needs a base date
  to regenerate from); "...for Hudson Ave" auto-assigns the task to an
  *existing* project named "Hudson Ave" — it never creates a new project
  from text.
- **New tasks inherit the current Today-view filter**: the add-bar's
  project/tag pickers now default to whatever project/tag the Today view
  is currently filtered to (falling back to Personal/no-tag when the
  filter is "All"), while still being manually overridable per task.
  Precedence when a task is captured via NLP text: an explicit manual pick
  in the add-bar picker wins, then an NLP-detected project match from the
  text, then the filter-synced default.

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
(after project/tag filtering). If you reorder while a filter is active, the
new order is relative to that filtered set — clearing the filter afterward
can interleave those tasks with others in a way that isn't perfectly
predictable. Reordering with no filter active avoids this entirely.

## Running locally

No build step. Serve the folder over HTTP (service workers and geolocation
need a real origin, not `file://`), e.g.:

```
npx serve Claude/todo-app
```

Then open the printed local URL.

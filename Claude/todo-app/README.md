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
  main site uses) rather than duplicated into this folder.

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

# To-Do — v1 scaffold

A local-first implementation of the task-manager spec (see the spec doc in
the branch/issue history). No build step: it's plain HTML/CSS/JS served
directly from this folder, so it deploys automatically wherever this repo
is published — no separate CI workflow needed.

## Architecture

Plain global-scope scripts, no bundler, loaded in dependency order from
`index.html`. Each file owns one thing:

| File | Responsibility |
| --- | --- |
| `js/db.js` | IndexedDB wrapper. Generic over stores, one transaction per call. Knows nothing about tasks. |
| `js/sync-config.js` / `js/sync.js` | Optional Supabase sync. Wraps `DB.put`/`DB.putMany`/`DB.remove`; fully inert when unconfigured. |
| `js/push-config.js` / `js/push.js` | Optional Web Push registration. Fully inert with no VAPID key configured; requires sync + sign-in. |
| `js/util.js` | Pure helpers: local-time dates, friendly formatting, DOM construction. |
| `js/nlp.js` | Free-text/voice parser. Pure functions, no DOM, no state. |
| `js/store.js` | **The only owner of state and the only writer to `DB`.** Every mutation reports which collections it touched. |
| `js/geofence.js` | Position watcher; calls back on arrival. |
| `js/map.js` | Leaflet picker + address geocoding/reverse-geocoding. |
| `js/ui-shell.js` | Toasts, tabs, modal plumbing, the `UI.guard()` error wrapper. |
| `js/ui-tasks.js`, `js/ui-settings.js`, `js/ui-record.js` | One screen each. Subscribe to the store; never write to `DB` directly. |
| `supabase/functions/send-reminders/` | The server side of Web Push: a scheduled Edge Function, not part of the client bundle. |
| `js/app.js` | Bootstrap and background jobs only (~100 lines). |

Two rules hold the whole thing together:

1. **UI never writes to the database.** It calls `Store.*`, which persists and
   then emits the names of the collections that changed. A screen redraws only
   the sections whose data actually moved, instead of everything redrawing on
   every keystroke-sized change.
2. **All user text goes through `textContent`** (`el()` in `js/util.js`), so a
   task title or label name can never be interpreted as markup.

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
  (`#record-btn` in `index.html`, wired in `js/ui-record.js`) is now the app's front door: hold it, speak, let
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

- **Tasks tab** shows every open task in one compact list — today's and
  overdue tasks are pinned to the top, everything else follows sorted by
  due date ascending (undated tasks last), rendered as "Today" / "Tomorrow"
  / "Thurs 8/27/2026"-style friendly dates rather than raw ISO strings
  (`friendlyDate()`/`friendlyTime()` in `js/util.js`; the weekday uses a
  custom abbreviation list, `WEEKDAY_ABBR`, since `Thurs` isn't one of the
  standard `Intl` 3-letter forms). Titles wrap onto multiple lines rather
  than truncating. Priority tags show as small colored dots rather than
  full pill badges; the → / ✕ row actions stay hidden until you hover a
  row (always visible on touch devices, where hover doesn't apply). A
  single **Filters** button
  above the list opens a small label-only filter panel (single-select) —
  there's no separate project filter anymore, since Projects were removed
  (see below). Tasks are added via a collapsed "+" trigger next to
  Filters, which expands the add-task bar inline and collapses it again
  after a successful add. Auto-rollover keeps overdue open tasks pinned at
  the top day after day, and completed tasks stay struck through until
  midnight, then archive (purged 30 days after completion) — all via
  `js/store.js` + IndexedDB (`js/db.js`).

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
  creates a real Location row immediately (address left blank) and
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
- **Named locations, identified by street address** (150m fixed radius,
  matches spec) and a **foreground geofence check** (`js/geofence.js`) that
  fires a notification when you enter a saved location's radius while the
  app is open. See "Locations are addresses" below. Locations with no
  address yet (see auto-create above) are skipped by the geofence check
  rather than erroring.
- **Sub-tasks / checklists.** Any task can hold a short list of steps: an
  overflow-menu action ("Add a step") on the row expands a checklist panel
  in place, and once one exists a small `2/5`-style progress chip appears
  next to the title — click it to expand or collapse. Steps have their own
  checkbox and delete action; typing one and hitting Enter re-focuses the
  input so a whole list can be typed straight through. One level deep only
  (a step can't have its own steps), and children are excluded from the
  main list's filters/sort — they only ever render inside their parent's
  row, including while it's being dragged. Completing the parent completes
  any steps still open (the reverse is deliberately not automatic — you
  can watch a checklist fill up without the parent auto-closing); deleting
  the parent deletes its steps; a recurring parent's next occurrence gets
  a fresh copy of the same steps, all unticked (`js/store.js`'s
  `subtasks()`/`addSubtask()`/`subtaskProgress()`, `parent_id` on `tasks`).
- **Time-based notifications** for tasks with a due time, checked locally
  while the app is open, and via Web Push when it's closed — see below.
- **Offline support**: all data lives in IndexedDB; the service worker
  (`sw.js`) caches the app shell so the whole app loads with no network.
- **Daily/weekly digest tracking**: completed vs. pushed counts are still
  recorded per day (`digests` IndexedDB store, `bumpDigest()`), but there's
  no digest panel in the UI anymore — the data's kept for potential future
  surfacing.
- **Manual export/import** (Settings) as a JSON file — a practical
  stopgap for moving data between devices by hand.
- **Rotating empty-state message**: when the open-task list is truly empty
  (not just fully filtered/completed, which still says "All caught up for
  now."), the placeholder text is picked from a small array
  (`EMPTY_STATE_MESSAGES` in `js/app.js`), chosen deterministically by
  day-of-epoch so it stays stable within a day rather than changing on
  every re-render.
- Installable PWA (`manifest.webmanifest`).
- **Editing a task**: click its title to rename it in place (an inline
  text input replaces the title, saved on blur/Enter, discarded on
  Escape); double-click the title to open the full edit sheet instead.
  There's no separate edit button anymore (a short click/double-click
  debounce keeps a real double-click from triggering inline-edit first).
  The edit sheet itself: Title and Due date (with Today/Tomorrow/Next
  week/No date quick-pick chips) show by default; a "More options"
  disclosure reveals Priority, Location trigger, and Repeat — it
  auto-expands on open if the task already has any of those set, so
  nothing already-configured is hidden without a hint. **Priority** is a
  multi-select dropdown (`#edit-tags-trigger`/`#edit-tags-panel` in
  `js/app.js`) listing your existing labels as checkboxes with their real
  colors — it only lets you pick from labels that already exist; typing a
  brand-new label name still works from the Tasks tab's quick-add bar
  (`#task-tags`), unchanged. **Repeat** is a segmented control instead of
  a dropdown.
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
  [OpenStreetMap Nominatim](https://nominatim.org/) (free geocoding *and*
  reverse-geocoding, no API key). Both load from CDN and are precached by
  the service worker for offline *use of the library code*, but actual
  searches and map tiles still need a live connection. Nominatim's usage
  policy caps this at light, interactive use (no bulk geocoding) — fine for
  a personal app, not something to scale up without switching to a paid
  provider; `js/map.js` throttles requests to stay inside it.
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

## Cross-device sync (Supabase + Google sign-in)

The app is local-first by default (IndexedDB only, no account) — that
keeps working exactly as before if you never touch this. Optionally, you
can turn on real cross-device sync: sign in with Google, and your tasks,
labels, and locations sync to a free Supabase project and back down to
every other device you sign into.

**How it's built:** `js/sync.js` is a self-contained layer that wraps
`DB.put`/`DB.remove` (defined in `js/db.js`, which is never itself
modified) to push local writes to Supabase, pulls and merges remote
changes on sign-in, and subscribes to Supabase Realtime so changes from
other devices show up without a manual refresh. It is **completely inert**
until you configure it — `js/sync-config.js` ships with blank
`url`/`anonKey` placeholders, and every sync function checks
`isConfigured()` first and no-ops if it's not set. Conflicts (the same
record edited on two devices) are resolved last-write-wins by an
`updated_at` timestamp; deletes use a soft-delete tombstone
(`deleted_at`) rather than a hard remove, so an offline device can't
accidentally resurrect something another device already deleted once it
reconnects. A local delete that fails to reach Supabase (offline, or a
transient error) queues in `localStorage` and retries automatically on
the next sync or when the browser comes back online.

**Setting it up** (all of this is one-time, done by you in a couple of
dashboards — none of it can be automated from here):

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run everything in
   [`supabase-schema.sql`](./supabase-schema.sql) (in this folder) —
   creates the five tables (`tasks`, `locations`, `labels`, `digests`,
   `push_subscriptions`) with Row Level Security so each signed-in user
   only ever sees their own rows.
3. Note the OAuth callback URL shown on Authentication → Providers:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
4. In the [Google Cloud Console](https://console.cloud.google.com/):
   create or pick a project → APIs & Services → OAuth consent screen
   (External; add yourself as a test user if it's left in "Testing") →
   Credentials → Create Credentials → OAuth client ID → Web application →
   Authorized redirect URIs = the URL from step 3. Copy the Client ID and
   Client Secret it gives you.
5. Back in Supabase → Authentication → Providers → Google: enable it,
   paste the Client ID/Secret, Save.
6. Supabase → Authentication → URL Configuration → Redirect URLs: add the
   deployed app's URL (e.g. `https://rachelmannella.com/Claude/todo-app/`).
7. Supabase → Project Settings → API: copy the **Project URL** and the
   **anon public** key (never the `service_role` key — that one must
   never appear in client-side code).
8. Paste those two values into `js/sync-config.js`'s `url`/`anonKey`
   fields and deploy (commit + push, same as any other change here).
9. In this GitHub repo → Settings → Secrets and variables → Actions: add
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` repo secrets with the same two
   values — these feed the keep-alive workflow below. (Not sensitive:
   the anon key is already public in the deployed `sync-config.js` — RLS
   is what actually protects your data, not the key's secrecy.)
10. Open the app → Settings → "Sign in with Google" → complete the
    consent screen → confirm you land back signed in.
11. Repeat sign-in with the same Google account on a second device;
    confirm your existing tasks appear there, and that new edits show up
    on both sides.

**Free-tier auto-pause**: Supabase pauses free projects after about a
week with no activity. `.github/workflows/keep-supabase-awake.yml` pings
the project's REST API every 3 days (via `workflow_dispatch`-triggerable
GitHub Actions cron) to keep that from happening — it's a no-op until you
add the two repo secrets in step 9 above. Once reminders (below) are set
up, the once-a-minute cron job pinging the Edge Function keeps the
project awake on its own and this workflow becomes redundant, though
there's no harm leaving it enabled.

## Reminders that arrive when the app is closed

Everything else in this app only runs while a tab or the installed PWA is
open — the in-page reminder loop, the geofence check, all of it. This is
the one piece that works when the app is fully closed: a scheduled
Supabase job checks for due tasks once a minute and sends a real
[Web Push](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
notification to every device you've enabled it on, the same way a native
app would.

**Requires cross-device sync to already be set up** (above) — a push
subscription is stored per Google account, not per device in isolation,
so there has to be an account to store it against.

**How it's built:**
- `js/push.js` registers the browser's `PushManager` and hands the
  subscription to `Sync.savePushSubscription()`, which stores it in the
  `push_subscriptions` table via RLS (so nobody but that user can read or
  write their own subscription rows).
- Every task write goes through `Store.newTask()`/`Store.updateTask()`
  in `js/store.js`, which resolve `due_date`+`due_time` (local wall-clock
  strings — the only way to know what "3pm" means is in the timezone
  that wrote it) into an absolute `due_at` timestamp column. That's what
  a server-side job can actually query against.
- [`supabase/functions/send-reminders/index.ts`](./supabase/functions/send-reminders/index.ts)
  is a Supabase Edge Function: it selects open tasks with `due_at` in the
  past and `push_sent_at` still null, sends each a Web Push message
  (VAPID-signed, via the `web-push` npm package running under Deno) to
  every subscription on that account, marks `push_sent_at` once at least
  one device received it, and prunes subscriptions the push service
  reports as gone (410/404 — the browser threw them away). A task more
  than 6 hours overdue is marked sent without pushing, rather than
  surprising you with a stale reminder hours later.
- A `pg_cron` job (`send-task-reminders`) calls that function once a
  minute via `pg_net`; the shared secret it authenticates with is read
  from Supabase Vault at call time so it never appears in plaintext in
  `cron.job` or migration history.
- `sw.js`'s `push` event handler shows the notification (works even if
  no tab is open); its `pushsubscriptionchange` handler re-subscribes
  automatically if the push service ever rotates the endpoint, and hands
  the new one to any open tab to re-save.

**Setting it up** (one-time, after cross-device sync above is working):

1. Generate a VAPID keypair — run this once, anywhere with Node:
   ```
   npx web-push generate-vapid-keys
   ```
2. Paste the **public** key into `js/push-config.js`'s `vapidPublicKey`
   (safe to commit — it's how a browser verifies a push actually came
   from this app) and deploy (commit + push).
3. In Supabase → Edge Functions → `send-reminders` → Secrets, add:
   - `VAPID_PUBLIC_KEY` — the same public key from step 1
   - `VAPID_PRIVATE_KEY` — the **private** key from step 1 (never commit
     this anywhere — it's what lets the server sign as this app)
   - `VAPID_CONTACT` — `mailto:you@example.com`, the contact a push
     service can reach you at if it needs to (required by the Web Push
     spec)
   - `REMINDER_SECRET` — any long random string you generate yourself;
     this is what stops a stranger from hitting the function URL and
     spamming every user's devices
4. Store that same `REMINDER_SECRET` value in Supabase Vault (SQL
   Editor), so the cron job can read it without it ever appearing in
   plaintext:
   ```sql
   select vault.create_secret('<the same random string from step 3>', 'reminder_secret');
   ```
5. Enable the scheduler extensions and create the cron job — run once in
   the SQL Editor (also included, commented, at the bottom of
   `supabase-schema.sql`):
   ```sql
   create extension if not exists pg_cron with schema pg_catalog;
   create extension if not exists pg_net with schema extensions;

   select cron.schedule(
     'send-task-reminders',
     '* * * * *',
     $$
     select net.http_post(
       url := '<your project URL>/functions/v1/send-reminders',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-reminder-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_secret')
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```
6. Deploy the function itself from this folder with the Supabase CLI:
   ```
   supabase functions deploy send-reminders --project-ref <project-ref> --no-verify-jwt
   ```
   (`--no-verify-jwt` because this endpoint authenticates via the shared
   secret above, not a user's session — there is no user in the loop,
   the caller is a cron job.)
7. Open the app → Settings → sign in with Google if you haven't, then
   "Send reminders to this device" → accept the browser's notification
   permission prompt.
8. Add a task due a minute or two from now and leave the tab closed —
   the notification should arrive without the app open.

If the button in Settings stays disabled with "Sign in with Google
first," that's step 7's actual order, not a bug — a subscription needs
an account to attach to. If notifications never arrive, the most likely
cause is step 3 or 4 being incomplete: the cron job runs every minute
regardless, but silently gets a 401 from the function until the secret
matches on both sides.

## What's intentionally NOT implemented (needs infra beyond this app)

- **Background geofencing.** The location check in `js/geofence.js` uses
  `watchPosition`, which only runs while the page is open. Real
  arrive-and-notify-even-when-closed behavior needs either a native
  wrapper or server-side geofence evaluation triggered by periodic
  background sync — both require more backend work than a Postgres table.
- **AI-based NL/voice extraction.** The parser in `js/nlp.js` is a
  regex/heuristic approximation of the spec's "voice → AI model → structured
  task" pipeline, good enough to demo the UX but not as robust as an actual
  LLM call. It's structured so a `parseEntry()` call could be replaced with
  a fetch to a real parsing endpoint later.

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

## Locations are addresses

A location is a **name plus a street address** — "Home", "350 5th Ave, New
York, NY". Coordinates still exist in the record because the geofence needs
something to measure against, but they are never shown or typed: they are
resolved from the address you search, or reverse-geocoded from a pin you drop
on the map. Geocoding uses OpenStreetMap's Nominatim, throttled to its
one-request-per-second policy in `js/map.js`.

The map is themed to the app rather than dropped in raw: CARTO's light
basemap, warmed and desaturated into the ivory/sage palette by a CSS filter
on the tile pane, with the marker and the 150m geofence ring drawn from the
live `--accent` design token (read at runtime in `js/map.js`, so they can't
drift out of step with the stylesheet). The ring is also functional — it
shows the actual radius that will trigger the reminder.

Saying "remind me when I get to the dentist" still auto-creates a location
named *Dentist* with no address. It shows in Settings → Locations flagged
**"No address yet"**; tapping it loads it back into the form so you can
search an address and save it in place. Until then it simply never triggers.

## Feature recommendations

Three things this app is now well-shaped to add, roughly in order of
value-for-effort:

1. **Snooze / defer presets on the row.** The `→` action only ever pushes to
   tomorrow. A long-press (or a small menu) offering "this evening / this
   weekend / next week" would cover most of what the edit card gets opened
   for. `Store.pushToTomorrow()` is already a one-line wrapper over
   `updateTask({ due_date })`, so this is UI work, not data work.
2. **A weekly review screen.** The `digests` store already records completed
   and pushed counts per day and nothing reads it. A simple week view —
   what got done, what keeps getting pushed — would surface the tasks that
   are silently rotting at the bottom of the list. Repeatedly-deferred tasks
   are the single most useful signal a to-do app can give you.
3. **Location-triggered push, not just time-triggered.** `send-reminders`
   only ever looks at `due_at`; arriving somewhere still depends on
   `js/geofence.js`'s foreground `watchPosition` check, which stops the
   moment the tab closes. A companion Edge Function on a tighter schedule
   (or the [Geolocation background sync patterns Chrome supports on
   Android](https://developer.chrome.com/docs/capabilities/geolocation))
   reading each account's last known position against `locations.lat/lng`
   would close the other half of the reminder story the same way
   `send-reminders` just closed the time half.

Two smaller ones worth noting: **task search** (trivial now that filtering
lives behind one `Store` predicate), and **a "snoozed reminder already
sent" indicator** on the row — `push_sent_at` is tracked but nothing in
the UI currently shows it, so there's no way to tell from the list alone
whether a device already buzzed for a task.

## Running locally

No build step. Serve the folder over HTTP (service workers and geolocation
need a real origin, not `file://`), e.g.:

```
npx serve Claude/todo-app
```

Then open the printed local URL.

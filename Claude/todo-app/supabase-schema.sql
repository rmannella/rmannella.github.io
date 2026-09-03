-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query) after creating your project. See README.md's "Cross-device sync"
-- section for the full setup walkthrough this fits into.
--
-- Primary keys reuse the app's own string ids (from js/db.js's uid())
-- rather than switching to Postgres-generated UUIDs, so there's no local/
-- remote id-mapping to maintain. Every table carries user_id (so RLS can
-- scope rows per signed-in user), updated_at (for last-write-wins merge),
-- and deleted_at (a soft-delete tombstone -- closes the edge case where an
-- offline device could resurrect a row another device legitimately
-- deleted).

create table public.tasks (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  description text,
  -- A sub-task's parent. Not a foreign key: the parent lives in the same
  -- table under the same composite key, and enforcing that in SQL buys
  -- nothing the app doesn't already guarantee (the client always creates a
  -- child through an existing parent's id).
  parent_id text,
  priority_tags text[] default '{}',
  due_date text,
  due_time text,
  -- The absolute instant due_date/due_time resolve to, in the client's own
  -- timezone. due_date/due_time are wall-clock strings with no timezone, so
  -- only the device that wrote them knows what "3pm" means in UTC -- a
  -- server-side reminder job reads this column instead of re-deriving it.
  due_at timestamptz,
  location_trigger_id text,
  status text,
  completed_at timestamptz,
  recurrence_rule jsonb,
  notified_at timestamptz,
  -- Set by the send-reminders Edge Function once a push has actually been
  -- delivered for this due date, so the same task is never pushed twice.
  push_sent_at timestamptz,
  sort_order double precision,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  primary key (id, user_id)
);

create index if not exists tasks_due_at_idx
  on public.tasks (due_at)
  where due_at is not null and push_sent_at is null;

create index if not exists tasks_parent_id_idx on public.tasks (parent_id);

create table public.locations (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  address text,
  lat double precision,
  lng double precision,
  updated_at timestamptz,
  deleted_at timestamptz,
  primary key (id, user_id)
);

create table public.labels (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  color text,
  updated_at timestamptz,
  deleted_at timestamptz,
  primary key (id, user_id)
);

create table public.digests (
  date text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  completed integer default 0,
  pushed integer default 0,
  updated_at timestamptz,
  deleted_at timestamptz,
  primary key (date, user_id)
);

-- One row per browser/device that has enabled push reminders.
create table public.push_subscriptions (
  endpoint text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now(),
  last_used_at timestamptz,
  failure_count integer default 0,
  primary key (endpoint, user_id)
);

alter table public.tasks enable row level security;
alter table public.locations enable row level security;
alter table public.labels enable row level security;
alter table public.digests enable row level security;
alter table public.push_subscriptions enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tasks', 'locations', 'labels', 'digests', 'push_subscriptions'] loop
    execute format('create policy "%s_select_own" on public.%I for select using (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_insert_own" on public.%I for insert with check (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_update_own" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_delete_own" on public.%I for delete using (auth.uid() = user_id)', t, t);
    execute format('create index %I on public.%I(user_id)', t || '_user_id_idx', t);
  end loop;
end $$;

-- Applied separately for projects created before locations stored addresses:
--   alter table public.locations add column if not exists address text;

-- Applied separately for projects created before subtasks, due_at, and Web
-- Push existed. All of the above (tables, columns, indexes, policies) is
-- safe to re-run: every statement is create-if-not-exists / do-block-guarded.
--
-- Also required, run once in the SQL Editor to enable the reminder schedule
-- (see README's "Reminders that arrive when the app is closed" section for
-- the full walkthrough, including where REMINDER_SECRET and the VAPID keys
-- come from):
--
--   create extension if not exists pg_cron with schema pg_catalog;
--   create extension if not exists pg_net with schema extensions;
--
--   select vault.create_secret('<a random secret string>', 'reminder_secret');
--
--   select cron.schedule(
--     'send-task-reminders',
--     '* * * * *',
--     $$
--     select net.http_post(
--       url := '<your project URL>/functions/v1/send-reminders',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'x-reminder-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_secret')
--       ),
--       body := '{}'::jsonb
--     );
--     $$
--   );

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
  priority_tags text[] default '{}',
  due_date text,
  due_time text,
  location_trigger_id text,
  status text,
  completed_at timestamptz,
  recurrence_rule jsonb,
  notified_at timestamptz,
  sort_order double precision,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  primary key (id, user_id)
);

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

alter table public.tasks enable row level security;
alter table public.locations enable row level security;
alter table public.labels enable row level security;
alter table public.digests enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tasks', 'locations', 'labels', 'digests'] loop
    execute format('create policy "%s_select_own" on public.%I for select using (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_insert_own" on public.%I for insert with check (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_update_own" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
    execute format('create policy "%s_delete_own" on public.%I for delete using (auth.uid() = user_id)', t, t);
    execute format('create index %I on public.%I(user_id)', t || '_user_id_idx', t);
  end loop;
end $$;

-- Applied separately for projects created before locations stored addresses:
--   alter table public.locations add column if not exists address text;

// Sends Web Push reminders for tasks that have come due.
//
// The app's in-page reminder loop only fires while the app is open, which is
// exactly when you least need reminding. This runs on a schedule in Supabase
// and pushes to every device the account has registered, open or not.
//
// Invoked by pg_cron (see the README) with a shared secret rather than a user
// JWT, since there is no user in the loop -- deploy with verify_jwt = false.
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   VAPID_PUBLIC_KEY   matching js/push-config.js
//   VAPID_PRIVATE_KEY  never committed anywhere
//   VAPID_CONTACT      e.g. mailto:you@example.com
//   REMINDER_SECRET    shared with the cron job
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const BATCH_LIMIT = 200;
// How late a task can be and still be worth pushing. Beyond this the reminder
// is noise -- it gets marked sent so it never fires, rather than surprising
// you with a 3am buzz for something from last Tuesday.
const MAX_LATENESS_MS = 6 * 60 * 60 * 1000;

// Gone / Not Found means the browser threw the subscription away.
const DEAD_SUBSCRIPTION_CODES = new Set([404, 410]);

function env(name: string, required = true): string {
  const value = Deno.env.get(name) ?? '';
  if (required && !value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Task {
  id: string;
  user_id: string;
  title: string | null;
  due_at: string;
}

interface Subscription {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  failure_count: number | null;
}

Deno.serve(async req => {
  // Constant-ish comparison is overkill here, but an unauthenticated endpoint
  // that sends notifications to real phones deserves the check.
  const provided = req.headers.get('x-reminder-secret') ?? '';
  const expected = env('REMINDER_SECRET');
  if (provided.length !== expected.length || provided !== expected) {
    return json({ error: 'Unauthorized' }, 401);
  }

  webpush.setVapidDetails(env('VAPID_CONTACT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

  // Service role: this runs with no user session and must read across accounts.
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  const now = new Date();
  const { data: dueTasks, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, due_at')
    .eq('status', 'open')
    .is('push_sent_at', null)
    .is('deleted_at', null)
    .not('due_at', 'is', null)
    .lte('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (taskError) return json({ error: taskError.message }, 500);
  if (!dueTasks?.length) return json({ sent: 0, tasks: 0 });

  const tasks = dueTasks as Task[];

  // Anything long overdue is retired without a push rather than fired late.
  const stale = tasks.filter(t => now.getTime() - new Date(t.due_at).getTime() > MAX_LATENESS_MS);
  const fresh = tasks.filter(t => !stale.includes(t));

  const userIds = [...new Set(fresh.map(t => t.user_id))];
  const { data: subsData, error: subError } = await supabase
    .from('push_subscriptions')
    .select('endpoint, user_id, p256dh, auth, failure_count')
    .in('user_id', userIds.length ? userIds : ['00000000-0000-0000-0000-000000000000']);

  if (subError) return json({ error: subError.message }, 500);

  const subsByUser = new Map<string, Subscription[]>();
  for (const sub of (subsData ?? []) as Subscription[]) {
    const list = subsByUser.get(sub.user_id) ?? [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  let sent = 0;
  const deadEndpoints: Subscription[] = [];
  const delivered = new Set<string>();

  for (const task of fresh) {
    const subs = subsByUser.get(task.user_id) ?? [];
    if (!subs.length) continue;

    const payload = JSON.stringify({
      title: 'Task due',
      body: task.title ?? 'You have a task due.',
      taskId: task.id,
      url: `/Claude/todo-app/?task=${task.id}`,
    });

    const outcomes = await Promise.allSettled(
      subs.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 * 60 }
        )
      )
    );

    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        sent += 1;
        delivered.add(task.id);
        return;
      }
      const status = (outcome.reason as { statusCode?: number })?.statusCode;
      if (status && DEAD_SUBSCRIPTION_CODES.has(status)) deadEndpoints.push(subs[i]);
      console.error('push failed', subs[i].endpoint.slice(-12), status, String(outcome.reason));
    });
  }

  // Mark a task sent only if it actually reached a device; a transient push
  // failure should be retried on the next run, not silently swallowed.
  const toMark = [...delivered, ...stale.map(t => t.id)];
  if (toMark.length) {
    const stamp = now.toISOString();
    for (const id of toMark) {
      await supabase.from('tasks').update({ push_sent_at: stamp }).eq('id', id);
    }
  }

  // Endpoints the push service says are gone will never work again.
  for (const sub of deadEndpoints) {
    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', sub.endpoint)
      .eq('user_id', sub.user_id);
  }

  return json({
    tasks: tasks.length,
    pushed: delivered.size,
    deliveries: sent,
    retiredStale: stale.length,
    prunedSubscriptions: deadEndpoints.length,
  });
});

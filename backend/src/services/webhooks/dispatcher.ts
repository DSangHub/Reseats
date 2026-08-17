import { config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { db, many, one } from '../../db/index.js';
import { signWebhook } from '../../lib/crypto.js';

/**
 * Outbound webhooks to merchants.
 *
 * Events are written in the same transaction as the state change (a simple
 * transactional outbox), then fanned out to every active endpoint that
 * subscribes to the type. Delivery is at-least-once with exponential backoff;
 * merchants must key off `event.id` to dedupe.
 */

export type WebhookEventType =
  | 'receipt.created'
  | 'receipt.updated'
  | 'receipt.matched'
  | 'receipt.refunded'
  | 'receipt.voided'
  | 'receipt.claimed'
  | 'customer.enrolled';

export interface EmitOptions {
  merchantId: string | null;
  type: WebhookEventType;
  data: Record<string, unknown>;
}

/** Writes the event and its per-endpoint delivery rows. Call inside your transaction. */
export async function emitEvent(d: Db, opts: EmitOptions): Promise<string | null> {
  const event = await one<{ id: string }>(
    d,
    `insert into webhook_events (merchant_id, type, payload)
     values ($1, $2, $3::jsonb)
     returning id`,
    [opts.merchantId, opts.type, JSON.stringify(opts.data)],
  );
  if (!event) return null;

  if (opts.merchantId) {
    await d.query(
      `insert into webhook_deliveries (event_id, webhook_id)
       select $1, w.id
         from merchant_webhooks w
        where w.merchant_id = $2
          and w.active
          and ($3 = any(w.events) or '*' = any(w.events))
       on conflict (event_id, webhook_id) do nothing`,
      [event.id, opts.merchantId, opts.type],
    );
  }

  return event.id;
}

interface DueDelivery {
  delivery_id: string;
  attempts: number;
  url: string;
  secret: string;
  event_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

/**
 * Claims up to `limit` due deliveries. `for update skip locked` means several
 * workers (or several serverless invocations) can run this concurrently without
 * double-sending.
 */
export async function claimDue(d: Db, limit = 20): Promise<DueDelivery[]> {
  return many<DueDelivery>(
    d,
    `with claimed as (
       select id from webhook_deliveries
        where status in ('pending', 'delivering')
          and next_attempt_at <= now()
        order by next_attempt_at asc
        limit $1
        for update skip locked
     ),
     updated as (
       update webhook_deliveries wd
          set status = 'delivering', attempts = wd.attempts + 1
         from claimed c
        where wd.id = c.id
        returning wd.id, wd.attempts, wd.webhook_id, wd.event_id
     )
     select u.id as delivery_id, u.attempts,
            w.url, w.secret,
            e.id as event_id, e.type, e.payload, e.created_at
       from updated u
       join merchant_webhooks w on w.id = u.webhook_id
       join webhook_events e on e.id = u.event_id`,
    [limit],
  );
}

function backoffSeconds(attempt: number): number {
  // 5s, 25s, 2m, 10m, 50m, 4h, capped at 6h.
  return Math.min(5 * 5 ** (attempt - 1), 6 * 60 * 60);
}

export async function deliverOne(
  d: Db,
  delivery: DueDelivery,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cfg = config();
  const body = JSON.stringify({
    id: delivery.event_id,
    object: 'event',
    type: delivery.type,
    created_at: new Date(delivery.created_at).toISOString(),
    data: delivery.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Reseats-Webhooks/1.0',
        'reseats-signature': signWebhook(body, delivery.secret, timestamp),
        'reseats-event-id': delivery.event_id,
        'reseats-event-type': delivery.type,
      },
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      await d.query(
        `update webhook_deliveries
            set status = 'succeeded', delivered_at = now(), last_status_code = $2, last_error = null
          where id = $1`,
        [delivery.delivery_id, res.status],
      );
      return true;
    }

    await scheduleRetry(d, delivery, res.status, `HTTP ${res.status}`);
    return false;
  } catch (err) {
    await scheduleRetry(d, delivery, null, err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function scheduleRetry(
  d: Db,
  delivery: DueDelivery,
  statusCode: number | null,
  error: string,
): Promise<void> {
  const max = config().WEBHOOK_MAX_ATTEMPTS;
  const exhausted = delivery.attempts >= max;

  await d.query(
    `update webhook_deliveries
        set status = $2::webhook_delivery_status,
            last_status_code = $3,
            last_error = $4,
            next_attempt_at = now() + make_interval(secs => $5)
      where id = $1`,
    [
      delivery.delivery_id,
      exhausted ? 'dead' : 'pending',
      statusCode,
      error.slice(0, 500),
      exhausted ? 0 : backoffSeconds(delivery.attempts),
    ],
  );
}

export async function drainOnce(limit = 20): Promise<number> {
  const due = await claimDue(db, limit);
  let delivered = 0;
  for (const item of due) {
    if (await deliverOne(db, item)) delivered += 1;
  }
  return delivered;
}

/**
 * In-process worker for long-running deployments. In serverless, leave
 * WEBHOOK_WORKER_ENABLED=false and hit `POST /internal/webhooks/drain` from cron.
 */
export function startWebhookWorker(): { stop: () => void } {
  const cfg = config();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await drainOnce();
    } catch {
      /* logged by the caller's error handler; never kill the loop */
    }
    if (!stopped) setTimeout(() => void tick(), cfg.WEBHOOK_WORKER_INTERVAL_MS).unref();
  };

  setTimeout(() => void tick(), cfg.WEBHOOK_WORKER_INTERVAL_MS).unref();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

export const __testing = { backoffSeconds };

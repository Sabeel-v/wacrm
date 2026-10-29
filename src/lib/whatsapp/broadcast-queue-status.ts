// Client-safe half of broadcast-queue.ts — no server imports, so the
// broadcast detail page can use it.

/**
 * A `delivery_queued_at` newer than this reads as "being delivered in
 * the background". Passes re-stamp it, so an active chain never ages
 * out; a chain that died stops refreshing it and the campaign shows as
 * stalled (with Resume) again.
 */
export const QUEUE_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** True when a QStash chain stamped this broadcast recently. */
export function isQueueActive(
  deliveryQueuedAt: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!deliveryQueuedAt) return false;
  const at = Date.parse(deliveryQueuedAt);
  return Number.isFinite(at) && now - at < QUEUE_ACTIVE_WINDOW_MS;
}

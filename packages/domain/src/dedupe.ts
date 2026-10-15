/**
 * Deterministic duplicate detection.
 *
 * WHY DETERMINISTIC: the duplicate guard has to work in a database constraint, at
 * the instant two near-simultaneous requests commit — before any AI has run. Stage 1
 * proved that an application-level check cannot do this (10 concurrent transactions,
 * all saw an empty table, 10 tickets created). A deterministic key + partial unique
 * index is the only construction that holds under true concurrency.
 *
 * TRADE-OFF, STATED HONESTLY:
 * With granularity 'spot_category' (the default), two genuinely distinct problems of
 * the same category at the SAME named spot — e.g. two different broken chairs in one
 * classroom — collapse into a single master ticket. That is the conservative choice:
 * the brief requires "a duplicate report must not create a second repair ticket", and
 * under-merging (one ticket covering both) is far less damaging than over-merging
 * repair work being silently lost. Phase 2's AI similarity pass can propose finer
 * groupings, and staff can split an issue; both require explicit human confirmation.
 *
 * Granularity is configuration, not code: app_settings["dedupe_granularity"].
 */

export type DedupeGranularity = 'spot_category' | 'block_category';

/** Canonical, order-stable key string. No timestamps: the key must be reproducible. */
export function computeDedupeKey(input: {
  blockId: string;
  spotId: string;
  categoryId: string;
  granularity?: DedupeGranularity;
}): string {
  const granularity = input.granularity ?? 'spot_category';
  return granularity === 'block_category'
    ? `b:${input.blockId}:c:${input.categoryId}`
    : `s:${input.spotId}:c:${input.categoryId}`;
}

/**
 * Coarse geographic clustering used ONLY by the Phase 2 AI candidate search.
 * It never creates or merges a ticket; it proposes candidates for human review.
 */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Default radius for "same place" when GPS is available. Advisory only. */
export const DUPLICATE_PROXIMITY_METERS = 30;

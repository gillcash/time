/**
 * Timezone helpers. Configure TZ constant for your region.
 * All business logic uses the configured timezone for day-of-week
 * assignment and pay week derivation. Timestamps are stored as UTC.
 */

import { DateTime } from 'luxon';

const TZ = 'America/Moncton';

/**
 * Get the current time in the configured timezone
 */
export function nowLocal() {
  return DateTime.now().setZone(TZ);
}

/**
 * Convert a UTC ISO string to a DateTime in the configured timezone
 */
export function toLocal(utcIso) {
  return DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(TZ);
}

/**
 * Get the local date string (YYYY-MM-DD) in the configured timezone
 * for a given UTC timestamp
 */
export function getLocalDate(utcIso) {
  return toLocal(utcIso).toISODate();
}

/**
 * Get the day of week in the configured timezone (0=Sun, 1=Mon, ..., 6=Sat)
 * luxon weekday: 1=Mon..7=Sun, so weekday % 7 gives 0=Sun..6=Sat
 */
export function getLocalDow(utcIso) {
  return toLocal(utcIso).weekday % 7;
}

/**
 * Get the Monday that starts the pay week containing the given date.
 * Pay weeks run Monday–Sunday.
 */
export function getPayWeekStart(utcIso) {
  const local = utcIso ? toLocal(utcIso) : nowLocal();
  // luxon weekday: 1=Mon..7=Sun
  // Go back to Monday of this week
  const monday = local.startOf('week'); // luxon weeks start on Monday by default
  return monday.toISODate();
}

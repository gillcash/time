/**
 * Quarter-hour rounding with grace periods for clock-in/clock-out.
 * Pure functions — no side effects, no imports.
 *
 * Clock-in rounding:
 *   Find nearest 15-min mark at or before the punch time.
 *   If ≤ 5 min after that mark → round BACK (favorable).
 *   If > 5 min after → round FORWARD to next 15-min mark (unfavorable).
 *
 * Clock-out rounding:
 *   Find nearest 15-min mark at or after the punch time.
 *   If ≤ 10 min before that mark → round FORWARD (favorable).
 *   If > 10 min before → round BACK to previous 15-min mark (unfavorable).
 */

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const CLOCK_IN_GRACE_MS = 5 * 60 * 1000;
const CLOCK_OUT_GRACE_MS = 10 * 60 * 1000;

/**
 * Round a clock-in timestamp.
 * @param {Date|string|number} timestamp — the raw punch time
 * @returns {Date} — the rounded time
 */
export function roundClockIn(timestamp) {
  const t = new Date(timestamp).getTime();

  // Nearest 15-min mark at or before punch time
  const prev = Math.floor(t / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  const minutesAfterMark = t - prev;

  if (minutesAfterMark <= CLOCK_IN_GRACE_MS) {
    // Within 5-min grace → round back (favorable)
    return new Date(prev);
  } else {
    // Exceeded grace → round forward (unfavorable — they were late)
    return new Date(prev + QUARTER_HOUR_MS);
  }
}

/**
 * Round a clock-out timestamp.
 * @param {Date|string|number} timestamp — the raw punch time
 * @returns {Date} — the rounded time
 */
export function roundClockOut(timestamp) {
  const t = new Date(timestamp).getTime();

  // Nearest 15-min mark at or after punch time
  const next = Math.ceil(t / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  // Handle exact quarter-hour (ceil of exact = exact)
  const adjustedNext = (t % QUARTER_HOUR_MS === 0) ? t : next;
  const minutesBeforeMark = adjustedNext - t;

  if (minutesBeforeMark <= CLOCK_OUT_GRACE_MS) {
    // Within 10-min grace → round forward (favorable)
    return new Date(adjustedNext);
  } else {
    // Exceeded grace → round back (unfavorable — they left early)
    return new Date(adjustedNext - QUARTER_HOUR_MS);
  }
}

/**
 * Calculate elapsed minutes between two rounded timestamps.
 */
export function elapsedMinutes(clockInRounded, clockOutRounded) {
  const inMs = new Date(clockInRounded).getTime();
  const outMs = new Date(clockOutRounded).getTime();
  return Math.round((outMs - inMs) / 60000);
}

/**
 * Determine if lunch should be auto-deducted.
 * @param {number} elapsedMins — elapsed minutes (rounded)
 * @returns {{ deducted: boolean, minutes: number }}
 */
export function lunchDeduction(elapsedMins) {
  const THRESHOLD = 300; // 5 hours
  const DEDUCTION = 30;

  if (elapsedMins >= THRESHOLD) {
    return { deducted: true, minutes: DEDUCTION };
  }
  return { deducted: false, minutes: 0 };
}

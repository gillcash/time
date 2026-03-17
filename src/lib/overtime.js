/**
 * Overtime calculation.
 * Pure function — no side effects, no imports.
 *
 * Defaults: 44 hours/week (2,640 minutes) threshold,
 * 1.5× minimum wage rate. Minimum wage default: $15.65/hr.
 */

const DEFAULT_THRESHOLD_MIN = 2640; // 44 hours
const DEFAULT_MIN_WAGE = 15.65;
const DEFAULT_OT_MULTIPLIER = 1.5;

/**
 * Calculate overtime for a weekly total.
 * @param {number} totalNetMinutes — sum of net_minutes for the week
 * @param {object} [config] — optional config overrides
 * @param {number} [config.thresholdMin] — OT threshold in minutes (default 2640)
 * @param {number} [config.minWage] — minimum wage $/hr (default 15.65)
 * @param {number} [config.otMultiplier] — OT multiplier (default 1.5)
 * @returns {{ totalNetMinutes, regularMinutes, overtimeMinutes, minWage, overtimeRate }}
 */
export function calculateOvertime(totalNetMinutes, config = {}) {
  const threshold = config.thresholdMin ?? DEFAULT_THRESHOLD_MIN;
  const minWage = config.minWage ?? DEFAULT_MIN_WAGE;
  const multiplier = config.otMultiplier ?? DEFAULT_OT_MULTIPLIER;

  const regularMinutes = Math.min(totalNetMinutes, threshold);
  const overtimeMinutes = Math.max(totalNetMinutes - threshold, 0);
  const overtimeRate = Math.round(minWage * multiplier * 100) / 100;

  return {
    totalNetMinutes,
    regularMinutes,
    overtimeMinutes,
    minWage,
    overtimeRate
  };
}

/**
 * Reddit timestamps are epoch **seconds** as a float. Everything here takes that unit.
 *
 * `now` is injected rather than read from `Date.now()` inside so rendering stays a pure function
 * and its output is assertable in tests without freezing the clock globally.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** ISO 8601, for the structured half of a result where an absolute time is more useful. */
export function toIso(createdUtc: number): string {
  return new Date(createdUtc * 1000).toISOString();
}

/**
 * Compact relative age: `3d ago`, `5mo ago`. Deliberately coarse — a comment thread reads better
 * with "3d ago" than with a full timestamp on every line, and the exact time is in the structured
 * output for anything that needs it.
 */
export function relativeAge(createdUtc: number, nowSeconds: number): string {
  const elapsed = nowSeconds - createdUtc;
  // Clock skew between Reddit and the Worker can make a fresh post look very slightly future-dated.
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / DAY)}d ago`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo ago`;
  return `${Math.floor(elapsed / YEAR)}y ago`;
}

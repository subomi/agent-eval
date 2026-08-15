/**
 * Minimal ISO-8601 week bucketing on native `Date` (no date libraries).
 * All arithmetic is in UTC so bucketing is deterministic across machines.
 * A week is identified by its key ("2026-W33") and its start (the Monday,
 * 00:00 UTC), which doubles as the sort/enumeration handle.
 */

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 UTC of the ISO week containing `date`. */
export function isoWeekStart(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() - (weekday - 1));
  return day;
}

/** ISO week key, e.g. "2026-W33". The year is the ISO week-numbering year. */
export function isoWeekKey(date: Date): string {
  // The Thursday of the week determines both the ISO year and week number.
  const thursday = isoWeekStart(date);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const week =
    1 +
    Math.round(
      (isoWeekStart(thursday).getTime() - isoWeekStart(firstThursday).getTime()) / WEEK_MS,
    );
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function addWeeks(weekStart: Date, n: number): Date {
  return new Date(weekStart.getTime() + n * WEEK_MS);
}

/** Every ISO week start from `from`'s week through `to`'s week, inclusive. */
export function enumerateWeeks(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const end = isoWeekStart(to).getTime();
  for (let cursor = isoWeekStart(from); cursor.getTime() <= end; cursor = addWeeks(cursor, 1)) {
    out.push(cursor);
  }
  return out;
}

/**
 * Formatting helpers.
 *
 * Centralised so a date, a duration or a count looks the same on every page. Scattered
 * `toLocaleString()` calls are how a dashboard ends up showing three different date formats.
 *
 * Everything is defensive about bad input: the API is typed, but a null timestamp reaching
 * `new Date(null)` renders as 1970 rather than as "—", which is the kind of small lie that
 * makes a UI untrustworthy.
 */

/** "12 Oct 2026, 14:32" — unambiguous, and readable in a table cell. */
export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "12 Oct 2026" */
export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * "3 hours ago", "in 2 days". Uses the browser's own relative-time formatting rather than
 * hand-rolled pluralisation.
 */
export function formatRelative(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const diffMs = date.getTime() - Date.now();

  const divisions: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let duration = diffMs / 1000;
  for (const [amount, unit] of divisions) {
    if (Math.abs(duration) < amount) {
      return formatter.format(Math.round(duration), unit);
    }
    duration /= amount;
  }
  return formatter.format(Math.round(duration), 'year');
}

/**
 * Elapsed time since a timestamp, as a coarse duration: "2d 4h", "45m", "just now".
 * Used for the overdue indicator, where a precise relative phrase reads as noise.
 */
export function formatElapsed(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const ms = Date.now() - date.getTime();
  if (ms < 0) return formatRelative(value);

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h`;

  const months = Math.floor(days / 30);
  return `${months}mo ${days % 30}d`;
}

/**
 * Formats a duration in hours as "3d 4h" / "6h 20m" / "12m".
 *
 * SUB-MINUTE VALUES RENDER AS "<1m", NOT "0m". This is not cosmetic. The demonstration seed
 * creates and resolves an issue inside the same transaction, so real average resolution
 * times of 0.0002 hours are genuinely present in the data — and rounding those to "0m" reads
 * as a broken calculation rather than as the instant it actually was. "<1m" says the true
 * thing: it took less than a minute, which is all the data supports.
 *
 * A zero is still shown as "0m", because a genuine zero is different from a very small
 * positive number — but `null` remains an em dash, and never becomes zero hours.
 */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours > 0 && hours < 1 / 60) return '<1m';
  if (hours < 0) return '—'; // A negative duration means the timestamps are inconsistent.
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / 1440);
  const remainingHours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${remainingHours}h`;
  if (remainingHours > 0) return `${remainingHours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Token amounts, with an explicit sign. Always tabular so columns line up. */
export function formatAmount(amount: number): string {
  return amount >= 0 ? `+${amount}` : `−${Math.abs(amount)}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '0';
  return value.toLocaleString('en-IN');
}

/** "DSU-2026-00042" — monospaced display, never truncated mid-token. */
export function formatReference(value: string | null | undefined): string {
  return value && value.length > 0 ? value : '—';
}

/**
 * Turns a backend enum into a readable label.
 * "IN_PROGRESS" -> "In progress". Used so the UI never shows raw SCREAMING_CASE.
 */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  const spaced = value.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Percentage from a 0..1 ratio, for the AI confidence display. */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

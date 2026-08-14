/** Small text-formatting helpers for terminal output. */

/** Human-friendly relative age, e.g. "just now", "5m ago", "3d ago". */
export function relativeAge(date: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Collapse whitespace to a single line and cap the length with an ellipsis. */
export function singleLine(text: string, maxChars: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Greedy word wrap. Always returns at least one line. */
export function wrapText(text: string, width: number): string[] {
  return wrapHanging(text, width, width);
}

/**
 * Greedy word wrap where the first line has its own (usually smaller) width,
 * for text that starts after an inline prefix and then hangs at a fixed
 * indent. Always returns at least one line.
 */
export function wrapHanging(text: string, firstWidth: number, restWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  let width = Math.max(1, firstWidth);
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
      width = Math.max(1, restWidth);
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

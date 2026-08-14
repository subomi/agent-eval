/**
 * Hand-rolled ANSI colors (no dependency). Colors are disabled when `NO_COLOR`
 * is set, and enabled when stdout is a TTY or `FORCE_COLOR` is set.
 */

export const colorsEnabled: boolean =
  process.env['NO_COLOR'] === undefined &&
  (process.stdout.isTTY === true || process.env['FORCE_COLOR'] !== undefined);

function style(open: number, close: number): (text: string) => string {
  return (text) => (colorsEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const red = style(31, 39);
export const green = style(32, 39);
export const yellow = style(33, 39);
export const blue = style(34, 39);
export const magenta = style(35, 39);
export const cyan = style(36, 39);
export const gray = style(90, 39);

/** Red below 0.5, yellow below 0.75, green otherwise. */
export function scoreStyle(score: number): (text: string) => string {
  if (score < 0.5) return red;
  if (score < 0.75) return yellow;
  return green;
}

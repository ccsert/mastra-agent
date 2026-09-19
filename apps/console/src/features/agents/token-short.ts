/**
 * Shorthand helpers for the token budget fields: "128k" / "1.5m" parse to
 * token counts, and counts format back to the shortest readable form. Plain
 * numbers keep working everywhere.
 */
export function parseTokenShort(input: string): number {
  const text = input.trim().toLowerCase().replace(/[_\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)(k|m|w)?(?![a-z])$/.exec(text);
  if (!match) return Number.NaN;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return Number.NaN;
  const scale =
    match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "w" ? 10_000 : 1;
  const value = base * scale;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

export function formatTokenShort(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(2).replace(/\.?0+$/, "")}m`;
  }
  if (value >= 10_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(value);
}

/**
 * Run budget recommendation: the per-call reserve is bounded by the trimmed
 * window plus the output cap, so budgeting the first 10 calls (cache makes
 * later calls cheaper) keeps a multi-step task alive without inviting runaway
 * spend. Never below one full call.
 */
export function recommendedMaxTokens(
  contextTokens: number,
  maxOutputTokens: number,
  maxModelCalls: number,
  hardCap = 20_000_000,
): number {
  const floor = contextTokens + maxOutputTokens;
  const recommended = Math.min(Math.max(maxModelCalls, 1), 10) * contextTokens + maxOutputTokens;
  return Math.min(Math.max(recommended, floor), hardCap);
}

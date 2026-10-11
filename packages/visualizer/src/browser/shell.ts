const PLACEHOLDER_PATH = "/path/to/report.html";

/** POSIX single-quote quoting. Paths are never JSON-stringified into shell text. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Report path inferred from the page URL. Only plain local `file:` URLs on POSIX
 * systems qualify; anything else keeps the placeholder so a moved report never
 * shows its creator's path.
 */
export function reportPathFromLocation(loc: { protocol: string; host: string; pathname: string }): string {
  if (loc.protocol !== "file:" || loc.host) return PLACEHOLDER_PATH;
  try {
    const p = decodeURIComponent(loc.pathname);
    if (!p.startsWith("/") || /^\/[A-Za-z]:/.test(p) || p.includes("\0")) return PLACEHOLDER_PATH;
    return p;
  } catch {
    return PLACEHOLDER_PATH;
  }
}

export function updateCommand(loc: { protocol: string; host: string; pathname: string }): string {
  return `moldesk visualizer update ${shellQuote(reportPathFromLocation(loc))}`;
}

export function checkmark(ok: boolean): string {
  return ok ? "✓" : "○";
}

export function section(title: string): string {
  return `\n${title}`;
}

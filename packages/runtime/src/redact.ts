const SECRET_KEY_PATTERN = /token|secret|password|key|credential|auth/i;
const REDACTED = "[redacted]";

/**
 * Redacts values whose keys look like secrets, plus any caller-declared
 * sensitive keys. Used before persisting adapter-declared command env into
 * a durable record (e.g. run.json) — never the full inherited environment.
 */
export function redactEnv(
  env: Record<string, string> | undefined,
  extraSensitiveKeys: readonly string[] = [],
): Record<string, string> {
  if (!env) return {};
  const sensitive = new Set(extraSensitiveKeys.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) || sensitive.has(key.toLowerCase()) ? REDACTED : value,
    ]),
  );
}

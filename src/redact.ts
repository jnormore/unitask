import type { ResolvedSecret } from "./types.js";

/**
 * Best-effort redaction of secret values from captured output.
 *
 * Replaces each secret value with `[REDACTED:NAME]`. Skips values shorter than
 * 4 chars (too noisy to redact safely) and skips empty values.
 *
 * This is a defense against accidental secret echo, NOT a defense against a
 * worker that intentionally exfiltrates. The network policy is the real
 * boundary; this just keeps secrets out of the run record when the worker
 * unintentionally logs them.
 */
export function redactSecrets(text: string, secrets: ResolvedSecret[]): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  for (const s of secrets) {
    if (!s.value || s.value.length < 4) continue;
    out = out.split(s.value).join(`[REDACTED:${s.name}]`);
  }
  return out;
}

import type { ExecuteInput } from "../execute.js";

/**
 * A policy ceiling. Each field is an upper bound the request may not exceed:
 *
 *   - Scalars (memoryMb, timeoutSeconds): request gets clamped to min(request, ceiling).
 *   - Allowlist sets (allowNet, allowTcp, secrets): request is set-intersected with ceiling.
 *   - Path prefixes (filesUnder, dirsUnder): each requested file/dir path must
 *     start with one of the ceiling entries; non-matching paths are dropped.
 *
 * A field omitted from the ceiling means *no constraint* on that field — the
 * request passes through unchanged. This makes a default-everything-allowed
 * `.unitask.toml` a no-op, and progressive tightening is additive.
 */
export type PolicyCeiling = {
  memoryMb?: number;
  timeoutSeconds?: number;
  allowNet?: string[];
  allowTcp?: string[];
  secrets?: string[];
  envs?: string[];
  /** Path prefixes (must match a request file path's startsWith). */
  filesUnder?: string[];
  /** Path prefixes (must match a request dir path's startsWith). */
  dirsUnder?: string[];
};

/**
 * Per-field record of what the ceiling narrowed or denied. Stored in the run
 * record alongside the requested + effective policies so the audit trail
 * shows exactly what the agent asked for vs. what it got.
 */
export type PolicyDenials = {
  /** Original request value if the scalar got clamped, otherwise undefined. */
  memoryMb?: number;
  timeoutSeconds?: number;
  /** Request entries that didn't survive the ceiling intersection. */
  allowNet?: string[];
  allowTcp?: string[];
  secrets?: string[];
  envs?: string[];
  files?: string[];
  dirs?: string[];
};

export function applyCeiling(
  req: ExecuteInput,
  ceiling: PolicyCeiling | null
): { effective: ExecuteInput; denials: PolicyDenials } {
  if (!ceiling) return { effective: req, denials: {} };

  const denials: PolicyDenials = {};
  const out: ExecuteInput = { ...req };

  // Scalars: clamp request to min(request, ceiling). Track the original if clamped.
  if (ceiling.memoryMb != null && req.memoryMb != null && req.memoryMb > ceiling.memoryMb) {
    denials.memoryMb = req.memoryMb;
    out.memoryMb = ceiling.memoryMb;
  }
  if (
    ceiling.timeoutSeconds != null &&
    req.timeoutSeconds != null &&
    req.timeoutSeconds > ceiling.timeoutSeconds
  ) {
    denials.timeoutSeconds = req.timeoutSeconds;
    out.timeoutSeconds = ceiling.timeoutSeconds;
  }

  // Lists: set-intersect. Track entries the ceiling dropped.
  if (ceiling.allowNet != null) {
    const allowed = new Set(ceiling.allowNet.map((h) => h.toLowerCase()));
    const dropped: string[] = [];
    out.allowNet = (req.allowNet ?? []).filter((h) => {
      if (allowed.has(h.toLowerCase())) return true;
      dropped.push(h);
      return false;
    });
    if (dropped.length > 0) denials.allowNet = dropped;
  }
  if (ceiling.allowTcp != null) {
    const allowed = new Set(ceiling.allowTcp);
    const dropped: string[] = [];
    out.allowTcp = (req.allowTcp ?? []).filter((t) => {
      if (allowed.has(t)) return true;
      dropped.push(t);
      return false;
    });
    if (dropped.length > 0) denials.allowTcp = dropped;
  }
  if (ceiling.secrets != null) {
    const allowed = new Set(ceiling.secrets);
    const dropped: string[] = [];
    out.secrets = (req.secrets ?? []).filter((s) => {
      if (allowed.has(s)) return true;
      dropped.push(s);
      return false;
    });
    if (dropped.length > 0) denials.secrets = dropped;
  }
  if (ceiling.envs != null) {
    const allowed = new Set(ceiling.envs);
    const dropped: string[] = [];
    out.envs = (req.envs ?? []).filter((e) => {
      if (allowed.has(e)) return true;
      dropped.push(e);
      return false;
    });
    if (dropped.length > 0) denials.envs = dropped;
  }

  // File/dir paths: must startsWith one of the ceiling prefixes (after path
  // normalization to abs). Non-matching paths are dropped from the request.
  if (ceiling.filesUnder != null) {
    const result = applyPathCeiling(req.files ?? [], ceiling.filesUnder);
    out.files = result.allowed;
    if (result.denied.length > 0) denials.files = result.denied;
  }
  if (ceiling.dirsUnder != null) {
    const result = applyPathCeiling(req.dirs ?? [], ceiling.dirsUnder);
    out.dirs = result.allowed;
    if (result.denied.length > 0) denials.dirs = result.denied;
  }

  return { effective: out, denials };
}

function applyPathCeiling(
  paths: string[],
  prefixes: string[]
): { allowed: string[]; denied: string[] } {
  const norms = prefixes.map(normalizePrefix);
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const p of paths) {
    const np = p; // we keep the original form so the worker sees what it asked for
    if (norms.some((pre) => np.startsWith(pre))) {
      allowed.push(p);
    } else {
      denied.push(p);
    }
  }
  return { allowed, denied };
}

function normalizePrefix(p: string): string {
  // Trailing-slash insensitive: a ceiling entry "/Users/me/work" should match
  // "/Users/me/work/data.csv" but not "/Users/me/workshop".
  return p.endsWith("/") ? p : p + "/";
}

export function hasAnyDenials(d: PolicyDenials): boolean {
  return (
    d.memoryMb != null ||
    d.timeoutSeconds != null ||
    (d.allowNet?.length ?? 0) > 0 ||
    (d.allowTcp?.length ?? 0) > 0 ||
    (d.secrets?.length ?? 0) > 0 ||
    (d.envs?.length ?? 0) > 0 ||
    (d.files?.length ?? 0) > 0 ||
    (d.dirs?.length ?? 0) > 0
  );
}

export function summarizeDenials(d: PolicyDenials): string {
  const parts: string[] = [];
  if (d.memoryMb != null) parts.push(`memory clamped (requested ${d.memoryMb}M)`);
  if (d.timeoutSeconds != null)
    parts.push(`timeout clamped (requested ${d.timeoutSeconds}s)`);
  if (d.allowNet?.length) parts.push(`allow-net dropped: ${d.allowNet.join(", ")}`);
  if (d.allowTcp?.length) parts.push(`allow-tcp dropped: ${d.allowTcp.join(", ")}`);
  if (d.secrets?.length) parts.push(`secrets dropped: ${d.secrets.join(", ")}`);
  if (d.envs?.length) parts.push(`envs dropped: ${d.envs.join(", ")}`);
  if (d.files?.length) parts.push(`files dropped: ${d.files.join(", ")}`);
  if (d.dirs?.length) parts.push(`dirs dropped: ${d.dirs.join(", ")}`);
  return parts.join("; ");
}

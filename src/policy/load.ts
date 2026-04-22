import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { PolicyCeiling } from "./ceiling.js";

export type LoadedCeiling = {
  ceiling: PolicyCeiling;
  /** Absolute path to the file the ceiling was loaded from, for diagnostics. */
  source: string;
};

/**
 * Walk up from `startDir` looking for a `.unitask.toml`. Returns the first
 * one found, or null if none exists between startDir and the filesystem root.
 *
 * This mirrors how every project-config tool works (.gitignore, .editorconfig,
 * tsconfig.json, etc.) — easy mental model, no surprises.
 */
export async function findProjectCeiling(
  startDir: string = process.cwd()
): Promise<LoadedCeiling | null> {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".unitask.toml");
    try {
      await stat(candidate);
      const text = await readFile(candidate, "utf8");
      const parsed = parsePolicyToml(text, candidate);
      return { ceiling: parsed, source: candidate };
    } catch {
      // not here; walk up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse a TOML string into a {@link PolicyCeiling}. Validates types and
 * throws a descriptive error on schema violations (so a bad project config
 * fails loudly at load time rather than producing surprises mid-run).
 */
export function parsePolicyToml(text: string, sourcePath: string): PolicyCeiling {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${sourcePath}: invalid TOML — ${(e as Error).message}`
    );
  }

  const out: PolicyCeiling = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "memoryMb":
        out.memoryMb = expectPositiveInt(key, value, sourcePath);
        break;
      case "timeoutSeconds":
        out.timeoutSeconds = expectPositiveInt(key, value, sourcePath);
        break;
      case "allowNet":
      case "allowTcp":
      case "secrets":
      case "filesUnder":
      case "dirsUnder":
        out[key] = expectStringArray(key, value, sourcePath);
        break;
      default:
        throw new Error(
          `${sourcePath}: unknown policy field '${key}'. Allowed: memoryMb, timeoutSeconds, allowNet, allowTcp, secrets, filesUnder, dirsUnder.`
        );
    }
  }
  return out;
}

function expectPositiveInt(name: string, v: unknown, source: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(
      `${source}: '${name}' must be a positive integer; got ${JSON.stringify(v)}`
    );
  }
  return v;
}

function expectStringArray(name: string, v: unknown, source: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(
      `${source}: '${name}' must be an array of strings; got ${JSON.stringify(v)}`
    );
  }
  return v;
}

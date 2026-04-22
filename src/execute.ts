import { NanosRuntime } from "./nanos.js";
import { newRunId, writeRunRecord } from "./runs.js";
import { applyCeiling, type PolicyDenials } from "./policy/ceiling.js";
import { findProjectCeiling, type LoadedCeiling } from "./policy/load.js";
import type { NetLogEntry } from "./proxy/index.js";
import type {
  ExecutionPolicy,
  ResolvedSecret,
  TcpTarget,
  WorkerSpec,
} from "./types.js";

export type ExecuteInput = {
  /** JavaScript source to run inside the unikernel. */
  code: string;
  /** Hostnames to allow HTTPS/HTTP CONNECT egress to. */
  allowNet?: string[];
  /** "host:port" raw-TCP destinations to allow. Includes loopback. */
  allowTcp?: string[];
  /** Host file paths to inject (read-only) at /<basename>. */
  files?: string[];
  /** Host directory paths to inject (recursively, read-only) at /<basename>/. */
  dirs?: string[];
  /** Env-var names to resolve from the caller's process.env and inject. */
  secrets?: string[];
  /** Wall-clock timeout in seconds. */
  timeoutSeconds?: number;
  /** Memory cap in MB. */
  memoryMb?: number;
};

export type CeilingMeta = {
  source: string;
  denials: PolicyDenials;
};

export type ExecuteOutput = {
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  runtime: string;
  /** Per-connection proxy decisions, when --allow-net was non-empty. */
  netlog?: NetLogEntry[];
  /** Project ceiling source + per-field denials, if a `.unitask.toml` was found and applied. */
  policyCeiling?: CeilingMeta;
};

export class UnitaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitaskInputError";
  }
}

/**
 * Execute a code spec inside an ephemeral unikernel and persist the run.
 *
 * Shared core for the CLI's `unitask run` and the MCP server's `run_code`
 * tool. Validates inputs, applies any project-level `.unitask.toml` ceiling,
 * resolves secrets from the host env, dispatches to the runtime, writes the
 * run record, and returns a structured result.
 *
 * Throws {@link UnitaskInputError} on bad caller input (malformed `--allow-tcp`
 * target, unset secret env var, malformed `.unitask.toml`, etc).
 */
export async function execute(input: ExecuteInput): Promise<ExecuteOutput> {
  if (!input.code || !input.code.trim()) {
    throw new UnitaskInputError("no code provided");
  }

  // Walk up from cwd looking for a `.unitask.toml`; missing file → no ceiling.
  // A malformed file fails loudly here rather than producing a surprising run.
  let loadedCeiling: LoadedCeiling | null;
  try {
    loadedCeiling = await findProjectCeiling();
  } catch (e) {
    throw new UnitaskInputError((e as Error).message);
  }
  const { effective, denials } = applyCeiling(
    input,
    loadedCeiling?.ceiling ?? null
  );

  const allowNet = effective.allowNet ?? [];
  const allowTcpRaw = effective.allowTcp ?? [];
  const files = effective.files ?? [];
  const dirs = effective.dirs ?? [];
  const secretNames = effective.secrets ?? [];

  const allowedTcp: TcpTarget[] = allowTcpRaw.map(parseTcpTarget);
  const resolvedSecrets: ResolvedSecret[] = resolveSecrets(secretNames);

  const spec: WorkerSpec = {
    language: "node",
    code: effective.code,
    inputFiles: files,
    inputDirs: dirs,
  };

  const policy: ExecutionPolicy = {
    timeoutSeconds: effective.timeoutSeconds ?? 30,
    memoryMb: effective.memoryMb ?? 256,
    allowedHosts: allowNet,
    allowedTcp,
    allowInternet: allowNet.length > 0 || allowedTcp.length > 0,
    secrets: resolvedSecrets,
  };

  const ceilingMeta: CeilingMeta | undefined = loadedCeiling
    ? { source: loadedCeiling.source, denials }
    : undefined;

  const runId = newRunId();
  const runtime = new NanosRuntime();
  const result = await runtime.run(spec, policy, runId);

  await writeRunRecord({
    runId,
    createdAt: new Date().toISOString(),
    spec,
    policy,
    result,
    netlog: result.netlog,
    requestedPolicyInput: input,
    policyCeiling: ceilingMeta,
  });

  return {
    runId,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    runtime: result.runtime,
    netlog: result.netlog,
    policyCeiling: ceilingMeta,
  };
}

export function parseTcpTarget(raw: string): TcpTarget {
  const idx = raw.lastIndexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new UnitaskInputError(
      `--allow-tcp ${raw}: must be host:port (e.g. 127.0.0.1:5432)`
    );
  }
  const host = raw.slice(0, idx).trim();
  const portStr = raw.slice(idx + 1).trim();
  const port = parseInt(portStr, 10);
  if (!host) {
    throw new UnitaskInputError(`--allow-tcp ${raw}: empty host`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host)) {
    throw new UnitaskInputError(
      `--allow-tcp ${raw}: host may only contain letters, digits, dot, underscore, and dash`
    );
  }
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new UnitaskInputError(`--allow-tcp ${raw}: port must be 1–65535`);
  }
  return { host, port };
}

export function resolveSecrets(names: string[]): ResolvedSecret[] {
  const out: ResolvedSecret[] = [];
  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new UnitaskInputError(
        `secret ${name}: must be an uppercase env-var name (matching /^[A-Z_][A-Z0-9_]*$/)`
      );
    }
    const value = process.env[name];
    if (value == null || value === "") {
      throw new UnitaskInputError(
        `secret ${name}: env var ${name} is not set on the host`
      );
    }
    out.push({ name, value });
  }
  return out;
}

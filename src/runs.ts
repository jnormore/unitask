import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WorkerSpec, ExecutionPolicy, RunResult } from "./types.js";
import type { NetLogEntry } from "./proxy/index.js";
import type { ExecuteInput, CeilingMeta } from "./execute.js";

export type RunRecord = {
  runId: string;
  createdAt: string;
  spec: WorkerSpec;
  policy: ExecutionPolicy;
  result: RunResult;
  netlog?: NetLogEntry[];
  /** Original caller input (pre-ceiling), so the audit trail shows what the
   *  agent / app asked for vs. what it actually got. */
  requestedPolicyInput?: ExecuteInput;
  policyCeiling?: CeilingMeta;
};

export const RUN_ID_RE = /^r_[a-f0-9]{8}$/;

export function newRunId(): string {
  return `r_${randomBytes(4).toString("hex")}`;
}

export function isValidRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
}

export function runsRoot(): string {
  return join(homedir(), ".unitask", "runs");
}

function runDir(runId: string): string {
  // Guard against path traversal: runId flows into a filesystem path, and
  // readRunRecord is reachable via the CLI and MCP. Keep the check here so
  // every caller gets it for free.
  if (!isValidRunId(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  return join(runsRoot(), runId);
}

export async function writeRunRecord(record: RunRecord): Promise<string> {
  const dir = runDir(record.runId);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "code.js"), record.spec.code, "utf8");

  // Strip secret values so they never land on disk; only names persist.
  const effectivePolicy = {
    timeoutSeconds: record.policy.timeoutSeconds,
    memoryMb: record.policy.memoryMb,
    allowedHosts: record.policy.allowedHosts,
    allowedTcp: record.policy.allowedTcp,
    allowInternet: record.policy.allowInternet,
    secrets: record.policy.secrets.map((s) => ({ name: s.name })),
  };

  // Caller-requested policy (pre-ceiling). Same redaction applied.
  const requestedPolicy = record.requestedPolicyInput
    ? {
        timeoutSeconds: record.requestedPolicyInput.timeoutSeconds,
        memoryMb: record.requestedPolicyInput.memoryMb,
        allowNet: record.requestedPolicyInput.allowNet ?? [],
        allowTcp: record.requestedPolicyInput.allowTcp ?? [],
        files: record.requestedPolicyInput.files ?? [],
        dirs: record.requestedPolicyInput.dirs ?? [],
        secrets: record.requestedPolicyInput.secrets ?? [],
      }
    : undefined;

  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        runId: record.runId,
        createdAt: record.createdAt,
        language: record.spec.language,
        inputFiles: (record.spec.inputFiles ?? []).map((p) => ({
          source: p,
          mountedAs: "/" + p.split("/").pop()!,
        })),
        inputDirs: (record.spec.inputDirs ?? []).map((p) => ({
          source: p,
          mountedAs: "/" + p.split("/").pop()! + "/",
        })),
        requestedPolicy,
        effectivePolicy,
        policyCeiling: record.policyCeiling,
        exitCode: record.result.exitCode,
        durationMs: record.result.durationMs,
        timedOut: record.result.timedOut,
        runtime: record.result.runtime,
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(join(dir, "stdout.log"), record.result.stdout, "utf8");
  await writeFile(join(dir, "stderr.log"), record.result.stderr, "utf8");

  if (record.netlog && record.netlog.length > 0) {
    const lines = record.netlog.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(dir, "netlog.jsonl"), lines, "utf8");
  }

  return dir;
}

export async function readRunRecord(runId: string): Promise<{
  meta: Record<string, unknown>;
  code: string;
  stdout: string;
  stderr: string;
  dir: string;
}> {
  const dir = runDir(runId);
  const [metaRaw, code, stdout, stderr] = await Promise.all([
    readFile(join(dir, "meta.json"), "utf8"),
    readFile(join(dir, "code.js"), "utf8"),
    readFile(join(dir, "stdout.log"), "utf8"),
    readFile(join(dir, "stderr.log"), "utf8"),
  ]);
  return {
    meta: JSON.parse(metaRaw) as Record<string, unknown>,
    code,
    stdout,
    stderr,
    dir,
  };
}

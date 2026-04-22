import type { WorkerSpec, ExecutionPolicy, RunResult } from "./types.js";

export interface SandboxRuntime {
  readonly name: string;
  run(spec: WorkerSpec, policy: ExecutionPolicy, runId: string): Promise<RunResult>;
}

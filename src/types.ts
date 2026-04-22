export type Language = "node";

export type WorkerSpec = {
  language: Language;
  code: string;
  entrypoint?: string;
  env?: Record<string, string>;
  /** Host paths to inject as read-only files inside the unikernel.
   *  Each ends up at /<basename> in the image. */
  inputFiles?: string[];
  /** Host directory paths to inject (recursively, read-only).
   *  Each ends up at /<basename>/ in the image. */
  inputDirs?: string[];
};

export type ResolvedSecret = {
  name: string;
  value: string;
};

export type TcpTarget = {
  host: string;
  port: number;
};

export type ExecutionPolicy = {
  timeoutSeconds: number;
  memoryMb: number;
  /** Allowed HTTP/HTTPS hostnames (proxied via CONNECT). */
  allowedHosts: string[];
  /** Allowed raw-TCP destinations (host:port). Includes loopback like
   *  127.0.0.1:5432 to reach a service running on the host. */
  allowedTcp: TcpTarget[];
  allowInternet: boolean;
  /** Resolved secrets (name + value). The value is injected as an env var into
   *  the worker; only the name is persisted to the run record. */
  secrets: ResolvedSecret[];
};

export type RunResult = {
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  runtime: string;
};

export type TaskRequest = {
  code: string;
  language: Language;
  policy: ExecutionPolicy;
};

import { readFile } from "node:fs/promises";
import { execute, UnitaskInputError } from "../execute.js";

export type RunOptions = {
  codeFile?: string;
  code?: string;
  stdin?: boolean;
  timeout: number;
  memory: number;
  allowNet: string[];
  allowTcp: string[];
  files: string[];
  dirs: string[];
  secrets: string[];
  json: boolean;
};

export async function runCommand(opts: RunOptions): Promise<number> {
  let code: string;
  try {
    code = await resolveCode(opts);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }
  if (!code.trim()) {
    process.stderr.write(
      "error: no code provided. Use --code, --code-file, or pipe via stdin with -\n"
    );
    return 2;
  }

  if (!opts.json) {
    const netParts: string[] = [];
    if (opts.allowNet.length > 0) {
      netParts.push(`http=[${opts.allowNet.join(", ")}]`);
    }
    if (opts.allowTcp.length > 0) {
      netParts.push(`tcp=[${opts.allowTcp.join(", ")}]`);
    }
    const netDesc = netParts.length === 0 ? "default-deny" : netParts.join(" ");
    process.stderr.write(`• runtime: nanos\n`);
    process.stderr.write(`• network: ${netDesc}\n`);
    if (opts.files.length > 0) {
      process.stderr.write(`• files: ${opts.files.length}\n`);
    }
    if (opts.dirs.length > 0) {
      process.stderr.write(`• dirs: ${opts.dirs.length}\n`);
    }
    if (opts.secrets.length > 0) {
      process.stderr.write(`• secrets: ${opts.secrets.join(", ")}\n`);
    }
    process.stderr.write(`• building image and booting unikernel...\n`);
  }

  const started = Date.now();
  let result;
  try {
    result = await execute({
      code,
      allowNet: opts.allowNet,
      allowTcp: opts.allowTcp,
      files: opts.files,
      dirs: opts.dirs,
      secrets: opts.secrets,
      timeoutSeconds: opts.timeout,
      memoryMb: opts.memory,
    });
  } catch (err) {
    if (err instanceof UnitaskInputError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n${msg}\n`);
    return 2;
  }
  const total = Date.now() - started;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          runId: result.runId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          netlog: result.netlog ?? [],
        },
        null,
        2
      ) + "\n"
    );
  } else {
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.stderr.write(
      `• done (${result.durationMs}ms in unikernel, ${total}ms total)\n`
    );
    if (result.timedOut) {
      process.stderr.write(`• TIMED OUT after ${opts.timeout}s\n`);
    }
    process.stderr.write(
      `• run id: ${result.runId}   inspect: unitask inspect ${result.runId}\n`
    );
  }

  return result.exitCode;
}

async function resolveCode(opts: RunOptions): Promise<string> {
  if (opts.code) return opts.code;
  if (opts.codeFile) {
    try {
      return await readFile(opts.codeFile, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`cannot read --code-file ${opts.codeFile}: ${msg}`);
    }
  }
  if (opts.stdin) return await readStdin();
  return "";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

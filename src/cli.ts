#!/usr/bin/env node
import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { inspectCommand } from "./commands/inspect.js";
import { doctorCommand } from "./commands/doctor.js";
import { mcpServeCommand, mcpConfigCommand } from "./commands/mcp.js";

const program = new Command();

program
  .name("unitask")
  .description("Disposable unikernels for untrusted code, with declarative policy.")
  .version("0.4.0");


program
  .command("run")
  .description("Run user-provided code in an ephemeral unikernel.")
  .option("--code <code>", "inline code string")
  .option("--code-file <path>", "path to a code file")
  .argument("[input]", "pass '-' to read code from stdin")
  .option(
    "--timeout <seconds>",
    "wall-clock timeout in seconds",
    (v) => parseInt(v, 10),
    30
  )
  .option(
    "--memory <mb>",
    "memory cap in MB",
    (v) => parseInt(v, 10),
    256
  )
  .option(
    "--allow-net <host>",
    "allow HTTP/HTTPS egress to the given hostname (repeatable). default: no network. pass '*' as the host to allow any destination — escape hatch for code that fetches user-supplied URLs across arbitrary domains.",
    (host: string, prev: string[]) => prev.concat([host]),
    [] as string[]
  )
  .option(
    "--allow-tcp <host:port>",
    "allow raw TCP egress to the given host:port (repeatable). includes loopback (e.g. 127.0.0.1:5432).",
    (target: string, prev: string[]) => prev.concat([target]),
    [] as string[]
  )
  .option(
    "--file <path>",
    "host file to inject into the unikernel as /<basename> (repeatable, read-only).",
    (path: string, prev: string[]) => prev.concat([path]),
    [] as string[]
  )
  .option(
    "--dir <path>",
    "host directory to inject (recursively) into the unikernel as /<basename>/ (repeatable, read-only).",
    (path: string, prev: string[]) => prev.concat([path]),
    [] as string[]
  )
  .option(
    "--secret <NAME>",
    "inject env var NAME from the host into the unikernel (repeatable). value never persisted to the run record. value is REDACTED from captured stdout/stderr — pick this for credentials, signing keys, tokens.",
    (name: string, prev: string[]) => prev.concat([name]),
    [] as string[]
  )
  .option(
    "--env <NAME>",
    "inject env var NAME from the host into the unikernel (repeatable). value is NOT redacted from output and IS persisted to the run record — pick this for non-sensitive runtime config (URLs, thresholds, channel names, recipient addresses).",
    (name: string, prev: string[]) => prev.concat([name]),
    [] as string[]
  )
  .option("--json", "emit machine-readable output on stdout", false)
  .action(async (input: string | undefined, opts) => {
    const stdin = input === "-";
    const exit = await runCommand({
      code: opts.code,
      codeFile: opts.codeFile,
      stdin,
      timeout: opts.timeout,
      memory: opts.memory,
      allowNet: opts.allowNet ?? [],
      allowTcp: opts.allowTcp ?? [],
      files: opts.file ?? [],
      dirs: opts.dir ?? [],
      secrets: opts.secret ?? [],
      envs: opts.env ?? [],
      json: opts.json,
    });
    process.exit(exit);
  });

program
  .command("inspect")
  .description("Show a past run's code, policy, and output.")
  .argument("<run-id>", "the run id returned by `unitask run`")
  .action(async (runId: string) => {
    const exit = await inspectCommand(runId);
    process.exit(exit);
  });

program
  .command("doctor")
  .description("Check that all prerequisites are installed and working.")
  .action(async () => {
    const exit = await doctorCommand();
    process.exit(exit);
  });

const mcp = program
  .command("mcp")
  .description(
    "Run unitask as an MCP server (stdio transport). Lets coding agents " +
      "(Claude Desktop, Claude Code, Cursor, …) execute code in a unikernel."
  )
  .action(async () => {
    const exit = await mcpServeCommand();
    process.exit(exit);
  });

mcp
  .command("config")
  .description(
    "Print the JSON snippet to paste into a given MCP client's config file."
  )
  .argument("[client]", "claude-desktop | claude-code | cursor | vscode-copilot")
  .action(async (client: string | undefined) => {
    const exit = await mcpConfigCommand(client);
    process.exit(exit);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});

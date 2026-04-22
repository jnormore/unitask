import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execute, UnitaskInputError } from "../execute.js";
import { readRunRecord, RUN_ID_RE } from "../runs.js";
import { preflight, formatReport } from "../preflight.js";

/**
 * Build (but do not start) the unitask MCP server. Caller wires it to a
 * transport (stdio for local agents; HTTP/SSE for remote — v0.5).
 *
 * Tools:
 *   - run_code     : execute a worker in a fresh unikernel under a policy
 *   - inspect_run  : read a past run by id
 *   - doctor       : report environment status (so the agent can reason about
 *                    whether code execution is even possible)
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "unitask",
    version: "0.4.0",
  });

  server.tool(
    "run_code",
    "Run a small JavaScript program inside a fresh, ephemeral Nanos unikernel " +
      "under a declarative policy. The unikernel boots, runs the code to " +
      "completion, captures output, and is destroyed. Default-deny on filesystem " +
      "and network: the worker only sees what the caller explicitly allows.",
    {
      code: z
        .string()
        .min(1)
        .describe("JavaScript source. Runs as worker.js in the unikernel."),
      allowNet: z
        .array(z.string())
        .optional()
        .describe(
          "Hostnames to allow HTTPS/HTTP egress to (e.g. ['api.github.com']). " +
            "Empty/omitted means no network at all."
        ),
      allowTcp: z
        .array(z.string())
        .optional()
        .describe(
          "Raw-TCP allowlist as 'host:port' strings (e.g. ['127.0.0.1:5432']). " +
            "Includes loopback for talking to host services."
        ),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Host file paths to inject as read-only at /<basename> in the unikernel."
        ),
      dirs: z
        .array(z.string())
        .optional()
        .describe(
          "Host directory paths to inject recursively (read-only) at /<basename>/."
        ),
      secrets: z
        .array(z.string())
        .optional()
        .describe(
          "Names of env vars to resolve from the host and inject as env vars " +
            "into the worker. Names must match /^[A-Z_][A-Z0-9_]*$/. Values " +
            "never land on disk; they're also redacted from captured output."
        ),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe("Wall-clock timeout. Default 30."),
      memoryMb: z
        .number()
        .int()
        .min(64)
        .max(8192)
        .optional()
        .describe("Memory cap in MB. Default 256."),
    },
    async (args) => {
      try {
        const out = await execute({
          code: args.code,
          allowNet: args.allowNet,
          allowTcp: args.allowTcp,
          files: args.files,
          dirs: args.dirs,
          secrets: args.secrets,
          timeoutSeconds: args.timeoutSeconds,
          memoryMb: args.memoryMb,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  runId: out.runId,
                  exitCode: out.exitCode,
                  timedOut: out.timedOut,
                  durationMs: out.durationMs,
                  stdout: out.stdout,
                  stderr: out.stderr,
                  netlog: out.netlog ?? [],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        const isCallerError = e instanceof UnitaskInputError;
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: isCallerError
                ? `unitask: ${msg}`
                : `unitask runtime error: ${msg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "inspect_run",
    "Read a past run's full record (code, policy, stdout, stderr, metadata).",
    {
      runId: z.string().regex(RUN_ID_RE),
    },
    async (args) => {
      try {
        const r = await readRunRecord(args.runId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  runId: args.runId,
                  dir: r.dir,
                  meta: r.meta,
                  code: r.code,
                  stdout: r.stdout,
                  stderr: r.stderr,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `unitask: cannot read run ${args.runId}: ${(e as Error).message}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "doctor",
    "Report whether the unitask runtime environment is properly set up. Use " +
      "this if `run_code` is failing to understand why.",
    {},
    async () => {
      const report = await preflight();
      return {
        content: [
          {
            type: "text",
            text:
              `unitask doctor:\n\n${formatReport(report)}\n\n` +
              (report.ok
                ? "all checks passed."
                : `${report.checks.filter((c) => !c.ok).length} issue(s) need attention before run_code will work.`),
          },
        ],
      };
    }
  );

  return server;
}

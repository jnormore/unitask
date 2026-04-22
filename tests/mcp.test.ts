import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

/**
 * Spawn `unitask mcp` and speak the MCP protocol against it via the SDK's
 * own client. This is the same handshake any agent (Claude Desktop, Cursor,
 * Claude Code, an AI app's backend) does on connect. If this passes, the
 * server is contractually compatible with any MCP-supporting consumer.
 */
describe("smoke: unitask mcp (stdio MCP server)", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "node",
      args: [CLI, "mcp"],
      stderr: "ignore",
    });
    client = new Client(
      { name: "unitask-smoke", version: "0" },
      { capabilities: {} }
    );
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {}
  });

  it("advertises the three expected tools with input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["doctor", "inspect_run", "run_code"]);

    const runCode = tools.find((t) => t.name === "run_code")!;
    expect(runCode.description).toContain("unikernel");
    const props = (runCode.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props).sort()).toEqual([
      "allowNet",
      "allowTcp",
      "code",
      "dirs",
      "files",
      "memoryMb",
      "secrets",
      "timeoutSeconds",
    ]);
  });

  it("doctor returns the env report", async () => {
    const res = await client.callTool({ name: "doctor", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("unitask doctor");
    expect(text).toMatch(/platform/);
    expect(text).toMatch(/qemu/);
  });

  it("run_code boots a unikernel and returns structured output", async () => {
    const res = await client.callTool({
      name: "run_code",
      arguments: {
        code: 'console.log("via-mcp:", process.platform, process.arch);',
        timeoutSeconds: 30,
      },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const parsed = JSON.parse(text) as {
      runId: string;
      exitCode: number;
      stdout: string;
      durationMs: number;
    };
    expect(parsed.runId).toMatch(/^r_[a-f0-9]{8}$/);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("via-mcp:");
    expect(parsed.durationMs).toBeGreaterThan(0);
  }, 60000);

  it("run_code surfaces input validation errors as tool errors", async () => {
    const res = await client.callTool({
      name: "run_code",
      arguments: {
        code: "console.log(1)",
        secrets: ["definitely_not_a_real_env_var_that_anyone_would_set"],
        timeoutSeconds: 5,
      },
    });
    // `resolveSecrets` (inside execute()) rejects the lowercase name with a
    // UnitaskInputError; the tool handler turns that into an MCP tool error.
    expect(res.isError).toBeTruthy();
  });

  it("inspect_run can read back a run created via run_code", async () => {
    const created = await client.callTool({
      name: "run_code",
      arguments: {
        code: 'console.log("inspect-me");',
        timeoutSeconds: 30,
      },
    });
    const text = (created.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const { runId } = JSON.parse(text) as { runId: string };

    const inspected = await client.callTool({
      name: "inspect_run",
      arguments: { runId },
    });
    expect(inspected.isError).toBeFalsy();
    const inspectedText = (
      inspected.content as Array<{ type: string; text: string }>
    )
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const record = JSON.parse(inspectedText) as {
      runId: string;
      code: string;
      stdout: string;
    };
    expect(record.runId).toBe(runId);
    expect(record.code).toContain("inspect-me");
    expect(record.stdout).toContain("inspect-me");
  }, 60000);
});

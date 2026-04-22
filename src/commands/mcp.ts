import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../mcp/server.js";
import { CLIENT_CONFIGS, listClients, renderConfig } from "../mcp/clients.js";

/**
 * `unitask mcp` — start a stdio-based MCP server. Designed to be invoked by an
 * MCP client (Claude Desktop, Claude Code, Cursor, etc.) as a subprocess. The
 * client speaks JSON-RPC on stdin/stdout; we log nothing to stdout (it would
 * corrupt the JSON-RPC stream) and put any informational messages on stderr.
 */
export async function mcpServeCommand(): Promise<number> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block until the transport closes (parent disconnects).
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
    transport.onclose = () => resolve();
  });
  return 0;
}

/**
 * `unitask mcp config [client]` — print a config snippet you can paste into
 * the chosen client's MCP-server config file. With no client given, lists
 * supported clients.
 */
export async function mcpConfigCommand(client?: string): Promise<number> {
  if (!client) {
    process.stdout.write("Supported MCP clients:\n");
    for (const id of listClients()) {
      const c = CLIENT_CONFIGS[id]!;
      process.stdout.write(`  ${id.padEnd(18)} ${c.label}\n`);
    }
    process.stdout.write(
      "\nRun `unitask mcp config <client>` to see the JSON snippet to add.\n"
    );
    return 0;
  }
  const rendered = renderConfig(client);
  if (!rendered) {
    process.stderr.write(
      `unknown client '${client}'. Try one of: ${listClients().join(", ")}\n`
    );
    return 2;
  }
  process.stdout.write(rendered);
  return 0;
}

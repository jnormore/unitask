/**
 * Config snippets for popular MCP clients. `unitask mcp config <client>`
 * prints these so users don't have to figure out the right shape themselves.
 */

const SERVER_CMD = {
  command: "unitask",
  args: ["mcp"],
};

export const CLIENT_CONFIGS: Record<
  string,
  { label: string; configPath: string; snippet: object | string }
> = {
  "claude-desktop": {
    label: "Claude Desktop",
    configPath:
      "macOS:    ~/Library/Application Support/Claude/claude_desktop_config.json\n" +
      "# Windows:  %APPDATA%\\Claude\\claude_desktop_config.json\n" +
      "# (Edit via Claude menu → Settings → Developer → Edit Config, then restart.)",
    snippet: {
      mcpServers: {
        unitask: SERVER_CMD,
      },
    },
  },
  "claude-code": {
    label: "Claude Code",
    configPath:
      "Project (preferred — ships with the repo): .mcp.json in the project root\n" +
      "# User-global (your tools across all projects):  ~/.claude.json",
    snippet: {
      mcpServers: {
        unitask: SERVER_CMD,
      },
    },
  },
  cursor: {
    label: "Cursor",
    configPath:
      "Project: .cursor/mcp.json (in the project root)\n" +
      "# User:    ~/.cursor/mcp.json",
    snippet: {
      mcpServers: {
        unitask: SERVER_CMD,
      },
    },
  },
  "vscode-copilot": {
    label: "VS Code (Copilot agent mode)",
    configPath:
      "Workspace: .vscode/mcp.json (in the project root)\n" +
      "# User:      run `MCP: Open User Configuration` from the command palette",
    snippet: {
      servers: {
        unitask: SERVER_CMD,
      },
    },
  },
};

export function listClients(): string[] {
  return Object.keys(CLIENT_CONFIGS);
}

export function renderConfig(client: string): string | null {
  const cfg = CLIENT_CONFIGS[client];
  if (!cfg) return null;
  const body =
    typeof cfg.snippet === "string"
      ? cfg.snippet
      : JSON.stringify(cfg.snippet, null, 2);
  return [
    `# ${cfg.label}`,
    `# Config file: ${cfg.configPath}`,
    "",
    body,
    "",
  ].join("\n");
}

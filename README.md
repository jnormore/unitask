# unitask

**CLI and MCP server for safe code execution.** Any AI application — chatbot code interpreters, workflow builders, eval pipelines, agentic SaaS backends, IDE coding agents — plugs in `unitask` via CLI or MCP and gets a tool that runs code in a fresh, ephemeral [unikernel](https://nanos.org/) under declarative policy. Code in, runs, returns, destroyed.

Today's MCP transport is **stdio** — works great for coding agents on a developer's machine (Claude Code, Cursor, Codex), or for an AI-app backend that's fine spawning a sandbox subprocess per request. A remote (HTTP/SSE) transport for shared multi-tenant servers isn't built yet.

## Why

Anywhere an LLM (or a user) emits code your app needs to execute, the options today are bad:

- **Run it on the host.** Containers help, but they're one kernel-escape thick.
- **Cloud sandboxes** (E2B, Code Interpreter). Remote, vendor-tied, non-ephemeral, billed by the second.
- **Roll your own VM tooling.** Kernel + sandbox + isolation work nobody wants to do.

`unitask` is the local-or-self-hostable primitive: code in, fresh unikernel runs to completion, disappears. The trace is preserved; the VM is not. The MCP transport means _any_ MCP-supporting consumer — IDE agent or production app backend — can plug it in with a config snippet or SDK call.

## What it does

- **MCP server** (stdio) + **CLI** — same primitive, two transports
- **Default-deny network**; opt-in via `--allow-net <host>` (HTTP/HTTPS) and `--allow-tcp <host>:<port>` (raw TCP, includes loopback)
- **`--file <path>`** and **`--dir <path>`** read-only mounts
- **`--secret NAME`** env injection — value never persisted to the run record, redacted from captured output
- **`.unitask.toml` policy ceiling.** Drop one in your project root and the host caps what every run can ask for: scalars (memory, timeout) get clamped to the ceiling; lists (allowNet, allowTcp, secrets, files, dirs) get intersected against it. Agents narrow, never exceed. The run record stores both what was requested and what was effective.
- HTTP/2, stdout/stderr separation, exit-code propagation, wall-clock timeout, memory cap
- Per-run trace under `~/.unitask/runs/<id>/`: code, policy (requested + effective + denials), stdout, stderr, netlog
- Runs on macOS arm64 (HVF) and Linux x86_64/arm64 (KVM where available, TCG software-emulation fallback otherwise)

## Prereqs

- macOS Apple Silicon **or** Linux x86_64/arm64 (KVM if available, TCG fallback otherwise)
- Node.js ≥ 20
- [Nanos `ops`](https://ops.city/): `curl -sSfL https://ops.city/get.sh | sh` (pulls QEMU)
- `nc` (netcat) — preinstalled on macOS, `apt install netcat-openbsd` on Debian/Ubuntu

## Install

There's no npm publish, on purpose. Install from source — under a minute:

```bash
git clone https://github.com/<you>/unitask.git
cd unitask
npm install && npm run build && npm link
unitask doctor                 # six green checks = ready to go
```

If you can't `npm link`, invoke directly: `node /abs/path/to/unitask/dist/cli.js …` and substitute that into your MCP config below.

## Use via MCP

The server exposes three tools to any MCP client:

- `run_code(code, allowNet?, allowTcp?, files?, dirs?, secrets?, timeoutSeconds?, memoryMb?)` — run JS in a fresh unikernel under policy
- `inspect_run(runId)` — read a past run's full record
- `doctor()` — env status (so the consumer can reason about whether code execution is even possible)

### From a coding agent (today, stdio)

```bash
unitask mcp config claude-code      # → JSON snippet + the file path it goes in
unitask mcp config claude-desktop   # also: cursor, vscode-copilot
```

For Claude Code / Claude Desktop / Cursor the snippet is:

```json
{
  "mcpServers": {
    "unitask": { "command": "unitask", "args": ["mcp"] }
  }
}
```

Paste, restart, done.

### From your AI app's backend

Spawn `unitask mcp` from your backend and talk MCP via the SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "unitask",
  args: ["mcp"],
});
const client = new Client(
  { name: "my-app", version: "0.1.0" },
  { capabilities: {} },
);
await client.connect(transport);

// In your LLM tool-call handler:
const res = await client.callTool({
  name: "run_code",
  arguments: { code, allowNet: ["api.example.com"], timeoutSeconds: 30 },
});
```

Stdio means one sandbox subprocess per request. Fine for prototyping and lower-volume backends. A remote HTTP/SSE transport for shared servers isn't built — if you'd find that useful, open an issue.

## CLI quickstart

`unitask` is also a useful CLI on its own.

```bash
# default-deny network
unitask run --code 'console.log("hello from", process.platform, process.arch, "pid", process.pid)'

# explicit per-host allowlist + secret injection
export GITHUB_TOKEN=ghp_…
unitask run --allow-net api.github.com --secret GITHUB_TOKEN \
  --code 'fetch("https://api.github.com/zen", {headers:{"User-Agent":"x"}})
            .then(r=>r.text()).then(console.log)'

# read a host file the worker has no other access to
unitask run --file ./sales.csv --code-file analyze.js

# reach a database on the host
unitask run --allow-tcp 127.0.0.1:5432 --code-file query.js
```

Everything else: `unitask --help`, `unitask run --help`, `unitask inspect <run-id>`.

## Project policy ceilings

Drop a `.unitask.toml` in your project root (or any parent dir — unitask walks up like git/tsc) to cap what every run is allowed to request:

```toml
memoryMb       = 512
timeoutSeconds = 60
allowNet       = ["api.github.com", "api.openai.com"]
allowTcp       = ["127.0.0.1:5432"]
secrets        = ["GITHUB_TOKEN", "OPENAI_API_KEY"]
filesUnder     = ["/Users/me/work"]   # request file paths must startsWith one
dirsUnder      = ["/Users/me/work"]
```

The host (you) declares the ceiling; the caller (agent or app) declares the per-call request. The effective policy is the intersection. Anything dropped lands in the run record's `policyCeiling.denials` for the audit trail.

Missing fields = no ceiling on that field. A `.unitask.toml` with just `allowNet = […]` doesn't constrain memory or files at all.

## Try Linux without leaving your Mac

```bash
docker build -f Dockerfile.linux-validate -t unitask-linux .
docker run --rm unitask-linux unitask doctor
docker run --rm unitask-linux unitask run --code 'console.log("hi from linux")'
```

Container has no `/dev/kvm`, so it runs under TCG software emulation (~1–2s per invocation instead of ~0.5s under KVM). Functionally identical.

## Tests

```bash
npm test       # 54 unit tests, ~120ms
npm run smoke  # 20 end-to-end tests, ~15s — boots real unikernels and runs MCP
               # protocol against unitask mcp via the official SDK client
```

## License

MIT.

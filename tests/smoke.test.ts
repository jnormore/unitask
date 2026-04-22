import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:net";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const execFileP = promisify(execFile);

const CLI = join(process.cwd(), "dist", "cli.js");

async function runUnitask(
  args: string[],
  expectExit: "any" | number = "any",
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec("node", [CLI, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
    if (expectExit !== "any" && expectExit !== 0) {
      throw new Error(`expected exit ${expectExit}, got 0. stdout: ${stdout}`);
    }
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    if (typeof e.code === "number") {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
    }
    throw e;
  }
}

describe("smoke: unitask end-to-end", () => {
  it("default-deny blocks fetch (no --allow-net)", async () => {
    const { stdout, code } = await runUnitask([
      "run",
      "--code",
      `fetch("https://api.github.com/zen").then(r => r.text()).then(t => console.log("LEAK:", t)).catch(e => console.log("blocked:", e.code || e.message));`,
      "--timeout",
      "15",
    ]);
    expect(stdout).toContain("blocked:");
    expect(stdout).not.toContain("LEAK");
    expect(code).toBe(0);
  });

  it("--allow-net <host> reaches the allowed host", async () => {
    const { stdout, code } = await runUnitask([
      "run",
      "--allow-net",
      "api.github.com",
      "--code",
      `fetch("https://api.github.com/zen", { headers: { "User-Agent": "unitask-smoke" } })
        .then(r => r.text())
        .then(t => console.log("STATUS_OK", t.trim()))
        .catch(e => console.log("FAIL:", e.code || e.message));`,
      "--timeout",
      "30",
    ]);
    expect(stdout).toContain("STATUS_OK");
    expect(stdout).not.toContain("FAIL:");
    expect(code).toBe(0);
  });

  it("negotiates HTTP/2 via ALPN when the origin supports it", async () => {
    const { stdout, code } = await runUnitask([
      "run",
      "--allow-net",
      "api.github.com",
      "--code",
      `fetch("https://api.github.com/zen", { headers: { "User-Agent": "unitask-smoke" } })
        .then(r => r.text().then(t => ({ r, t })))
        .then(({ r, t }) => console.log("ALPN=" + r.__alpn + " OK=" + (t.trim().length > 0)))
        .catch(e => console.log("FAIL:", e.code || e.message));`,
      "--timeout",
      "30",
    ]);
    expect(stdout).toContain("ALPN=h2");
    expect(stdout).toContain("OK=true");
    expect(stdout).not.toContain("FAIL:");
    expect(code).toBe(0);
  });

  it("--allow-net blocks unlisted hosts", async () => {
    const { stdout, code } = await runUnitask([
      "run",
      "--allow-net",
      "api.github.com",
      "--code",
      `fetch("https://example.com/", { headers: { "User-Agent": "u" } })
        .then(r => console.log("LEAK:", r.status))
        .catch(e => console.log("blocked:", e.code || e.message));`,
      "--timeout",
      "20",
    ]);
    expect(stdout).toContain("blocked:");
    expect(stdout).toContain("403");
    expect(stdout).not.toContain("LEAK");
    expect(code).toBe(0);
  });

  it("separates worker stdout from worker stderr", async () => {
    const { stdout, code } = await runUnitask([
      "run",
      "--code",
      `console.log("on-stdout"); console.error("on-stderr"); process.exit(0);`,
      "--timeout",
      "15",
      "--json",
    ]);
    // --json mode emits a single JSON object on stdout. Parse it and check
    // that the two streams landed in their own fields.
    const result = JSON.parse(stdout);
    expect(result.stdout).toContain("on-stdout");
    expect(result.stdout).not.toContain("on-stderr");
    expect(result.stderr).toContain("on-stderr");
    expect(result.stderr).not.toContain("on-stdout");
    expect(result.stderr).not.toMatch(/\x01E\x01/);
    expect(code).toBe(0);
  });

  it("propagates worker exit code", async () => {
    const { code } = await runUnitask(
      ["run", "--code", "process.exit(42)", "--timeout", "15"],
      42
    );
    expect(code).toBe(42);
  });

  it("enforces --timeout with exit 124", async () => {
    const { code, stderr } = await runUnitask(
      [
        "run",
        "--code",
        "setTimeout(() => console.log('never'), 60000)",
        "--timeout",
        "3",
      ],
      124
    );
    expect(code).toBe(124);
    expect(stderr).toContain("TIMED OUT");
  });

  it("--file injects host file readable by the worker", async () => {
    const work = await mkdtemp(join(tmpdir(), "unitask-smoke-"));
    const csvPath = join(work, "sales.csv");
    await writeFile(csvPath, "month,total\njan,1000\nfeb,2500\nmar,1800\n", "utf8");
    try {
      const { stdout, code } = await runUnitask([
        "run",
        "--file",
        csvPath,
        "--code",
        `const fs = require("fs");
         const rows = fs.readFileSync("/sales.csv","utf8").trim().split("\\n").slice(1);
         const total = rows.map(r => parseInt(r.split(",")[1],10)).reduce((a,b)=>a+b,0);
         console.log("rows:", rows.length, "total:", total);`,
        "--timeout",
        "20",
      ]);
      expect(stdout).toContain("rows: 3 total: 5300");
      expect(code).toBe(0);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("--dir injects host directory recursively, readable by the worker", async () => {
    const work = await mkdtemp(join(tmpdir(), "unitask-smoke-"));
    const inputDir = join(work, "data");
    await rm(inputDir, { recursive: true, force: true });
    await execFileP("mkdir", ["-p", join(inputDir, "nested")]);
    await writeFile(join(inputDir, "a.txt"), "alpha", "utf8");
    await writeFile(join(inputDir, "nested", "c.txt"), "gamma", "utf8");
    try {
      const { stdout, code } = await runUnitask([
        "run",
        "--dir",
        inputDir,
        "--code",
        `const fs = require("fs");
         console.log("ls:", fs.readdirSync("/data").sort().join(","));
         console.log("a:", fs.readFileSync("/data/a.txt","utf8"));
         console.log("c:", fs.readFileSync("/data/nested/c.txt","utf8"));`,
        "--timeout",
        "20",
      ]);
      expect(stdout).toContain("ls: a.txt,nested");
      expect(stdout).toContain("a: alpha");
      expect(stdout).toContain("c: gamma");
      expect(code).toBe(0);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("--allow-tcp 127.0.0.1:<port> reaches a host-side TCP service", async () => {
    const echo: Server = createServer((sock) => {
      sock.on("data", (c) => sock.write("ECHO:" + c.toString()));
    });
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve())
    );
    const port = (echo.address() as { port: number }).port;
    try {
      const { stdout, code } = await runUnitask([
        "run",
        "--allow-tcp",
        `127.0.0.1:${port}`,
        "--code",
        `const net = require("node:net");
         const s = net.connect({ host: "127.0.0.1", port: ${port} }, () => s.write("ping"));
         s.on("data", c => { console.log("got:", c.toString()); s.end(); });
         s.on("error", e => console.log("ERR:", e.code || e.message));`,
        "--timeout",
        "20",
      ]);
      expect(stdout).toContain("got: ECHO:ping");
      expect(code).toBe(0);
    } finally {
      echo.close();
    }
  });

  it("--allow-tcp blocks ports not in the allowlist", async () => {
    const echo: Server = createServer(() => {});
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve())
    );
    const allowedPort = (echo.address() as { port: number }).port;
    const blockedPort = allowedPort + 1; // very likely free; test doesn't depend on it
    try {
      const { stdout, code } = await runUnitask([
        "run",
        "--allow-tcp",
        `127.0.0.1:${allowedPort}`,
        "--code",
        `const net = require("node:net");
         const s = net.connect({ host: "127.0.0.1", port: ${blockedPort} }, () => console.log("LEAK"));
         s.on("error", e => console.log("blocked:", e.code || e.message));
         setTimeout(() => s.destroy(), 1500);`,
        "--timeout",
        "10",
      ]);
      expect(stdout).not.toContain("LEAK");
      expect(stdout).toContain("blocked:");
      expect(code).toBe(0);
    } finally {
      echo.close();
    }
  });

  it("rejects malformed --allow-tcp arguments", async () => {
    const { stderr, code } = await runUnitask(
      ["run", "--allow-tcp", "no-port-here", "--code", "x", "--timeout", "5"],
      2
    );
    expect(code).toBe(2);
    expect(stderr).toContain("--allow-tcp");
    expect(stderr).toMatch(/host:port/);
  });

  it("--secret injects env var without persisting value", async () => {
    const tokenValue = "sk-test-must-be-redacted-1234567";
    const { stdout, code } = await runUnitask(
      [
        "run",
        "--secret",
        "DEMO_TOKEN",
        "--code",
        `console.log("len:", process.env.DEMO_TOKEN.length);
         console.log("the token is:", process.env.DEMO_TOKEN);`,
        "--timeout",
        "15",
      ],
      "any",
      { DEMO_TOKEN: tokenValue }
    );

    // Worker saw the real value (length matches)
    expect(stdout).toContain(`len: ${tokenValue.length}`);
    // But the captured stdout has it redacted
    expect(stdout).toContain("the token is: [REDACTED:DEMO_TOKEN]");
    expect(stdout).not.toContain(tokenValue);
    expect(code).toBe(0);

    // And the on-disk run record never has the value
    const runIdMatch = /run id: (r_[a-f0-9]+)/.exec(stdout);
    if (runIdMatch) {
      const runId = runIdMatch[1]!;
      const dir = join(homedir(), ".unitask", "runs", runId);
      const meta = await readFile(join(dir, "meta.json"), "utf8");
      const stdoutLog = await readFile(join(dir, "stdout.log"), "utf8");
      expect(meta).not.toContain(tokenValue);
      expect(stdoutLog).not.toContain(tokenValue);
      expect(meta).toContain('"name": "DEMO_TOKEN"');
    }
  });

  it("rejects --secret when env var is unset", async () => {
    const { stderr, code } = await runUnitask(
      [
        "run",
        "--secret",
        "DEFINITELY_UNSET_ENV_VAR_1234",
        "--code",
        "console.log('x')",
        "--timeout",
        "5",
      ],
      2
    );
    expect(code).toBe(2);
    expect(stderr).toContain("DEFINITELY_UNSET_ENV_VAR_1234");
  });

  it("captures multi-host allowlist correctly", async () => {
    const { stdout, code } = await runUnitask([
      "run",
      "--allow-net",
      "api.github.com",
      "--allow-net",
      "www.wikipedia.org",
      "--code",
      `(async () => {
         const r1 = await fetch("https://api.github.com/zen", { headers: {"User-Agent":"u"} }).catch(e => ({status: "ERR " + e.message}));
         const r2 = await fetch("https://www.wikipedia.org/", { headers: {"User-Agent":"u"} }).catch(e => ({status: "ERR " + e.message}));
         const r3 = await fetch("https://example.com/", { headers: {"User-Agent":"u"} }).catch(e => ({status: "ERR " + e.message}));
         console.log("github:", r1.status);
         console.log("wiki:", r2.status);
         console.log("example:", r3.status);
       })();`,
      "--timeout",
      "30",
    ]);
    expect(stdout).toMatch(/github: 200/);
    expect(stdout).toMatch(/wiki: 200/);
    expect(stdout).toMatch(/example: ERR/);
    expect(code).toBe(0);
  });
});

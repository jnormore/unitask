import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, stat, copyFile, cp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, join } from "node:path";
import type { SandboxRuntime } from "./runtime.js";
import type { WorkerSpec, ExecutionPolicy, RunResult } from "./types.js";
import {
  startNetworkSidecars,
  PROXY_VM_IP,
  PROXY_VM_PORT,
  type NetLogEntry,
} from "./proxy/index.js";

import { preflight } from "./preflight.js";
import { redactSecrets } from "./redact.js";
import {
  qemuBinaryFor,
  cpuFor,
  machineArgs,
  type Accel,
  type Platform,
} from "./platform.js";

const NODE_PACKAGE = "eyberg/node:20.5.0";

// Prepended to every worker. Provides:
// 1. A minimal proxied fetch() that tunnels via HTTP CONNECT if HTTPS_PROXY
//    is set (since Node 20's built-in fetch doesn't honor the env var and
//    `require('undici')` isn't available in the Nanos Node image).
// 2. A net.connect/net.createConnection/Socket.prototype.connect override that
//    consults UNITASK_TCP_MAP to redirect allowed (host:port) -> virtual
//    in-VM addresses that QEMU's guestfwd bridges back to the real upstream.
// 3. An exit marker so unitask can recover the worker's real exit code
//    across the QEMU boundary.
const HARNESS = `(() => {
  // --- stderr redirect via tagged stdout ---
  // Nanos virtio-console is single-channel so there's no separate /dev/hvc1
  // for stderr. We multiplex: each full stderr line is rewritten onto stdout
  // with a "\\x01E\\x01" prefix. Host-side splits by line, strips the marker.
  // Partial (non-newline-terminated) writes are buffered until the next
  // newline or process exit, so ordering within a single source stream is
  // preserved. The marker bytes are low-ASCII control chars that should never
  // appear in real Node program output.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  let stderrTail = '';
  const flushLines = (buf) => {
    let out = '';
    let idx;
    while ((idx = buf.indexOf('\\n')) !== -1) {
      out += '\\x01E\\x01' + buf.slice(0, idx) + '\\n';
      buf = buf.slice(idx + 1);
    }
    if (out) origStdoutWrite(out);
    return buf;
  };
  process.stderr.write = function(chunk, encoding, cb) {
    const s = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    stderrTail = flushLines(stderrTail + s);
    if (typeof encoding === 'function') encoding();
    else if (cb) cb();
    return true;
  };
  process.on('exit', () => {
    if (stderrTail) {
      origStdoutWrite('\\x01E\\x01' + stderrTail + '\\n');
      stderrTail = '';
    }
  });
})();
(() => {
  // --- raw TCP redirect (--allow-tcp) ---
  let tcpMap = {};
  try { tcpMap = JSON.parse(process.env.UNITASK_TCP_MAP || '{}'); } catch {}
  if (Object.keys(tcpMap).length > 0) {
    const net = require('node:net');
    const remap = (opts) => {
      if (!opts || typeof opts !== 'object') return opts;
      const host = opts.host || opts.hostname;
      const port = opts.port;
      if (host == null || port == null) return opts;
      const key = host + ':' + port;
      const target = tcpMap[key];
      if (!target) return opts;
      const sep = target.lastIndexOf(':');
      return Object.assign({}, opts, {
        host: target.slice(0, sep),
        hostname: target.slice(0, sep),
        port: parseInt(target.slice(sep + 1), 10),
      });
    };
    const remapArgs = (args) => {
      if (typeof args[0] === 'object') {
        args[0] = remap(args[0]);
      } else if (typeof args[0] === 'number' && typeof args[1] === 'string') {
        const key = args[1] + ':' + args[0];
        const target = tcpMap[key];
        if (target) {
          const sep = target.lastIndexOf(':');
          args[1] = target.slice(0, sep);
          args[0] = parseInt(target.slice(sep + 1), 10);
        }
      }
      return args;
    };
    const origConnect = net.connect;
    net.connect = function(...args) { return origConnect.apply(net, remapArgs(args)); };
    net.createConnection = net.connect;
    const origSockConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function(...args) { return origSockConnect.apply(this, remapArgs(args)); };
  }

  // --- proxied fetch (--allow-net) ---
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  const http = require('node:http');
  const tls = require('node:tls');
  const h2 = require('node:http2');
  const H2_FORBIDDEN = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
  const proxyUrl = new URL(proxy);
  const proxyHost = proxyUrl.hostname;
  const proxyPort = parseInt(proxyUrl.port, 10) || 8080;

  const readAll = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

  const parseResponse = (buf) => {
    const hdrEnd = buf.indexOf(Buffer.from('\\r\\n\\r\\n'));
    const headerBuf = hdrEnd === -1 ? buf : buf.subarray(0, hdrEnd);
    const body = hdrEnd === -1 ? Buffer.alloc(0) : buf.subarray(hdrEnd + 4);
    const lines = headerBuf.toString('ascii').split('\\r\\n');
    const first = lines[0] || '';
    const m = /HTTP\\/[0-9.]+ (\\d+)(?: (.+))?/.exec(first);
    const status = m ? parseInt(m[1], 10) : 0;
    const statusText = m && m[2] ? m[2] : '';
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':');
      if (idx > 0) {
        headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
      }
    }
    return { status, statusText, headers, body };
  };

  const doProxiedFetch = async (target, init) => {
    init = init || {};
    const u = new URL(typeof target === 'string' ? target : target.url);
    const isHttps = u.protocol === 'https:';
    const originPort = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname + u.search;
    const headers = Object.assign({}, init.headers || {});
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) {
      headers['Host'] = u.host;
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'connection')) {
      headers['Connection'] = 'close';
    }
    const body = init.body ? (Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body))) : null;
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length);
    }

    const writeRequest = (sock, reqPath) => {
      let req = method + ' ' + reqPath + ' HTTP/1.1\\r\\n';
      for (const [k, v] of Object.entries(headers)) {
        req += k + ': ' + v + '\\r\\n';
      }
      req += '\\r\\n';
      sock.write(req);
      if (body) sock.write(body);
    };

    const makeResponse = (parsed) => ({
      status: parsed.status,
      statusText: parsed.statusText,
      ok: parsed.status >= 200 && parsed.status < 300,
      headers: { get: (k) => parsed.headers[k.toLowerCase()] ?? null },
      // Non-standard debug surface: which ALPN protocol carried the response.
      // Useful for tests and for agents reasoning about transport. Prefixed
      // with __ to flag "unstable, unitask-specific".
      __alpn: parsed.alpn || 'http/1.1',
      text: async () => parsed.body.toString('utf8'),
      json: async () => JSON.parse(parsed.body.toString('utf8')),
      arrayBuffer: async () => parsed.body.buffer.slice(parsed.body.byteOffset, parsed.body.byteOffset + parsed.body.length),
    });

    const doH2Request = (tlsSock) => new Promise((resolve, reject) => {
      const session = h2.connect(u.origin, { createConnection: () => tlsSock });
      session.once('error', reject);
      const h2Headers = {
        ':method': method,
        ':path': path,
        ':scheme': 'https',
        ':authority': u.host,
      };
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (H2_FORBIDDEN.has(lk)) continue;
        h2Headers[lk] = v;
      }
      const stream = session.request(h2Headers, { endStream: !body });
      stream.once('error', reject);
      let status = 0;
      const respHeaders = {};
      stream.on('response', (rh) => {
        status = rh[':status'] || 0;
        for (const [k, v] of Object.entries(rh)) {
          if (k[0] === ':') continue;
          respHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        }
      });
      const chunks = [];
      stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        try { session.close(); } catch {}
        resolve(makeResponse({ status, statusText: '', headers: respHeaders, body: bodyBuf, alpn: 'h2' }));
      });
      if (body) stream.end(body);
    });

    if (isHttps) {
      return await new Promise((resolve, reject) => {
        const connectReq = http.request({
          host: proxyHost, port: proxyPort, method: 'CONNECT',
          path: u.hostname + ':' + originPort,
          headers: { Host: u.hostname + ':' + originPort },
        });
        connectReq.once('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            reject(new Error('proxy CONNECT returned ' + res.statusCode));
            return;
          }
          const tlsSock = tls.connect({ socket, host: u.hostname, servername: u.hostname, ALPNProtocols: ['h2', 'http/1.1'] }, () => {
            if (tlsSock.alpnProtocol === 'h2') {
              doH2Request(tlsSock).then(resolve, reject);
            } else {
              writeRequest(tlsSock, path);
              readAll(tlsSock).then((buf) => resolve(makeResponse(parseResponse(buf)))).catch(reject);
            }
          });
          tlsSock.once('error', reject);
        });
        connectReq.once('error', reject);
        connectReq.end();
      });
    } else {
      return await new Promise((resolve, reject) => {
        const sock = require('node:net').connect({ host: proxyHost, port: proxyPort }, () => {
          writeRequest(sock, target); // absolute URI for plain HTTP via proxy
        });
        sock.once('error', reject);
        readAll(sock).then((buf) => resolve(makeResponse(parseResponse(buf)))).catch(reject);
      });
    }
  };

  globalThis.fetch = doProxiedFetch;
})();
process.on('exit', (code) => {
  try { process.stdout.write('\\n[__unitask_exit__:' + (code == null ? 0 : code) + ']\\n'); } catch {}
});
`;

const EXIT_MARKER_RE = /\[__unitask_exit__:(-?\d+)\]/g;

const IMAGES_DIR = join(homedir(), ".ops", "images");

let cachedEnv: {
  kernelPath: string;
  platform: Platform;
  accel: Accel;
} | null = null;

async function resolveRuntimeEnv(): Promise<{
  kernelPath: string;
  platform: Platform;
  accel: Accel;
}> {
  if (cachedEnv) return cachedEnv;
  const report = await preflight();
  if (!report.ok || !report.kernelPath || !report.platform || !report.accel) {
    const { preflightErrorMessage } = await import("./preflight.js");
    throw new Error(preflightErrorMessage(report));
  }
  cachedEnv = {
    kernelPath: report.kernelPath,
    platform: report.platform,
    accel: report.accel,
  };
  return cachedEnv;
}

function opsBin(): string {
  return join(homedir(), ".ops", "bin");
}

function envWithOps(): NodeJS.ProcessEnv {
  const path = `${opsBin()}:${process.env.PATH ?? ""}`;
  return { ...process.env, PATH: path };
}

export type NanosRunResult = RunResult & {
  netlog?: NetLogEntry[];
};

export class NanosRuntime implements SandboxRuntime {
  readonly name = "nanos";

  async run(
    spec: WorkerSpec,
    policy: ExecutionPolicy,
    runId: string
  ): Promise<NanosRunResult> {
    if (spec.language !== "node") {
      throw new Error(
        `Unsupported language '${spec.language}'. Only 'node' is supported in v0.3.`
      );
    }

    const { kernelPath, platform, accel } = await resolveRuntimeEnv();
    const workDir = await mkdtemp(join(tmpdir(), "unitask-"));
    const codePath = join(workDir, "worker.js");
    await writeFile(codePath, HARNESS + spec.code, "utf8");
    void spec; // codeFile path is implicit (always "worker.js") inside the image

    // Stage input files and dirs into the work dir under their basenames so
    // the ops config's `Files` / `Dirs` entries are clean relative paths.
    // Reject collisions across files, dirs, and our reserved names.
    const stagedFiles: string[] = [];
    const stagedDirs: string[] = [];
    const reserved = new Set(["worker.js", "_unitask.json"]);
    const taken = new Set(reserved);
    for (const src of spec.inputFiles ?? []) {
      const base = basename(src);
      if (taken.has(base)) {
        throw new Error(
          `--file ${src}: name '${base}' collides with another input or a reserved name`
        );
      }
      try {
        await copyFile(src, join(workDir, base));
      } catch (e) {
        throw new Error(`--file ${src}: ${(e as Error).message ?? e}`);
      }
      stagedFiles.push(base);
      taken.add(base);
    }
    for (const src of spec.inputDirs ?? []) {
      const base = basename(src);
      if (taken.has(base)) {
        throw new Error(
          `--dir ${src}: name '${base}' collides with another input or a reserved name`
        );
      }
      try {
        const st = await stat(src);
        if (!st.isDirectory()) {
          throw new Error(`not a directory`);
        }
        await cp(src, join(workDir, base), { recursive: true });
      } catch (e) {
        throw new Error(`--dir ${src}: ${(e as Error).message ?? e}`);
      }
      stagedDirs.push(base);
      taken.add(base);
    }

    const imageName = `unitask-${runId}`;
    const imagePath = join(IMAGES_DIR, imageName);

    const start = Date.now();
    let timedOut = false;

    // Spin up network sidecars iff the policy declares any allowed HTTP hosts.
    let sidecars: Awaited<ReturnType<typeof startNetworkSidecars>> | null = null;
    if (policy.allowedHosts.length > 0) {
      sidecars = await startNetworkSidecars(policy.allowedHosts);
    }

    // Build TCP forward table for --allow-tcp entries. Each entry gets its own
    // virtual guest IP (10.0.2.101, 10.0.2.102, …) on the same port so the
    // worker's net.connect rewrite preserves the original port number.
    const tcpForwards: Array<{
      target: { host: string; port: number };
      guestIp: string;
    }> = policy.allowedTcp.map((target, i) => ({
      target,
      guestIp: `10.0.2.${101 + i}`,
    }));
    const tcpMap: Record<string, string> = {};
    for (const f of tcpForwards) {
      tcpMap[`${f.target.host}:${f.target.port}`] = `${f.guestIp}:${f.target.port}`;
    }

    try {
      const extraEnv: Record<string, string> = {};
      if (sidecars) {
        const proxyUrl = `http://${PROXY_VM_IP}:${PROXY_VM_PORT}`;
        extraEnv["HTTPS_PROXY"] = proxyUrl;
        extraEnv["HTTP_PROXY"] = proxyUrl;
      }
      if (tcpForwards.length > 0) {
        extraEnv["UNITASK_TCP_MAP"] = JSON.stringify(tcpMap);
      }
      for (const s of policy.secrets) {
        extraEnv[s.name] = s.value;
      }

      await buildImage({
        codeFile: codePath,
        imageName,
        cwd: workDir,
        env: extraEnv,
        files: stagedFiles,
        dirs: stagedDirs,
      });

      const networkConfig: NetworkConfig =
        sidecars || tcpForwards.length > 0
          ? {
              mode: "allowlisted",
              proxyHostPort: sidecars ? sidecars.proxyPort : null,
              tcpForwards,
            }
          : { mode: "none" };

      const { rawStdout, exitCode } = await bootImage({
        kernelPath,
        imagePath,
        memoryMb: policy.memoryMb,
        network: networkConfig,
        timeoutSeconds: policy.timeoutSeconds,
        platform,
        accel,
        onTimeout: () => {
          timedOut = true;
        },
      });

      // Split the single-channel console into stdout vs. stderr using the
      // harness's \x01E\x01 line markers, then strip kernel noise from the
      // stdout side only (kernel logs always arrive untagged).
      const { stdout: rawWorkerStdout, stderr: rawWorkerStderr } =
        splitStderr(rawStdout);
      const { stdoutClean, workerExitCode } = extractWorkerExit(
        filterKernelNoise(rawWorkerStdout)
      );

      let finalExitCode: number;
      if (timedOut) {
        finalExitCode = 124;
      } else if (workerExitCode != null) {
        finalExitCode = workerExitCode;
      } else {
        finalExitCode = exitCode === 0 ? 1 : exitCode;
      }

      const redactedStdout = redactSecrets(stdoutClean, policy.secrets);
      const redactedStderr = redactSecrets(rawWorkerStderr.trim(), policy.secrets);

      return {
        runId,
        exitCode: finalExitCode,
        stdout: redactedStdout,
        stderr: redactedStderr,
        durationMs: Date.now() - start,
        timedOut,
        runtime: this.name,
        netlog: sidecars ? sidecars.log : undefined,
      };
    } finally {
      if (sidecars) await sidecars.close();
      await rm(workDir, { recursive: true, force: true });
      await deleteImageIfExists(imagePath);
    }
  }
}

type NetworkConfig =
  | { mode: "none" }
  | {
      mode: "allowlisted";
      /** Host port of the per-run HTTP CONNECT proxy, or null if --allow-net
       *  wasn't passed (allowlist may be raw-TCP-only). */
      proxyHostPort: number | null;
      tcpForwards: Array<{
        target: { host: string; port: number };
        guestIp: string;
      }>;
    };

async function buildImage(opts: {
  codeFile: string;
  imageName: string;
  cwd: string;
  env?: Record<string, string>;
  /** File basenames (relative to opts.cwd) to copy into the image. */
  files?: string[];
  /** Directory basenames (relative to opts.cwd) to copy recursively. */
  dirs?: string[];
}): Promise<void> {
  // Use a per-run ops config file. Args/Env/Files/Dirs give us clean control
  // vs. stacking up `-a` flags (which double as argv pollution and only
  // auto-copy the entrypoint).
  const config: {
    Args: string[];
    Env: Record<string, string>;
    Files?: string[];
    Dirs?: string[];
  } = {
    Args: ["worker.js"],
    Env: opts.env ?? {},
  };
  if (opts.files && opts.files.length > 0) {
    config.Files = opts.files;
  }
  if (opts.dirs && opts.dirs.length > 0) {
    config.Dirs = opts.dirs;
  }

  const configPath = join(opts.cwd, "_unitask.json");
  // mode 0o600: this file carries resolved --secret values as env entries for
  // the ~hundred-millisecond window before `ops image create` consumes it and
  // the enclosing temp dir gets rm'd. Keep it unreadable to other users on
  // the host for that window.
  await writeFile(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });

  const args = [
    "image",
    "create",
    "--package",
    NODE_PACKAGE,
    "-c",
    "_unitask.json",
    "-i",
    opts.imageName,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ops", args, {
      cwd: opts.cwd,
      env: envWithOps(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.stdout.on("data", () => {});

    proc.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ops image create exited ${code}: ${stderr.trim()}`));
    });
    proc.once("error", (e: Error) => reject(e));
  });
}

function bootImage(opts: {
  kernelPath: string;
  imagePath: string;
  memoryMb: number;
  network: NetworkConfig;
  timeoutSeconds: number;
  platform: Platform;
  accel: Accel;
  onTimeout: () => void;
}): Promise<{ rawStdout: string; rawStderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = qemuArgs({
      kernelPath: opts.kernelPath,
      imagePath: opts.imagePath,
      memoryMb: opts.memoryMb,
      network: opts.network,
      platform: opts.platform,
      accel: opts.accel,
    });

    const proc = spawn(qemuBinaryFor(opts.platform.arch), args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      opts.onTimeout();
      if (proc.pid != null) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }
    }, opts.timeoutSeconds * 1000);

    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve({ rawStdout: stdout, rawStderr: stderr, exitCode: code ?? -1 });
    });
    proc.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function qemuArgs(opts: {
  kernelPath: string;
  imagePath: string;
  memoryMb: number;
  network: NetworkConfig;
  platform: Platform;
  accel: Accel;
}): string[] {
  const base = [
    ...machineArgs(opts.platform.arch),
    "-kernel",
    opts.kernelPath,
    "-drive",
    `file=${opts.imagePath},format=raw,if=none,id=hd0`,
    "-device",
    "virtio-blk-pci,drive=hd0",
    "-device",
    "virtio-rng-pci",
    "-device",
    "virtio-balloon",
    "-accel",
    opts.accel,
    "-cpu",
    cpuFor(opts.platform.arch, opts.accel),
    "-m",
    `${opts.memoryMb}M`,
    "-display",
    "none",
    "-serial",
    "stdio",
    "-no-reboot",
  ];

  // NB: we deliberately do NOT pass `-semihosting` on arm64. Semihosting lets
  // the guest request host-level services — including SYS_OPEN / SYS_READ /
  // SYS_WRITE against the host filesystem — through HLT-trap instructions. For
  // a sandbox whose whole job is to keep an untrusted worker off the host,
  // that's the wrong direction. x86_64 doesn't use it; arm64 boots fine
  // without it. If a future Nanos build needs it, pin the flag via
  // `-semihosting-config enable=on,target=native,chardev=null,arg=` with an
  // explicit no-op chardev rather than enabling the default stdio surface.

  if (opts.network.mode === "none") {
    base.push("-nic", "none");
    return base;
  }

  // Allowlisted mode: SLIRP user-mode networking with restrict=on. Per-run
  // guestfwd entries:
  //   - HTTPS proxy at 10.0.2.100:8080 (only if --allow-net was passed)
  //   - one entry per --allow-tcp target at 10.0.2.{101+N}:<port>, bridged
  //     via `nc <host> <port>` to the real upstream
  // restrict=on dead-ends any other socket attempt the worker might make.
  const { proxyHostPort, tcpForwards } = opts.network;
  const netdevParts = ["user", "id=n0", "restrict=on"];
  if (proxyHostPort != null) {
    netdevParts.push(
      `guestfwd=tcp:${PROXY_VM_IP}:${PROXY_VM_PORT}-cmd:nc 127.0.0.1 ${proxyHostPort}`
    );
  }
  for (const f of tcpForwards) {
    netdevParts.push(
      `guestfwd=tcp:${f.guestIp}:${f.target.port}-cmd:nc ${validateHost(f.target.host)} ${f.target.port}`
    );
  }

  base.push(
    "-netdev",
    netdevParts.join(","),
    "-device",
    "virtio-net,netdev=n0,mac=52:54:00:12:34:56"
  );

  return base;
}

function validateHost(s: string): string {
  // QEMU's `cmd:` guestfwd runs the command through /bin/sh -c, so the host
  // token ends up as an unquoted shell word. We don't quote it; we reject
  // anything outside [A-Za-z0-9._-] so there's nothing for the shell to
  // interpret. This is the last line of defense for --allow-tcp input that
  // originated from an (untrusted) MCP caller.
  if (!/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`refusing to forward to malformed host: ${s}`);
  }
  return s;
}

async function deleteImageIfExists(imagePath: string): Promise<void> {
  try {
    await stat(imagePath);
  } catch {
    return;
  }
  await rm(imagePath, { force: true });
}

export function extractWorkerExit(stdout: string): {
  stdoutClean: string;
  workerExitCode: number | null;
} {
  const matches = [...stdout.matchAll(EXIT_MARKER_RE)];
  const last = matches[matches.length - 1];
  const workerExitCode = last ? parseInt(last[1]!, 10) : null;
  const stdoutClean = stdout
    .replace(EXIT_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { stdoutClean, workerExitCode };
}

export function filterKernelNoise(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      if (/^\[\d+\.\d+\]/.test(line)) return false;
      return true;
    })
    .join("\n");
}

// Parses the single console stream from the unikernel into separate stdout
// and stderr buffers. The harness tags each stderr line with "\x01E\x01"; this
// splits the raw stream by newline, routes tagged lines to stderr (stripping
// the marker), and leaves everything else on stdout. Trailing non-newline
// content is kept on stdout (kernel noise / exit marker fallback).
export function splitStderr(raw: string): { stdout: string; stderr: string } {
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const nl = raw.indexOf("\n", i);
    if (nl === -1) {
      stdoutParts.push(raw.slice(i));
      break;
    }
    const line = raw.slice(i, nl);
    if (line.startsWith("\x01E\x01")) {
      stderrParts.push(line.slice(3) + "\n");
    } else {
      stdoutParts.push(line + "\n");
    }
    i = nl + 1;
  }
  return { stdout: stdoutParts.join(""), stderr: stderrParts.join("") };
}

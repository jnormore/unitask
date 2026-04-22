import { createServer, connect, type Socket, type Server } from "node:net";

export type HttpProxyLogEntry = {
  ts: string;
  kind: "proxy";
  method: "CONNECT" | "HTTP" | "UNKNOWN";
  host: string | null;
  port: number;
  allowed: boolean;
  reason?: string;
  bytesUp: number;
  bytesDown: number;
  durationMs: number;
};

export type HttpProxyOptions = {
  bindHost: string;
  allowlist: string[];
  onLog: (entry: HttpProxyLogEntry) => void;
};

export type RunningHttpProxy = {
  port: number;
  close: () => Promise<void>;
};

export async function startHttpProxy(
  opts: HttpProxyOptions
): Promise<RunningHttpProxy> {
  const allow = new Set(opts.allowlist.map((h) => h.toLowerCase()));

  const server: Server = createServer((client: Socket) => {
    handleConnection(client, allow, opts.onLog).catch(() => {
      try {
        client.destroy();
      } catch {}
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, opts.bindHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleConnection(
  client: Socket,
  allow: Set<string>,
  onLog: (e: HttpProxyLogEntry) => void
): Promise<void> {
  const start = Date.now();
  let bytesUp = 0;
  let bytesDown = 0;

  let headerChunk: Buffer;
  try {
    headerChunk = await readUntilHeaderEnd(client, 8192, 3000);
  } catch {
    onLog({
      ts: new Date().toISOString(),
      kind: "proxy",
      method: "UNKNOWN",
      host: null,
      port: 0,
      allowed: false,
      reason: "no-headers",
      bytesUp: 0,
      bytesDown: 0,
      durationMs: Date.now() - start,
    });
    client.destroy();
    return;
  }

  const parsed = parseRequest(headerChunk);
  if (!parsed) {
    onLog({
      ts: new Date().toISOString(),
      kind: "proxy",
      method: "UNKNOWN",
      host: null,
      port: 0,
      allowed: false,
      reason: "malformed-request",
      bytesUp: headerChunk.length,
      bytesDown: 0,
      durationMs: Date.now() - start,
    });
    client.destroy();
    return;
  }

  const allowed = allow.has(parsed.host.toLowerCase());
  if (!allowed) {
    onLog({
      ts: new Date().toISOString(),
      kind: "proxy",
      method: parsed.method,
      host: parsed.host,
      port: parsed.port,
      allowed: false,
      reason: "not-in-allowlist",
      bytesUp: headerChunk.length,
      bytesDown: 0,
      durationMs: Date.now() - start,
    });
    try {
      client.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "Content-Length: 26\r\n" +
          "Connection: close\r\n\r\n" +
          "unitask: host not allowed\n"
      );
    } catch {}
    client.destroy();
    return;
  }

  const upstream: Socket = connect({ host: parsed.host, port: parsed.port });

  upstream.on("error", () => {
    try {
      client.destroy();
    } catch {}
  });
  client.on("error", () => {
    try {
      upstream.destroy();
    } catch {}
  });

  await new Promise<void>((resolve) => {
    upstream.once("connect", () => resolve());
    upstream.once("error", () => resolve());
  });

  if (upstream.destroyed || !upstream.writable) {
    onLog({
      ts: new Date().toISOString(),
      kind: "proxy",
      method: parsed.method,
      host: parsed.host,
      port: parsed.port,
      allowed: true,
      reason: "upstream-failed",
      bytesUp: headerChunk.length,
      bytesDown: 0,
      durationMs: Date.now() - start,
    });
    try {
      client.write(
        "HTTP/1.1 502 Bad Gateway\r\n" +
          "Content-Length: 30\r\n" +
          "Connection: close\r\n\r\n" +
          "unitask: upstream connect failed\n"
      );
    } catch {}
    client.destroy();
    return;
  }

  if (parsed.method === "CONNECT") {
    // Acknowledge the tunnel to the client.
    try {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } catch {}
    // Forward any leftover bytes that came after the CONNECT line.
    if (parsed.leftover.length > 0) {
      upstream.write(parsed.leftover);
      bytesUp += parsed.leftover.length;
    }
  } else {
    // Plain HTTP: replay the already-read headers (rewritten to strip proxy absolute URI).
    const rewritten = parsed.rewrittenFirstRequest ?? headerChunk;
    upstream.write(rewritten);
    bytesUp += rewritten.length;
  }

  client.on("data", (chunk: Buffer) => {
    bytesUp += chunk.length;
    if (!upstream.write(chunk)) client.pause();
  });
  upstream.on("drain", () => client.resume());

  upstream.on("data", (chunk: Buffer) => {
    bytesDown += chunk.length;
    if (!client.write(chunk)) upstream.pause();
  });
  client.on("drain", () => upstream.resume());

  client.on("end", () => upstream.end());
  upstream.on("end", () => client.end());

  let logged = false;
  const finish = () => {
    if (logged) return;
    logged = true;
    onLog({
      ts: new Date().toISOString(),
      kind: "proxy",
      method: parsed.method,
      host: parsed.host,
      port: parsed.port,
      allowed: true,
      bytesUp,
      bytesDown,
      durationMs: Date.now() - start,
    });
  };
  client.on("close", finish);
  upstream.on("close", finish);
}

export type ParsedRequest = {
  method: "CONNECT" | "HTTP";
  host: string;
  port: number;
  leftover: Buffer;
  rewrittenFirstRequest?: Buffer;
};

export function parseRequest(buf: Buffer): ParsedRequest | null {
  const end = buf.indexOf("\r\n\r\n");
  if (end === -1) return null;
  const headerText = buf.subarray(0, end + 2).toString("ascii"); // include the trailing \r\n
  const leftover = buf.subarray(end + 4);

  const firstLineEnd = headerText.indexOf("\r\n");
  if (firstLineEnd === -1) return null;
  const firstLine = headerText.substring(0, firstLineEnd);
  const firstLineParts = firstLine.split(" ");
  if (firstLineParts.length < 3) return null;

  const method = firstLineParts[0]!.toUpperCase();
  const target = firstLineParts[1]!;

  if (method === "CONNECT") {
    const [host, portStr] = target.split(":");
    if (!host || !portStr) return null;
    const port = parseInt(portStr, 10);
    if (isNaN(port)) return null;
    return {
      method: "CONNECT",
      host: host.toLowerCase(),
      port,
      leftover,
    };
  }

  // Regular HTTP proxy: "GET http://example.com/path HTTP/1.1"
  if (target.startsWith("http://") || target.startsWith("https://")) {
    try {
      const url = new URL(target);
      const host = url.hostname.toLowerCase();
      const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
      // Rewrite request to be origin-form (strip the absolute URI).
      const pathAndQuery = (url.pathname || "/") + url.search;
      const newFirstLine = `${method} ${pathAndQuery} ${firstLineParts.slice(2).join(" ")}`;
      const restHeaders = headerText.substring(firstLineEnd); // starts with \r\n
      const rewritten = Buffer.concat([
        Buffer.from(newFirstLine, "ascii"),
        Buffer.from(restHeaders, "ascii"),
        Buffer.from("\r\n", "ascii"),
        leftover,
      ]);
      return {
        method: "HTTP",
        host,
        port,
        leftover: Buffer.alloc(0),
        rewrittenFirstRequest: rewritten,
      };
    } catch {
      return null;
    }
  }

  // Origin-form with Host header (shouldn't usually happen for a proxy, but handle it)
  const hostMatch = /\r\nHost:[ \t]*([^\r\n]+)/i.exec(headerText);
  if (hostMatch) {
    const rawHost = hostMatch[1]!.trim();
    const [host, portStr] = rawHost.split(":");
    const port = portStr ? parseInt(portStr, 10) : 80;
    return {
      method: "HTTP",
      host: host!.toLowerCase(),
      port,
      leftover,
      rewrittenFirstRequest: buf,
    };
  }

  return null;
}

function readUntilHeaderEnd(
  socket: Socket,
  maxBytes: number,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("header read timeout"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      const merged = Buffer.concat(chunks, total);
      if (merged.indexOf("\r\n\r\n") !== -1) {
        clearTimeout(timer);
        cleanup();
        resolve(merged);
      } else if (total >= maxBytes) {
        clearTimeout(timer);
        cleanup();
        reject(new Error("headers too large"));
      }
    };
    const onEnd = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("closed before headers"));
    };
    const onError = (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    };

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

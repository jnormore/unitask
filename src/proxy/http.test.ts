import { describe, expect, it } from "vitest";
import { parseRequest } from "./http.js";

const buf = (s: string) => Buffer.from(s, "ascii");

describe("parseRequest — CONNECT", () => {
  it("parses a typical CONNECT for HTTPS", () => {
    const r = parseRequest(
      buf(
        "CONNECT api.github.com:443 HTTP/1.1\r\n" +
          "Host: api.github.com:443\r\n" +
          "Proxy-Connection: keep-alive\r\n\r\n"
      )
    );
    expect(r).not.toBeNull();
    expect(r!.method).toBe("CONNECT");
    expect(r!.host).toBe("api.github.com");
    expect(r!.port).toBe(443);
    expect(r!.leftover.length).toBe(0);
  });

  it("normalizes CONNECT host to lowercase", () => {
    const r = parseRequest(buf("CONNECT API.GitHub.COM:443 HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(r!.host).toBe("api.github.com");
  });

  it("parses non-443 ports", () => {
    const r = parseRequest(buf("CONNECT example.com:8443 HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(r!.port).toBe(8443);
  });

  it("preserves bytes after the CONNECT block as leftover", () => {
    const tail = "\x16\x03\x01"; // looks like a TLS handshake start
    const r = parseRequest(
      buf("CONNECT a.com:443 HTTP/1.1\r\nHost: x\r\n\r\n" + tail)
    );
    expect(r!.leftover.toString("ascii")).toBe(tail);
  });

  it("returns null on missing CONNECT target port", () => {
    const r = parseRequest(buf("CONNECT api.github.com HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(r).toBeNull();
  });

  it("returns null on non-numeric port", () => {
    const r = parseRequest(buf("CONNECT a.com:abc HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(r).toBeNull();
  });
});

describe("parseRequest — absolute-URI HTTP proxy", () => {
  it("parses GET with absolute URI", () => {
    const r = parseRequest(
      buf(
        "GET http://example.com/path?q=1 HTTP/1.1\r\n" +
          "Host: example.com\r\n" +
          "User-Agent: x\r\n\r\n"
      )
    );
    expect(r!.method).toBe("HTTP");
    expect(r!.host).toBe("example.com");
    expect(r!.port).toBe(80);
    expect(r!.rewrittenFirstRequest).toBeDefined();
    // The rewritten request must be origin-form (no scheme/host in target)
    expect(r!.rewrittenFirstRequest!.toString("ascii")).toContain(
      "GET /path?q=1 HTTP/1.1"
    );
  });

  it("derives port 443 for https:// absolute URIs", () => {
    const r = parseRequest(
      buf("POST https://api.example.com/x HTTP/1.1\r\nHost: x\r\n\r\n")
    );
    expect(r!.port).toBe(443);
  });

  it("respects explicit port in absolute URI", () => {
    const r = parseRequest(
      buf("GET http://example.com:8080/x HTTP/1.1\r\nHost: x\r\n\r\n")
    );
    expect(r!.port).toBe(8080);
  });
});

describe("parseRequest — origin-form fallback (with Host header)", () => {
  it("uses Host header when target is origin-form", () => {
    const r = parseRequest(
      buf(
        "GET /resource HTTP/1.1\r\n" +
          "Host: example.com\r\n" +
          "User-Agent: x\r\n\r\n"
      )
    );
    expect(r!.host).toBe("example.com");
    expect(r!.port).toBe(80);
  });

  it("parses port from Host header if present", () => {
    const r = parseRequest(buf("GET / HTTP/1.1\r\nHost: example.com:9000\r\n\r\n"));
    expect(r!.host).toBe("example.com");
    expect(r!.port).toBe(9000);
  });
});

describe("parseRequest — malformed input", () => {
  it("returns null on incomplete headers (no \\r\\n\\r\\n)", () => {
    const r = parseRequest(buf("GET / HTTP/1.1\r\nHost: x"));
    expect(r).toBeNull();
  });

  it("returns null on garbled first line", () => {
    const r = parseRequest(buf("garbage\r\n\r\n"));
    expect(r).toBeNull();
  });

  it("returns null on origin-form GET with no Host header", () => {
    const r = parseRequest(buf("GET /x HTTP/1.1\r\nUser-Agent: x\r\n\r\n"));
    expect(r).toBeNull();
  });
});

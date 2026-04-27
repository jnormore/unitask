import { describe, expect, it } from "vitest";
import { applyCeiling, hasAnyDenials, summarizeDenials } from "./ceiling.js";

describe("applyCeiling — null ceiling", () => {
  it("passes the request through unchanged", () => {
    const req = {
      code: "x",
      allowNet: ["a.com"],
      allowTcp: ["1.1.1.1:80"],
      memoryMb: 512,
    };
    const { effective, denials } = applyCeiling(req, null);
    expect(effective).toEqual(req);
    expect(denials).toEqual({});
  });
});

describe("applyCeiling — scalar clamping", () => {
  it("clamps memoryMb when request exceeds ceiling", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", memoryMb: 1024 },
      { memoryMb: 512 }
    );
    expect(effective.memoryMb).toBe(512);
    expect(denials.memoryMb).toBe(1024);
  });

  it("leaves memoryMb alone when within the ceiling", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", memoryMb: 256 },
      { memoryMb: 512 }
    );
    expect(effective.memoryMb).toBe(256);
    expect(denials.memoryMb).toBeUndefined();
  });

  it("doesn't constrain a missing request scalar", () => {
    const { effective } = applyCeiling({ code: "x" }, { memoryMb: 512 });
    expect(effective.memoryMb).toBeUndefined();
  });

  it("clamps timeoutSeconds independently", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", timeoutSeconds: 600 },
      { timeoutSeconds: 60 }
    );
    expect(effective.timeoutSeconds).toBe(60);
    expect(denials.timeoutSeconds).toBe(600);
  });
});

describe("applyCeiling — list intersection", () => {
  it("intersects allowNet (case-insensitive)", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", allowNet: ["api.github.com", "Evil.com", "api.openai.com"] },
      { allowNet: ["api.github.com", "api.openai.com"] }
    );
    expect(effective.allowNet).toEqual(["api.github.com", "api.openai.com"]);
    expect(denials.allowNet).toEqual(["Evil.com"]);
  });

  it("returns empty when nothing in request matches the ceiling", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", allowNet: ["evil.com"] },
      { allowNet: ["api.github.com"] }
    );
    expect(effective.allowNet).toEqual([]);
    expect(denials.allowNet).toEqual(["evil.com"]);
  });

  it("intersects allowTcp by exact host:port match", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", allowTcp: ["127.0.0.1:5432", "127.0.0.1:6379"] },
      { allowTcp: ["127.0.0.1:5432"] }
    );
    expect(effective.allowTcp).toEqual(["127.0.0.1:5432"]);
    expect(denials.allowTcp).toEqual(["127.0.0.1:6379"]);
  });

  it("intersects secrets by exact name", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", secrets: ["GH_TOKEN", "AWS_KEY"] },
      { secrets: ["GH_TOKEN"] }
    );
    expect(effective.secrets).toEqual(["GH_TOKEN"]);
    expect(denials.secrets).toEqual(["AWS_KEY"]);
  });

  it("intersects envs by exact name (separate from secrets)", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", envs: ["MONITOR_URL", "FORBIDDEN_CONFIG"] },
      { envs: ["MONITOR_URL"] }
    );
    expect(effective.envs).toEqual(["MONITOR_URL"]);
    expect(denials.envs).toEqual(["FORBIDDEN_CONFIG"]);
  });

  it("envs ceiling and secrets ceiling are independent", () => {
    const { effective } = applyCeiling(
      { code: "x", secrets: ["GH_TOKEN"], envs: ["MONITOR_URL"] },
      { secrets: ["AWS_KEY"], envs: ["MONITOR_URL"] }
    );
    // Secrets request was fully intersected away, envs survived.
    expect(effective.secrets).toEqual([]);
    expect(effective.envs).toEqual(["MONITOR_URL"]);
  });

  it("doesn't constrain a list field absent from the ceiling", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", allowNet: ["anything.com"] },
      { allowTcp: ["127.0.0.1:5432"] }
    );
    expect(effective.allowNet).toEqual(["anything.com"]);
    expect(denials.allowNet).toBeUndefined();
  });
});

describe("applyCeiling — path-prefix intersection", () => {
  it("allows files under a ceiling prefix and drops the rest", () => {
    const { effective, denials } = applyCeiling(
      {
        code: "x",
        files: [
          "/Users/me/work/data.csv",
          "/Users/me/work/notes.md",
          "/Users/me/secrets/x.csv",
        ],
      },
      { filesUnder: ["/Users/me/work"] }
    );
    expect(effective.files).toEqual([
      "/Users/me/work/data.csv",
      "/Users/me/work/notes.md",
    ]);
    expect(denials.files).toEqual(["/Users/me/secrets/x.csv"]);
  });

  it("treats trailing slash as boundary (no /Users/me/work matching workshop)", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", files: ["/Users/me/workshop/x"] },
      { filesUnder: ["/Users/me/work"] }
    );
    expect(effective.files).toEqual([]);
    expect(denials.files).toEqual(["/Users/me/workshop/x"]);
  });

  it("accepts a ceiling prefix with or without a trailing slash", () => {
    const a = applyCeiling(
      { code: "x", files: ["/Users/me/work/d.csv"] },
      { filesUnder: ["/Users/me/work"] }
    );
    const b = applyCeiling(
      { code: "x", files: ["/Users/me/work/d.csv"] },
      { filesUnder: ["/Users/me/work/"] }
    );
    expect(a.effective.files).toEqual(["/Users/me/work/d.csv"]);
    expect(b.effective.files).toEqual(["/Users/me/work/d.csv"]);
  });

  it("intersects dirs the same way", () => {
    const { effective, denials } = applyCeiling(
      { code: "x", dirs: ["/work/data", "/etc/secrets"] },
      { dirsUnder: ["/work"] }
    );
    expect(effective.dirs).toEqual(["/work/data"]);
    expect(denials.dirs).toEqual(["/etc/secrets"]);
  });
});

describe("hasAnyDenials / summarizeDenials", () => {
  it("returns false for empty denials", () => {
    expect(hasAnyDenials({})).toBe(false);
    expect(summarizeDenials({})).toBe("");
  });

  it("returns true when anything was denied", () => {
    expect(hasAnyDenials({ allowNet: ["x"] })).toBe(true);
    expect(hasAnyDenials({ memoryMb: 1024 })).toBe(true);
  });

  it("formats a human-readable summary", () => {
    const summary = summarizeDenials({
      memoryMb: 1024,
      allowNet: ["evil.com"],
      secrets: ["AWS_KEY"],
    });
    expect(summary).toContain("memory clamped (requested 1024M)");
    expect(summary).toContain("allow-net dropped: evil.com");
    expect(summary).toContain("secrets dropped: AWS_KEY");
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectCeiling, parsePolicyToml } from "./load.js";

describe("parsePolicyToml", () => {
  it("parses a complete policy file", () => {
    const ceiling = parsePolicyToml(
      `memoryMb = 512
       timeoutSeconds = 60
       allowNet = ["api.github.com", "api.openai.com"]
       allowTcp = ["127.0.0.1:5432"]
       secrets = ["GH_TOKEN"]
       filesUnder = ["/work/data"]
       dirsUnder = ["/work/cache"]`,
      "/test/.unitask.toml"
    );
    expect(ceiling).toEqual({
      memoryMb: 512,
      timeoutSeconds: 60,
      allowNet: ["api.github.com", "api.openai.com"],
      allowTcp: ["127.0.0.1:5432"],
      secrets: ["GH_TOKEN"],
      filesUnder: ["/work/data"],
      dirsUnder: ["/work/cache"],
    });
  });

  it("parses a partial policy (missing fields = no constraint)", () => {
    const ceiling = parsePolicyToml(
      `allowNet = ["api.github.com"]`,
      "/test/.unitask.toml"
    );
    expect(ceiling).toEqual({ allowNet: ["api.github.com"] });
    expect(ceiling.memoryMb).toBeUndefined();
  });

  it("rejects unknown fields with a clear error", () => {
    expect(() =>
      parsePolicyToml(`mystery = 42`, "/test/.unitask.toml")
    ).toThrow(/unknown policy field 'mystery'/);
  });

  it("rejects non-integer memoryMb", () => {
    expect(() =>
      parsePolicyToml(`memoryMb = "lots"`, "/test/.unitask.toml")
    ).toThrow(/'memoryMb' must be a positive integer/);
  });

  it("rejects allowNet with non-string entries", () => {
    expect(() =>
      parsePolicyToml(`allowNet = ["ok", 42]`, "/test/.unitask.toml")
    ).toThrow(/'allowNet' must be an array of strings/);
  });

  it("rejects malformed TOML loudly", () => {
    expect(() =>
      parsePolicyToml(`memoryMb = `, "/test/.unitask.toml")
    ).toThrow(/invalid TOML/);
  });
});

describe("findProjectCeiling — directory walk", () => {
  let workRoot: string;
  let projectDir: string;
  let nestedDir: string;
  let outsideDir: string;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "unitask-policy-test-"));
    projectDir = join(workRoot, "project");
    nestedDir = join(projectDir, "src", "deep");
    outsideDir = join(workRoot, "elsewhere");
    await mkdir(nestedDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(projectDir, ".unitask.toml"),
      `allowNet = ["api.example.com"]\nmemoryMb = 256\n`,
      "utf8"
    );
  });

  afterAll(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it("finds .unitask.toml in the start dir", async () => {
    const r = await findProjectCeiling(projectDir);
    expect(r).not.toBeNull();
    expect(r!.ceiling.allowNet).toEqual(["api.example.com"]);
    expect(r!.source).toBe(join(projectDir, ".unitask.toml"));
  });

  it("walks up to find a parent's .unitask.toml", async () => {
    const r = await findProjectCeiling(nestedDir);
    expect(r).not.toBeNull();
    expect(r!.ceiling.memoryMb).toBe(256);
    expect(r!.source).toBe(join(projectDir, ".unitask.toml"));
  });

  it("returns null when no .unitask.toml exists anywhere up", async () => {
    const r = await findProjectCeiling(outsideDir);
    expect(r).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { extractWorkerExit, filterKernelNoise, splitStderr } from "./nanos.js";

describe("extractWorkerExit", () => {
  it("returns null when no marker present", () => {
    const r = extractWorkerExit("hello world\n");
    expect(r.workerExitCode).toBeNull();
    expect(r.stdoutClean).toBe("hello world");
  });

  it("extracts a single marker", () => {
    const r = extractWorkerExit("hello\n[__unitask_exit__:0]\n");
    expect(r.workerExitCode).toBe(0);
    expect(r.stdoutClean).toBe("hello");
  });

  it("uses the last marker when multiple are present", () => {
    const r = extractWorkerExit("a\n[__unitask_exit__:1]\nb\n[__unitask_exit__:42]\n");
    expect(r.workerExitCode).toBe(42);
  });

  it("strips marker from output regardless of position", () => {
    const r = extractWorkerExit("[__unitask_exit__:7]\nhello\n");
    expect(r.workerExitCode).toBe(7);
    expect(r.stdoutClean).toBe("hello");
  });

  it("handles negative exit codes", () => {
    const r = extractWorkerExit("x\n[__unitask_exit__:-1]\n");
    expect(r.workerExitCode).toBe(-1);
  });

  it("collapses runs of blank lines left after stripping", () => {
    const r = extractWorkerExit("a\n\n\n[__unitask_exit__:0]\n\n\nb\n");
    expect(r.stdoutClean).toBe("a\n\nb");
  });
});

describe("splitStderr", () => {
  const MARK = "\x01E\x01";

  it("returns stdout unchanged when no marker present", () => {
    const r = splitStderr("hello\nworld\n");
    expect(r.stdout).toBe("hello\nworld\n");
    expect(r.stderr).toBe("");
  });

  it("extracts a single stderr line", () => {
    const r = splitStderr("a\n" + MARK + "err\nb\n");
    expect(r.stdout).toBe("a\nb\n");
    expect(r.stderr).toBe("err\n");
  });

  it("extracts multiple stderr lines preserving order within each stream", () => {
    const r = splitStderr(
      "stdout1\n" + MARK + "e1\nstdout2\n" + MARK + "e2\nstdout3\n"
    );
    expect(r.stdout).toBe("stdout1\nstdout2\nstdout3\n");
    expect(r.stderr).toBe("e1\ne2\n");
  });

  it("keeps trailing non-newline content on stdout", () => {
    const r = splitStderr("hello\nno-newline");
    expect(r.stdout).toBe("hello\nno-newline");
    expect(r.stderr).toBe("");
  });

  it("leaves kernel noise untagged (host-side filter handles it)", () => {
    const r = splitStderr("[0.001] k\n" + MARK + "e\napp\n");
    expect(r.stdout).toBe("[0.001] k\napp\n");
    expect(r.stderr).toBe("e\n");
  });

  it("handles empty input", () => {
    expect(splitStderr("")).toEqual({ stdout: "", stderr: "" });
  });

  it("handles all-stderr input", () => {
    const r = splitStderr(MARK + "a\n" + MARK + "b\n");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("a\nb\n");
  });
});

describe("filterKernelNoise", () => {
  it("strips lines with bracketed timestamps", () => {
    const out = filterKernelNoise(
      "[0.001234] vtbln blah\n" +
        "[0.005678] en1: assigned 10.0.2.15\n" +
        "actual user output\n"
    );
    expect(out).toBe("actual user output\n");
  });

  it("preserves user output that happens to contain brackets", () => {
    const out = filterKernelNoise("[INFO] something happened\nhello\n");
    expect(out).toContain("[INFO] something happened");
    expect(out).toContain("hello");
  });

  it("returns empty string when input is only kernel noise", () => {
    expect(filterKernelNoise("[0.001] a\n[0.002] b\n")).toBe("");
  });

  it("is a no-op for already-clean output", () => {
    expect(filterKernelNoise("hello\nworld\n")).toBe("hello\nworld\n");
  });
});

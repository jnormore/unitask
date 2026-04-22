import { describe, expect, it } from "vitest";
import {
  qemuBinaryFor,
  accelFor,
  fallbackAccel,
  cpuFor,
  kernelDirSuffix,
  machineArgs,
  platformLabel,
} from "./platform.js";

describe("qemuBinaryFor", () => {
  it("returns qemu-system-aarch64 for arm64", () => {
    expect(qemuBinaryFor("arm64")).toBe("qemu-system-aarch64");
  });
  it("returns qemu-system-x86_64 for x64", () => {
    expect(qemuBinaryFor("x64")).toBe("qemu-system-x86_64");
  });
});

describe("accelFor", () => {
  it("returns hvf on darwin", () => {
    expect(accelFor("darwin")).toBe("hvf");
  });
  it("returns kvm on linux", () => {
    expect(accelFor("linux")).toBe("kvm");
  });
});

describe("fallbackAccel", () => {
  it("returns tcg", () => {
    expect(fallbackAccel()).toBe("tcg");
  });
});

describe("cpuFor", () => {
  it("returns 'host' under HVF (arm64)", () => {
    expect(cpuFor("arm64", "hvf")).toBe("host");
  });
  it("returns 'host' under KVM (x64)", () => {
    expect(cpuFor("x64", "kvm")).toBe("host");
  });
  it("returns 'max' under TCG (any arch)", () => {
    expect(cpuFor("arm64", "tcg")).toBe("max");
    expect(cpuFor("x64", "tcg")).toBe("max");
  });
});

describe("kernelDirSuffix", () => {
  it("returns -arm for arm64", () => {
    expect(kernelDirSuffix("arm64")).toBe("-arm");
  });
  it("returns empty string for x64", () => {
    expect(kernelDirSuffix("x64")).toBe("");
  });
});

describe("machineArgs", () => {
  it("includes gic-version=2 for arm64 virt machine", () => {
    expect(machineArgs("arm64")).toEqual([
      "-machine",
      "virt",
      "-machine",
      "gic-version=2",
    ]);
  });
  it("uses q35 for x86_64", () => {
    expect(machineArgs("x64")).toEqual(["-machine", "q35"]);
  });
});

describe("platformLabel", () => {
  it("formats macOS arm64", () => {
    expect(platformLabel({ os: "darwin", arch: "arm64" })).toBe("macOS arm64");
  });
  it("formats Linux x86_64", () => {
    expect(platformLabel({ os: "linux", arch: "x64" })).toBe("Linux x86_64");
  });
  it("formats Linux arm64", () => {
    expect(platformLabel({ os: "linux", arch: "arm64" })).toBe("Linux arm64");
  });
});

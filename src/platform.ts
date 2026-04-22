import { platform as osPlatform, arch as osArch } from "node:os";

export type SupportedOs = "darwin" | "linux";
export type SupportedArch = "arm64" | "x64";

export type Platform = {
  os: SupportedOs;
  arch: SupportedArch;
};

export type PlatformError = {
  os: string;
  arch: string;
  reason: string;
};

export function detectPlatform(): Platform | PlatformError {
  const os = osPlatform();
  const arch = osArch();

  if (os !== "darwin" && os !== "linux") {
    return {
      os,
      arch,
      reason: `unsupported OS '${os}'. v0.4 supports macOS (darwin) and Linux only.`,
    };
  }
  if (arch !== "arm64" && arch !== "x64") {
    return {
      os,
      arch,
      reason: `unsupported architecture '${arch}'. v0.4 supports arm64 and x86_64 (x64).`,
    };
  }
  return { os, arch };
}

export function isPlatformError(p: Platform | PlatformError): p is PlatformError {
  return (p as PlatformError).reason !== undefined;
}

/** QEMU binary name for the target arch (we always run a guest matching the host arch). */
export function qemuBinaryFor(arch: SupportedArch): string {
  return arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

export type Accel = "hvf" | "kvm" | "tcg";

/** Default QEMU acceleration backend for the host OS, assuming hardware
 *  virtualization is available. Linux falls back to "tcg" via {@link
 *  fallbackAccel} when /dev/kvm is missing (e.g. inside a Docker container
 *  on a non-Linux host). */
export function accelFor(os: SupportedOs): Accel {
  return os === "darwin" ? "hvf" : "kvm";
}

export function fallbackAccel(): Accel {
  return "tcg";
}

/** -cpu argument for QEMU. `host` only works under hardware virtualization
 *  (KVM/HVF). TCG software emulation needs a concrete CPU model. */
export function cpuFor(arch: SupportedArch, accel: Accel): string {
  if (accel === "tcg") {
    // `max` enables every feature QEMU's TCG implements for the target arch;
    // good enough for booting a unikernel. The model is arch-aware behind the
    // scenes (max for aarch64 vs max for x86_64 are different CPUs).
    void arch;
    return "max";
  }
  return "host";
}

/** ops's kernel directory suffix convention. arm64 builds get a `-arm` suffix
 *  in the version directory name; x86_64 builds use the plain version. */
export function kernelDirSuffix(arch: SupportedArch): string {
  return arch === "arm64" ? "-arm" : "";
}

/** Machine-type args for QEMU. arm64's `virt` machine needs gic-version=2;
 *  x86_64 uses `q35`. */
export function machineArgs(arch: SupportedArch): string[] {
  if (arch === "arm64") {
    return ["-machine", "virt", "-machine", "gic-version=2"];
  }
  return ["-machine", "q35"];
}

/** Human-readable label for diagnostics. */
export function platformLabel(p: Platform): string {
  const archLabel = p.arch === "x64" ? "x86_64" : "arm64";
  const osLabel = p.os === "darwin" ? "macOS" : "Linux";
  return `${osLabel} ${archLabel}`;
}

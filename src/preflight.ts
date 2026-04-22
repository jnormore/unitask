import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  detectPlatform,
  isPlatformError,
  qemuBinaryFor,
  kernelDirSuffix,
  platformLabel,
  accelFor,
  fallbackAccel,
  type Platform,
  type Accel,
} from "./platform.js";

const exec = promisify(execFile);

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
};

export type PreflightReport = {
  ok: boolean;
  checks: CheckResult[];
  kernelPath?: string;
  platform?: Platform;
  accel?: Accel;
};

const OPS_BIN = join(homedir(), ".ops", "bin", "ops");
const OPS_HOME = join(homedir(), ".ops");

export async function preflight(): Promise<PreflightReport> {
  const checks: CheckResult[] = [];

  const platform = detectPlatform();
  if (isPlatformError(platform)) {
    checks.push({
      name: "platform",
      ok: false,
      detail: `${platform.os}/${platform.arch} — unsupported`,
      fix: platform.reason,
    });
    return { ok: false, checks };
  }
  checks.push({
    name: "platform",
    ok: true,
    detail: platformLabel(platform),
  });

  const opsCheck = await checkOps();
  checks.push(opsCheck);

  const kernelCheck = await checkKernel(platform);
  checks.push(kernelCheck.result);

  checks.push(
    await checkBin(qemuBinaryFor(platform.arch), "QEMU", {
      via:
        platform.os === "darwin"
          ? "ops install pulls it in via Homebrew, or `brew install qemu`"
          : "install via your distro's package manager (e.g. `apt install qemu-system-arm` or `qemu-system-x86`)",
    })
  );
  const accelCheck = await checkAccel(platform);
  checks.push(accelCheck.result);
  checks.push(
    await checkBin("nc", "netcat (nc)", {
      via:
        platform.os === "darwin"
          ? "preinstalled on macOS; `brew install netcat` or `nmap` if missing"
          : "install via your distro's package manager (e.g. `apt install netcat-openbsd`)",
    })
  );

  return {
    ok: checks.every((c) => c.ok),
    checks,
    kernelPath: kernelCheck.kernelPath,
    platform,
    accel: accelCheck.accel,
  };
}

async function checkAccel(platform: Platform): Promise<{
  result: CheckResult;
  accel: Accel;
}> {
  const preferred = accelFor(platform.os);
  if (preferred === "hvf") {
    // HVF on macOS is part of the OS; if QEMU is built with HVF support
    // (true for the Homebrew/ops bundle on Apple Silicon), it just works.
    return {
      result: { name: "accel", ok: true, detail: "hvf (Apple HVF)" },
      accel: "hvf",
    };
  }
  // Linux: KVM availability is signalled by /dev/kvm. If absent (e.g. Docker
  // container without --device /dev/kvm), fall back to TCG software emulation
  // — slower per run but the code paths still work.
  try {
    await stat("/dev/kvm");
    return {
      result: { name: "accel", ok: true, detail: "kvm" },
      accel: "kvm",
    };
  } catch {
    return {
      result: {
        name: "accel",
        ok: true,
        detail:
          "tcg (KVM unavailable — falling back to software emulation; runs will be slow)",
      },
      accel: fallbackAccel(),
    };
  }
}

async function checkOps(): Promise<CheckResult> {
  try {
    await stat(OPS_BIN);
  } catch {
    return {
      name: "ops",
      ok: false,
      detail: `ops not found at ${OPS_BIN}`,
      fix: "install with: curl -sSfL https://ops.city/get.sh | sh",
    };
  }
  try {
    const { stdout } = await exec(OPS_BIN, ["version"], { timeout: 5000 });
    const m = /Ops version: (\S+)/.exec(stdout);
    return {
      name: "ops",
      ok: true,
      detail: m ? `ops ${m[1]}` : stdout.trim().split("\n")[0]!,
    };
  } catch (e) {
    return {
      name: "ops",
      ok: false,
      detail: `ops at ${OPS_BIN} failed to run: ${(e as Error).message}`,
      fix: "try reinstalling: curl -sSfL https://ops.city/get.sh | sh",
    };
  }
}

async function checkKernel(platform: Platform): Promise<{
  result: CheckResult;
  kernelPath?: string;
}> {
  const suffix = kernelDirSuffix(platform.arch);
  // arm64 dirs end in `-arm`, x86_64 dirs are plain version (e.g. `0.1.54`).
  const wantsArm = suffix === "-arm";
  try {
    const entries = await readdir(OPS_HOME);
    const matching = entries.filter((e) => {
      const isArmDir = /-arm$/.test(e);
      const isVersion = /^[0-9]+\.[0-9]+\.[0-9]+/.test(e);
      return isVersion && isArmDir === wantsArm;
    });
    if (matching.length === 0) {
      return {
        result: {
          name: "nanos-kernel",
          ok: false,
          detail: `no Nanos ${platform.arch} kernel found under ${OPS_HOME}`,
          fix: "ops should pull it on first run; try `ops update`",
        },
      };
    }
    matching.sort().reverse();
    const newest = matching[0]!;
    const path = join(OPS_HOME, newest, "kernel.img");
    try {
      await stat(path);
      return {
        result: {
          name: "nanos-kernel",
          ok: true,
          detail: `kernel: ${newest}`,
        },
        kernelPath: path,
      };
    } catch {
      return {
        result: {
          name: "nanos-kernel",
          ok: false,
          detail: `${path} missing`,
          fix: "try `ops update`",
        },
      };
    }
  } catch {
    return {
      result: {
        name: "nanos-kernel",
        ok: false,
        detail: `${OPS_HOME} not readable`,
        fix: "install ops first (curl -sSfL https://ops.city/get.sh | sh)",
      },
    };
  }
}

async function checkBin(
  bin: string,
  human: string,
  hint: { via: string }
): Promise<CheckResult> {
  try {
    const { stdout } = await exec("which", [bin], { timeout: 3000 });
    return {
      name: bin,
      ok: true,
      detail: `${human} at ${stdout.trim()}`,
    };
  } catch {
    return {
      name: bin,
      ok: false,
      detail: `${human} not found on PATH`,
      fix: hint.via,
    };
  }
}

export function formatReport(report: PreflightReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    const mark = c.ok ? "✓" : "✗";
    lines.push(`  ${mark} ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok && c.fix) {
      lines.push(`    fix: ${c.fix}`);
    }
  }
  return lines.join("\n");
}

export function preflightErrorMessage(report: PreflightReport): string {
  const failed = report.checks.filter((c) => !c.ok);
  const lines = [
    `unitask: prerequisites not met (${failed.length} ${failed.length === 1 ? "issue" : "issues"})`,
    "",
    formatReport(report),
    "",
    "Run `unitask doctor` to see this report any time.",
  ];
  return lines.join("\n");
}

import { preflight, formatReport } from "../preflight.js";

export async function doctorCommand(): Promise<number> {
  const report = await preflight();
  process.stdout.write("unitask environment check\n\n");
  process.stdout.write(formatReport(report) + "\n\n");
  if (report.ok) {
    process.stdout.write("all checks passed.\n");
    return 0;
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  process.stdout.write(
    `${failed} ${failed === 1 ? "issue" : "issues"} need attention before \`unitask run\` will work.\n`
  );
  return 1;
}

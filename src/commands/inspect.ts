import { readRunRecord } from "../runs.js";

export async function inspectCommand(runId: string): Promise<number> {
  try {
    const { meta, code, stdout, stderr, dir } = await readRunRecord(runId);

    process.stdout.write(`run ${runId}\n`);
    process.stdout.write(`  dir:       ${dir}\n`);
    process.stdout.write(`  createdAt: ${meta.createdAt}\n`);
    process.stdout.write(`  runtime:   ${meta.runtime}\n`);
    process.stdout.write(`  language:  ${meta.language}\n`);
    process.stdout.write(`  exitCode:  ${meta.exitCode}\n`);
    process.stdout.write(`  duration:  ${meta.durationMs}ms\n`);
    process.stdout.write(`  timedOut:  ${meta.timedOut}\n`);
    process.stdout.write(`  policy:    ${JSON.stringify(meta.policy)}\n`);
    process.stdout.write(`\n--- code ---\n`);
    process.stdout.write(code.endsWith("\n") ? code : code + "\n");
    process.stdout.write(`\n--- stdout ---\n`);
    process.stdout.write(stdout || "(empty)\n");
    if (stderr) {
      process.stdout.write(`\n--- stderr ---\n`);
      process.stdout.write(stderr);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: cannot read run ${runId}: ${msg}\n`);
    return 1;
  }
}

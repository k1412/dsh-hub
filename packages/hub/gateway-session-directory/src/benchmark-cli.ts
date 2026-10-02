import { runSyntheticBenchmark } from './benchmark.ts'
const report = await runSyntheticBenchmark()
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

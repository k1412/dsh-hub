import { execFile, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface CommandResult { stdout: string; stderr: string; code: number }
export type CommandRunner = (binary: string, args: string[], options?: {
  env?: NodeJS.ProcessEnv; timeoutMs?: number
}) => Promise<CommandResult>

export const runCommand: CommandRunner = (binary, args, options = {}) => new Promise((resolve, reject) => {
  execFile(binary, args, { env: options.env ?? process.env, timeout: options.timeoutMs ?? 10_000,
    maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      reject(new Error(`${binary.split('/').at(-1)} is not installed`))
      return
    }
    const numericCode = error !== null && typeof error.code === 'number' ? error.code : 1
    resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: error === null ? 0 : numericCode })
  })
})

export type ProcessSpawner = (binary: string, args: string[], env?: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
export const spawnProcess: ProcessSpawner = (binary, args, env) =>
  spawn(binary, args, { env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

/** Only owned processes are terminated; host tailscaled is never touched. */
export async function stopProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

export function tailcatAddress(output: string): string | undefined {
  return /(?:^|[^A-Za-z0-9_-])(tc[A-Za-z0-9_-]{20,})(?=$|[^A-Za-z0-9_-])/m.exec(output)?.[1]
}

export function safeNetworkError(error: unknown, fallback: string): string {
  // Upstream stderr can contain login URLs, PSKs and tunnel addresses.
  // Keep diagnostics actionable without returning upstream secrets in errors.
  if (error instanceof Error && error.message.endsWith('is not installed')) return error.message
  return fallback
}

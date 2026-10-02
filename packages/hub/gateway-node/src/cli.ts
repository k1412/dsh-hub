#!/usr/bin/env node
import { createManagement } from './management.ts'
import { readConnectionConfig, startNodeConnector } from './connector.ts'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { installNode, parseManifest, pairSupervisor } from './install.ts'

async function main(): Promise<void> {
  const args = parseArgs({ allowPositionals: true, options: {
    manifest: { type: 'string' }, 'state-directory': { type: 'string' }, 'bin-directory': { type: 'string' },
    profile: { type: 'string' }, 'package-file': { type: 'string' }, 'dsh-executable': { type: 'string' },
    'tailscale-socket': { type: 'string' },
    'connection-file': { type: 'string' }, 'update-executor': { type: 'string' }, 'runtime-id': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } })
  if (args.values.help) {
    process.stdout.write('Usage: dsh-gateway-node install --manifest <file> [--state-directory <directory>] [--bin-directory <directory>] [--profile web] [--dsh-executable <path>] [--tailscale-socket <path>]\nAlso: pair-supervisor --manifest <file> [--runtime-id default]\nAlso: supervise --connection-file <file> --runtime-id <id> --update-executor <absolute-path>\nInstalls and pairs the remote plugin inside an existing DSH 0.1.7-rc.2 profile.\n')
    return
  }
  if (args.positionals[0] === 'pair-supervisor') {
    if (!args.values.manifest) throw new Error('pair-supervisor requires --manifest')
    const result = await pairSupervisor({ manifest: parseManifest(JSON.parse(await readFile(args.values.manifest, 'utf8'))), stateDirectory: args.values['state-directory'] ?? join(homedir(), '.dsh-gateway'), runtimeId: args.values['runtime-id'] ?? 'default',
      ...(args.values['bin-directory'] ? { binDirectory: args.values['bin-directory'] } : {}), ...(args.values['tailscale-socket'] ? { tailscaleSocket: args.values['tailscale-socket'] } : {}) })
    process.stdout.write(`${JSON.stringify(result)}\n`); return
  }
  if (args.positionals[0] === 'supervise') {
    if (!args.values['connection-file'] || !args.values['update-executor'] || !args.values['runtime-id']) throw new Error('supervise requires --connection-file, --update-executor and --runtime-id')
    const config = await readConnectionConfig(args.values['connection-file'])
    const management = await createManagement({ stateDirectory: join(config.stateDir, 'supervisor-jobs'), lockDirectory: join(config.stateDir, 'management.lock'), version: 'external-supervisor', trustedPackages: [], lifecycle: true, updateExecutor: args.values['update-executor'] })
    const connector = startNodeConnector({ config: { ...config, stateDir: join(config.stateDir, 'supervisor-network') }, role: 'supervisor',
      metadata: { protocol: 1, name: config.name, runtimeId: args.values['runtime-id'], dshVersion: 'external-supervisor' },
      surface: { handle: async () => new Response('Supervisor has no native surface', { status: 404 }), openMux: () => { throw new Error('Supervisor has no Runtime') } },
      control: { capabilities: ['lifecycle'], connected: () => {}, handle: (method, input) => management.handle(method, input) },
      onStatus: status => process.stderr.write(`Supervisor ${status.state}: ${status.message}\n`),
    })
    const stop = () => { void connector.close() }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    return
  }
  if (args.positionals[0] !== 'install' || !args.values.manifest) throw new Error('Usage: dsh-gateway-node install --manifest <file> [--state-directory <directory>] [--profile web]')
  const manifest = parseManifest(JSON.parse(await readFile(args.values.manifest, 'utf8')))
  const tailscaleSocket = args.values['tailscale-socket'] ?? process.env.DSH_GATEWAY_TAILSCALE_SOCKET
  const result = await installNode({ manifest, stateDirectory: args.values['state-directory'] ?? join(homedir(), '.dsh-gateway'),
    ...(args.values['bin-directory'] ? { binDirectory: args.values['bin-directory'] } : {}),
    ...(args.values['package-file'] ? { packageFile: args.values['package-file'] } : {}),
    ...(args.values['dsh-executable'] ? { dshExecutable: args.values['dsh-executable'] } : {}),
    ...(tailscaleSocket ? { tailscaleSocket } : {}),
    ...(args.values.profile ? { profile: args.values.profile } : {}),
    onProgress: (message) => { process.stderr.write(`${message}\n`) },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.stderr.write('Plugin installed and paired. Reload the existing DSH Runtime to connect; this command does not start another Runtime.\n')
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Gateway installation failed'}\n`); process.exitCode = 1 })

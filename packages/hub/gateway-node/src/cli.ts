#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { installNode, parseManifest } from './install.ts'

async function main(): Promise<void> {
  const args = parseArgs({ allowPositionals: true, options: {
    manifest: { type: 'string' }, 'state-directory': { type: 'string' }, 'bin-directory': { type: 'string' },
    instance: { type: 'string' }, profile: { type: 'string' }, 'package-file': { type: 'string' }, 'dsh-executable': { type: 'string' },
    'tailscale-socket': { type: 'string' },
    'package-alias': { type: 'string' },
    'reuse-tailscale': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } })
  if (args.values.help) {
    process.stdout.write('Usage: dsh-gateway-node install --manifest <file> [--state-directory <directory>] [--bin-directory <directory>] [--profile web] [--instance gateway-node-experiment] [--dsh-executable <path>] [--tailscale-socket <path>] [--reuse-tailscale] [--package-alias npm-name]\nInstalls and pairs the remote plugin inside an existing DSH 0.1.7-rc.2 profile.\n')
    return
  }
  if (args.positionals[0] !== 'install' || !args.values.manifest) throw new Error('Usage: dsh-gateway-node install --manifest <file> [--state-directory <directory>] [--profile web] [--instance gateway-node-experiment]')
  const manifest = parseManifest(JSON.parse(await readFile(args.values.manifest, 'utf8')))
  const tailscaleSocket = args.values['tailscale-socket'] ?? process.env.DSH_GATEWAY_TAILSCALE_SOCKET
  const result = await installNode({ manifest, stateDirectory: args.values['state-directory'] ?? join(homedir(), '.dsh-gateway'),
    ...(args.values['bin-directory'] ? { binDirectory: args.values['bin-directory'] } : {}),
    ...(args.values['package-alias'] ? { packageAlias: args.values['package-alias'] } : {}),
    ...(args.values['package-file'] ? { packageFile: args.values['package-file'] } : {}),
    ...(args.values['dsh-executable'] ? { dshExecutable: args.values['dsh-executable'] } : {}),
    ...(tailscaleSocket ? { tailscaleSocket } : {}),
    ...(args.values.instance ? { instance: args.values.instance } : {}),
    ...(args.values['reuse-tailscale'] ? { allowManagedTailscale: false } : {}),
    ...(args.values.profile ? { profile: args.values.profile } : {}),
    onProgress: (message) => { process.stderr.write(`${message}\n`) },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.stderr.write('Plugin installed and paired. Reload the existing DSH Runtime to connect; this command does not start another Runtime.\n')
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Gateway installation failed'}\n`); process.exitCode = 1 })

#!/usr/bin/env node

/** Node Agent enrollment, configuration, and long-running service entry. */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HubNodeAgent } from './agent.ts'
import { readHubBootstrap } from './bootstrap.ts'
import { upgradeConnectorPackage } from './connector-upgrade.ts'
import { HubNodeAgentState, loadHubNodeAgentConfig } from './state.ts'

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name)?.trim()
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function defaultStateDirectory(): string {
  return resolve(process.env.DSH_HUB_STATE_DIRECTORY?.trim() || join(homedir(), '.dsh-hub'))
}

function defaultIpcEndpoint(stateDirectory: string): string {
  return process.platform === 'win32' ? String.raw`\\.\pipe\dsh-hub-node` : join(stateDirectory, 'connector.sock')
}

async function command(program: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', shell: false, windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveCommand()
      else reject(new Error(`${program} exited with ${String(code)}`))
    })
  })
}

async function initialize(args: readonly string[]): Promise<void> {
  const hubUrl = new URL(requiredOption(args, '--hub'))
  if (hubUrl.protocol !== 'https:' || hubUrl.pathname !== '/' || hubUrl.search !== '' || hubUrl.hash !== '') {
    throw new Error('--hub must be an HTTPS origin without path, query, or fragment')
  }
  const accessClientId = requiredOption(args, '--access-client-id')
  const accessClientSecret = process.env.DSH_HUB_ACCESS_CLIENT_SECRET?.trim()
  const enrollmentCode = process.env.DSH_HUB_ENROLLMENT_CODE?.trim()
  if (accessClientSecret === undefined || accessClientSecret === '') {
    throw new Error('DSH_HUB_ACCESS_CLIENT_SECRET is required for init')
  }
  if (enrollmentCode === undefined || enrollmentCode === '') {
    throw new Error('DSH_HUB_ENROLLMENT_CODE is required for init')
  }
  const bootstrapResponse = await fetch(new URL('/hub/v1/bootstrap', hubUrl), {
    headers: {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
    },
  })
  const bootstrap = await readHubBootstrap(bootstrapResponse, accessClientId)
  const stateDirectory = resolve(option(args, '--state-directory') ?? defaultStateDirectory())
  const configPath = resolve(option(args, '--config') ?? join(stateDirectory, 'node-agent.json'))
  const profileDirectory = option(args, '--profile-directory')
  const profileName = option(args, '--profile')?.trim() || 'web'
  const runtimeId = option(args, '--runtime-id')?.trim() || 'default'
  const config = {
    hubUrl: hubUrl.origin,
    nodeId: requiredOption(args, '--node'),
    accessClientId,
    accessClientSecret,
    enrollmentCode,
    hubPublicKey: bootstrap.hubPublicKey,
    stateDirectory,
    ipcEndpoint: option(args, '--ipc-endpoint') ?? defaultIpcEndpoint(stateDirectory),
    ...(profileDirectory === undefined ? {} : {
      management: {
        profiles: [{
          runtimeId,
          profileDirectory: resolve(profileDirectory),
          profileName,
          dshExecutable: option(args, '--dsh-executable') ?? 'dsh',
          snapshotPaths: [],
        }],
      },
    }),
  }
  await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  const state = await HubNodeAgentState.open(configPath)
  state.close()

  const connector = option(args, '--install-connector')
  if (connector !== undefined) {
    await command(option(args, '--dsh-executable') ?? 'dsh', [
      'plugin', '--profile', profileName, 'add', connector, '--save-exact',
    ])
  }
  process.stdout.write([
    `Node Agent configuration created: ${configPath}`,
    `Connector IPC endpoint: ${config.ipcEndpoint}`,
    connector === undefined
      ? `Install the Connector: dsh plugin --profile ${profileName} add <connector-package> --save-exact`
      : `Connector installed in profile ${profileName}`,
    `Start the Agent: dsh-hub-node --config ${configPath}`,
  ].join('\n') + '\n')
}

async function upgradeConnector(args: readonly string[]): Promise<void> {
  const configPath = resolve(option(args, '--config') ?? join(defaultStateDirectory(), 'node-agent.json'))
  const config = await loadHubNodeAgentConfig(configPath)
  const profileName = option(args, '--profile')?.trim()
  const profiles = config.management?.profiles ?? []
  const profile = profileName === undefined
    ? profiles.length === 1 ? profiles[0] : undefined
    : profiles.find(candidate => candidate.profileName === profileName)
  if (profile === undefined) {
    throw new Error(profileName === undefined
      ? 'exactly one managed profile is required, or pass --profile'
      : `managed profile not found: ${profileName}`)
  }
  await upgradeConnectorPackage({
    profileDirectory: profile.profileDirectory,
    profileName: profile.profileName,
    dshExecutable: profile.dshExecutable,
    connectorPackage: requiredOption(args, '--connector'),
    run: command,
  })
  process.stdout.write(`Connector upgraded in profile ${profile.profileName}\n`)
}

async function serve(args: readonly string[]): Promise<void> {
  const index = args.indexOf('--config')
  const configPath = index < 0 ? process.env.DSH_HUB_NODE_CONFIG : args[index + 1]
  if (configPath === undefined || configPath.length === 0) {
    throw new Error('usage: dsh-hub-node --config /absolute/path/to/node-agent.json')
  }
  const abort = new AbortController()
  process.once('SIGINT', () => { abort.abort(new Error('SIGINT')) })
  process.once('SIGTERM', () => { abort.abort(new Error('SIGTERM')) })
  const state = await HubNodeAgentState.open(configPath)
  try {
    const agent = new HubNodeAgent({
      state,
      notice: notice => process.stdout.write(`${new Date().toISOString()} ${notice.state} ${notice.message}\n`),
    })
    await agent.run(abort.signal)
  } finally {
    state.close()
  }
}

try {
  const args = process.argv.slice(2)
  if (args[0] === 'init') await initialize(args.slice(1))
  else if (args[0] === 'upgrade-connector') await upgradeConnector(args.slice(1))
  else await serve(args)
} catch (error) {
  process.stderr.write(`dsh-hub-node: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

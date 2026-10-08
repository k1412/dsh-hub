import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, mkdtemp, chmod, copyFile, rm, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { hostname, homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectNodeNetwork } from '@k1412/dsh-gateway-network'
import type { NodeConnectionConfig } from './connector.ts'

const execute = promisify(execFile)
const PACKAGE_NAME = '@k1412/dsh-gateway-node'
const markerStart = '# BEGIN DSH GATEWAY NODE (managed by dsh-gateway-node)'
const markerEnd = '# END DSH GATEWAY NODE'
interface ProfileManifest {
  [key: string]: unknown
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export interface EnrollmentManifest {
  protocol: 1
  inviteToken: string
  hubUrl: string
  mode: 'tailscale' | 'tailcat'
  endpoint: string
  expiresAt: number | string
  sessionDirectory?: boolean
  claimed?: boolean
  package: { url: string; sha256: string }
  packageFile?: string
  packageDirectory?: string
}

export async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await atomicPrivateText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicPrivateText(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

/** A real package name isolates pnpm's hoisted layout as well as its default layout. */
export async function createAliasedGatewayArchive(verifiedArchive: string, packageName: string, directory: string): Promise<string> {
  const temporary = await mkdtemp(join(directory, '.alias-package-'))
  try {
    const listed = (await execute('tar', ['-tzf', verifiedArchive], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim().split('\n')
    if (listed.some(path => !path.startsWith('package/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('Unsafe Gateway archive path')
    const verbose = (await execute('tar', ['-tvzf', verifiedArchive], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout
    if (/^[lh]/m.test(verbose)) throw new Error('Gateway archives must not contain links')
    await execute('tar', ['-xzf', verifiedArchive, '-C', temporary], { timeout: 15_000 })
    const manifestPath = join(temporary, 'package/package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.name !== PACKAGE_NAME) throw new Error('Unexpected Gateway package identity')
    manifest.name = packageName
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    if (listed.includes('package/lib/client.js')) {
      const clientPath = join(temporary, 'package/lib/client.js'), client = await readFile(clientPath, 'utf8')
      const registration = `window.__ModuleLoader__.load({id:${JSON.stringify(PACKAGE_NAME)},factory:`
      if (!client.startsWith(registration)) throw new Error('Unexpected Gateway browser module registration')
      await writeFile(clientPath, client.replace(registration, `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:`), { mode: 0o600 })
    }
    const sourceDigest = createHash('sha256').update(await readFile(verifiedArchive)).digest('hex')
    const aliasDigest = createHash('sha256').update(packageName).digest('hex').slice(0, 16)
    const archive = join(directory, `gateway-alias-${aliasDigest}-${sourceDigest.slice(0, 16)}.tgz`)
    const next = `${archive}.tmp`
    await execute('tar', ['-czf', next, '-C', temporary, 'package'], { timeout: 15_000 })
    await chmod(next, 0o600); await rename(next, archive)
    return archive
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** Refuse a successful package-manager exit if it installed another Gateway's code. */
export async function verifyInstalledGateway(archive: string, profileDirectory: string, packageName: string): Promise<void> {
  const listed = (await execute('tar', ['-tzf', archive], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim().split('\n')
  const required = ['package/lib/index.js', 'package/lib/cli.js', 'package/package.json']
  if (required.some(path => !listed.includes(path))) throw new Error('Gateway archive is missing runtime files')
  for (const path of [...required, ...(listed.includes('package/lib/client.js') ? ['package/lib/client.js'] : [])]) {
    const expected = (await execute('tar', ['-xOzf', archive, path], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 })).stdout
    const actual = await readFile(join(profileDirectory, 'node_modules', packageName, path.slice('package/'.length)), 'utf8')
    if (actual !== expected) throw new Error(`Installed Gateway ${packageName} differs from its verified archive; refusing to activate this connection`)
  }
}

/** Preserve the operator's raw YAML/!!js expressions and replace only our own block. */
export function gatewayProfilePatch(original: string, connectionFile: string, instance = 'gateway-node', sessionDirectory = false, packageName = PACKAGE_NAME): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(instance)) throw new Error('Invalid Gateway instance name')
  const startMarker = instance === 'gateway-node' ? markerStart : `# BEGIN DSH GATEWAY INSTANCE ${instance}`
  const endMarker = instance === 'gateway-node' ? markerEnd : `# END DSH GATEWAY INSTANCE ${instance}`
  const offsetOf = (marker: string) => {
    let offset = 0
    for (const line of original.split('\n')) { if (line.replace(/\r$/, '') === marker) return offset; offset += line.length + 1 }
    return -1
  }
  const beginning = offsetOf(startMarker)
  const end = offsetOf(endMarker)
  if ((beginning >= 0) !== (end >= 0) || (beginning >= 0 && end < beginning)) throw new Error('Incomplete managed gateway profile block; repair it before installing')
  let preserved = beginning < 0 ? original : `${original.slice(0, beginning)}${original.slice(end + endMarker.length)}`
  preserved = preserved.replace(/^\s*\[\]\s*$/m, '').trimEnd()
  const entry = instance === 'gateway-node' ? '- id: gateway-node\n  disabled: false' : `- insert:\n    - id: ${instance}\n      name: ${JSON.stringify(packageName)}`
  const indent = instance === 'gateway-node' ? '  ' : '      '
  const extensions: string[] = []
  let keepField = false
  const fieldIndent = `${indent}  `
  if (beginning >= 0 && instance !== 'gateway-node') {
    for (const line of original.slice(beginning, end).split('\n')) {
      const field = new RegExp(`^${fieldIndent}([a-zA-Z_][\\w-]*):`).exec(line)
      if (field) keepField = !['connectionFile', 'control', 'sessionDirectory'].includes(field[1] ?? '')
      else if (line.trim() && !line.startsWith(fieldIndent)) keepField = false
      if (keepField) extensions.push(line)
    }
  }
  const extraConfig = extensions.length ? `${extensions.join('\n').trimEnd()}\n` : ''
  const unusedDefault = packageName === PACKAGE_NAME && instance !== 'gateway-node' && !/(?:^|\n)\s*-\s*id:\s*gateway-node(?:\s|$)/.test(preserved) ? '- id: gateway-node\n  disabled: true\n' : ''
  return `${preserved}\n${startMarker}\n${unusedDefault}${entry}\n${indent}config:\n${indent}  connectionFile: ${JSON.stringify(connectionFile)}\n${indent}  sessionDirectory: ${sessionDirectory}\n${extraConfig}${endMarker}\n`
}

export function parseManifest(value: unknown): EnrollmentManifest {
  const candidate = value as Partial<EnrollmentManifest>
  if (!candidate || candidate.protocol !== 1 || !candidate.inviteToken || !['tailscale', 'tailcat'].includes(candidate.mode ?? '')
    || !candidate.endpoint || !candidate.hubUrl || !candidate.package?.url || !/^[a-f0-9]{64}$/.test(candidate.package.sha256)) throw new Error('Invalid gateway invitation manifest')
  const publicUrl = new URL(candidate.hubUrl)
  const packageUrl = new URL(candidate.package.url, publicUrl)
  if (!['https:', 'http:'].includes(publicUrl.protocol) || !['https:', 'http:'].includes(packageUrl.protocol)
    || publicUrl.username || publicUrl.password || packageUrl.username || packageUrl.password) throw new Error('Invalid gateway invitation URL')
  return candidate as EnrollmentManifest
}

/** A new invitation deliberately starts a fresh identity; retrying the same one is idempotent. */
export function enrollmentIdentity(inviteToken: string, previous?: { clientId: string; credential: string; invitationHash?: string }, claimed = false): { clientId: string; credential: string; invitationHash: string } {
  const invitationHash = createHash('sha256').update(inviteToken).digest('hex')
  if (claimed && (!previous || previous.invitationHash !== invitationHash)) throw new Error('This invitation was already claimed. Retry with its original saved node identity or create a new invitation.')
  if (previous && (previous.invitationHash === undefined || previous.invitationHash === invitationHash)) return { ...previous, invitationHash }
  return { clientId: randomUUID(), credential: randomBytes(32).toString('base64url'), invitationHash }
}

export async function installNode(options: {
  manifest: EnrollmentManifest
  stateDirectory: string
  binDirectory?: string
  tailscaleSocket?: string
  instance?: string
  packageAlias?: string
  allowManagedTailscale?: boolean
  profile?: string
  dshExecutable?: string
  packageFile?: string
  onProgress?: (message: string) => void
}): Promise<{ nodeId: string; connectionFile: string; profileDirectory: string; needsReload: true }> {
  const profile = options.profile ?? 'web'
  if (options.tailscaleSocket && !isAbsolute(options.tailscaleSocket)) throw new Error('Tailscale socket path must be absolute')
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid DSH profile name')
  const profileDirectory = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile)
  const manifestPath = join(profileDirectory, 'package.json')
  const originalManifest = await readFile(manifestPath, 'utf8').catch(() => { throw new Error(`Existing DSH profile ${profile} was not found. Install DSH first and run this command as its Runtime user.`) })
  const profileManifest = JSON.parse(originalManifest) as ProfileManifest
  if (typeof profileManifest !== 'object' || profileManifest === null || Array.isArray(profileManifest)) throw new Error('Invalid existing DSH profile manifest')
  const patchPath = join(profileDirectory, 'cordis.patch.yml')
  const patch = await readFile(patchPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]\n'; throw error })
  const instance = options.instance ?? (options.manifest.sessionDirectory && patch.includes(markerStart) ? 'gateway-node-experiment' : 'gateway-node')
  const packageName = options.packageAlias ?? PACKAGE_NAME
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(instance)) throw new Error('Invalid Gateway instance name')
  if (options.packageAlias !== undefined && (instance === 'gateway-node' || packageName === PACKAGE_NAME
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName))) throw new Error('Package aliases require a named Gateway instance and a distinct npm dependency name')
  const dshExecutable = options.dshExecutable ?? 'dsh'
  const version = (await execute(dshExecutable, ['--version'], { timeout: 15_000 })).stdout.trim().split(/\s+/).at(-1) ?? ''
  if (version !== '0.1.7-rc.2') throw new Error(`This gateway release is validated with DSH 0.1.7-rc.2; found ${version}. Upgrade this node before pairing.`)
  const stateDirectory = resolve(options.stateDirectory)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 }); await chmod(stateDirectory, 0o700)
  const connectionFile = join(stateDirectory, 'connection.json')
  const canonicalConnection = join(await realpath(stateDirectory), 'connection.json')
  const ownMarker = instance === 'gateway-node' ? markerStart : `# BEGIN DSH GATEWAY INSTANCE ${instance}`
  for (const block of patch.matchAll(/^# BEGIN DSH GATEWAY[^\n]*\n[\s\S]*?^# END DSH GATEWAY[^\n]*$/gm)) {
    if (block[0].split('\n')[0] === ownMarker) continue
    const configured = /connectionFile:\s*("[^"\n]*"|'[^'\n]*'|[^\s#]+)/.exec(block[0])?.[1]
    if (!configured) continue
    const saved = configured.startsWith('"') ? JSON.parse(configured) as string : configured.replace(/^'|'$/g, '')
    const canonicalSaved = await realpath(saved).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return resolve(saved); throw error })
    if (canonicalSaved === canonicalConnection) throw new Error('Each Gateway instance requires its own state directory; this connection file belongs to another instance')
  }
  const invitation = options.manifest
  const existingConnection = await readFile(join(stateDirectory, 'connection.json'), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  })
  if (existingConnection && (JSON.parse(existingConnection) as {hubUrl?:string}).hubUrl !== invitation.hubUrl) {
    throw new Error('This state directory belongs to another Hub. Use a separate --state-directory for the experiment.')
  }
  const identityPath = join(stateDirectory, 'identity.json')
  let previousIdentity: { clientId: string; credential: string; invitationHash?: string } | undefined
  try { previousIdentity = JSON.parse(await readFile(identityPath, 'utf8')) as typeof previousIdentity }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const savedIdentity = enrollmentIdentity(invitation.inviteToken, previousIdentity, invitation.claimed === true)
  await atomicPrivateJson(identityPath, savedIdentity)
  const identity = { clientId: savedIdentity.clientId, credential: savedIdentity.credential }
  if (!identity.clientId || !/^[a-zA-Z0-9_-]{32,}$/.test(identity.credential)) throw new Error('Invalid existing gateway identity file')
  options.onProgress?.(`Preparing ${invitation.mode} connection`)
  // The existing Runtime may already own a live Tailcat process for this state.
  // Enrollment gets an independent, short-lived carrier identity; the Hub's
  // persistent clientId/credential above still own the idempotent pairing.
  const enrollmentState = invitation.mode === 'tailcat'
    ? await mkdtemp(join(stateDirectory, '.enroll-tailcat-')) : stateDirectory
  let network: Awaited<ReturnType<typeof connectNodeNetwork>> | undefined
  let nodeId: string
  try {
    network = await connectNodeNetwork({ mode: invitation.mode, endpoint: invitation.endpoint, stateDirectory: enrollmentState,
      ...(options.binDirectory ? { binDirectory: options.binDirectory } : {}), waitForLoginMs: 120_000,
      ...(options.tailscaleSocket ? { tailscaleSocket: options.tailscaleSocket } : {}),
      ...(options.allowManagedTailscale === undefined ? {} : { allowManagedTailscale: options.allowManagedTailscale }),
      onLogin: (url) => { options.onProgress?.(`Sign in to Tailscale: ${url}`) },
    })
    const enrolled = await fetch(new URL('/enroll', network.url), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: invitation.inviteToken, ...identity, name: hostname(), dshVersion: version, runtimeId: 'default' }), signal: AbortSignal.timeout(30_000) })
    if (!enrolled.ok) throw new Error(`Hub refused node enrollment (HTTP ${enrolled.status}); create a new invitation if it expired or was revoked`)
    const result = await enrolled.json() as { nodeId?: string }
    if (!result.nodeId || !/^[a-zA-Z0-9_-]+$/.test(result.nodeId)) throw new Error('Hub returned an invalid node identity')
    nodeId = result.nodeId
  } finally {
    try { await network?.close() }
    finally { if (enrollmentState !== stateDirectory) await rm(enrollmentState, { recursive: true, force: true }) }
  }

  const configuration: NodeConnectionConfig = { protocol: 1, nodeId, ...identity, name: hostname(), mode: invitation.mode,
    endpoint: invitation.endpoint, stateDir: stateDirectory, hubUrl: invitation.hubUrl,
    ...(options.binDirectory ? { binDirectory: resolve(options.binDirectory) } : {}),
    ...(options.tailscaleSocket ? { tailscaleSocket: options.tailscaleSocket } : {}),
    ...(options.allowManagedTailscale === undefined ? {} : { allowManagedTailscale: options.allowManagedTailscale }),
  }
  await atomicPrivateJson(connectionFile, configuration)
  const packageDirectory = join(stateDirectory, 'packages')
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 })
  const packagePath = join(packageDirectory, `gateway-node-${invitation.package.sha256.slice(0, 16)}.tgz`)
  const suppliedPackage = options.packageFile ?? invitation.packageFile
  if (suppliedPackage) await copyFile(suppliedPackage, packagePath)
  else {
    const packageResponse = await fetch(new URL(invitation.package.url, invitation.hubUrl), { signal: AbortSignal.timeout(120_000) })
    if (!packageResponse.ok) throw new Error(`Gateway package download failed (HTTP ${packageResponse.status})`)
    await writeFile(packagePath, new Uint8Array(await packageResponse.arrayBuffer()), { mode: 0o600 })
  }
  const digest = createHash('sha256').update(await readFile(packagePath)).digest('hex')
  if (digest !== invitation.package.sha256) throw new Error('Gateway package checksum mismatch')
  const installationArchive = options.packageAlias ? await createAliasedGatewayArchive(packagePath, packageName, packageDirectory) : packagePath
  profileManifest.dependencies = { ...profileManifest.dependencies, [packageName]: `file:${installationArchive}` }
  // HMR may observe this manifest immediately. Add the dependency first, but
  // activate the bundle only after the package has been fully installed.
  const dependencyManifest = structuredClone(profileManifest)
  profileManifest.dsh ??= {}; profileManifest.dsh.profile ??= {}; profileManifest.dsh.profile.bundles ??= []
  if (!Array.isArray(profileManifest.dsh.profile.bundles)) throw new Error('Existing profile bundle list is invalid')
  if (!options.packageAlias && !profileManifest.dsh.profile.bundles.includes(PACKAGE_NAME)) profileManifest.dsh.profile.bundles.push(PACKAGE_NAME)
  const patchNext = gatewayProfilePatch(patch, connectionFile, instance, invitation.sessionDirectory === true, options.packageAlias ? join(profileDirectory, 'node_modules', packageName, 'lib/index.js') : packageName)
  const suffix = `.gateway-backup-${Date.now()}`
  await writeFile(`${manifestPath}${suffix}`, originalManifest, { mode: 0o600 })
  await writeFile(`${patchPath}${suffix}`, patch, { mode: 0o600 })
  await atomicPrivateJson(manifestPath, dependencyManifest)
  options.onProgress?.(`Installing plugin into existing DSH profile ${profile}`)
  try {
    await execute(dshExecutable, ['plugin', '--profile', profile, 'install'], { timeout: 300_000, maxBuffer: 1024 * 1024 })
    if (options.packageAlias) await verifyInstalledGateway(installationArchive, profileDirectory, packageName)
    await atomicPrivateText(patchPath, patchNext)
    await atomicPrivateJson(manifestPath, profileManifest)
  }
  catch (error) {
    await atomicPrivateText(manifestPath, originalManifest); await atomicPrivateText(patchPath, patch)
    const detail = error instanceof Error && error.message.startsWith('Installed Gateway ') ? ` ${error.message}` : ''
    throw new Error(`DSH plugin installation failed; profile files restored. Node pairing is saved so the installation can be retried.${detail}`, { cause: error })
  }
  return { nodeId, connectionFile, profileDirectory, needsReload: true }
}

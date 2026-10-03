import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, mkdtemp, chmod, copyFile, rm } from 'node:fs/promises'
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

/** Preserve the operator's raw YAML/!!js expressions and replace only our own block. */
export function gatewayProfilePatch(original: string, connectionFile: string, instance = 'gateway-node', sessionDirectory = false): string {
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
  const entry = instance === 'gateway-node' ? '- id: gateway-node\n  disabled: false' : `- insert:\n    - id: ${instance}\n      name: '@k1412/dsh-gateway-node'`
  const indent = instance === 'gateway-node' ? '  ' : '      '
  const unusedDefault = instance !== 'gateway-node' && !/(?:^|\n)\s*-\s*id:\s*gateway-node(?:\s|$)/.test(preserved) ? '- id: gateway-node\n  disabled: true\n' : ''
  return `${preserved}\n${startMarker}\n${unusedDefault}${entry}\n${indent}config:\n${indent}  connectionFile: ${JSON.stringify(connectionFile)}\n${indent}  sessionDirectory: ${sessionDirectory}\n${endMarker}\n`
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
  const dshExecutable = options.dshExecutable ?? 'dsh'
  const version = (await execute(dshExecutable, ['--version'], { timeout: 15_000 })).stdout.trim().split(/\s+/).at(-1) ?? ''
  if (version !== '0.1.7-rc.2') throw new Error(`This gateway release is validated with DSH 0.1.7-rc.2; found ${version}. Upgrade this node before pairing.`)
  const stateDirectory = resolve(options.stateDirectory)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 }); await chmod(stateDirectory, 0o700)
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

  const connectionFile = join(stateDirectory, 'connection.json')
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
  profileManifest.dependencies = { ...profileManifest.dependencies, [PACKAGE_NAME]: `file:${packagePath}` }
  // HMR may observe this manifest immediately. Add the dependency first, but
  // activate the bundle only after the package has been fully installed.
  const dependencyManifest = structuredClone(profileManifest)
  profileManifest.dsh ??= {}; profileManifest.dsh.profile ??= {}; profileManifest.dsh.profile.bundles ??= []
  if (!Array.isArray(profileManifest.dsh.profile.bundles)) throw new Error('Existing profile bundle list is invalid')
  if (!profileManifest.dsh.profile.bundles.includes(PACKAGE_NAME)) profileManifest.dsh.profile.bundles.push(PACKAGE_NAME)
  const patchPath = join(profileDirectory, 'cordis.patch.yml')
  const patch = await readFile(patchPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]\n'; throw error })
  const patchNext = gatewayProfilePatch(patch, connectionFile, options.instance ?? (invitation.sessionDirectory && patch.includes(markerStart) ? 'gateway-node-experiment' : 'gateway-node'), invitation.sessionDirectory === true)
  const suffix = `.gateway-backup-${Date.now()}`
  await writeFile(`${manifestPath}${suffix}`, originalManifest, { mode: 0o600 })
  await writeFile(`${patchPath}${suffix}`, patch, { mode: 0o600 })
  await atomicPrivateJson(manifestPath, dependencyManifest)
  options.onProgress?.(`Installing plugin into existing DSH profile ${profile}`)
  try {
    await execute(dshExecutable, ['plugin', '--profile', profile, 'install'], { timeout: 300_000, maxBuffer: 1024 * 1024 })
    await atomicPrivateText(patchPath, patchNext)
    await atomicPrivateJson(manifestPath, profileManifest)
  }
  catch {
    await atomicPrivateText(manifestPath, originalManifest); await atomicPrivateText(patchPath, patch)
    throw new Error('DSH plugin installation failed; profile files restored. Node pairing is saved so the installation can be retried.')
  }
  return { nodeId, connectionFile, profileDirectory, needsReload: true }
}

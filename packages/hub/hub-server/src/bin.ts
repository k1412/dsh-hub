#!/usr/bin/env node

/** Production process entry for the authenticated Hub control plane. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { generateHubIdentity, HubNodeId, type HubIdentityKeyPair } from '@k1412/dsh-hub-protocol'
import { HubStorage } from '@k1412/dsh-hub-storage'
import { CloudflareAccessVerifier, HubOriginGuard } from './auth.ts'
import { HubServer } from './server.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error(`${name} must be a valid port`)
  return value
}

interface BackupFileRecord {
  path: string
  sizeBytes: number
  sha256: string
}

async function digest(path: string): Promise<string> {
  const value = createHash('sha256')
  for await (const chunk of createReadStream(path)) value.update(chunk as Buffer)
  return value.digest('base64url')
}

async function backupFiles(root: string): Promise<BackupFileRecord[]> {
  const files: BackupFileRecord[] = []
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('backup contains a symbolic link')
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      return
    }
    if (!metadata.isFile()) throw new Error('backup contains a non-regular entry')
    const name = relative(root, path).split(sep).join('/')
    if (name === 'manifest.json') return
    files.push({ path: name, sizeBytes: metadata.size, sha256: await digest(path) })
  }
  await visit(join(root, 'hub.db'))
  await visit(join(root, 'objects'))
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function verifyBackup(source: string): Promise<number> {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as {
    version?: unknown
    files?: unknown
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('backup manifest is invalid')
  const expected = manifest.files as BackupFileRecord[]
  if (expected.some(file => typeof file.path !== 'string'
    || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
    || !/^[A-Za-z0-9_-]{43}$/.test(file.sha256)
    || (file.path !== 'hub.db' && !file.path.startsWith('objects/'))
    || file.path.includes('..'))) {
    throw new Error('backup manifest file record is invalid')
  }
  const actual = await backupFiles(source)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('backup file checksum or file-set integrity check failed')
  const verified = await HubStorage.open(join(source, 'hub.db'), join(source, 'objects'))
  try {
    verified.control.verifyAuditChain()
    return await verified.objects.verifyAll()
  } finally {
    verified.close()
  }
}

async function identity(path: string): Promise<HubIdentityKeyPair> {
  const actual = resolve(path)
  await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
  try {
    const metadata = await stat(actual)
    if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
      throw new Error('Hub identity file must be owner-only')
    }
    return JSON.parse(await readFile(actual, 'utf8')) as HubIdentityKeyPair
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const value = generateHubIdentity()
    await writeFileAtomic(actual, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await chmod(actual, 0o600)
    return value
  }
}

const stateDirectory = resolve(process.env.DSH_HUB_STATE_DIRECTORY?.trim() || '/var/lib/dsh-hub')
const databasePath = resolve(process.env.DSH_HUB_DATABASE_PATH?.trim() || `${stateDirectory}/hub.db`)
const objectDirectory = resolve(process.env.DSH_HUB_OBJECT_DIRECTORY?.trim() || `${stateDirectory}/objects`)
const identityPath = resolve(process.env.DSH_HUB_IDENTITY_PATH?.trim() || `${stateDirectory}/identity.json`)
function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`create-enrollment requires ${name} VALUE`)
  }
  return value.trim()
}

if (process.argv[2] === 'create-enrollment') {
  const nodeId = HubNodeId(option('--node-id'))
  const displayName = option('--display-name')
  const expiresInRaw = option('--expires-in')
  const expiresInSeconds = Number(expiresInRaw)
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86_400) {
    throw new Error('--expires-in must be an integer from 60 through 86400 seconds')
  }
  const enrollmentStorage = await HubStorage.open(databasePath, objectDirectory)
  try {
    enrollmentStorage.control.verifyAuditChain()
    const grant = enrollmentStorage.control.createEnrollment(
      nodeId, displayName, Date.now() + expiresInSeconds * 1_000,
    )
    enrollmentStorage.control.appendAudit({
      occurredAt: Date.now(),
      actor: 'local-admin',
      action: 'node.enrollment.created',
      nodeId,
      outcome: 'ok',
      details: { expiresAt: grant.expiresAt, interface: 'offline-cli' },
    })
    process.stdout.write(`${JSON.stringify(grant)}\n`)
  } finally {
    enrollmentStorage.close()
  }
  process.exit(0)
}
if (process.argv[2] === 'backup') {
  const destinationIndex = process.argv.indexOf('--destination')
  const destinationValue = destinationIndex < 0 ? undefined : process.argv[destinationIndex + 1]
  if (destinationValue === undefined || destinationValue.trim() === '') {
    throw new Error('backup requires --destination /absolute/backup/directory')
  }
  const destination = resolve(destinationValue)
  await mkdir(destination, { recursive: false, mode: 0o700 })
  const backupStorage = await HubStorage.open(databasePath, objectDirectory)
  try {
    await backupStorage.control.backupTo(resolve(destination, 'hub.db'))
    await cp(objectDirectory, resolve(destination, 'objects'), { recursive: true, force: false })
    const files = await backupFiles(destination)
    await writeFileAtomic(resolve(destination, 'manifest.json'), `${JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      files,
    }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  } finally {
    backupStorage.close()
  }
  process.stdout.write(`dsh-hub: backup created at ${destination}\n`)
  process.exit(0)
}
if (process.argv[2] === 'verify-backup') {
  const sourceIndex = process.argv.indexOf('--source')
  const sourceValue = sourceIndex < 0 ? undefined : process.argv[sourceIndex + 1]
  if (sourceValue === undefined || sourceValue.trim() === '') {
    throw new Error('verify-backup requires --source /absolute/backup/directory')
  }
  const source = resolve(sourceValue)
  const objectCount = await verifyBackup(source)
  process.stdout.write(`dsh-hub: backup verified (${String(objectCount)} explicit objects)\n`)
  process.exit(0)
}
const operators = required('DSH_HUB_OPERATOR_EMAILS').split(',').map(value => value.trim()).filter(Boolean)

let storage: HubStorage | undefined
let server: HubServer | undefined
const shutdown = new AbortController()
process.once('SIGINT', () => { shutdown.abort(new Error('SIGINT')) })
process.once('SIGTERM', () => { shutdown.abort(new Error('SIGTERM')) })

try {
  storage = await HubStorage.open(databasePath, objectDirectory)
  storage.control.verifyAuditChain()
  storage.control.redactTerminalCommandContentBefore(Date.now() - 5 * 60_000)
  server = new HubServer({
    storage,
    access: new CloudflareAccessVerifier({
      teamDomain: required('DSH_HUB_CF_TEAM_DOMAIN'),
      audience: required('DSH_HUB_CF_AUDIENCE'),
      operatorEmails: operators,
    }),
    originGuard: new HubOriginGuard(required('DSH_HUB_ORIGIN_SECRET')),
    hubIdentity: await identity(identityPath),
    publicOrigin: required('DSH_HUB_PUBLIC_ORIGIN'),
    ...(process.env.DSH_HUB_STATIC_DIRECTORY?.trim()
      ? { staticDirectory: resolve(process.env.DSH_HUB_STATIC_DIRECTORY.trim()) }
      : {}),
    reportError: error => process.stderr.write(
      `dsh-hub: ${error instanceof Error ? error.message : String(error)}\n`,
    ),
  })
  const address = await server.listen(process.env.DSH_HUB_HOST?.trim() || '0.0.0.0', port('PORT', 8080))
  process.stdout.write(`dsh-hub: listening on ${address.host}:${String(address.port)}\n`)
  await new Promise<void>((resolveAbort) => {
    shutdown.signal.addEventListener('abort', () => { resolveAbort() }, { once: true })
  })
} catch (error) {
  process.stderr.write(`dsh-hub: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await server?.close().catch(() => undefined)
  storage?.close()
}

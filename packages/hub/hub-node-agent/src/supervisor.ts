/** Transactional plugin and explicit snapshot management owned by the Node Agent. */

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import * as pty from 'node-pty'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HubMessageId, type HubEnvelopeBody, type HubJson } from '@k1412/dsh-hub-protocol'
import type { HubNodeManagementProfile } from './state.ts'

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: {
    bundle?: unknown
    profile?: { bundles?: unknown }
  }
}

interface ManagedPlugin {
  packageName: string
  version: string
  artifactHash: string
}

interface SnapshotFile {
  root: number
  path: string
  mode: number
  content: string
}

interface SnapshotArchive {
  version: 1
  snapshotId: string
  type: 'configuration' | 'dependency' | 'data' | 'fleet'
  createdAt: number
  roots: string[]
  files: SnapshotFile[]
  manifest: HubJson
}

interface SnapshotIndexRow {
  snapshotId: string
  type: SnapshotArchive['type']
  artifactHash: string
  createdAt: number
  clientMutationId?: string
}

interface SnapshotRestoreEntry {
  destination: string
  temporary: string
  backup: string
  bytes: Buffer
  mode: number
  existed: boolean
  committed: boolean
}

const PROFILE_FILES = ['cordis.yml', 'cordis.patch.yml']
const DEPENDENCY_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']
const SECRET_NAME = /(?:^|[._-])(secret|credential|identity|private|token|key)(?:[._-]|$)|^\.env(?:\.|$)/i
const MAX_SNAPSHOT_FILES = 20_000
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const MAX_REGISTRY_METADATA_BYTES = 1024 * 1024
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url')
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid base64 data')
  }
  return Buffer.from(value, 'base64')
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function boundedResponseBytes(response: Response, maximum: number): Promise<Buffer> {
  if (response.body === null) throw new Error('registry response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maximum) throw new Error('registry response exceeds size limit')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks, total)
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    const stderr: Buffer[] = []
    let bytes = 0
    child.stderr.on('data', (chunk) => {
      if (bytes >= 64 * 1024) return
      const buffer = Buffer.from(chunk as Uint8Array)
      stderr.push(buffer.subarray(0, 64 * 1024 - bytes))
      bytes += buffer.byteLength
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else reject(new Error(
        `managed command failed (${signal ?? String(code)}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
      ))
    })
  })
}

/** Privileged operations explicitly enabled for one managed DSH profile. */
export class HubNodeSupervisor {
  private readonly root: string
  private readonly profile: HubNodeManagementProfile
  private readonly managedPath: string
  private readonly snapshotsPath: string
  private readonly transactionsPath: string
  private operation = Promise.resolve()
  private readonly terminals = new Map<string, {
    terminal: pty.IPty
    sequence: number
    mutationId: string
    runtimeId: string
  }>()

  public constructor(
    stateDirectory: string,
    management: HubNodeManagementProfile,
    private readonly emit?: (body: HubEnvelopeBody) => void,
  ) {
    this.root = join(stateDirectory, 'management')
    this.profile = management
    this.managedPath = join(this.root, 'managed-plugins.json')
    this.snapshotsPath = join(this.root, 'snapshots')
    this.transactionsPath = join(this.root, 'transactions')
  }

  /**
   * Serialize all mutations so lock hashes remain meaningful.
   * @param capability - management capability namespace.
   * @param operation - operation within the capability.
   * @param input - untrusted command payload validated by the selected operation.
   * @param runtimeId - runtime associated with transient stream output.
   * @returns capability-specific JSON result.
   */
  public invoke(capability: string, operation: string, input: unknown, runtimeId = 'agent-managed'): Promise<HubJson> {
    const next = this.operation.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await chmod(this.root, 0o700)
      if (capability === 'dsh.plugins') return this.plugins(operation, input)
      if (capability === 'dsh.snapshots') return this.snapshots(operation, input)
      if (capability === 'dsh.files') return this.files(operation, input)
      if (capability === 'dsh.terminals') return this.terminal(operation, input, runtimeId)
      throw new Error('Node Agent management capability is unavailable')
    })
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }

  /** Terminate every transient PTY on Node Agent shutdown. */
  public close(): void {
    for (const record of this.terminals.values()) record.terminal.kill()
    this.terminals.clear()
  }

  private async files(operation: string, value: unknown): Promise<HubJson> {
    const input = value as Record<string, unknown>
    const target = resolve(String(input.path))
    if (operation === 'list') {
      const offset = typeof input.cursor === 'string' ? Number.parseInt(input.cursor, 10) : 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid directory cursor')
      const limit = Number(input.limit)
      const entries = (await readdir(target, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name))
      const page = entries.slice(offset, offset + limit)
      const rows = await Promise.all(page.map(async (entry) => {
        const path = join(target, entry.name)
        const metadata = await lstat(path)
        return {
          path,
          kind: entry.isSymbolicLink() ? 'symlink' as const : entry.isDirectory() ? 'directory' as const : 'file' as const,
          ...entry.isFile() ? { size: metadata.size } : {},
          modifiedAt: Math.max(0, Math.round(metadata.mtimeMs)),
        }
      }))
      return {
        entries: rows,
        ...(offset + page.length < entries.length ? { nextCursor: String(offset + page.length) } : {}),
      }
    }
    if (operation === 'read') {
      const offset = Number(input.offset)
      const maximum = Number(input.maxBytes)
      const handle = await open(target, 'r')
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile()) throw new Error('file target is not a regular file')
        const length = Math.min(maximum, Math.max(0, metadata.size - offset))
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        const bytes = buffer.subarray(0, bytesRead)
        const utf8 = bytes.toString('utf8')
        const roundTrip = Buffer.from(utf8, 'utf8')
        const text = roundTrip.equals(bytes)
        return {
          encoding: text ? 'utf8' : 'base64',
          data: text ? utf8 : bytes.toString('base64'),
          eof: offset + bytesRead >= metadata.size,
          contentHash: hash(await readFile(target)),
        }
      } finally {
        await handle.close()
      }
    }
    if (operation === 'write') {
      const expected = input.expectedHash
      const present = await exists(target)
      if (typeof expected === 'string') {
        if (!present || hash(await readFile(target)) !== expected) throw new Error('file write precondition failed')
      } else if (expected === null && present) {
        throw new Error('file already exists')
      }
      const bytes = input.encoding === 'base64'
        ? decodeBase64(String(input.data))
        : Buffer.from(String(input.data), 'utf8')
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.dsh-hub-${randomBytes(8).toString('hex')}`
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
      return { contentHash: hash(bytes), size: bytes.byteLength }
    }
    if (operation === 'remove') {
      const expected = input.expectedHash
      if (typeof expected === 'string') {
        const metadata = await lstat(target)
        if (!metadata.isFile() || hash(await readFile(target)) !== expected) {
          throw new Error('file remove precondition failed')
        }
      }
      await rm(target, { recursive: input.recursive === true, force: false })
      return { ok: true }
    }
    throw new Error(`unsupported file operation ${operation}`)
  }

  private terminal(operation: string, value: unknown, runtimeId: string): HubJson {
    const input = value as Record<string, unknown>
    if (operation === 'open') {
      const mutationId = String(input.clientMutationId)
      const existing = [...this.terminals.entries()].find(([, record]) => record.mutationId === mutationId)
      if (existing !== undefined) return { terminalId: existing[0] }
      const terminalId = `terminal-${randomBytes(18).toString('base64url')}`
      const executable = typeof input.shell === 'string' && input.shell !== ''
        ? input.shell
        : process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh'
      const terminal = pty.spawn(executable, [], {
        name: 'xterm-256color',
        cols: Number(input.columns),
        rows: Number(input.rows),
        cwd: typeof input.cwd === 'string' ? resolve(input.cwd) : process.cwd(),
        env: { ...process.env },
      })
      const record = { terminal, sequence: 0, mutationId, runtimeId }
      this.terminals.set(terminalId, record)
      terminal.onData((data) => {
        record.sequence += 1
        this.emit?.({
          type: 'stream.frame',
          runtimeId: record.runtimeId,
          streamId: HubMessageId(hash(`${terminalId}:output`).slice(0, 24)),
          capability: 'dsh.terminals',
          stream: 'output',
          frameSequence: record.sequence,
          payload: { terminalId, sequence: record.sequence, encoding: 'utf8', data, eof: false },
        })
      })
      terminal.onExit(({ exitCode }) => {
        record.sequence += 1
        this.emit?.({
          type: 'stream.frame',
          runtimeId: record.runtimeId,
          streamId: HubMessageId(hash(`${terminalId}:output`).slice(0, 24)),
          capability: 'dsh.terminals',
          stream: 'output',
          frameSequence: record.sequence,
          payload: {
            terminalId, sequence: record.sequence, encoding: 'utf8', data: '', eof: true, exitCode,
          },
        })
        this.terminals.delete(terminalId)
      })
      return { terminalId }
    }
    const terminalId = String(input.terminalId)
    const record = this.terminals.get(terminalId)
    if (operation === 'close' && record === undefined) return { ok: true }
    if (record === undefined) throw new Error('terminal is unavailable')
    if (operation === 'write') {
      const data = input.encoding === 'base64'
        ? decodeBase64(String(input.data)).toString('utf8')
        : String(input.data)
      record.terminal.write(data)
      return { ok: true }
    }
    if (operation === 'resize') {
      record.terminal.resize(Number(input.columns), Number(input.rows))
      return { ok: true }
    }
    if (operation === 'close') {
      record.terminal.kill()
      this.terminals.delete(terminalId)
      return { ok: true }
    }
    throw new Error(`unsupported terminal operation ${operation}`)
  }

  private async lockHash(): Promise<string> {
    const parts: string[] = []
    for (const name of DEPENDENCY_FILES) {
      const path = join(this.profile.profileDirectory, name)
      if (await exists(path)) parts.push(`${name}\0${await readFile(path, 'utf8')}`)
    }
    return hash(parts.join('\0'))
  }

  private async inventory(): Promise<HubJson> {
    const manifest = await readJson<PackageManifest>(join(this.profile.profileDirectory, 'package.json'), {})
    const managed = await readJson<ManagedPlugin[]>(this.managedPath, [])
    const dependencies = { ...manifest.devDependencies, ...manifest.dependencies }
    const managedByName = new Map(managed.map(plugin => [plugin.packageName, plugin]))
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
      ? new Set(manifest.dsh.profile.bundles.filter((item): item is string => typeof item === 'string'))
      : new Set<string>()
    const plugins: HubJson[] = []
    for (const packageName of [...new Set([...Object.keys(dependencies), ...managedByName.keys()])].sort()) {
      const installed = await this.installedPackage(packageName)
      const tracked = managedByName.get(packageName)
      if (installed?.dsh?.bundle === undefined && tracked === undefined) continue
      const enabled = bundles.has(packageName)
      plugins.push({
        packageName,
        version: installed?.version ?? tracked?.version ?? '0.0.0',
        ...(tracked === undefined ? {} : { artifactHash: tracked.artifactHash }),
        enabled,
        healthy: installed !== undefined && enabled
          && (tracked === undefined || installed.version === tracked.version),
      })
    }
    return { plugins, lockHash: await this.lockHash() }
  }

  private async installedPackage(packageName: string): Promise<PackageManifest | undefined> {
    if (!PACKAGE_NAME.test(packageName) || packageName.length > 214) throw new Error('invalid plugin package name')
    const modules = resolve(this.profile.profileDirectory, 'node_modules')
    const target = resolve(modules, ...packageName.split('/'), 'package.json')
    if (!target.startsWith(`${modules}${sep}`)) throw new Error('plugin package path escapes node_modules')
    return readJson<PackageManifest | undefined>(target, undefined)
  }

  private async plugins(operation: string, value: unknown): Promise<HubJson> {
    if (operation === 'inventory') return this.inventory()
    const input = value as Record<string, unknown>
    if (operation === 'apply') {
      const current = await this.lockHash()
      const packageName = String(input.packageName)
      const version = String(input.version)
      const artifactHash = String(input.artifactHash)
      if (current !== input.expectedLockHash) {
        const currentInventory = await this.inventory() as { plugins: HubJson[]; lockHash: string }
        const reconciled = currentInventory.plugins.find(candidate =>
          typeof candidate === 'object' && candidate !== null
          && (candidate as { packageName?: unknown }).packageName === packageName
          && (candidate as { version?: unknown }).version === version
          && (candidate as { artifactHash?: unknown }).artifactHash === artifactHash)
        if (reconciled !== undefined) {
          return { plugin: reconciled, previousLockHash: String(input.expectedLockHash), lockHash: current }
        }
        throw new Error('plugin lock changed before apply')
      }
      const transaction = join(this.transactionsPath, current)
      await this.backupDependencyState(transaction)
      const tarball = await this.fetchArtifact(packageName, version, artifactHash)
      try {
        await run(this.profile.dshExecutable, [
          'plugin', '--profile', this.profile.profileName, 'add', tarball, '--save-exact',
        ], dirname(this.profile.profileDirectory))
        await run(this.profile.dshExecutable, [
          '--profile', this.profile.profileName, '--dump-config',
        ], dirname(this.profile.profileDirectory))
        const managed = await readJson<ManagedPlugin[]>(this.managedPath, [])
        const next = managed.filter(plugin => plugin.packageName !== packageName)
        next.push({ packageName, version, artifactHash })
        next.sort((left, right) => left.packageName.localeCompare(right.packageName))
        await writeFileAtomic(this.managedPath, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          dirMode: 0o700,
        })
        const after = await this.inventory() as { plugins: HubJson[]; lockHash: string }
        const plugin = after.plugins.find(candidate =>
          typeof candidate === 'object' && candidate !== null
          && (candidate as { packageName?: unknown }).packageName === packageName
          && (candidate as { healthy?: unknown }).healthy === true)
        if (plugin === undefined) throw new Error('installed plugin did not pass inventory validation')
        return { plugin, previousLockHash: current, lockHash: after.lockHash }
      } catch (error) {
        await this.restoreDependencyState(transaction)
        await run(this.profile.dshExecutable, [
          'plugin', '--profile', this.profile.profileName, 'install', '--frozen-lockfile',
        ], dirname(this.profile.profileDirectory)).catch((rollbackError: unknown) => {
          throw new AggregateError([error, rollbackError], 'plugin apply and rollback both failed')
        })
        throw error
      }
    }
    if (operation === 'rollback') {
      const target = String(input.targetLockHash)
      if (await this.lockHash() === target) return this.inventory()
      const transaction = join(this.transactionsPath, target)
      if (!await exists(transaction)) throw new Error('plugin rollback target is unavailable')
      await this.restoreDependencyState(transaction)
      await run(this.profile.dshExecutable, [
        'plugin', '--profile', this.profile.profileName, 'install', '--frozen-lockfile',
      ], dirname(this.profile.profileDirectory))
      const restored = await this.inventory() as { plugins: HubJson[]; lockHash: string }
      if (restored.plugins.some(plugin =>
        typeof plugin !== 'object' || plugin === null || Array.isArray(plugin) || plugin.healthy !== true)) {
        throw new Error('plugin rollback did not restore a healthy inventory')
      }
      return restored
    }
    throw new Error(`unsupported plugin operation ${operation}`)
  }

  private async fetchArtifact(packageName: string, version: string, expectedHash: string): Promise<string> {
    const directory = join(this.root, 'artifacts')
    const destination = join(directory, `${expectedHash}.tgz`)
    if (await exists(destination)) {
      if (hash(await readFile(destination)) !== expectedHash) throw new Error('cached plugin artifact hash mismatch')
      return destination
    }
    const metadataResponse = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      { redirect: 'error' },
    )
    if (!metadataResponse.ok) throw new Error(`plugin registry metadata failed with HTTP ${String(metadataResponse.status)}`)
    const metadata = JSON.parse(
      (await boundedResponseBytes(metadataResponse, MAX_REGISTRY_METADATA_BYTES)).toString('utf8'),
    ) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown } }
    if (metadata.name !== packageName || metadata.version !== version) {
      throw new Error('plugin registry metadata identity mismatch')
    }
    if (typeof metadata.dist?.tarball !== 'string') throw new Error('plugin registry metadata has no tarball')
    const artifactUrl = new URL(metadata.dist.tarball)
    if (artifactUrl.protocol !== 'https:' || artifactUrl.hostname !== 'registry.npmjs.org') {
      throw new Error('plugin artifact URL is outside the trusted npm registry')
    }
    const artifactResponse = await fetch(artifactUrl, { redirect: 'error' })
    if (!artifactResponse.ok) throw new Error(`plugin artifact failed with HTTP ${String(artifactResponse.status)}`)
    const declared = Number(artifactResponse.headers.get('content-length') ?? '0')
    if (declared > MAX_ARTIFACT_BYTES) throw new Error('plugin artifact exceeds size limit')
    const bytes = await boundedResponseBytes(artifactResponse, MAX_ARTIFACT_BYTES)
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('plugin artifact exceeds size limit')
    if (hash(bytes) !== expectedHash) throw new Error('plugin artifact hash mismatch')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' })
    return destination
  }

  private async backupDependencyState(destination: string): Promise<void> {
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true, mode: 0o700 })
    for (const name of [...DEPENDENCY_FILES, ...PROFILE_FILES]) {
      const source = join(this.profile.profileDirectory, name)
      if (await exists(source)) await copyFile(source, join(destination, name))
    }
    if (await exists(this.managedPath)) await copyFile(this.managedPath, join(destination, 'managed-plugins.json'))
  }

  private async restoreDependencyState(source: string): Promise<void> {
    for (const name of [...DEPENDENCY_FILES, ...PROFILE_FILES]) {
      const saved = join(source, name)
      const destination = join(this.profile.profileDirectory, name)
      if (await exists(saved)) await copyFile(saved, destination)
      else await unlink(destination).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    const managed = join(source, 'managed-plugins.json')
    if (await exists(managed)) await copyFile(managed, this.managedPath)
    else await unlink(this.managedPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  private async snapshots(operation: string, value: unknown): Promise<HubJson> {
    const indexPath = join(this.snapshotsPath, 'index.json')
    const index = await readJson<SnapshotIndexRow[]>(indexPath, [])
    if (operation === 'list') return {
      snapshots: index.map(({ clientMutationId: _mutation, ...snapshot }) => snapshot),
    }
    const input = value as Record<string, unknown>
    if (operation === 'create') {
      const type = String(input.type) as SnapshotArchive['type']
      const clientMutationId = String(input.clientMutationId)
      const prior = index.find(candidate => candidate.clientMutationId === clientMutationId)
      if (prior !== undefined) {
        const priorArchive = JSON.parse(
          await readFile(join(this.snapshotsPath, `${prior.artifactHash}.json`), 'utf8'),
        ) as SnapshotArchive
        return {
          snapshotId: prior.snapshotId,
          type: prior.type,
          artifactHash: prior.artifactHash,
          createdAt: prior.createdAt,
          manifest: priorArchive.manifest,
        }
      }
      const snapshotId = `snapshot-${randomBytes(18).toString('base64url')}`
      const createdAt = Date.now()
      const roots = type === 'data' ? this.profile.snapshotPaths : [this.profile.profileDirectory]
      const files = await this.collectSnapshot(type, roots)
      const archive: SnapshotArchive = {
        version: 1,
        snapshotId,
        type,
        createdAt,
        roots,
        files,
        manifest: {
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'base64'), 0),
          knownSecretFileClassesExcluded: true,
          contentClassifiedForSecrets: false,
        },
      }
      const serialized = JSON.stringify(archive)
      const artifactHash = hash(serialized)
      await mkdir(this.snapshotsPath, { recursive: true, mode: 0o700 })
      await writeFileAtomic(join(this.snapshotsPath, `${artifactHash}.json`), serialized, { mode: 0o600, dirMode: 0o700 })
      index.push({ snapshotId, type, artifactHash, createdAt, clientMutationId })
      await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return { snapshotId, type, artifactHash, createdAt, manifest: archive.manifest }
    }
    if (operation === 'restore') {
      const row = index.find(candidate => candidate.snapshotId === input.snapshotId)
      if (row === undefined) throw new Error('snapshot is unavailable')
      const currentHash = await this.snapshotCurrentHash(row.type)
      if (input.expectedCurrentHash !== undefined && input.expectedCurrentHash !== currentHash) {
        throw new Error('snapshot restore precondition failed')
      }
      const serialized = await readFile(join(this.snapshotsPath, `${row.artifactHash}.json`), 'utf8')
      if (hash(serialized) !== row.artifactHash) throw new Error('snapshot artifact hash mismatch')
      const archive = JSON.parse(serialized) as SnapshotArchive
      await this.restoreSnapshot(archive)
      return { restored: true, currentHash: await this.snapshotCurrentHash(row.type) }
    }
    throw new Error(`unsupported snapshot operation ${operation}`)
  }

  private async collectSnapshot(type: SnapshotArchive['type'], roots: string[]): Promise<SnapshotFile[]> {
    const files: SnapshotFile[] = []
    let total = 0
    const includeRootFile = (name: string) => {
      if (type === 'configuration') return PROFILE_FILES.includes(name) || name.endsWith('.cordis.yml')
      if (type === 'dependency') return DEPENDENCY_FILES.includes(name)
      return type === 'fleet' ? [...PROFILE_FILES, ...DEPENDENCY_FILES].includes(name) : true
    }
    const walk = async (rootIndex: number, root: string, current: string): Promise<void> => {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) return
      if (metadata.isDirectory()) {
        if (current !== root && type !== 'data') return
        const entries = (await readdir(current)).sort()
        for (const entry of entries) {
          if (SECRET_NAME.test(entry)) continue
          await walk(rootIndex, root, join(current, entry))
        }
        return
      }
      if (!metadata.isFile() || !includeRootFile(basename(current))) return
      const relativePath = relative(root, current)
      if (relativePath === '' || relativePath.startsWith(`..${sep}`) || relativePath === '..') return
      const content = await readFile(current)
      total += content.byteLength
      if (files.length >= MAX_SNAPSHOT_FILES || total > MAX_SNAPSHOT_BYTES) throw new Error('snapshot exceeds local safety limits')
      files.push({ root: rootIndex, path: relativePath, mode: metadata.mode & 0o777, content: content.toString('base64') })
    }
    for (const [rootIndex, root] of roots.entries()) {
      if (await exists(root)) await walk(rootIndex, root, root)
    }
    return files
  }

  private async snapshotCurrentHash(type: SnapshotArchive['type']): Promise<string> {
    const roots = type === 'data' ? this.profile.snapshotPaths : [this.profile.profileDirectory]
    return hash(JSON.stringify(await this.collectSnapshot(type, roots)))
  }

  private async restoreSnapshot(value: unknown): Promise<void> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('snapshot archive is invalid')
    }
    const archive = value as Record<string, unknown>
    const type = archive.type
    if (archive.version !== 1
      || (type !== 'configuration' && type !== 'dependency' && type !== 'data' && type !== 'fleet')
      || !Array.isArray(archive.roots) || !archive.roots.every(root => typeof root === 'string')
      || !Array.isArray(archive.files)) {
      throw new Error('snapshot archive is invalid')
    }
    const expectedRoots = type === 'data' ? this.profile.snapshotPaths : [this.profile.profileDirectory]
    if (JSON.stringify(expectedRoots) !== JSON.stringify(archive.roots)) throw new Error('snapshot root policy changed')
    if (archive.files.length > MAX_SNAPSHOT_FILES) throw new Error('snapshot exceeds local safety limits')
    const restoreId = randomBytes(12).toString('hex')
    const entries: SnapshotRestoreEntry[] = []
    const destinations = new Set<string>()
    let total = 0
    for (const candidate of archive.files) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('snapshot file record is invalid')
      }
      const file = candidate as Record<string, unknown>
      const rootIndex = file.root
      const path = file.path
      const mode = file.mode
      const content = file.content
      if (typeof rootIndex !== 'number' || !Number.isSafeInteger(rootIndex)
        || typeof path !== 'string' || path === ''
        || typeof mode !== 'number' || !Number.isSafeInteger(mode)
        || mode < 0 || mode > 0o777 || typeof content !== 'string') {
        throw new Error('snapshot file record is invalid')
      }
      const root = expectedRoots[rootIndex]
      if (root === undefined) throw new Error('snapshot references an unknown root')
      const destination = resolve(root, path)
      if (!destination.startsWith(`${resolve(root)}${sep}`)) throw new Error('snapshot path escapes its root')
      if (path.split(/[\\/]/u).some(name => SECRET_NAME.test(name))) {
        throw new Error('snapshot contains a known secret-file class')
      }
      if (destinations.has(destination)) throw new Error('snapshot contains a duplicate destination')
      destinations.add(destination)
      const bytes = decodeBase64(content)
      total += bytes.byteLength
      if (total > MAX_SNAPSHOT_BYTES) throw new Error('snapshot exceeds local safety limits')
      await this.ensureSnapshotParent(root, dirname(destination))
      const existing = await lstat(destination).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error('snapshot destination is not a regular file')
      }
      entries.push({
        destination,
        temporary: `${destination}.dsh-hub-stage-${restoreId}`,
        backup: `${destination}.dsh-hub-backup-${restoreId}`,
        bytes,
        mode: mode & 0o700,
        existed: existing !== undefined,
        committed: false,
      })
    }
    try {
      for (const entry of entries) {
        await writeFile(entry.temporary, entry.bytes, { mode: entry.mode, flag: 'wx' })
      }
      for (const entry of entries) {
        if (entry.existed) await rename(entry.destination, entry.backup)
        try {
          await rename(entry.temporary, entry.destination)
          entry.committed = true
        } catch (error) {
          if (entry.existed) await rename(entry.backup, entry.destination)
          throw error
        }
      }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const entry of entries.toReversed()) {
        if (entry.committed) {
          await unlink(entry.destination).catch((rollbackError: unknown) => { rollbackErrors.push(rollbackError) })
          if (entry.existed) {
            await rename(entry.backup, entry.destination)
              .catch((rollbackError: unknown) => { rollbackErrors.push(rollbackError) })
          }
        }
        await unlink(entry.temporary).catch((rollbackError: unknown) => {
          if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') rollbackErrors.push(rollbackError)
        })
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'snapshot restore and rollback both failed')
      }
      throw error
    }
    for (const entry of entries) {
      if (entry.existed) await unlink(entry.backup)
    }
  }

  private async ensureSnapshotParent(root: string, parent: string): Promise<void> {
    const rootPath = resolve(root)
    const relativeParent = relative(rootPath, parent)
    if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`)) {
      throw new Error('snapshot parent escapes its root')
    }
    let current = rootPath
    for (const part of relativeParent.split(sep).filter(Boolean)) {
      current = join(current, part)
      try {
        const metadata = await lstat(current)
        if (metadata.isSymbolicLink()) throw new Error('snapshot restore refuses symlinked parent directories')
        if (!metadata.isDirectory()) throw new Error('snapshot restore parent is not a directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(current, { mode: 0o700 })
      }
    }
  }
}

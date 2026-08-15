/** Owner-only Node Agent configuration, identity, secret, and SQLite journal. */

import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { generateHubIpcSecret } from '@k1412/dsh-hub-node-ipc'
import { generateHubIdentity, HubNodeId, type HubIdentityKeyPair, type HubNodeId as HubNodeIdType } from '@k1412/dsh-hub-protocol'
import { SqliteReliableJournal } from '@k1412/dsh-hub-transport'

/** Persistent Node Agent configuration. Secret-bearing files require mode 0600. */
export interface HubNodeManagementProfile {
  runtimeId: string
  profileDirectory: string
  profileName: string
  dshExecutable: string
  snapshotPaths: string[]
}

/** Persistent Node Agent configuration. Secret-bearing files require mode 0600. */
export interface HubNodeAgentConfig {
  hubUrl: string
  nodeId: HubNodeIdType
  accessClientId: string
  accessClientSecret: string
  enrollmentCode?: string
  hubPublicKey: string
  stateDirectory: string
  ipcEndpoint: string
  management?: { profiles: HubNodeManagementProfile[] }
}

const configSchema = z.strictObject({
  hubUrl: z.url().refine(value => new URL(value).protocol === 'https:', 'Hub URL must use HTTPS'),
  nodeId: z.string().min(1).max(64),
  accessClientId: z.string().min(1).max(512),
  accessClientSecret: z.string().min(32).max(4_096),
  enrollmentCode: z.string().min(24).max(512).optional(),
  hubPublicKey: z.string().min(80).max(4_096),
  stateDirectory: z.string().min(1),
  ipcEndpoint: z.string().min(1),
  management: z.strictObject({
    profiles: z.array(z.strictObject({
      runtimeId: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/),
      profileDirectory: z.string().min(1),
      profileName: z.string().min(1).max(64),
      dshExecutable: z.string().min(1).max(4_096).default('dsh'),
      snapshotPaths: z.array(z.string().min(1)).max(64).default([]),
    })).min(1).max(64).refine(
      profiles => new Set(profiles.map(profile => profile.runtimeId)).size === profiles.length,
      'management runtime IDs must be unique',
    ),
  }).optional(),
})

async function ensurePrivateFile(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const metadata = await stat(path)
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Node Agent secret file must be a regular owner-only file: ${path}`)
  }
}

/**
 * Load and strictly validate a private Node Agent JSON configuration.
 * @param path - configuration file path.
 * @returns normalized and validated Node Agent configuration.
 */
export async function loadHubNodeAgentConfig(path: string): Promise<HubNodeAgentConfig> {
  const actual = resolve(path)
  await ensurePrivateFile(actual)
  const raw = configSchema.parse(JSON.parse(await readFile(actual, 'utf8')))
  const stateDirectory = resolve(raw.stateDirectory)
  if (!isAbsolute(raw.ipcEndpoint) && process.platform !== 'win32') throw new Error('IPC endpoint must be absolute')
  const managementProfiles = raw.management?.profiles.map(profile => ({
    runtimeId: profile.runtimeId,
    profileDirectory: resolve(profile.profileDirectory),
    profileName: profile.profileName,
    dshExecutable: profile.dshExecutable,
    snapshotPaths: profile.snapshotPaths.map(path => resolve(path)),
  }))
  if (managementProfiles !== undefined
    && new Set(managementProfiles.map(profile => profile.profileDirectory)).size !== managementProfiles.length) {
    throw new Error('management profile directories must be unique')
  }
  return {
    hubUrl: raw.hubUrl,
    nodeId: HubNodeId(raw.nodeId),
    accessClientId: raw.accessClientId,
    accessClientSecret: raw.accessClientSecret,
    ...(raw.enrollmentCode === undefined ? {} : { enrollmentCode: raw.enrollmentCode }),
    hubPublicKey: raw.hubPublicKey,
    stateDirectory,
    ipcEndpoint: process.platform === 'win32' ? raw.ipcEndpoint : resolve(raw.ipcEndpoint),
    ...(managementProfiles === undefined ? {} : {
      management: { profiles: managementProfiles },
    }),
  }
}

/** Persisted resources owned by the long-running Node Agent process. */
export class HubNodeAgentState implements Disposable {
  private constructor(
    public readonly configPath: string,
    public config: HubNodeAgentConfig,
    public readonly identity: HubIdentityKeyPair,
    public readonly ipcSecret: string,
    private readonly database: DatabaseSync,
    public readonly journal: SqliteReliableJournal,
  ) {}

  /**
   * Open or create identity, IPC secret, and durable transport journal.
   * @param configPath - owner-only Node Agent configuration path.
   * @returns initialized durable Node Agent state.
   */
  public static async open(configPath: string): Promise<HubNodeAgentState> {
    const actualConfigPath = resolve(configPath)
    const config = await loadHubNodeAgentConfig(actualConfigPath)
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 })
    await chmod(config.stateDirectory, 0o700)
    const identityPath = join(config.stateDirectory, 'identity.json')
    const secretPath = join(config.stateDirectory, 'connector.secret')
    const databasePath = join(config.stateDirectory, 'agent.db')
    const identity = await readOrCreateJson<HubIdentityKeyPair>(identityPath, generateHubIdentity)
    const ipcSecret = await readOrCreateText(secretPath, generateHubIpcSecret)
    const database = await openPrivateDatabase(databasePath)
    return new HubNodeAgentState(
      actualConfigPath,
      config,
      identity,
      ipcSecret,
      database,
      new SqliteReliableJournal(database, 'hub'),
    )
  }

  /** Remove the one-time enrollment code after Hub acceptance. */
  public async clearEnrollmentCode(): Promise<void> {
    if (this.config.enrollmentCode === undefined) return
    const { enrollmentCode: _removed, ...remaining } = this.config
    await writeFileAtomic(this.configPath, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    this.config = remaining
  }

  /** Close the durable transport database. */
  public close(): void {
    if (this.database.isOpen) this.database.close()
  }

  public [Symbol.dispose](): void {
    this.close()
  }
}

async function readOrCreateJson<T>(path: string, create: () => T): Promise<T> {
  try {
    await ensurePrivateFile(path)
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const value = create()
    await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return value
  }
}

async function readOrCreateText(path: string, create: () => string): Promise<string> {
  try {
    await ensurePrivateFile(path)
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const value = create()
    await writeFileAtomic(path, `${value}\n`, { mode: 0o600, dirMode: 0o700 })
    return value
  }
}

async function openPrivateDatabase(path: string): Promise<DatabaseSync> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await chmod(path, 0o600)
  const database = new DatabaseSync(path, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  })
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA trusted_schema = OFF')
  return database
}

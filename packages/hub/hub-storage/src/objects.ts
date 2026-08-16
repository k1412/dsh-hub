/** Immutable content-addressed durable objects for DSH Hub. */

import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  chmod, link, mkdir, open, readFile, stat, unlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { hubTransaction } from './schema.ts'

/** Deliberately narrow set of durable file classifications. */
export type HubObjectKind = 'plugin-artifact' | 'snapshot' | 'export' | 'backup'

/** Persisted immutable object metadata. */
export interface HubObjectRecord {
  objectHash: string
  kind: HubObjectKind
  sizeBytes: number
  mediaType: string
  createdAt: number
  referenceCount: number
}

function objectFromRow(row: Record<string, unknown>): HubObjectRecord {
  return {
    objectHash: String(row.object_hash),
    kind: String(row.kind) as HubObjectKind,
    sizeBytes: Number(row.size_bytes),
    mediaType: String(row.media_type),
    createdAt: Number(row.created_at),
    referenceCount: Number(row.reference_count),
  }
}

function assertObjectHash(hash: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) throw new Error('invalid SHA-256 object hash')
}

/** Content-addressed object store backed by an owner-only local directory. */
export class HubObjectStore {
  private constructor(private readonly database: DatabaseSync, private readonly root: string) {}

  /**
   * Prepare owner-only directories before accepting durable objects.
   * @param database - Hub control database carrying object metadata.
   * @param directory - content-addressed filesystem root.
   * @returns initialized immutable object store.
   */
  public static async open(database: DatabaseSync, directory: string): Promise<HubObjectStore> {
    const root = resolve(directory)
    await mkdir(join(root, 'objects', 'sha256'), { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    await chmod(join(root, 'objects'), 0o700)
    await chmod(join(root, 'objects', 'sha256'), 0o700)
    return new HubObjectStore(database, root)
  }

  /**
   * Store immutable bytes atomically and deduplicate by SHA-256.
   * @param kind - explicit durable-object classification.
   * @param bytes - immutable object bytes.
   * @param mediaType - recorded media type.
   * @param now - creation clock in Unix milliseconds.
   * @returns verified object metadata.
   */
  public async putBytes(kind: HubObjectKind, bytes: Uint8Array, mediaType: string, now = Date.now()): Promise<HubObjectRecord> {
    if (mediaType.length === 0 || mediaType.length > 256) throw new Error('invalid object media type')
    const hash = createHash('sha256').update(bytes).digest('base64url')
    const destination = this.pathFor(hash)
    const directory = dirname(destination)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporary = join(directory, `.${hash}.${randomBytes(12).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    let installed = false
    try {
      try {
        await link(temporary, destination)
        installed = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await this.verifyFile(destination, hash, bytes.byteLength)
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    try {
      hubTransaction(this.database, () => {
        const existing = this.database.prepare(`
          SELECT * FROM durable_objects WHERE object_hash = ?
        `).get(hash)
        if (existing === undefined) {
          this.database.prepare(`
            INSERT INTO durable_objects (
              object_hash, kind, size_bytes, media_type, created_at, reference_count
            ) VALUES (?, ?, ?, ?, ?, 0)
          `).run(hash, kind, bytes.byteLength, mediaType, now)
          return
        }
        const record = objectFromRow(existing)
        if (record.kind !== kind || record.sizeBytes !== bytes.byteLength || record.mediaType !== mediaType) {
          throw new Error('object hash already exists with incompatible metadata')
        }
      })
    } catch (error) {
      if (installed) await unlink(destination).catch(() => {})
      throw error
    }
    return this.requireObject(hash)
  }

  /**
   * Read one verified immutable object.
   * @param hash - canonical object SHA-256 identifier.
   * @returns verified object bytes.
   */
  public async readBytes(hash: string): Promise<Uint8Array> {
    const record = this.requireObject(hash)
    const path = this.pathFor(hash)
    await this.verifyFile(path, hash, record.sizeBytes)
    return readFile(path)
  }

  /**
   * Add an idempotent ownership reference and increment the durable count once.
   * @param ownerType - reference namespace.
   * @param ownerId - owning resource identifier.
   * @param hash - referenced object hash.
   * @param now - reference creation clock in Unix milliseconds.
   */
  public addReference(ownerType: string, ownerId: string, hash: string, now = Date.now()): void {
    assertObjectHash(hash)
    hubTransaction(this.database, () => {
      this.requireObject(hash)
      const result = this.database.prepare(`
        INSERT INTO object_references (owner_type, owner_id, object_hash, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(ownerType, ownerId, hash, now)
      if (Number(result.changes) === 1) {
        this.database.prepare(`
          UPDATE durable_objects SET reference_count = reference_count + 1 WHERE object_hash = ?
        `).run(hash)
      }
    })
  }

  /**
   * Remove an ownership reference and decrement the count exactly once.
   * @param ownerType - reference namespace.
   * @param ownerId - owning resource identifier.
   * @param hash - referenced object hash.
   */
  public removeReference(ownerType: string, ownerId: string, hash: string): void {
    assertObjectHash(hash)
    hubTransaction(this.database, () => {
      const result = this.database.prepare(`
        DELETE FROM object_references WHERE owner_type = ? AND owner_id = ? AND object_hash = ?
      `).run(ownerType, ownerId, hash)
      if (Number(result.changes) === 1) {
        this.database.prepare(`
          UPDATE durable_objects SET reference_count = reference_count - 1
          WHERE object_hash = ? AND reference_count > 0
        `).run(hash)
      }
    })
  }

  /**
   * Delete only unreferenced explicit objects older than a caller-selected horizon.
   * @param createdBefore - exclusive creation-time cutoff in Unix milliseconds.
   * @returns hashes removed from metadata and disk.
   */
  public async collectUnreferenced(createdBefore: number): Promise<string[]> {
    const rows = this.database.prepare(`
      SELECT * FROM durable_objects WHERE reference_count = 0 AND created_at < ? ORDER BY created_at
    `).all(createdBefore)
    const collected: string[] = []
    for (const row of rows) {
      const record = objectFromRow(row)
      const removed = hubTransaction(this.database, () => Number(this.database.prepare(`
          DELETE FROM durable_objects WHERE object_hash = ? AND reference_count = 0
        `).run(record.objectHash).changes) === 1)
      if (!removed) continue
      try {
        await unlink(this.pathFor(record.objectHash)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      } catch (error) {
        this.database.prepare(`
          INSERT INTO durable_objects (
            object_hash, kind, size_bytes, media_type, created_at, reference_count
          ) VALUES (?, ?, ?, ?, ?, 0)
        `).run(
          record.objectHash, record.kind, record.sizeBytes, record.mediaType, record.createdAt,
        )
        throw error
      }
      collected.push(record.objectHash)
    }
    return collected
  }

  /**
   * Resolve one object for administrative verification without exposing arbitrary paths.
   * @param hash - canonical object SHA-256 identifier.
   * @returns internal path for a known object.
   */
  public objectPath(hash: string): string {
    this.requireObject(hash)
    return this.pathFor(hash)
  }

  /**
   * Verify every object recorded by the control database.
   * @returns number of verified immutable objects.
   */
  public async verifyAll(): Promise<number> {
    const rows = this.database.prepare('SELECT * FROM durable_objects ORDER BY object_hash').all()
    for (const row of rows) {
      const record = objectFromRow(row)
      await this.verifyFile(this.pathFor(record.objectHash), record.objectHash, record.sizeBytes)
    }
    return rows.length
  }

  private pathFor(hash: string): string {
    assertObjectHash(hash)
    return join(this.root, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2))
  }

  private requireObject(hash: string): HubObjectRecord {
    assertObjectHash(hash)
    const row = this.database.prepare('SELECT * FROM durable_objects WHERE object_hash = ?').get(hash)
    if (row === undefined) throw new Error('durable object not found')
    return objectFromRow(row)
  }

  private async verifyFile(path: string, expectedHash: string, expectedSize: number): Promise<void> {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== expectedSize) throw new Error('durable object size mismatch')
    const bytes = await readFile(path)
    const actualHash = createHash('sha256').update(bytes).digest('base64url')
    if (actualHash !== expectedHash) throw new Error('durable object hash mismatch')
    await chmod(path, 0o600)
  }
}

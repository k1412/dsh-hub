/** SQLite control-plane and durable-object storage assembly for DSH Hub. */

import type { DatabaseSync } from 'node:sqlite'
import { installReliableJournalSchema, SqliteReliableJournal } from '@k1412/dsh-hub-transport'
import { HubObjectStore } from './objects.ts'
import { openHubDatabase } from './schema.ts'
import { HubControlStore } from './store.ts'

export * from './objects.ts'
export * from './schema.ts'
export * from './store.ts'

/** One ownership boundary for Hub database and immutable objects. */
export class HubStorage implements Disposable {
  private constructor(
    private readonly database: DatabaseSync,
    public readonly control: HubControlStore,
    public readonly objects: HubObjectStore,
  ) {}

  /**
   * Open the control database and object directory with owner-only permissions.
   * @param databasePath - SQLite control database path.
   * @param objectDirectory - content-addressed object-store root.
   * @returns initialized Hub storage boundary.
   */
  public static async open(databasePath: string, objectDirectory: string): Promise<HubStorage> {
    const database = await openHubDatabase(databasePath)
    try {
      const objects = await HubObjectStore.open(database, objectDirectory)
      installReliableJournalSchema(database)
      return new HubStorage(database, new HubControlStore(database), objects)
    } catch (error) {
      database.close()
      throw error
    }
  }

  /** Flush WAL state into the main database before an external filesystem backup. */
  public checkpoint(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  /**
   * Open one node's reliable-delivery journal inside the backed-up control database.
   * @param peerId - stable transport peer key.
   * @returns durable journal scoped to that peer.
   */
  public reliableJournal(peerId: string): SqliteReliableJournal {
    return new SqliteReliableJournal(this.database, peerId)
  }

  /** Close the underlying SQLite connection. */
  public close(): void {
    if (this.database.isOpen) this.database.close()
  }

  /** Close the underlying SQLite connection at explicit-disposal scope exit. */
  public [Symbol.dispose](): void {
    this.close()
  }
}

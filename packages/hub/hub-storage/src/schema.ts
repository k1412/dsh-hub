/** SQLite schema, secure open sequence, and transaction helper for DSH Hub. */

import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Current Hub control-plane schema version. */
export const HUB_STORAGE_SCHEMA_VERSION = 2

/**
 * Resolve, owner-create, configure, and migrate one Hub database.
 * @param path - database path or `:memory:` for tests.
 * @returns configured SQLite connection.
 */
export async function openHubDatabase(path: string): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await chmod(dirname(actual), 0o700)
    try {
      const handle = await open(actual, 'wx', 0o600)
      await handle.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await chmod(actual, 0o600)
  }
  const database = new DatabaseSync(actual, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  })
  try {
    configure(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function configure(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA trusted_schema = OFF')
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version < 0 || version > HUB_STORAGE_SCHEMA_VERSION) {
    throw new Error(`Hub database schema ${String(version)} is incompatible with ${String(HUB_STORAGE_SCHEMA_VERSION)}`)
  }
  if (version === 0) materializeV2(database)
  else if (version === 1) migrateV1ToV2(database)
}

function materializeV2(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;

    CREATE TABLE hub_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE nodes (
      node_id               TEXT PRIMARY KEY,
      display_name          TEXT NOT NULL,
      public_key            TEXT NOT NULL,
      status                TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      connection_generation INTEGER NOT NULL DEFAULT 0 CHECK (connection_generation >= 0),
      service_identity      TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      last_seen_at          INTEGER,
      revoked_at            INTEGER
    ) STRICT;

    CREATE TABLE enrollment_codes (
      code_hash    TEXT PRIMARY KEY,
      node_id      TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      expires_at   INTEGER NOT NULL,
      consumed_at  INTEGER,
      created_at   INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE runtimes (
      node_id             TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
      runtime_id          TEXT NOT NULL,
      boot_id             TEXT NOT NULL,
      dsh_version         TEXT NOT NULL,
      connector_version   TEXT NOT NULL,
      capabilities_json   TEXT NOT NULL,
      online              INTEGER NOT NULL CHECK (online IN (0, 1)),
      last_seen_at        INTEGER NOT NULL,
      PRIMARY KEY (node_id, runtime_id)
    ) STRICT;

    CREATE TABLE session_index (
      hub_session_id TEXT PRIMARY KEY,
      node_id        TEXT NOT NULL,
      runtime_id     TEXT NOT NULL,
      source_id      TEXT NOT NULL,
      title          TEXT,
      workspace_path TEXT,
      updated_at     INTEGER NOT NULL,
      running        INTEGER NOT NULL CHECK (running IN (0, 1)),
      stale          INTEGER NOT NULL CHECK (stale IN (0, 1)),
      FOREIGN KEY (node_id, runtime_id) REFERENCES runtimes(node_id, runtime_id) ON DELETE CASCADE,
      UNIQUE (node_id, runtime_id, source_id)
    ) STRICT;

    CREATE TABLE commands (
      command_id       TEXT PRIMARY KEY,
      node_id          TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
      runtime_id       TEXT,
      capability       TEXT NOT NULL,
      capability_ver   TEXT NOT NULL,
      operation        TEXT NOT NULL,
      idempotency      TEXT NOT NULL CHECK (idempotency IN ('read', 'idempotent', 'reconcile', 'never-retry')),
      idempotency_key  TEXT,
      payload_json     TEXT,
      payload_hash     TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'running', 'ok', 'error', 'outcome-unknown')),
      result_json      TEXT,
      result_hash      TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      terminal_at      INTEGER
    ) STRICT;

    CREATE INDEX commands_pending_by_node ON commands(node_id, status, created_at);

    CREATE TABLE durable_objects (
      object_hash      TEXT PRIMARY KEY,
      kind             TEXT NOT NULL CHECK (kind IN ('plugin-artifact', 'snapshot', 'export', 'backup')),
      size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
      media_type       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      reference_count INTEGER NOT NULL DEFAULT 0 CHECK (reference_count >= 0)
    ) STRICT;

    CREATE TABLE object_references (
      owner_type  TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      object_hash TEXT NOT NULL REFERENCES durable_objects(object_hash) ON DELETE RESTRICT,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (owner_type, owner_id, object_hash)
    ) STRICT;

    CREATE TABLE audit_log (
      sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at   INTEGER NOT NULL,
      actor         TEXT NOT NULL,
      action        TEXT NOT NULL,
      node_id       TEXT,
      runtime_id    TEXT,
      resource_id   TEXT,
      outcome       TEXT NOT NULL,
      details_json  TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      record_hash   TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;

    CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;

    PRAGMA user_version = 2;
    COMMIT;
  `)
}

function migrateV1ToV2(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE session_index ADD COLUMN workspace_path TEXT;
    PRAGMA user_version = 2;
    COMMIT;
  `)
}

/**
 * Execute one synchronous immediate transaction with rollback on failure.
 * @param database - target SQLite connection.
 * @param operation - synchronous transaction body.
 * @returns operation result after commit.
 */
export function hubTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

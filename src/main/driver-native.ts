import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { SqlDriver } from './driver'

/**
 * The native driver: real SQLite, on the real file, through the C library.
 *
 * Writes are durable when the statement returns — there is no whole-file
 * re-serialisation, so the cost of a write stops tracking the size of the
 * board. Measured on the real 12MB spec.db (Electron 34.5.8, this machine):
 *
 *     durable single write   sql.js 29.1ms   native+WAL 0.095ms   (307x)
 *     100 node creates       sql.js 2871ms   native+WAL 89ms      (32x)
 *     one persist at 12MB    sql.js 21ms     native            ~0
 *     one persist at 663MB   sql.js 5862ms   native            ~0
 *
 * ---------------------------------------------------------------------------
 * WAL AND THE DUAL-RUN CONSTRAINT
 *
 * The speed comes from WAL. WAL also stamps the file header and puts committed
 * data in a `-wal` sidecar that sql.js — which reads a flat byte array and has
 * no sidecar — cannot see. While BOTH drivers are in play that is a way to lose
 * data in plain sight, so this driver is disciplined about it:
 *
 *  - persist() runs a PASSIVE checkpoint, folding the WAL back into the main
 *    file on the same 400ms cadence sql.js used to re-serialise on. Cheap, and
 *    it means the main file is never far behind.
 *  - close() runs a TRUNCATE checkpoint and then puts the journal mode back to
 *    `delete`, removing the sidecar and the WAL header. The file left behind is
 *    an ordinary SQLite database that sql.js opens without knowing this driver
 *    was ever there. Verified as a full round trip: native writes -> sql.js
 *    reads and writes -> native reads back, integrity_check ok, 0 FK violations.
 *
 * Set OZMO_DB_JOURNAL=delete to skip WAL entirely (~63x slower on durable
 * writes, still 5x faster than sql.js) if a shared filesystem ever makes WAL
 * unavailable — WAL requires real shared memory and does not work over SMB/NFS.
 */
export function openNativeDriver(file: string): SqlDriver {
  fs.mkdirSync(path.dirname(file), { recursive: true })

  let db: Database.Database
  try {
    db = new Database(file)
  } catch (e) {
    const msg = (e as Error).message
    if (/NODE_MODULE_VERSION|was compiled against/.test(msg)) {
      throw new Error(
        `better-sqlite3 is built for the wrong Node ABI. Run \`npm run rebuild:native\`, ` +
          `or set OZMO_DB_DRIVER=sqljs to fall back. (${msg})`
      )
    }
    throw e
  }

  const journal = (process.env.OZMO_DB_JOURNAL ?? 'wal').toLowerCase()
  db.pragma(`journal_mode = ${journal === 'delete' ? 'delete' : 'wal'}`)
  db.pragma('foreign_keys = ON')
  // WAL's fsync-per-commit is the remaining cost; NORMAL gives up only the
  // last few committed transactions on an OS-level crash (not on app crash),
  // which is the same exposure the 400ms debounce already accepted.
  if (journal !== 'delete') db.pragma('synchronous = NORMAL')

  /**
   * better-sqlite3 compiles a statement once; reusing it is most of the win on
   * repeated writes. DDL can invalidate a cached plan, so the cache is dropped
   * whenever exec() runs something that is not transaction control or a pragma.
   */
  let closed = false
  /**
   * Leaving the process without the close discipline above would leave the file
   * flagged WAL, and — if the process died mid-transaction — with committed data
   * only in a `-wal` sidecar that sql.js cannot see. `index.ts` calls flushDb()
   * on before-quit, not closeDb(), so until it adopts closeDb() this hook is
   * what guarantees the file is handed back in a shape the other driver can
   * open. `exit` handlers must be synchronous; every pragma here is.
   */
  process.once('exit', () => closeCleanly())

  const cache = new Map<string, Database.Statement>()
  const TRANSIENT = /^\s*(begin|commit|rollback|savepoint|release|pragma)\b/i
  const prep = (sql: string): Database.Statement => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }

  return {
    name: 'native',

    exec(sql: string): void {
      if (!TRANSIENT.test(sql)) cache.clear() // DDL may have changed the schema
      db.exec(sql)
    },

    run(sql: string, params: readonly unknown[] = []): void {
      const stmt = prep(sql)
      // `run()` throws on a statement that returns rows, where sql.js quietly
      // stepped it once and moved on. Keep the seam's behaviour identical.
      if (stmt.reader) stmt.all(...(params as unknown[]))
      else stmt.run(...(params as unknown[]))
    },

    all<T>(sql: string, params: readonly unknown[] = []): T[] {
      const stmt = prep(sql)
      // ...and the mirror: sql.js returns [] for a non-SELECT, better-sqlite3
      // throws. PRAGMA sets reach here through get() in a couple of places.
      if (!stmt.reader) {
        stmt.run(...(params as unknown[]))
        return []
      }
      return stmt.all(...(params as unknown[])) as T[]
    },

    get<T>(sql: string, params: readonly unknown[] = []): T | undefined {
      const stmt = prep(sql)
      if (!stmt.reader) {
        stmt.run(...(params as unknown[]))
        return undefined
      }
      return stmt.get(...(params as unknown[])) as T | undefined
    },

    /** Already durable. Fold the WAL back so the main file stays current. */
    persist(): void {
      if (journal !== 'delete') db.pragma('wal_checkpoint(PASSIVE)')
    },

    close: closeCleanly
  }

  function closeCleanly(): void {
    if (closed) return
    closed = true
    try {
      if (journal !== 'delete') {
        db.pragma('wal_checkpoint(TRUNCATE)')
        db.pragma('journal_mode = delete') // leave a file sql.js can open
      }
      cache.clear()
      db.close()
    } catch (e) {
      console.error('[ozmo] native driver close failed', e)
    }
  }
}

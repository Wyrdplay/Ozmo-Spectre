import fs from 'fs'
import path from 'path'
import initSqlJs, { type Database } from 'sql.js'
import type { SqlDriver } from './driver'

/**
 * The incumbent: SQLite compiled to WASM, whole database held in memory, the
 * file on disk rewritten in full on every persist.
 *
 * This is a LIFT of what `db.ts` did inline, not a rewrite. It keeps working
 * exactly as it did, including the two things that were paid for in blood:
 *
 *  1. `export()` closes and reopens the underlying connection (sqlite3_close_v2
 *     + sqlite3_open), which resets every PER-CONNECTION pragma — foreign_keys
 *     among them. Re-assert it after EVERY export or ON DELETE CASCADE stops
 *     firing from the first debounced save onward. That bug orphaned rows for a
 *     day before anyone noticed; two one-shot sweeps in db.ts cleaned up after it.
 *  2. Write to a temp file and rename, so a crash mid-write cannot leave a
 *     half-serialised database where the real one was.
 */
/**
 * REFUSE A FILE WHOSE MOST RECENT WRITES ARE SOMEWHERE THIS DRIVER CANNOT SEE.
 *
 * The native driver runs in WAL: committed data sits in a `-wal` sidecar until
 * a checkpoint folds it back, and its close does exactly that. Close does not
 * run when the process is KILLED — a force-quit, a crashed machine, a task
 * manager. What is left behind is a main file that is out of date beside a
 * sidecar holding the difference.
 *
 * This driver reads a flat byte array and has no concept of a sidecar. Left to
 * itself it would open the stale bytes, show a board missing the most recent
 * work as though nothing were wrong, and then serialise that back over the top
 * on the first debounced save. Silent, and unrecoverable by the time anybody
 * notices what is gone.
 *
 * So: refuse, loudly, and name the one command that fixes it. A start-up that
 * fails with an instruction is strictly better than a start-up that succeeds
 * with a lie — this is the one place in the app where being unable to open the
 * database is the SAFE outcome.
 *
 * Checked by size, not by existence: SQLite leaves a zero-length `-wal` beside
 * a cleanly checkpointed database quite normally, and refusing on that would
 * make the app unstartable for no reason.
 */
function refuseIfWalPending(file: string): void {
  const sidecar = `${file}-wal`
  let size = 0
  try {
    size = fs.statSync(sidecar).size
  } catch {
    return // no sidecar at all: nothing to be behind
  }
  if (size === 0) return

  throw new Error(
    `${path.basename(file)} has un-folded WAL data in ${path.basename(sidecar)} (${(size / 1024).toFixed(0)}KB).\n` +
      'That sidecar was written by the native driver and this one cannot read it, so opening now would ' +
      'show a board missing its most recent work and then overwrite that work on the first save.\n\n' +
      '  npm run db:checkpoint\n\n' +
      'folds it back and leaves a file either driver can open. (Or run this session on the driver that ' +
      'wrote it: OZMO_DB_DRIVER=native.)'
  )
}

export async function openSqlJsDriver(file: string): Promise<SqlDriver> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  refuseIfWalPending(file)
  const wasmDir = path.dirname(require.resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) })
  const db: Database = fs.existsSync(file)
    ? new SQL.Database(fs.readFileSync(file))
    : new SQL.Database()

  const enableForeignKeys = (): void => {
    db.run('PRAGMA foreign_keys = ON')
  }
  enableForeignKeys() // immediately after construction, before any other statement

  const all = <T>(sql: string, params: readonly unknown[] = []): T[] => {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params as never[])
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  /** O(database size), every time, however little changed. */
  const persist = (): void => {
    const data = Buffer.from(db.export())
    enableForeignKeys() // export() just reset the connection — see the note above
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  }

  return {
    name: 'sqljs',

    exec(sql: string): void {
      db.run(sql)
    },

    run(sql: string, params: readonly unknown[] = []): void {
      const stmt = db.prepare(sql)
      try {
        stmt.bind(params as never[])
        stmt.step()
      } finally {
        stmt.free()
      }
    },

    all,

    get<T>(sql: string, params: readonly unknown[] = []): T | undefined {
      return all<T>(sql, params)[0]
    },

    persist,

    close(): void {
      persist()
      db.close()
    }
  }
}

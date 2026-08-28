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
export async function openSqlJsDriver(file: string): Promise<SqlDriver> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
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

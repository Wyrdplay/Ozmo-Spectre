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
  // a temp file left by a killed process is a half-written copy, never the truth:
  // the real file only ever changes by rename
  const base = path.basename(file)
  for (const f of fs.readdirSync(path.dirname(file))) {
    if (f.startsWith(base + '.tmp')) fs.rmSync(path.join(path.dirname(file), f), { force: true })
  }
  const wasmDir = path.dirname(require.resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) })
  const db: Database = fs.existsSync(file)
    ? new SQL.Database(fs.readFileSync(file))
    : new SQL.Database()

  const enableForeignKeys = (): void => {
    db.run('PRAGMA foreign_keys = ON')
  }
  enableForeignKeys() // immediately after construction, before any other statement

  /**
   * Column names are read ONCE per statement, not per row: getAsObject() asks
   * the WASM side for every name on every row, which on a graph read of ~20k
   * rows was the single largest self-time entry in the profile. Same object
   * shape (a repeated name still resolves to the last column), ~1.9× faster.
   */
  const readRows = <T>(sql: string, params: readonly unknown[], limit: number): T[] => {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params as never[])
      const cols = stmt.getColumnNames()
      const rows: T[] = []
      while (rows.length < limit && stmt.step()) {
        const values = stmt.get()
        const row: Record<string, unknown> = {}
        for (let i = 0; i < cols.length; i++) row[cols[i]] = values[i]
        rows.push(row as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  /**
   * SAVING WITHOUT STOPPING THE WORLD.
   *
   * export() is cheap (~20ms at 37MB). Writing those bytes is not: on a Docker
   * Desktop bind mount (9p/drvfs) one 37MB write measured 0.5–2s, sometimes
   * far worse, and a writeFileSync there held every request hostage for the
   * whole of it. So the snapshot is taken synchronously — it is the consistent
   * point — and the bytes go to disk off the event loop.
   *
   * Every snapshot carries a generation. Only a NEWER generation may replace
   * the file, and the rename itself stays synchronous so that check and the
   * rename cannot be split by a flush landing in between. At most one write is
   * in flight; snapshots taken meanwhile collapse into the latest one.
   *
   * flush() is the synchronous path for shutdown and board switching: it
   * writes a fresh snapshot and wins over anything still in flight, which then
   * discards itself.
   *
   * Every temp file is named for this driver instance and its generation. The
   * desktop app can close a board and reopen the same file while a background
   * write is still out; with one shared temp name the two would write into the
   * same file, and whichever renamed last could put torn bytes in place. Once
   * closed, a driver never renames again.
   */
  let exportedGen = 0
  let committedGen = 0
  let writing = false
  let closed = false
  let queued: { gen: number; data: Buffer } | null = null
  const instance = `${process.pid}-${Date.now().toString(36)}`
  const tmpFor = (gen: number): string => `${file}.tmp-${instance}-${gen}`
  // the background loop is a floating promise: anything thrown out of it would
  // be an unhandled rejection, which ends the process on Node 20
  const discard = (tmp: string): void => {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* swept at the next open */
    }
  }

  const snapshot = (): { gen: number; data: Buffer } => {
    const data = Buffer.from(db.export())
    enableForeignKeys() // export() just reset the connection — see the note above
    return { gen: ++exportedGen, data }
  }

  const drain = async (): Promise<void> => {
    if (writing) return
    writing = true
    let failures = 0
    try {
      while (queued) {
        const s = queued
        queued = null
        if (closed || s.gen <= committedGen) continue
        const tmp = tmpFor(s.gen)
        try {
          await fs.promises.writeFile(tmp, s.data)
          if (!closed && s.gen > committedGen) {
            fs.renameSync(tmp, file)
            committedGen = s.gen
          } else {
            discard(tmp) // a flush overtook us, or we were closed — ours is older
          }
          failures = 0
        } catch (e) {
          discard(tmp)
          failures++
          console.error(`[ozmo] background save failed (attempt ${failures}) — retrying`, e)
          if (!queued) queued = s // nothing newer to write: try this one again
          await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** failures)))
        }
      }
    } finally {
      writing = false
    }
  }

  /** Snapshot now, write in the background. The file on disk trails by one write at most. */
  const persist = (): void => {
    queued = snapshot()
    void drain()
  }

  /** Synchronous and final: when this returns, the file on disk is the database in memory. */
  const flush = (dirty: boolean): void => {
    if (closed || (!dirty && committedGen === exportedGen)) return
    const s = snapshot()
    queued = null
    const tmp = tmpFor(s.gen)
    fs.writeFileSync(tmp, s.data)
    fs.renameSync(tmp, file)
    committedGen = s.gen
  }

  const all = <T>(sql: string, params: readonly unknown[] = []): T[] => readRows<T>(sql, params, Infinity)

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
      return readRows<T>(sql, params, 1)[0]
    },

    persist,

    flush,

    close(): void {
      flush(true)
      closed = true
      db.close()
    }
  }
}

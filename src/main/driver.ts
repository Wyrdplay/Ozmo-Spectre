/**
 * The storage seam.
 *
 * `db.ts` owns the schema, the guarded ALTER TABLE migrations and the
 * persistence POLICY (the 400ms debounce). It does not own the SQLite driver.
 * Everything a driver must provide is below — five methods and a name — so the
 * `sql.js` path and the native path can run side by side and be compared on the
 * same database file.
 *
 * Deliberately NOT in this interface:
 *  - `tx()`          — identical for both drivers, built on exec() in db.ts
 *  - `foreignKeysOn` — identical for both, built on get() in db.ts
 *  - anything about the debounce — that is db.ts's policy, not a driver's
 *
 * The split between `exec` and `run` mirrors what db.ts already does today:
 * migrations and transaction control call the raw driver and do NOT schedule a
 * save; the exported `run()` does. Keeping both keeps the migration path
 * byte-for-byte the shape it was.
 */
export interface SqlDriver {
  readonly name: DriverName
  /**
   * Multi-statement SQL with no parameters: schema DDL, PRAGMA sets,
   * BEGIN/COMMIT/ROLLBACK. Never schedules a save.
   */
  exec(sql: string): void
  /** One parameterised statement. Never schedules a save — db.ts decides that. */
  run(sql: string, params?: readonly unknown[]): void
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  /**
   * Make everything written so far durable on disk.
   *
   * This is the whole reason the seam exists. For `sql.js` it is a whole-file
   * re-serialisation costing O(database size) — 21ms at 12MB, 5.9s at 663MB —
   * regardless of how few rows changed. For the native driver the data is
   * ALREADY durable when the statement returned, so this is only a WAL
   * checkpoint that keeps the main file current (and therefore readable by
   * sql.js, which matters while both drivers are in play).
   */
  persist(): void
  /** Flush and release the file. Must leave the file readable by the OTHER driver. */
  close(): void
}

export type DriverName = 'sqljs' | 'native'

export const DEFAULT_DRIVER: DriverName = 'sqljs'

/**
 * Which driver to open with. `sql.js` remains the default: the native driver is
 * opt-in until it has been run against a real board for long enough to trust.
 *
 *   OZMO_DB_DRIVER=native   npm run dev     (or the same key in settings)
 *
 * An unknown value is a typo, not a request for exotic behaviour — say so and
 * fall back rather than silently running the wrong engine.
 */
export function resolveDriverName(requested?: string | null): DriverName {
  const want = (requested ?? process.env.OZMO_DB_DRIVER ?? '').trim().toLowerCase()
  if (!want) return DEFAULT_DRIVER
  if (want === 'native' || want === 'better-sqlite3') return 'native'
  if (want === 'sqljs' || want === 'sql.js' || want === 'wasm') return 'sqljs'
  console.warn(`[ozmo] unknown OZMO_DB_DRIVER "${want}" — using ${DEFAULT_DRIVER}`)
  return DEFAULT_DRIVER
}

/**
 * Open `file` with the named driver.
 *
 * The native driver is a native module: it must have been built for THIS
 * Electron's ABI (`npm run rebuild:native`). If it cannot load we do NOT limp
 * on — an unreadable driver at startup should be loud, and the caller can set
 * OZMO_DB_DRIVER=sqljs to get the known-good path back in one keystroke.
 */
export async function openDriver(name: DriverName, file: string): Promise<SqlDriver> {
  if (name === 'native') {
    const { openNativeDriver } = await import('./driver-native')
    return openNativeDriver(file)
  }
  const { openSqlJsDriver } = await import('./driver-sqljs')
  return openSqlJsDriver(file)
}

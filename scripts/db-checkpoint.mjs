#!/usr/bin/env node
/**
 * Fold a WAL sidecar back into the database file, and leave the file in a shape
 * EITHER driver can open.
 *
 *   npm run db:checkpoint
 *   npm run db:checkpoint -- --db path\to\spec.db
 *
 * ## Why this exists
 *
 * The native driver runs in WAL mode. Committed data lives in a `-wal` sidecar
 * until a checkpoint folds it back, and the driver does that on a timer and
 * again on close (`wal_checkpoint(TRUNCATE)` then `journal_mode = delete`, so
 * the file left behind is an ordinary SQLite database).
 *
 * Close does not run when the process is KILLED. What is left is a main file
 * that is out of date and a sidecar holding the difference — and `sql.js`, the
 * default driver, reads a flat byte array with no idea sidecars exist. It would
 * open the stale file, show a board missing the most recent work, and then
 * serialise that back over the top. Silent, and unrecoverable by the time
 * anyone notices.
 *
 * `driver-sqljs.ts` now REFUSES to open such a file and names this script. This
 * is the other half: the fix it names.
 *
 * Runs headless under Electron's Node against a file no app is holding. It does
 * not migrate, does not read the schema, and changes no rows.
 */
import { reexecUnderElectron, loadBetterSqlite3, defaultDbPath } from './lib/electron-node.mjs'
reexecUnderElectron(import.meta.url)

import fs from 'node:fs'
import path from 'node:path'

const Database = loadBetterSqlite3()

const argIndex = process.argv.indexOf('--db')
const file = path.resolve(argIndex >= 0 && process.argv[argIndex + 1] ? process.argv[argIndex + 1] : defaultDbPath())

if (!fs.existsSync(file)) {
  console.error(`[checkpoint] no database at ${file}`)
  process.exit(1)
}

const sidecar = `${file}-wal`
const before = fs.existsSync(sidecar) ? fs.statSync(sidecar).size : 0
console.log(`[checkpoint] ${file}`)
console.log(`[checkpoint] wal sidecar: ${before === 0 ? 'none' : `${(before / 1024).toFixed(0)}KB`}`)

if (before === 0 && !fs.existsSync(`${file}-shm`)) {
  console.log('[checkpoint] nothing to fold — this file is already plain SQLite.')
  process.exit(0)
}

let db
try {
  db = new Database(file)
} catch (e) {
  console.error(`[checkpoint] cannot open: ${e.message}`)
  console.error('[checkpoint] is Spectre still running? Close it first — this must be the only writer.')
  process.exit(1)
}

// TRUNCATE rather than PASSIVE: PASSIVE gives up if any reader is in the way,
// and reports success either way. The point here is that the fold definitely
// happened, so a partial one has to be a failure.
const [{ busy, log, checkpointed }] = [db.pragma('wal_checkpoint(TRUNCATE)')].flat().map((r) => ({
  busy: r.busy, log: r.log, checkpointed: r.checkpointed
}))
if (busy !== 0) {
  console.error(`[checkpoint] REFUSED — something else holds this database (busy=${busy}). Close it and try again.`)
  process.exit(1)
}
console.log(`[checkpoint] folded ${checkpointed} of ${log} pages`)

db.pragma('journal_mode = delete')
const integrity = db.pragma('integrity_check', { simple: true })
const violations = db.pragma('foreign_key_check')
db.close()

const after = fs.existsSync(sidecar) ? fs.statSync(sidecar).size : 0
console.log(`[checkpoint] integrity_check: ${integrity}`)
console.log(`[checkpoint] foreign_key_check: ${violations.length} violations`)
console.log(`[checkpoint] wal sidecar now: ${after === 0 ? 'gone' : `${after} bytes`}`)

const ok = integrity === 'ok' && violations.length === 0 && after === 0
console.log(ok ? '[checkpoint] done — either driver can open this file.' : '[checkpoint] FAILED — do not run on this file until it is understood.')
process.exit(ok ? 0 : 1)

#!/usr/bin/env node
/**
 * Restore a snapshot and PROVE it. No snapshot counts as a backup until this
 * has run green against it (nd_be2580eab8: "an untested backup is a belief,
 * not a backup").
 *
 *   npm run db:restore                              # newest snapshot -> scratch, verify
 *   npm run db:restore -- --from path\to\spec.db
 *   npm run db:restore -- --into path\to\dir        # somewhere other than temp
 *   npm run db:restore -- --list                    # what snapshots exist
 *
 * By default it restores into a SCRATCH directory and never touches the live
 * database. Restoring over the live file is a down-tools operation and requires
 * --into pointing at it plus --app-is-stopped; the script refuses otherwise,
 * because writing spec.db underneath a running app loses whatever that app has
 * in memory (which, on the sql.js driver, is the entire database).
 *
 * The verification is deliberately more than "it opened":
 *   - SQLite header, integrity_check, foreign_key_check
 *   - every required table present, the retired review tables absent
 *   - row counts against the snapshot's manifest
 *   - the orphan-zero queries smoke ends on, and pair-uniqueness
 *   - BOTH drivers open the restored file — the dual-run guarantee, checked
 *     rather than assumed
 *   - a write/rollback probe, so we know the restored file is not read-only
 *     or missing a writable page
 */
import { reexecUnderElectron, loadBetterSqlite3, defaultDbPath, defaultBackupDir, ROOT } from './lib/electron-node.mjs'
reexecUnderElectron(import.meta.url)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { verifyDb, printChecks, sha256 } from './lib/db-verify.mjs'

const require = createRequire(import.meta.url)
const Database = loadBetterSqlite3()

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const backupDir = path.resolve(arg('dir', defaultBackupDir()))

function snapshots() {
  if (!fs.existsSync(backupDir)) return []
  return fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ file: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}

if (has('list')) {
  const s = snapshots()
  if (!s.length) console.log(`[restore] no snapshots in ${backupDir}`)
  for (const x of s) {
    const m = fs.existsSync(`${x.file}.json`) ? JSON.parse(fs.readFileSync(`${x.file}.json`, 'utf8')) : null
    console.log(`  ${new Date(x.mtime).toISOString()}  ${(fs.statSync(x.file).size / 1048576).toFixed(1)}MB  ${path.basename(x.file)}${m ? `  nodes=${m.counts?.nodes}` : '  (no manifest)'}`)
  }
  process.exit(0)
}

const newest = snapshots()[0]
const from = path.resolve(arg('from', newest ? newest.file : ''))
if (!from || !fs.existsSync(from)) {
  console.error(`[restore] no snapshot to restore. Looked in ${backupDir}. Use --from <file>.`)
  process.exit(1)
}

const scratch = path.resolve(arg('into', path.join(os.tmpdir(), 'ozmo-restore-' + Date.now())))
const target = path.join(scratch, 'spec.db')
const live = path.resolve(defaultDbPath())

if (path.resolve(target) === live && !has('app-is-stopped')) {
  console.error('[restore] REFUSING to write the live database while the app may be running.')
  console.error('[restore] Stop Ozmo Spectre, then re-run with --app-is-stopped.')
  process.exit(1)
}

fs.mkdirSync(scratch, { recursive: true })
for (const f of [target, `${target}-wal`, `${target}-shm`]) { try { fs.unlinkSync(f) } catch {} }

console.log(`[restore] from : ${from}`)
console.log(`[restore] into : ${target}\n`)

const manifest = fs.existsSync(`${from}.json`) ? JSON.parse(fs.readFileSync(`${from}.json`, 'utf8')) : null

const checks = []
const add = (name, pass, detail = '') => checks.push({ name, pass, detail })
const warnings = []

if (manifest) {
  // a manifest that DISAGREES with the file is bit rot, and that is fatal
  const actual = sha256(from)
  add('snapshot sha256 matches its manifest', actual === manifest.sha256,
    actual === manifest.sha256 ? `${actual.slice(0, 16)}…` : `manifest ${manifest.sha256.slice(0, 16)}… vs file ${actual.slice(0, 16)}…`)
} else {
  // a snapshot taken before db-backup existed. Every integrity check below still
  // applies; we just cannot cross-check row counts against what was intended.
  warnings.push('no .json manifest beside the snapshot — row counts cannot be cross-checked against the source')
}

fs.copyFileSync(from, target)
add('restored a byte-identical copy', sha256(target) === sha256(from))

const core = verifyDb(Database, target, { expectCounts: manifest?.counts ?? null })
checks.push(...core.checks)

// --- writable? a restored file that cannot take a write is not a restored board
if (core.ok) {
  try {
    const d = new Database(target)
    d.pragma('journal_mode = wal')
    d.exec('BEGIN')
    d.prepare("INSERT INTO meta (key, value) VALUES ('restore_probe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()))
    d.exec('ROLLBACK')
    const leaked = d.prepare("SELECT COUNT(*) c FROM meta WHERE key = 'restore_probe'").get().c
    d.pragma('wal_checkpoint(TRUNCATE)')
    d.pragma('journal_mode = delete')
    d.close()
    for (const f of [`${target}-wal`, `${target}-shm`]) { try { fs.unlinkSync(f) } catch {} }
    add('accepts a write and rolls it back cleanly', leaked === 0, `${leaked} rows survived the rollback`)
  } catch (e) {
    add('accepts a write and rolls it back cleanly', false, e.message)
  }
}

// --- BOTH drivers must open it. This is the dual-run guarantee, tested.
{
  const nodesNative = (() => {
    try {
      const d = new Database(target, { readonly: true })
      const n = d.prepare('SELECT COUNT(*) c FROM nodes').get().c
      d.close()
      return n
    } catch (e) { return `ERROR: ${e.message}` }
  })()
  add('native driver (better-sqlite3) opens it', typeof nodesNative === 'number', `nodes=${nodesNative}`)

  let nodesSqlJs
  try {
    const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'))
    const wasmDir = path.dirname(require.resolve(path.join(ROOT, 'node_modules', 'sql.js')))
    const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) })
    const d = new SQL.Database(fs.readFileSync(target))
    const st = d.prepare('SELECT COUNT(*) c FROM nodes')
    st.step()
    nodesSqlJs = st.getAsObject().c
    st.free()
    d.close()
  } catch (e) {
    nodesSqlJs = `ERROR: ${e.message}`
  }
  add('sql.js driver opens it', typeof nodesSqlJs === 'number', `nodes=${nodesSqlJs}`)
  add('both drivers agree on the row count', nodesNative === nodesSqlJs, `${nodesNative} vs ${nodesSqlJs}`)
}

printChecks(checks)
for (const w of warnings) console.log(`  warn  ${w}`)
const ok = checks.every((c) => c.pass)
console.log(`\n[restore] ${checks.filter((c) => c.pass).length}/${checks.length} checks passed${warnings.length ? `, ${warnings.length} warning(s)` : ''}`)
if (core.counts) console.log(`[restore] counts: ${JSON.stringify(core.counts)}`)

if (!ok) {
  console.error(`\n[restore] THIS SNAPSHOT IS NOT A BACKUP. Restored copy left at ${target} for inspection.`)
  process.exit(1)
}
console.log(`\n[restore] PROVEN. ${path.basename(from)} restores to a working board.`)
console.log(`[restore] restored copy: ${target}`)
if (!has('keep')) {
  fs.rmSync(scratch, { recursive: true, force: true })
  console.log('[restore] scratch removed (pass --keep to inspect it).')
}

#!/usr/bin/env node
/**
 * Do both drivers run the REAL src/main/db.ts identically?
 *
 *   npm run db:parity                       # newest snapshot
 *   npm run db:parity -- --db path\to.db
 *
 * The other scripts test the file format. This tests the code: it bundles the
 * actual db.ts — schema, guarded ALTER TABLE migrations, orphan sweep, the
 * exported all/get/run/tx — and runs openDb() twice against two copies of the
 * same database, once per driver, then diffs everything observable.
 *
 * It runs headless under Electron's Node (ELECTRON_RUN_AS_NODE): no app, no
 * window, no single-instance lock, and it only ever touches copies in a scratch
 * directory. It cannot disturb a running Ozmo Spectre.
 *
 * Why this exists: a seam that merely compiles proves nothing. The migration
 * path is where the two drivers would diverge — sql.js and SQLite 3.49 differ
 * on what PRAGMA returns, on whether a statement that returns rows may be
 * `run()`, and on whether ALTER TABLE DROP COLUMN exists at all.
 */
import { reexecUnderElectron, loadBetterSqlite3, defaultBackupDir, ROOT } from './lib/electron-node.mjs'
reexecUnderElectron(import.meta.url)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { verifyDb, printChecks, rowCounts } from './lib/db-verify.mjs'

const require = createRequire(import.meta.url)
const Better = loadBetterSqlite3()

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function newestSnapshot() {
  const dir = defaultBackupDir()
  if (!fs.existsSync(dir)) return ''
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.db'))
    .map((x) => ({ f: path.join(dir, x), m: fs.statSync(path.join(dir, x)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]
  return f ? f.f : ''
}

const SRC = path.resolve(arg('db', newestSnapshot()))
if (!SRC || !fs.existsSync(SRC)) {
  console.error('[parity] no database. Use --db <file>, or npm run db:backup first.')
  process.exit(1)
}

const SCRATCH = path.join(os.tmpdir(), 'ozmo-parity-' + Date.now())
fs.mkdirSync(SCRATCH, { recursive: true })

// --- bundle the real db.ts so we are testing shipped code, not a paraphrase
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
// inside the project: the bundle leaves sql.js / better-sqlite3 / gray-matter
// external, so it must sit somewhere node's resolver can walk up to node_modules
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'ozmo-parity')
fs.mkdirSync(BUILD_DIR, { recursive: true })
const bundle = path.join(BUILD_DIR, 'db.bundle.cjs')
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'main', 'db.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external', // sql.js, better-sqlite3, chokidar... all load from node_modules
  alias: { '@shared': path.join(ROOT, 'src', 'shared') },
  logLevel: 'warning'
})
const db = require(bundle)

const checks = []
const add = (name, pass, detail = '') => checks.push({ name, pass, detail })

console.log(`[parity] database : ${SRC}`)
console.log(`[parity] scratch  : ${SCRATCH}\n`)

const results = {}

for (const driver of ['sqljs', 'native']) {
  const file = path.join(SCRATCH, `${driver}.db`)
  fs.copyFileSync(SRC, file)
  const t0 = performance.now()
  try {
    await db.openDb(file, driver)
  } catch (e) {
    add(`${driver}: openDb() runs the schema + migrations`, false, e.message)
    results[driver] = null
    continue
  }
  const openMs = performance.now() - t0
  add(`${driver}: openDb() runs the schema + migrations`, true, `${openMs.toFixed(0)}ms`)
  add(`${driver}: reports its own name`, db.driverName() === driver, db.driverName())
  add(`${driver}: foreign_keys is ON after open`, db.foreignKeysOn() === true)

  const r = {
    counts: {},
    // a real read the app makes constantly
    nodeTypes: db.all('SELECT type, COUNT(*) c FROM nodes GROUP BY type ORDER BY type'),
    meta: db.all('SELECT key FROM meta ORDER BY key').map((m) => m.key),
    schema: db.all("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").map((s) => s.name),
    nodeCols: db.all('PRAGMA table_info(nodes)').map((c) => c.name).sort()
  }
  for (const t of ['projects', 'nodes', 'edges', 'edge_relationships', 'node_tags', 'annotations', 'activity', 'node_revisions']) {
    r.counts[t] = db.get(`SELECT COUNT(*) c FROM ${t}`).c
  }

  // --- exercise the write path the app actually uses: run() + tx() + rollback
  const pid = db.get('SELECT id FROM projects LIMIT 1').id
  const probeId = 'nd_parity_probe'
  const now = Date.now()
  db.run('INSERT INTO nodes (id,project_id,type,title,pinned,file_path,created_at,updated_at,created_by,shared) VALUES (?,?,?,?,0,?,?,?,?,0)',
    [probeId, pid, 'idea', 'parity probe', '', now, now, 'parity'])
  r.afterInsert = db.get('SELECT title FROM nodes WHERE id = ?', [probeId])?.title

  // tx that commits
  db.tx(() => {
    db.run('INSERT INTO node_tags (node_id, tag) VALUES (?, ?)', [probeId, 'parity'])
    db.run('UPDATE nodes SET x = ?, y = ? WHERE id = ?', [42, 43, probeId])
  })
  r.afterTx = db.get('SELECT x, y FROM nodes WHERE id = ?', [probeId])

  // tx that throws must leave nothing behind
  let threw = false
  try {
    db.tx(() => {
      db.run('INSERT INTO node_tags (node_id, tag) VALUES (?, ?)', [probeId, 'rolled-back'])
      throw new Error('deliberate')
    })
  } catch { threw = true }
  r.rollbackWorked = threw && !db.get('SELECT 1 FROM node_tags WHERE node_id = ? AND tag = ?', [probeId, 'rolled-back'])

  // cascade: deleting the node must take its tags (the pragma that once died)
  db.run('DELETE FROM nodes WHERE id = ?', [probeId])
  r.cascadeWorked = !db.get('SELECT 1 FROM node_tags WHERE node_id = ?', [probeId])
  r.fkStillOn = db.foreignKeysOn()

  const t1 = performance.now()
  db.flushDb()
  r.flushMs = +(performance.now() - t1).toFixed(1)
  db.closeDb()

  add(`${driver}: run() inserts and reads back`, r.afterInsert === 'parity probe', String(r.afterInsert))
  add(`${driver}: tx() commits both statements`, r.afterTx?.x === 42 && r.afterTx?.y === 43, JSON.stringify(r.afterTx))
  add(`${driver}: a throwing tx() rolls the whole thing back`, r.rollbackWorked === true)
  add(`${driver}: ON DELETE CASCADE fires (the pragma survived)`, r.cascadeWorked === true)
  add(`${driver}: foreign_keys still ON after persists`, r.fkStillOn === true)
  add(`${driver}: flush cost`, true, `${r.flushMs}ms`)

  // the file it left behind must be sound, and openable by the OTHER driver
  const v = verifyDb(Better, file, {})
  add(`${driver}: the file it left behind verifies`, v.ok, v.checks.filter((c) => !c.pass).map((c) => c.name).join(', '))
  r.finalCounts = v.counts
  results[driver] = r
}

// ---------------------------------------------------------------------------
// THE UNCLEAN EXIT
//
// The native driver's close folds the WAL back and clears the flag. A KILLED
// process never gets there, and what it leaves is a stale main file beside a
// sidecar holding the difference. sql.js reads a flat byte array and cannot see
// the sidecar — so left to itself it would open the stale bytes, look fine, and
// then write them back over the newer data on the first save.
//
// This simulates exactly that: write through native, abandon the file WITHOUT
// closing, and check that the other driver refuses instead of quietly lying.
{
  const dirty = path.join(SCRATCH, 'unclean.db')
  fs.copyFileSync(SRC, dirty)

  // Write in WAL and walk away — no checkpoint, no journal_mode reset.
  const raw = new Better(dirty)
  raw.pragma('journal_mode = wal')
  raw.exec("CREATE TABLE IF NOT EXISTS wal_probe (k TEXT PRIMARY KEY, v TEXT)")
  raw.exec("INSERT OR REPLACE INTO wal_probe VALUES ('written','through the wal')")
  // deliberately NOT: wal_checkpoint(TRUNCATE), journal_mode = delete, close()

  const sidecar = `${dirty}-wal`
  const size = fs.existsSync(sidecar) ? fs.statSync(sidecar).size : 0
  add('unclean exit leaves a non-empty -wal sidecar', size > 0, `${size} bytes`)

  let refused = null
  try {
    await db.openDb(dirty)
    await db.closeDb?.()
  } catch (e) {
    refused = String(e?.message ?? e)
  }
  add('sql.js REFUSES a file with un-folded WAL data rather than opening it stale',
    refused !== null, refused === null ? 'it OPENED — this is the silent-data-loss path' : '')
  add('and the refusal names the command that fixes it',
    refused !== null && /db:checkpoint/.test(refused),
    refused === null ? 'nothing was thrown' : refused.slice(0, 90))

  // The data really was only in the sidecar — which is what made the refusal
  // necessary rather than merely cautious.
  raw.pragma('wal_checkpoint(TRUNCATE)')
  raw.pragma('journal_mode = delete')
  raw.close()
  const recovered = new Better(dirty, { readonly: true })
  const row = recovered.prepare("SELECT v FROM wal_probe WHERE k = 'written'").get()
  recovered.close()
  add('and once folded, the write is there and the other driver may proceed',
    row?.v === 'through the wal', JSON.stringify(row))

  let reopened = null
  try {
    await db.openDb(dirty)
    await db.closeDb?.()
  } catch (e) {
    reopened = String(e?.message ?? e)
  }
  add('sql.js opens the same file once the sidecar is folded', reopened === null, reopened ?? '')
}

// ------------------------------------------------------------------ the diff
console.log('')
printChecks(checks)

if (results.sqljs && results.native) {
  console.log('\n--- sqljs vs native, on identical inputs ---')
  const diffs = []
  const cmp = (label, a, b) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b)
    if (sa !== sb) diffs.push(`${label}\n    sqljs : ${sa}\n    native: ${sb}`)
    console.log(`  ${sa === sb ? 'same' : 'DIFF'}  ${label}`)
  }
  cmp('row counts after open', results.sqljs.counts, results.native.counts)
  cmp('node type histogram', results.sqljs.nodeTypes, results.native.nodeTypes)
  cmp('meta keys (migration stamps)', results.sqljs.meta, results.native.meta)
  cmp('tables and indexes', results.sqljs.schema, results.native.schema)
  cmp('nodes columns after guarded ALTERs', results.sqljs.nodeCols, results.native.nodeCols)
  cmp('final row counts', results.sqljs.finalCounts, results.native.finalCounts)
  if (diffs.length) {
    console.log('\n' + diffs.join('\n'))
  }
  console.log(`\n  flush cost: sqljs ${results.sqljs.flushMs}ms  vs  native ${results.native.flushMs}ms`)
  if (diffs.length) checks.push({ name: 'drivers agree on every observable', pass: false, detail: `${diffs.length} differences` })
  else checks.push({ name: 'drivers agree on every observable', pass: true, detail: '' })
}


const ok = checks.every((c) => c.pass)
console.log(`\n[parity] ${checks.filter((c) => c.pass).length}/${checks.length} checks passed`)
if (!process.argv.includes('--keep')) {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.rmSync(BUILD_DIR, { recursive: true, force: true })
} else console.log(`[parity] scratch kept at ${SCRATCH}`)
process.exit(ok ? 0 : 1)

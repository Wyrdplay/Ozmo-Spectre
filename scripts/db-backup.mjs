#!/usr/bin/env node
/**
 * Take a snapshot of the board's database — and verify it before claiming it.
 *
 *   npm run db:backup                       # live spec.db -> ~/Documents/OzmoSpectreBackups
 *   npm run db:backup -- --db path\to.db --out path\to\dir
 *   npm run db:backup -- --label pre-cutover
 *
 * SAFE WHILE THE APP IS RUNNING. The source is opened READ-ONLY and copied
 * through SQLite's online backup API, which walks pages under a read lock and
 * restarts if a writer changes the file underneath it. A plain file copy would
 * be fine against the sql.js driver (which writes whole-file via temp+rename)
 * but would tear against the native driver mid-transaction; this is correct
 * against both, which is what a dual-run migration needs.
 *
 * The snapshot is written to a .part file and renamed only after it verifies,
 * so a directory of backups never contains a file that failed its own checks.
 * A .json manifest lands beside it with row counts and a sha256 — db-restore
 * checks the restored file against them.
 */
import { reexecUnderElectron, loadBetterSqlite3, defaultDbPath, defaultBackupDir } from './lib/electron-node.mjs'
reexecUnderElectron(import.meta.url)

import fs from 'node:fs'
import path from 'node:path'
import { verifyDb, printChecks, rowCounts, sha256 } from './lib/db-verify.mjs'

const Database = loadBetterSqlite3()

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const src = path.resolve(arg('db', defaultDbPath()))
const outDir = path.resolve(arg('out', defaultBackupDir()))
const label = arg('label', '')

if (!fs.existsSync(src)) {
  console.error(`[backup] no database at ${src}`)
  process.exit(1)
}

const now = new Date()
const p = (n, w = 2) => String(n).padStart(w, '0')
const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
const base = `spec-${stamp}${label ? '-' + label.replace(/[^a-zA-Z0-9._-]/g, '_') : ''}`
const dest = path.join(outDir, `${base}.db`)
const part = `${dest}.part`

fs.mkdirSync(outDir, { recursive: true })
for (const f of [part, `${part}-wal`, `${part}-shm`]) { try { fs.unlinkSync(f) } catch {} }

console.log(`[backup] source : ${src}  (${(fs.statSync(src).size / 1048576).toFixed(2)}MB)`)
console.log(`[backup] target : ${dest}`)

const t0 = Date.now()
const source = new Database(src, { readonly: true, fileMustExist: true })
const srcCounts = rowCounts(source)

try {
  await source.backup(part)
} catch (e) {
  source.close()
  console.error(`[backup] online backup failed: ${e.message}`)
  process.exit(1)
}
source.close()

// the backup API can leave the copy in WAL mode if the source was; normalise so
// the snapshot is a plain single-file database either driver can open cold
{
  const d = new Database(part)
  d.pragma('wal_checkpoint(TRUNCATE)')
  d.pragma('journal_mode = delete')
  d.close()
  for (const f of [`${part}-wal`, `${part}-shm`]) { try { fs.unlinkSync(f) } catch {} }
}

console.log(`[backup] copied in ${Date.now() - t0}ms — verifying before it counts as a backup\n`)
const { ok, checks, counts } = verifyDb(Database, part, { expectCounts: srcCounts })
printChecks(checks)

if (!ok) {
  console.error(`\n[backup] VERIFICATION FAILED — leaving the bad copy at ${part} and NOT publishing it.`)
  process.exit(1)
}

fs.renameSync(part, dest)
const probe = new Database(dest, { readonly: true })
const sqliteVersion = probe.prepare('SELECT sqlite_version() v').get().v
probe.close()
const manifest = {
  createdAt: now.toISOString(),
  source: src,
  file: path.basename(dest),
  bytes: fs.statSync(dest).size,
  sha256: sha256(dest),
  sqliteVersion,
  counts,
  label: label || undefined
}
fs.writeFileSync(`${dest}.json`, JSON.stringify(manifest, null, 2))

console.log(`\n[backup] verified and published: ${dest}`)
console.log(`[backup] manifest: ${dest}.json  (sha256 ${manifest.sha256.slice(0, 16)}…)`)
console.log(`[backup] counts: ${JSON.stringify(counts)}`)
console.log(`\n[backup] this snapshot is UNPROVEN until it has been restored:`)
console.log(`         npm run db:restore -- --from "${dest}"`)

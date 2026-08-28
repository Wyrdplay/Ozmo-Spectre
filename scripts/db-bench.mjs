#!/usr/bin/env node
/**
 * The measurement that justifies (or kills) the driver migration.
 *
 *   npm run db:bench                      # newest snapshot, N=500
 *   npm run db:bench -- --db path\to.db --n 2000
 *   npm run db:bench -- --scale           # also: how each driver behaves as the file grows
 *
 * Always runs against COPIES in a scratch directory. Never touches the source,
 * and never touches the live database.
 *
 * The claim under test is not "sql.js is slow" — its in-memory statements are
 * fine. It is that `Database.export()` re-serialises the WHOLE file on every
 * persist, so the cost of making a write durable is a function of how big the
 * board is rather than how much changed. A single local process hides that
 * behind a 400ms debounce. A served board with concurrent writers cannot.
 */
import { reexecUnderElectron, loadBetterSqlite3, defaultBackupDir, ROOT } from './lib/electron-node.mjs'
reexecUnderElectron(import.meta.url)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Better = loadBetterSqlite3()

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (n) => process.argv.includes(`--${n}`)

function newestSnapshot() {
  const dir = defaultBackupDir()
  if (!fs.existsSync(dir)) return ''
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.db'))
    .map((x) => ({ f: path.join(dir, x), m: fs.statSync(path.join(dir, x)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]
  return f ? f.f : ''
}

const SRC = path.resolve(arg('db', newestSnapshot()))
const N = Number(arg('n', 500))
if (!SRC || !fs.existsSync(SRC)) {
  console.error('[bench] no database to benchmark. Use --db <file>, or take a snapshot first (npm run db:backup).')
  process.exit(1)
}

const SCRATCH = path.join(os.tmpdir(), 'ozmo-bench-' + Date.now())
fs.mkdirSync(SCRATCH, { recursive: true })
const fresh = (name) => {
  const f = path.join(SCRATCH, name)
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s) } catch {} }
  fs.copyFileSync(SRC, f)
  return f
}

const rows = []
const report = (label, totalMs, n) => {
  rows.push({ label, totalMs: +totalMs.toFixed(1), perWriteMs: +(totalMs / n).toFixed(3), n })
  console.log(label.padEnd(50) + (totalMs.toFixed(1) + 'ms').padStart(11) + '  ' + (totalMs / n).toFixed(3) + ' ms/write')
}

// ---------------------------------------------------------------- sql.js
const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'))
const wasmDir = path.dirname(require.resolve(path.join(ROOT, 'node_modules', 'sql.js')))
const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) })

const openSqlJs = (f) => {
  const d = new SQL.Database(fs.readFileSync(f))
  d.run('PRAGMA foreign_keys = ON')
  return d
}
/** byte-for-byte what src/main/driver-sqljs.ts does. */
const persist = (d, f) => {
  const data = Buffer.from(d.export())
  d.run('PRAGMA foreign_keys = ON') // export() reset the connection
  fs.writeFileSync(f + '.tmp', data)
  fs.renameSync(f + '.tmp', f)
}
const sRun = (d, sql, params) => {
  const st = d.prepare(sql)
  try { st.bind(params); st.step() } finally { st.free() }
}
const sGet = (d, sql) => { const st = d.prepare(sql); st.step(); const r = st.getAsObject(); st.free(); return r }

const probe = new Better(SRC, { readonly: true })
const ids = probe.prepare('SELECT id FROM nodes LIMIT ?').all(Math.max(N, 1)).map((r) => r.id)
const pid = probe.prepare('SELECT id FROM projects LIMIT 1').get().id
probe.close()
const pick = (i) => ids[i % ids.length]
const UPD = 'UPDATE nodes SET x=?, y=?, updated_at=? WHERE id=?'

console.log(`database : ${SRC}`)
console.log(`size     : ${(fs.statSync(SRC).size / 1048576).toFixed(2)}MB`)
console.log(`N        : ${N}\n`)
console.log('--- a node drag: UPDATE nodes SET x, y, updated_at ---')

{ // in-memory floor — sql.js statements are NOT the problem
  const f = fresh('s-a.db'), d = openSqlJs(f)
  const t = performance.now()
  for (let i = 0; i < N; i++) sRun(d, UPD, [i, i, Date.now(), pick(i)])
  const e = performance.now() - t
  d.close()
  report('sql.js  statements only (no persist)', e, N)
}
{ // today's app under a burst: the 400ms debounce coalesces into one export
  const f = fresh('s-b.db'), d = openSqlJs(f)
  const t = performance.now()
  for (let i = 0; i < N; i++) sRun(d, UPD, [i, i, Date.now(), pick(i)])
  persist(d, f)
  const e = performance.now() - t
  d.close()
  report('sql.js  N writes + 1 persist (debounce best case)', e, N)
}
{ // the cost of ONE debounce window, whatever changed in it
  const f = fresh('s-c.db'), d = openSqlJs(f)
  const samples = []
  for (let i = 0; i < 10; i++) {
    sRun(d, UPD, [i, i, Date.now(), pick(i)])
    const t = performance.now(); persist(d, f); samples.push(performance.now() - t)
  }
  d.close()
  report('sql.js  ONE persist (whole-file re-serialise)', samples.reduce((a, b) => a + b, 0), samples.length)
}
{ // durable per write — what a server owes each caller before it answers
  const f = fresh('s-d.db'), d = openSqlJs(f)
  const n = Math.min(N, 200)
  const t = performance.now()
  for (let i = 0; i < n; i++) { sRun(d, UPD, [i, i, Date.now(), pick(i)]); persist(d, f) }
  const e = performance.now() - t
  d.close()
  report(`sql.js  persist per write (durable, n=${n})`, e, n)
}

// ---------------------------------------------------------- better-sqlite3
for (const mode of ['delete', 'wal']) {
  {
    const f = fresh(`b-${mode}-a.db`), d = new Better(f)
    d.pragma('foreign_keys = ON'); d.pragma(`journal_mode = ${mode}`)
    if (mode === 'wal') d.pragma('synchronous = NORMAL')
    const st = d.prepare(UPD)
    const t = performance.now()
    for (let i = 0; i < N; i++) st.run(i, i, Date.now(), pick(i))
    const e = performance.now() - t
    d.close()
    report(`native [${mode}] durable per write`, e, N)
  }
  {
    const f = fresh(`b-${mode}-b.db`), d = new Better(f)
    d.pragma('foreign_keys = ON'); d.pragma(`journal_mode = ${mode}`)
    if (mode === 'wal') d.pragma('synchronous = NORMAL')
    const st = d.prepare(UPD)
    const batch = d.transaction((n) => { for (let i = 0; i < n; i++) st.run(i, i, Date.now(), pick(i)) })
    const t = performance.now(); batch(N); const e = performance.now() - t
    d.close()
    report(`native [${mode}] N writes in one transaction`, e, N)
  }
}

// ------------------------------------------------- a whole verb, not a column
// A node create touches nodes, edges, edge_relationships, node_tags, activity
// and node_revisions — six tables, one transaction. This is the real unit.
console.log('\n--- a whole verb: node create across six tables, one transaction each ---')
const M = 100
const nid = (i) => `nd_bench${String(i).padStart(6, '0')}`
const eid = (i) => `ed_bench${String(i).padStart(6, '0')}`
const INS = {
  node: 'INSERT INTO nodes (id,project_id,type,title,pinned,file_path,created_at,updated_at,created_by,shared) VALUES (?,?,?,?,0,?,?,?,?,0)',
  edge: 'INSERT INTO edges (id,project_id,source_id,target_id,label,created_at,created_by) VALUES (?,?,?,?,?,?,?)',
  rel: 'INSERT INTO edge_relationships (edge_id,type,source_id,target_id,created_at,created_by) VALUES (?,?,?,?,?,?)',
  tag: 'INSERT INTO node_tags (node_id,tag) VALUES (?,?)',
  act: 'INSERT INTO activity (project_id,actor,action,subject_kind,subject_id,summary,at) VALUES (?,?,?,?,?,?,?)',
  rev: 'INSERT INTO node_revisions (node_id,at,actor,sha,content) VALUES (?,?,?,?,?)'
}
{
  const f = fresh('s-verb.db'), d = openSqlJs(f)
  const src = sGet(d, 'SELECT id FROM nodes LIMIT 1').id
  const t = performance.now()
  for (let i = 0; i < M; i++) {
    const now = Date.now()
    d.run('BEGIN')
    sRun(d, INS.node, [nid(i), pid, 'idea', 'bench ' + i, '', now, now, 'bench'])
    sRun(d, INS.edge, [eid(i), pid, nid(i), src, '', now, 'bench'])
    sRun(d, INS.rel, [eid(i), 'member', nid(i), src, now, 'bench'])
    sRun(d, INS.tag, [nid(i), 'bench'])
    sRun(d, INS.act, [pid, 'bench', 'node.create', 'node', nid(i), 'bench', now])
    sRun(d, INS.rev, [nid(i), now, 'bench', 'x'.repeat(40), 'body'])
    d.run('COMMIT')
    persist(d, f)
  }
  const e = performance.now() - t
  d.close()
  report(`sql.js  ${M} node creates (tx + persist each)`, e, M)
}
{
  const f = fresh('b-verb.db'), d = new Better(f)
  d.pragma('foreign_keys = ON'); d.pragma('journal_mode = wal'); d.pragma('synchronous = NORMAL')
  const src = d.prepare('SELECT id FROM nodes LIMIT 1').get().id
  const s = Object.fromEntries(Object.entries(INS).map(([k, v]) => [k, d.prepare(v)]))
  const create = d.transaction((i) => {
    const now = Date.now()
    s.node.run(nid(i), pid, 'idea', 'bench ' + i, '', now, now, 'bench')
    s.edge.run(eid(i), pid, nid(i), src, '', now, 'bench')
    s.rel.run(eid(i), 'member', nid(i), src, now, 'bench')
    s.tag.run(nid(i), 'bench')
    s.act.run(pid, 'bench', 'node.create', 'node', nid(i), 'bench', now)
    s.rev.run(nid(i), now, 'bench', 'x'.repeat(40), 'body')
  })
  const t = performance.now()
  for (let i = 0; i < M; i++) create(i)
  const e = performance.now() - t
  d.close()
  report(`native [wal] ${M} node creates (tx each)`, e, M)
}

// ------------------------------------------------------ how it scales, or does not
if (has('scale')) {
  console.log('\n--- cost vs file size (the actual argument) ---')
  console.log('file size'.padEnd(14) + 'sql.js one persist'.padStart(20) + 'native durable write'.padStart(24))
  for (const mult of [1, 2, 4, 8]) {
    const f = fresh(`scale-${mult}.db`)
    if (mult > 1) {
      const d = new Better(f)
      d.pragma('journal_mode = wal')
      d.transaction(() => {
        for (let i = 1; i < mult; i++) {
          d.prepare('INSERT INTO node_revisions (node_id, at, actor, sha, content) SELECT node_id, at + ?, actor, sha, content FROM node_revisions WHERE id <= (SELECT MAX(id) FROM node_revisions) LIMIT 100000').run(i)
        }
      })()
      d.pragma('wal_checkpoint(TRUNCATE)'); d.pragma('journal_mode = delete'); d.close()
      for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(f + s) } catch {} }
    }
    const size = fs.statSync(f).size
    const d = openSqlJs(f)
    const id = sGet(d, 'SELECT id FROM nodes LIMIT 1').id
    const samples = []
    for (let i = 0; i < 6; i++) {
      sRun(d, 'UPDATE nodes SET x=? WHERE id=?', [i, id])
      const t = performance.now(); persist(d, f); samples.push(performance.now() - t)
    }
    d.close()
    const sqljsAvg = samples.reduce((a, b) => a + b) / samples.length

    const b = new Better(f)
    b.pragma('journal_mode = wal'); b.pragma('synchronous = NORMAL')
    const st = b.prepare('UPDATE nodes SET x=? WHERE id=?')
    const t2 = performance.now()
    for (let i = 0; i < 500; i++) st.run(i, id)
    const nativeAvg = (performance.now() - t2) / 500
    b.pragma('wal_checkpoint(TRUNCATE)'); b.pragma('journal_mode = delete'); b.close()

    console.log(((size / 1048576).toFixed(1) + 'MB').padEnd(14) + (sqljsAvg.toFixed(2) + 'ms').padStart(20) + (nativeAvg.toFixed(3) + 'ms').padStart(24))
    rows.push({ label: `scale ${(size / 1048576).toFixed(1)}MB`, sqljsPersistMs: +sqljsAvg.toFixed(2), nativeWriteMs: +nativeAvg.toFixed(3) })
  }
}

fs.rmSync(SCRATCH, { recursive: true, force: true })
if (has('json')) console.log('\n' + JSON.stringify(rows, null, 2))

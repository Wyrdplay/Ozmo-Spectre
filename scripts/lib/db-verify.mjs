/**
 * What it means for a database file to be OK.
 *
 * "An untested backup is a belief, not a backup" (nd_be2580eab8). This is the
 * test. Both db-backup.mjs and db-restore.mjs run it, so a snapshot is verified
 * the moment it is taken AND again when it is restored — a backup that was fine
 * on Tuesday and rotted on the disk since fails on the way back in.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

/** Tables the app cannot function without. */
export const REQUIRED_TABLES = [
  'projects', 'nodes', 'node_tags', 'edges', 'edge_relationships',
  'annotations', 'activity', 'node_revisions', 'meta'
]

/** Tables retired by the review-nodes migrations — their presence means a stale file. */
export const RETIRED_TABLES = ['reviews', 'review_items', 'review_comments']

export const COUNTED_TABLES = [
  'projects', 'nodes', 'node_tags', 'edges', 'edge_relationships',
  'annotations', 'activity', 'node_revisions', 'skill_installs', 'meta'
]

/**
 * The orphan-zero queries `npm run smoke` ends on. Every one must return 0:
 * a child row whose parent is gone is exactly what the silently-disabled
 * foreign_keys pragma produced for a whole day.
 */
export const ORPHAN_QUERIES = {
  nodes: 'SELECT COUNT(*) c FROM nodes WHERE project_id NOT IN (SELECT id FROM projects)',
  edges: 'SELECT COUNT(*) c FROM edges WHERE project_id NOT IN (SELECT id FROM projects) OR source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)',
  edge_relationships: 'SELECT COUNT(*) c FROM edge_relationships WHERE edge_id NOT IN (SELECT id FROM edges)',
  node_tags: 'SELECT COUNT(*) c FROM node_tags WHERE node_id NOT IN (SELECT id FROM nodes)',
  node_revisions: 'SELECT COUNT(*) c FROM node_revisions WHERE node_id NOT IN (SELECT id FROM nodes)',
  annotations: "SELECT COUNT(*) c FROM annotations WHERE (parent_kind = 'node' AND parent_id NOT IN (SELECT id FROM nodes)) OR (parent_kind = 'edge' AND parent_id NOT IN (SELECT id FROM edges))",
  skill_installs: 'SELECT COUNT(*) c FROM skill_installs WHERE node_id NOT IN (SELECT id FROM nodes)'
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

export function rowCounts(db) {
  const out = {}
  for (const t of COUNTED_TABLES) {
    out[t] = tableExists(db, t) ? db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : null
  }
  return out
}

/**
 * Open `file` read-only and interrogate it. Returns { ok, checks[], counts }.
 * Never throws for a bad database — a corrupt file is a RESULT, not a crash.
 */
export function verifyDb(Database, file, { expectCounts = null } = {}) {
  const checks = []
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail })
  let counts = null

  if (!fs.existsSync(file)) {
    add('file exists', false, file)
    return { ok: false, checks, counts }
  }
  const size = fs.statSync(file).size
  add('file exists', true, `${(size / 1048576).toFixed(2)}MB`)

  const header = Buffer.alloc(16)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, header, 0, 16, 0)
  fs.closeSync(fd)
  add('SQLite header magic', header.toString('utf8', 0, 15) === 'SQLite format 3')

  let db
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
  } catch (e) {
    add('opens read-only', false, e.message)
    return { ok: false, checks, counts }
  }

  try {
    add('opens read-only', true)

    const ic = db.pragma('integrity_check')[0].integrity_check
    add('PRAGMA integrity_check', ic === 'ok', ic)

    const fk = db.pragma('foreign_key_check')
    add('PRAGMA foreign_key_check', fk.length === 0, `${fk.length} violations`)

    const missing = REQUIRED_TABLES.filter((t) => !tableExists(db, t))
    add('required tables present', missing.length === 0, missing.join(', '))

    const stale = RETIRED_TABLES.filter((t) => tableExists(db, t))
    add('retired review tables are gone', stale.length === 0, stale.join(', '))

    counts = rowCounts(db)
    add('projects and nodes are non-empty', counts.projects > 0 && counts.nodes > 0,
      `${counts.projects} projects, ${counts.nodes} nodes`)

    const orphans = {}
    for (const [name, sql] of Object.entries(ORPHAN_QUERIES)) {
      if (!tableExists(db, name)) continue
      orphans[name] = db.prepare(sql).get().c
    }
    const totalOrphans = Object.values(orphans).reduce((a, b) => a + b, 0)
    add('zero orphans in every child table', totalOrphans === 0, JSON.stringify(orphans))

    // the pair-uniqueness invariant: ONE connection per unordered node pair
    const dupPairs = db.prepare(
      'SELECT COUNT(*) c FROM (SELECT MIN(source_id, target_id) a, MAX(source_id, target_id) b FROM edges GROUP BY a, b HAVING COUNT(*) > 1)'
    ).get().c
    add('one connection per node pair', dupPairs === 0, `${dupPairs} duplicated pairs`)

    if (expectCounts) {
      const drift = []
      for (const t of COUNTED_TABLES) {
        if (expectCounts[t] == null) continue
        if (counts[t] !== expectCounts[t]) drift.push(`${t}: expected ${expectCounts[t]}, found ${counts[t]}`)
      }
      add('row counts match the manifest', drift.length === 0, drift.join('; '))
    }
  } finally {
    db.close()
  }

  return { ok: checks.every((c) => c.pass), checks, counts }
}

export function printChecks(checks) {
  for (const c of checks) {
    console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  —  ${c.detail}` : ''}`)
  }
}

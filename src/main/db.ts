import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import initSqlJs, { type Database } from 'sql.js'
import { newId } from '@shared/types'
import * as vault from './vault'

let db: Database
let dbFile = ''
let saveTimer: NodeJS.Timeout | null = null
let dirty = false

export async function openDb(file: string): Promise<void> {
  dbFile = file
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const wasmDir = path.dirname(require.resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) })
  db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database()
  enableForeignKeys() // immediately after construction, before any other statement
  migrate()
  enableForeignKeys() // re-assert after migrations (belt and braces)
  console.log(`[ozmo] PRAGMA foreign_keys = ${foreignKeysOn() ? 1 : 0} (per-connection; re-asserted after every export — see persistNow)`)
  cleanupOrphans()
  persistNow()
}

/**
 * foreign_keys is PER-CONNECTION in SQLite, and sql.js Database.export()
 * silently closes and reopens the underlying connection (sqlite3_close_v2 +
 * sqlite3_open in sql.js's export implementation) — which resets the pragma
 * to OFF. Set it right after construction and RE-ASSERT after every export,
 * or ON DELETE CASCADE stops firing the moment the first debounced save runs.
 */
function enableForeignKeys(): void {
  db.run('PRAGMA foreign_keys = ON')
}

/** Runtime truth of the per-connection pragma — logged at open, guarded in smoke. */
export function foreignKeysOn(): boolean {
  return get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1
}

// v1 swept the historical orphans but shipped with persistNow still dropping the
// pragma, so deletes made between v1 and the fix orphaned a few more rows — v2
// sweeps once with the pragma actually pinned. The sweep itself is idempotent.
const ORPHAN_CLEANUP_KEY = 'orphan_cleanup_v2'

/**
 * One-shot guarded cleanup: while the foreign_keys pragma was silently OFF
 * (export() reset, above), project deletes left their nodes/edges/tags —
 * and node deletes their revisions — behind as orphans. Sweep them once,
 * parent-tables first with FK enforcement paused so each DELETE's WHERE
 * clause (and therefore each reported count) is exact, then record the
 * counts in the meta table so the sweep never runs again.
 */
function cleanupOrphans(): void {
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (get('SELECT 1 FROM meta WHERE key = ?', [ORPHAN_CLEANUP_KEY])) return
  // ordered parent→child: deleting orphan nodes makes their tags/annotations/
  // revisions orphans, which the later sweeps then catch in the same pass
  // (the review tables retired into review NODES — no sweeps for them; on old DBs
  // the review-nodes migration runs before this ever re-runs)
  const sweeps: [table: string, where: string][] = [
    ['nodes', 'FROM nodes WHERE project_id NOT IN (SELECT id FROM projects)'],
    ['edges', 'FROM edges WHERE project_id NOT IN (SELECT id FROM projects) OR source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)'],
    ['node_tags', 'FROM node_tags WHERE node_id NOT IN (SELECT id FROM nodes)'],
    ['annotations', "FROM annotations WHERE (parent_kind = 'node' AND parent_id NOT IN (SELECT id FROM nodes)) OR (parent_kind = 'edge' AND parent_id NOT IN (SELECT id FROM edges))"],
    ['node_revisions', 'FROM node_revisions WHERE node_id NOT IN (SELECT id FROM nodes)']
  ]
  const removed: Record<string, number> = {}
  db.run('PRAGMA foreign_keys = OFF') // no cascades mid-sweep — counts stay exact
  db.run('BEGIN')
  try {
    for (const [table, where] of sweeps) {
      removed[table] = get<{ c: number }>(`SELECT COUNT(*) AS c ${where}`)?.c ?? 0
      if (removed[table] > 0) db.run(`DELETE ${where}`)
    }
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)',
      [ORPHAN_CLEANUP_KEY, JSON.stringify({ at: Date.now(), removed })] as never[])
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    enableForeignKeys()
    throw e
  }
  enableForeignKeys()
  const total = Object.values(removed).reduce((s, n) => s + n, 0)
  console.log(`[ozmo] migration: orphan cleanup removed ${total} rows ${JSON.stringify(removed)}`)
}

function migrate(): void {
  // Detected BEFORE the CREATEs: a missing node_revisions table means this is the
  // migration that introduces revision tracking, so existing nodes get a baseline.
  const hadRevisions = !!get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_revisions'")
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      folder TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL, title TEXT NOT NULL,
      progress INTEGER, rank REAL, pinned INTEGER NOT NULL DEFAULT 0, x REAL, y REAL,
      file_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
    CREATE TABLE IF NOT EXISTS node_tags (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL, PRIMARY KEY (node_id, tag)
    );
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);
    CREATE TABLE IF NOT EXISTS edge_relationships (
      edge_id TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (edge_id, type)
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      parent_kind TEXT NOT NULL CHECK (parent_kind IN ('node','edge')),
      parent_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_parent ON annotations(parent_id);
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      summary TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, at);
    CREATE TABLE IF NOT EXISTS node_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL,
      sha TEXT NOT NULL, content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_revisions_node ON node_revisions(node_id, at);

    -- Where a skill node has been installed, and the sha of exactly what WE wrote
    -- there. Drift is this sha vs the file on disk vs what the node renders to now.
    -- 1-to-N and written at a completely different cadence from the node, so it is
    -- a table and NEVER frontmatter (which would rewrite the vault file on every
    -- install and let the watcher fold it straight back).
    CREATE TABLE IF NOT EXISTS skill_installs (
      node_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id    TEXT NOT NULL,
      abs_path     TEXT NOT NULL,
      sha          TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      installed_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (node_id, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_installs_target ON skill_installs(target_id);
  `)
  // Guarded column adds — CREATE TABLE IF NOT EXISTS never touches existing tables.
  const nodeCols = all<{ name: string }>('PRAGMA table_info(nodes)').map((c) => c.name)
  if (!nodeCols.includes('rank')) db.run('ALTER TABLE nodes ADD COLUMN rank REAL')
  if (!nodeCols.includes('stage')) {
    db.run('ALTER TABLE nodes ADD COLUMN stage TEXT')
    if (nodeCols.includes('status')) {
      // one-shot backfill: existing warps derive their stage from the status they had
      // (planning→concept, active→implement, done→done, dropped→not_needed)
      db.run(`UPDATE nodes SET stage = CASE status
                WHEN 'planning' THEN 'concept'
                WHEN 'active'   THEN 'implement'
                WHEN 'done'     THEN 'done'
                WHEN 'dropped'  THEN 'not_needed'
                ELSE 'concept' END
              WHERE type = 'warp'`)
    } else {
      db.run("UPDATE nodes SET stage = 'concept' WHERE type = 'warp'")
    }
  }
  // cross-project sharing. `shared` is a FIELD, not a tag: tags are
  // replace-semantic (a PATCH sends the whole array), so a routine
  // read-modify-write could sever another project's references as a side effect,
  // and a structural relationship must not be destructible that way.
  // `references_node_id` marks a node as a REFERENCE to another project's node;
  // it is cleared on severance, when the reference materialises into an ordinary
  // local node carrying the `reference-broken` tag.
  if (!nodeCols.includes('shared')) db.run('ALTER TABLE nodes ADD COLUMN shared INTEGER NOT NULL DEFAULT 0')
  if (!nodeCols.includes('references_node_id')) db.run('ALTER TABLE nodes ADD COLUMN references_node_id TEXT')
  // skills. `slug` is the installed identity and must survive a retitle, so like
  // `shared` it is a column rather than anything tag- or title-derived.
  if (!nodeCols.includes('slug')) db.run('ALTER TABLE nodes ADD COLUMN slug TEXT')
  if (!nodeCols.includes('description')) db.run('ALTER TABLE nodes ADD COLUMN description TEXT')
  if (!nodeCols.includes('skill_options')) db.run('ALTER TABLE nodes ADD COLUMN skill_options TEXT')
  const activityCols = all<{ name: string }>('PRAGMA table_info(activity)').map((c) => c.name)
  if (!activityCols.includes('detail')) db.run('ALTER TABLE activity ADD COLUMN detail TEXT')
  if (!hadRevisions) backfillRevisions()
  if (nodeCols.includes('status')) migrateStatusToTags()
  migrateEdgeConnections()
  migrateReviewsToNodes()
  migrateReviewNodesAway()
}

const REVIEW_NODES_V2_KEY = 'review_nodes_v2'

/**
 * One-shot guarded (meta key): the AMENDED model — "REVIEW is a stage of a
 * Warp, which is a node" (faykarta). Review NODES retire: every feedback
 * membering a review re-parents onto the review's addressed node (merging onto
 * an existing feedback↔target connection when one exists — the exit-review
 * pattern, where feedback already "discusses" its warp); feedback in
 * trigger-less (rolling) reviews goes containerless — the inbox lens owns it.
 * "filed against" labels become "discusses" everywhere. The review nodes, their
 * remaining edges, tags, annotations and revisions are removed (files → vault
 * trash) with one activity row each preserving title + intent. Counts in meta.
 * Runs right after migrateReviewsToNodes, so DBs that never saw the interim
 * model pass straight through both (v1 stamps zeros, v2 finds no review nodes).
 */
function migrateReviewNodesAway(): void {
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (get('SELECT 1 FROM meta WHERE key = ?', [REVIEW_NODES_V2_KEY])) return
  const stats = {
    at: Date.now(), reviewNodesRemoved: 0, membersMerged: 0, membersRepointed: 0,
    membersDropped: 0, discussesRelabelled: 0, edgesRemoved: 0, annotationsRemoved: 0
  }
  interface Row { id: string; project_id: string; title: string; file_path: string }
  const reviewNodes = all<Row>("SELECT id, project_id, title, file_path FROM nodes WHERE type = 'review'")
  const t = Date.now()
  db.run('BEGIN')
  try {
    stats.discussesRelabelled = get<{ c: number }>("SELECT COUNT(*) AS c FROM edges WHERE label = 'filed against'")?.c ?? 0
    if (stats.discussesRelabelled) db.run("UPDATE edges SET label = 'discusses' WHERE label = 'filed against'")
    for (const rv of reviewNodes) {
      const intent = vault.readBody(rv.file_path).replace(/\s+/g, ' ').trim().slice(0, 200)
      const trigger = get<{ target_id: string }>(
        "SELECT target_id FROM edge_relationships WHERE type = 'addresses' AND source_id = ? LIMIT 1", [rv.id]
      )?.target_id ?? null
      const triggerExists = trigger ? !!get('SELECT 1 FROM nodes WHERE id = ?', [trigger]) : false
      const memberRels = all<{ edge_id: string; source_id: string }>(
        "SELECT edge_id, source_id FROM edge_relationships WHERE type = 'member' AND target_id = ?", [rv.id]
      )
      for (const m of memberRels) {
        if (trigger && triggerExists && m.source_id !== trigger) {
          const existing = get<{ id: string }>(
            'SELECT id FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
            [m.source_id, trigger, trigger, m.source_id]
          )
          if (existing) {
            // the feedback already discusses its trigger — the SAME connection gains membership
            const dup = get("SELECT 1 FROM edge_relationships WHERE edge_id = ? AND type = 'member'", [existing.id])
            if (!dup) {
              run('INSERT INTO edge_relationships (edge_id, type, source_id, target_id, created_at, created_by) VALUES (?,?,?,?,?,?)',
                [existing.id, 'member', m.source_id, trigger, t, 'migration'])
            }
            stats.membersMerged++
            // the feedback↔review connection dies with the review node below
          } else {
            // repoint the whole connection at the trigger (feedback → warp membership)
            run('UPDATE edges SET target_id = ? WHERE id = ?', [trigger, m.edge_id])
            run("UPDATE edge_relationships SET target_id = ? WHERE edge_id = ? AND type = 'member'", [trigger, m.edge_id])
            stats.membersRepointed++
          }
        } else {
          stats.membersDropped++ // rolling-review feedback goes containerless — the inbox owns it
        }
      }
      // remove the review node + everything still touching it
      const edgeIds = all<{ id: string }>('SELECT id FROM edges WHERE source_id = ? OR target_id = ?', [rv.id, rv.id]).map((x) => x.id)
      const parents = [rv.id, ...edgeIds]
      const ph = parents.map(() => '?').join(',')
      stats.annotationsRemoved += get<{ c: number }>(`SELECT COUNT(*) AS c FROM annotations WHERE parent_id IN (${ph})`, parents)?.c ?? 0
      run(`DELETE FROM annotations WHERE parent_id IN (${ph})`, parents)
      if (edgeIds.length) {
        const eph = edgeIds.map(() => '?').join(',')
        run(`DELETE FROM edge_relationships WHERE edge_id IN (${eph})`, edgeIds)
        run(`DELETE FROM edges WHERE id IN (${eph})`, edgeIds)
        stats.edgesRemoved += edgeIds.length
      }
      run('DELETE FROM node_tags WHERE node_id = ?', [rv.id])
      run('DELETE FROM node_revisions WHERE node_id = ?', [rv.id])
      run('DELETE FROM nodes WHERE id = ?', [rv.id])
      vault.trashFile(rv.file_path)
      run('INSERT INTO activity (project_id, actor, action, subject_kind, subject_id, summary, at, detail) VALUES (?,?,?,?,?,?,?,?)',
        [rv.project_id, 'migration', 'review.retired', 'node', rv.id,
          `review node "${rv.title}" retired — the warp's Review stage IS the review now${intent ? ` (intent: ${intent})` : ''}`,
          t, JSON.stringify({ trigger, title: rv.title })])
      stats.reviewNodesRemoved++
    }
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [REVIEW_NODES_V2_KEY, JSON.stringify(stats)] as never[])
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
  if (reviewNodes.length) console.log(`[ozmo] migration: review nodes → stage-is-the-review ${JSON.stringify(stats)}`)
}

const REVIEW_NODES_KEY = 'review_nodes_v1'

/**
 * One-shot guarded (meta key): the review/review_item/review_comment TABLES
 * retire into the graph. Each review → a `review` node (title; description →
 * body; `addresses` its warp where inferable — item-target majority, then
 * title-word overlap; no match = rolling, no trigger). Each item → a `feedback`
 * node (kind → tag; body → content; comments → annotations; node_id → a bare
 * connection labelled "filed against"). Old statuses map to graph position:
 * applied → folded (pruned + note), declined → folded-waived, open/accepted →
 * OPEN feedback — except inside CLOSED reviews, where open/accepted also fold
 * (the closure was faykarta's call in the old model; resurrecting them would
 * override it). Closed reviews are then trivially fully-actioned and gain the
 * `archived` tag. Review nodes pin in a row below the existing graph; feedback
 * hangs unpinned off its review (the member force pulls it in). Counts land in
 * meta; the three tables are DROPPED after an in-transaction recount.
 */
function migrateReviewsToNodes(): void {
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (get('SELECT 1 FROM meta WHERE key = ?', [REVIEW_NODES_KEY])) return
  const stats = {
    at: Date.now(), reviews: 0, feedback: 0, comments: 0, foldNotes: 0,
    memberEdges: 0, addressesEdges: 0, filedAgainst: 0,
    folded: 0, waived: 0, open: 0, archived: 0, rolling: 0
  }
  const hasTables = !!get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reviews'")
  if (!hasTables) {
    // fresh database — the tables never existed; stamp and move on
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [REVIEW_NODES_KEY, JSON.stringify(stats)] as never[])
    return
  }

  interface OldReview { id: string; project_id: string; title: string; description: string; status: string; created_at: number; updated_at: number; created_by: string }
  interface OldItem { id: string; review_id: string; node_id: string | null; kind: string; title: string; body: string; status: string; created_at: number; updated_at: number; created_by: string }
  interface OldComment { id: string; item_id: string; author: string; body: string; created_at: number }
  const reviews = all<OldReview>('SELECT * FROM reviews ORDER BY created_at')
  const items = all<OldItem>('SELECT * FROM review_items ORDER BY created_at')
  const comments = all<OldComment>('SELECT * FROM review_comments ORDER BY created_at')
  const commentsByItem = new Map<string, OldComment[]>()
  for (const c of comments) {
    const list = commentsByItem.get(c.item_id) ?? []
    list.push(c)
    commentsByItem.set(c.item_id, list)
  }
  const sha1 = (s: string): string => crypto.createHash('sha1').update(s, 'utf8').digest('hex')
  const t = Date.now()

  /** Infer the warp a review addressed: (a) a strict majority of its items
   *  target one node and that node is a warp; (b) exactly one same-project warp
   *  shares a "Warp N" number or a distinctive (≥5 char) title word. */
  const inferTrigger = (rv: OldReview, rvItems: OldItem[]): { id: string; title: string } | null => {
    const counts = new Map<string, number>()
    for (const i of rvItems) if (i.node_id) counts.set(i.node_id, (counts.get(i.node_id) ?? 0) + 1)
    let best: string | null = null
    let bestC = 0
    for (const [nid, c] of counts) if (c > bestC) { best = nid; bestC = c }
    if (best && rvItems.length > 0 && bestC * 2 >= rvItems.length) {
      const n = get<{ id: string; title: string; type: string }>('SELECT id, title, type FROM nodes WHERE id = ?', [best])
      if (n?.type === 'warp') return { id: n.id, title: n.title }
    }
    const warps = all<{ id: string; title: string }>("SELECT id, title FROM nodes WHERE project_id = ? AND type = 'warp'", [rv.project_id])
    const rvLower = rv.title.toLowerCase()
    const rvNum = /warp\s*(\d+)/i.exec(rv.title)?.[1]
    const matches = warps.filter((w) => {
      const wNum = /warp\s*(\d+)/i.exec(w.title)?.[1]
      if (rvNum && wNum && rvNum === wNum) return true
      return w.title.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.length >= 5 && word !== 'review' && rvLower.includes(word))
    })
    return matches.length === 1 ? matches[0] : null
  }

  /** Direct node insert + vault file + baseline revision (services is a higher layer — unavailable here).
   *  The interim 'review' type only ever exists between this migration and the v2 one that follows in
   *  the same startup — its folder name is pinned here (the live NODE_TYPES no longer knows it). */
  const INTERIM_FOLDERS = { review: 'Reviews', feedback: 'Feedback' } as const
  const makeNode = (
    projectId: string, projFolder: string, type: 'review' | 'feedback',
    title: string, body: string, tags: string[], createdAt: number, updatedAt: number, createdBy: string,
    pos: { x: number; y: number } | null, links: string[]
  ): string => {
    const id = newId('nd')
    const filePath = vault.createNodeFile(projFolder, INTERIM_FOLDERS[type], title,
      { id, type, stage: null, progress: null, tags, links: links.map((l) => `[[${vault.sanitizeFileName(l)}]]`) }, body)
    run(
      `INSERT INTO nodes (id, project_id, type, title, stage, progress, pinned, x, y, file_path, created_at, updated_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, projectId, type, title, null, null, pos ? 1 : 0, pos?.x ?? null, pos?.y ?? null, filePath, createdAt, updatedAt, createdBy]
    )
    for (const tag of tags) run('INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?,?)', [id, tag])
    const canonical = vault.readBody(filePath)
    run('INSERT INTO node_revisions (node_id, at, actor, sha, content) VALUES (?,?,?,?,?)',
      [id, t, 'migration', sha1(canonical), canonical])
    return id
  }

  const makeEdge = (projectId: string, sourceId: string, targetId: string, label: string, createdAt: number, createdBy: string,
    rel?: { type: string; sourceId: string; targetId: string }): string => {
    const id = newId('ed')
    run('INSERT INTO edges (id, project_id, source_id, target_id, label, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
      [id, projectId, sourceId, targetId, label, createdAt, createdBy])
    if (rel) {
      run('INSERT INTO edge_relationships (edge_id, type, source_id, target_id, created_at, created_by) VALUES (?,?,?,?,?,?)',
        [id, rel.type, rel.sourceId, rel.targetId, createdAt, createdBy])
    }
    return id
  }

  db.run('BEGIN')
  try {
    const perProjectX = new Map<string, number>()
    for (const rv of reviews) {
      const proj = get<{ folder: string }>('SELECT folder FROM projects WHERE id = ?', [rv.project_id])
      if (!proj) continue // orphan review row — the old cleanup missed it; leave it to die with the DROP
      const rvItems = items.filter((i) => i.review_id === rv.id)
      const closed = rv.status === 'closed'

      // pin the review node in a tidy row below the project's existing graph
      const ext = get<{ maxY: number | null; minX: number | null }>(
        'SELECT MAX(y) AS maxY, MIN(x) AS minX FROM nodes WHERE project_id = ? AND x IS NOT NULL', [rv.project_id])
      const idx = perProjectX.get(rv.project_id) ?? 0
      perProjectX.set(rv.project_id, idx + 1)
      const pos = { x: (ext?.minX ?? 0) + idx * 420, y: (ext?.maxY ?? 0) + 340 }

      const trigger = inferTrigger(rv, rvItems)
      const reviewId = makeNode(
        rv.project_id, proj.folder, 'review', rv.title, rv.description ? rv.description + '\n' : '',
        closed ? ['archived'] : [], rv.created_at, rv.updated_at, rv.created_by, pos,
        trigger ? [trigger.title] : []
      )
      stats.reviews++
      if (closed) stats.archived++
      if (trigger) {
        makeEdge(rv.project_id, reviewId, trigger.id, '', rv.created_at, rv.created_by,
          { type: 'addresses', sourceId: reviewId, targetId: trigger.id })
        stats.addressesEdges++
      } else {
        stats.rolling++
      }

      for (const it of rvItems) {
        const itComments = commentsByItem.get(it.id) ?? []
        // closed reviews keep their closure: everything folds; open reviews map
        // applied/declined → folded, open/accepted stay OPEN feedback
        const folds = closed || it.status === 'applied' || it.status === 'declined'
        const waive = it.status === 'declined'
        const tags = [it.kind, ...(folds ? ['pruned'] : [])]
        const target = it.node_id
          ? get<{ id: string; title: string }>('SELECT id, title FROM nodes WHERE id = ?', [it.node_id])
          : undefined
        const links = [rv.title, ...(target ? [target.title] : [])]
        const fbId = makeNode(rv.project_id, proj.folder, 'feedback', it.title, it.body ? it.body + '\n' : '',
          tags, it.created_at, it.updated_at, it.created_by, null, links)
        stats.feedback++
        if (folds) { if (waive) stats.waived++; else stats.folded++ } else stats.open++
        makeEdge(rv.project_id, fbId, reviewId, '', it.created_at, it.created_by,
          { type: 'member', sourceId: fbId, targetId: reviewId })
        stats.memberEdges++
        if (target) {
          makeEdge(rv.project_id, fbId, target.id, 'filed against', it.created_at, it.created_by)
          stats.filedAgainst++
        }
        for (const c of itComments) {
          run('INSERT INTO annotations (id, parent_kind, parent_id, author, body, created_at) VALUES (?,?,?,?,?,?)',
            [newId('an'), 'node', fbId, c.author, c.body, c.created_at])
          stats.comments++
        }
        if (folds) {
          const last = itComments[itComments.length - 1]
          const why = closed && it.status !== 'applied' && it.status !== 'declined'
            ? 'folded on migration — the review was closed in the old model'
            : waive
              ? `waived on migration (was: declined)${last ? ` — ${last.body.slice(0, 140)}` : ''}`
              : `folded on migration (was: applied)${last ? ` — ${last.body.slice(0, 140)}` : ''}`
          run('INSERT INTO annotations (id, parent_kind, parent_id, author, body, created_at) VALUES (?,?,?,?,?,?)',
            [newId('an'), 'node', fbId, 'migration', why, t])
          stats.foldNotes++
        }
      }
      run('INSERT INTO activity (project_id, actor, action, subject_kind, subject_id, summary, at, detail) VALUES (?,?,?,?,?,?,?,?)',
        [rv.project_id, 'migration', 'review.migrated', 'node', reviewId,
          `review "${rv.title}" became a review node (${rvItems.length} item${rvItems.length === 1 ? '' : 's'} → feedback)`,
          t, JSON.stringify({ oldReviewId: rv.id, items: rvItems.length, trigger: trigger?.id ?? null })])
    }

    // verify before the point of no return — a mismatch rolls the whole thing back
    if (stats.reviews !== reviews.filter((r) => get('SELECT 1 FROM projects WHERE id = ?', [r.project_id])).length ||
        stats.feedback !== stats.folded + stats.waived + stats.open ||
        stats.comments !== comments.filter((c) => items.some((i) => i.id === c.item_id)).length) {
      throw new Error(`review-nodes migration verification failed: ${JSON.stringify(stats)}`)
    }
    db.run('DROP TABLE IF EXISTS review_comments')
    db.run('DROP TABLE IF EXISTS review_items')
    db.run('DROP TABLE IF EXISTS reviews')
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [REVIEW_NODES_KEY, JSON.stringify(stats)] as never[])
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
  console.log(`[ozmo] migration: reviews → review nodes ${JSON.stringify(stats)}`)
}

const EDGE_CONNECTIONS_KEY = 'edge_connections_v1'

/**
 * One-shot guarded (meta key): parallel edges collapse into ONE connection per
 * unordered node pair; the old per-row `type` becomes a typed, directed
 * relationship ON the surviving connection (edge_relationships). Rules:
 * oldest row of a pair survives as the connection; each absorbed row's type
 * becomes a relationship keeping ITS direction/timestamps (exact type dups
 * collapse, oldest wins); `relates` rows contribute NO relationship — a bare
 * connection IS the plain association; distinct non-empty labels join with
 * " · "; annotations of absorbed rows reparent to the survivor; absorbed rows
 * are deleted. Counts land in the meta table. Afterwards the type column is
 * dropped (or orphaned if SQLite refuses) and the unordered-pair uniqueness is
 * locked in with an expression index.
 */
function migrateEdgeConnections(): void {
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const hasType = all<{ name: string }>('PRAGMA table_info(edges)').map((c) => c.name).includes('type')
  if (!get('SELECT 1 FROM meta WHERE key = ?', [EDGE_CONNECTIONS_KEY])) {
    interface OldEdge { id: string; source_id: string; target_id: string; type?: string; label: string; created_at: number; created_by: string }
    const stats = {
      at: Date.now(), pairs: 0, rowsBefore: 0, rowsAbsorbed: 0, relationships: 0,
      dupRelationshipsCollapsed: 0, labelsMerged: 0, annotationsReparented: 0
    }
    db.run('BEGIN')
    try {
      const rows = all<OldEdge>('SELECT * FROM edges ORDER BY created_at ASC, id ASC')
      stats.rowsBefore = rows.length
      const groups = new Map<string, OldEdge[]>()
      for (const r of rows) {
        const key = r.source_id < r.target_id ? `${r.source_id}|${r.target_id}` : `${r.target_id}|${r.source_id}`
        const list = groups.get(key) ?? []
        list.push(r)
        groups.set(key, list)
      }
      stats.pairs = groups.size
      for (const [, list] of groups) {
        const survivor = list[0] // oldest row IS the connection
        const seenTypes = new Set<string>()
        const labels: string[] = []
        for (const r of list) {
          const t = hasType ? r.type ?? 'relates' : 'relates'
          if (t !== 'relates') {
            if (seenTypes.has(t)) {
              stats.dupRelationshipsCollapsed++
            } else {
              seenTypes.add(t)
              run('INSERT INTO edge_relationships (edge_id, type, source_id, target_id, created_at, created_by) VALUES (?,?,?,?,?,?)',
                [survivor.id, t, r.source_id, r.target_id, r.created_at, r.created_by])
              stats.relationships++
            }
          }
          if (r.label && !labels.includes(r.label)) labels.push(r.label)
        }
        const label = labels.join(' · ')
        if (label !== survivor.label) {
          run('UPDATE edges SET label = ? WHERE id = ?', [label, survivor.id])
          stats.labelsMerged++
        }
        for (const r of list.slice(1)) {
          const anns = get<{ c: number }>("SELECT COUNT(*) AS c FROM annotations WHERE parent_kind = 'edge' AND parent_id = ?", [r.id])?.c ?? 0
          if (anns > 0) {
            run("UPDATE annotations SET parent_id = ? WHERE parent_kind = 'edge' AND parent_id = ?", [survivor.id, r.id])
            stats.annotationsReparented += anns
          }
          run('DELETE FROM edges WHERE id = ?', [r.id])
          stats.rowsAbsorbed++
        }
      }
      db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [EDGE_CONNECTIONS_KEY, JSON.stringify(stats)] as never[])
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
      throw e
    }
    console.log(`[ozmo] migration: edges → connections ${JSON.stringify(stats)}`)
  }
  if (hasType) {
    try {
      db.run('ALTER TABLE edges DROP COLUMN type')
      console.log('[ozmo] migration: edges.type column dropped — relationships carry types now')
    } catch (e) {
      console.error('[ozmo] migration: edges.type DROP COLUMN failed — column orphaned (never read or written again)', e)
    }
  }
  // pair uniqueness, locked in at the storage layer (2-arg scalar min/max expression
  // index) — created only after the dedup above so it cannot trip on legacy parallels
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON edges (min(source_id, target_id), max(source_id, target_id))')
}

/**
 * One-shot (guarded on the status column existing): node status dies, tags
 * carry state. Every non-default status becomes a same-named lowercase tag;
 * type-default statuses (idea/bug/question "open", feature "planned",
 * pillar/principle "active") just drop, and warps drop status entirely (their
 * lifecycle lives in stage). Frontmatter of every node file is rewritten to
 * lose the status key and carry the DB-truth tags, so the watcher's
 * replace-tags semantics cannot wipe migrated tags on the next external edit.
 * Finally the column is dropped (SQLite ≥3.35); if that fails the column is
 * orphaned — never read or written again.
 */
function migrateStatusToTags(): void {
  run(`INSERT OR IGNORE INTO node_tags (node_id, tag)
       SELECT id, LOWER(TRIM(status)) FROM nodes
       WHERE type != 'warp' AND status IS NOT NULL AND TRIM(status) != ''
         AND NOT ((type IN ('idea','bug','question') AND status = 'open')
               OR (type = 'feature' AND status = 'planned')
               OR (type IN ('pillar','principle') AND status = 'active'))`)
  try {
    if (vault.getVaultRoot()) {
      for (const n of all<{ id: string; file_path: string }>("SELECT id, file_path FROM nodes WHERE file_path != ''")) {
        const tags = all<{ tag: string }>('SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag', [n.id]).map((t) => t.tag)
        vault.stripStatusFrontmatter(n.file_path, tags)
      }
    }
  } catch (e) {
    console.error('status → tags frontmatter rewrite failed', e)
  }
  try {
    db.run('ALTER TABLE nodes DROP COLUMN status')
    console.log('[ozmo] migration: node status → tags complete; status column dropped')
  } catch (e) {
    legacyStatusColumn = true
    console.error('[ozmo] migration: node status → tags complete, but DROP COLUMN failed — status column orphaned (ignored everywhere)', e)
  }
}

let legacyStatusColumn = false

/** True when the legacy NOT NULL status column could not be dropped — inserts must feed it ''. */
export function hasLegacyStatusColumn(): boolean {
  return legacyStatusColumn
}

/**
 * One-shot when revision tracking first arrives: snapshot the current body of every
 * existing node with a file as its baseline revision, so diffs work from day one.
 * Runs inside the migration path only when node_revisions was just created.
 * The vault is initialised before openDb (see index.ts); if that ever changes we
 * skip quietly — the diff endpoint self-heals missing revisions on first read.
 */
function backfillRevisions(): void {
  try {
    if (!vault.getVaultRoot()) return
    const t = Date.now()
    for (const n of all<{ id: string; file_path: string }>("SELECT id, file_path FROM nodes WHERE file_path != ''")) {
      const parsed = vault.parseFile(vault.absPath(n.file_path))
      if (!parsed) continue // no file on disk — nothing to snapshot
      const sha = crypto.createHash('sha1').update(parsed.body, 'utf8').digest('hex')
      run('INSERT INTO node_revisions (node_id, at, actor, sha, content) VALUES (?,?,?,?,?)',
        [n.id, t, 'migration', sha, parsed.body])
    }
  } catch (e) {
    console.error('node_revisions backfill failed', e)
  }
}

export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
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

export function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  return all<T>(sql, params)[0]
}

export function run(sql: string, params: unknown[] = []): void {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params as never[])
    stmt.step()
  } finally {
    stmt.free()
  }
  scheduleSave()
}

export function tx(fn: () => void): void {
  db.run('BEGIN')
  try {
    fn()
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
  scheduleSave()
}

function scheduleSave(): void {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistNow()
  }, 400)
}

export function persistNow(): void {
  if (!db || !dbFile) return
  dirty = false
  const data = Buffer.from(db.export())
  // export() closed and reopened the underlying connection — the per-connection
  // foreign_keys pragma just silently reset to OFF. Re-assert or cascades die
  // after the first debounced save (the original orphan-rows bug).
  enableForeignKeys()
  const tmp = dbFile + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, dbFile)
}

export function flushDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (dirty) persistNow()
}

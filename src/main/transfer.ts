/**
 * Moving one project between two cores.
 *
 * The board asked for this twice. "If the database is the only copy, export is
 * the escape hatch", and it has to be "scheduled and tested rather than
 * available". And separately: the desktop app and a container MUST NOT hold the
 * same vault, so export → transfer → import is the sanctioned way two instances
 * share work, not a workaround for a missing feature.
 *
 * WHAT A PROJECT CONSISTS OF is not re-derived here. deleteProject already
 * enumerates every dependent table explicitly — children first, cascades
 * deliberately not load-bearing — and that enumeration IS the answer. This file
 * mirrors it table for table, including the broad edge WHERE, so the two drift
 * only if somebody changes one and not the other. If you add a table to one, add
 * it to the other.
 *
 * EXPORT IS A READ. It writes nothing: no activity rows, no node mutations, no
 * touching the vault. That rule is inherited verbatim from the document export,
 * and it is what makes exporting safe to do at any time on a live board. In
 * particular, materialising a reference happens IN THE BUNDLE ONLY — the live
 * board's reference node is left exactly as it was.
 */

import path from 'path'
import * as db from './db'
import * as vault from './vault'
import { ApiError, frontmatterFor } from './services'
import { emitEvent } from './events'
import { NODE_TYPES, newId, slugify } from '@shared/types'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  bundleProblem,
  toPosix,
  type ImportOptions,
  type ImportResult,
  type BundleActivity,
  type BundleAnnotation,
  type BundleEdge,
  type BundleNode,
  type BundleRelationship,
  type BundleRevision,
  type BundleSource,
  type DeferredLink,
  type ExportOptions,
  type ProjectBundle
} from '@shared/transfer'

interface ProjectRow {
  id: string
  name: string
  slug: string
  folder: string
  description: string
  created_at: number
  updated_at: number
}

interface NodeRow {
  id: string
  project_id: string
  graph_id?: string | null
  is_graph?: number
  subfolder?: string | null
  type: string
  title: string
  stage: string | null
  progress: number | null
  rank: number | null
  pinned: number
  x: number | null
  y: number | null
  file_path: string
  created_at: number
  updated_at: number
  created_by: string
  shared?: number
  references_node_id?: string | null
  slug?: string | null
  description?: string | null
  skill_options?: string | null
}

interface EdgeRow {
  id: string
  project_id: string
  source_id: string
  target_id: string
  label: string
  created_at: number
  created_by: string
}

interface RelRow {
  edge_id: string
  type: string
  source_id: string
  target_id: string
  created_at: number
  created_by: string
}

interface AnnRow {
  id: string
  parent_kind: string
  parent_id: string
  author: string
  body: string
  created_at: number
}

interface RevRow {
  node_id: string
  at: number
  /** the column really is `actor` here, while annotations use `author` */
  actor: string
  sha: string
  content: string
}

interface ActRow {
  at: number
  actor: string
  action: string
  subject_kind: string
  subject_id: string
  summary: string
  detail: string | null
}

/**
 * The same project must export to the same bytes, so every collection is ordered
 * by something stable that a human did not choose. Ids are generated and never
 * reused, which makes them the right key; `at` alone is not, because two rows
 * written in the same millisecond would swap places between runs.
 */
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function exportProject(opts: ExportOptions, source: BundleSource): ProjectBundle {
  // Checked before it reaches the driver. An absent projectId binds as undefined,
  // which sql.js answers with "Wrong API use : tried to bind a value of an
  // unknown type" — a 500 that describes the database's disappointment rather
  // than the caller's mistake.
  if (typeof opts?.projectId !== 'string' || !opts.projectId.trim()) {
    throw new ApiError('projectId is required', 400)
  }
  const project = db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [opts.projectId])
  if (!project) throw new ApiError('project not found', 404)
  const pid = project.id

  const nodeRows = db.all<NodeRow>('SELECT * FROM nodes WHERE project_id = ? ORDER BY id', [pid])
  const localIds = new Set(nodeRows.map((n) => n.id))

  // The subquery form, not an IN list of ids: a project with more nodes than
  // SQLite's variable limit would otherwise fail here and nowhere else. It is
  // also the exact shape deleteProject uses, which is the point.
  const edgeRows = db.all<EdgeRow>(
    `SELECT * FROM edges
      WHERE project_id = ?
         OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
         OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)
      ORDER BY id`,
    [pid, pid, pid]
  )

  const relRows = db.all<RelRow>(
    `SELECT * FROM edge_relationships
      WHERE edge_id IN (SELECT id FROM edges WHERE project_id = ?
                           OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
                           OR target_id IN (SELECT id FROM nodes WHERE project_id = ?))
      ORDER BY edge_id, created_at, type`,
    [pid, pid, pid]
  )
  const relsByEdge = new Map<string, BundleRelationship[]>()
  for (const r of relRows) {
    const list = relsByEdge.get(r.edge_id) ?? []
    list.push({
      type: r.type,
      sourceId: r.source_id,
      targetId: r.target_id,
      createdAt: r.created_at,
      createdBy: r.created_by
    })
    relsByEdge.set(r.edge_id, list)
  }

  const toBundleEdge = (e: EdgeRow): BundleEdge => ({
    id: e.id,
    sourceId: e.source_id,
    targetId: e.target_id,
    label: e.label,
    createdAt: e.created_at,
    createdBy: e.created_by,
    relationships: relsByEdge.get(e.id) ?? []
  })

  // A connection MAY join two projects — the board says so explicitly. So an
  // edge here is one of three things, and only the first is unambiguously ours.
  const edges: BundleEdge[] = []
  const deferredLinks: DeferredLink[] = []
  for (const e of edgeRows) {
    const hasSource = localIds.has(e.source_id)
    const hasTarget = localIds.has(e.target_id)
    if (hasSource && hasTarget) {
      edges.push(toBundleEdge(e))
      continue
    }
    if (!hasSource && !hasTarget) continue // owned by us, joins two other projects: not ours to carry
    const foreignId = hasSource ? e.target_id : e.source_id
    const far = db.get<{ id: string; title: string; type: string; slug: string; name: string }>(
      `SELECT n.id, n.title, n.type, p.slug, p.name
         FROM nodes n JOIN projects p ON p.id = n.project_id
        WHERE n.id = ?`,
      [foreignId]
    )
    if (!far) continue // the far end is already gone; nothing to relink to
    deferredLinks.push({
      edge: toBundleEdge(e),
      localNodeId: hasSource ? e.source_id : e.target_id,
      foreign: {
        nodeId: far.id,
        title: far.title,
        type: far.type,
        projectSlug: far.slug,
        projectName: far.name
      }
    })
  }
  const internalEdgeIds = new Set(edges.map((e) => e.id))

  const tagRows = db.all<{ node_id: string; tag: string }>(
    `SELECT * FROM node_tags
      WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)
      ORDER BY node_id, tag`,
    [pid]
  )
  const tagsByNode = new Map<string, string[]>()
  for (const t of tagRows) {
    const list = tagsByNode.get(t.node_id) ?? []
    list.push(t.tag)
    tagsByNode.set(t.node_id, list)
  }

  // ---- bodies, and the one place a reference stops being a pointer ---------
  //
  // A reference node's body on disk is an Obsidian embed of ANOTHER project's
  // file (`![[Other/Features/Thing]]`). Sent on its own, that is a dangling
  // pointer at the far end. severReferences already answers this for deletion —
  // materialise the owner's words into the referrer — so the same answer is used
  // here, with the difference that this one does not write it back.
  const files: Record<string, string> = {}
  let materialisedReferences = 0
  const nodes: BundleNode[] = nodeRows.map((r) => {
    const rel = toPosix(r.file_path)
    let body = vault.readBody(r.file_path)
    let materialised = false
    if (r.references_node_id) {
      const owner = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [r.references_node_id])
      if (owner && !localIds.has(owner.id)) {
        body = vault.readBody(owner.file_path)
        materialised = true
        materialisedReferences++
      }
    }
    files[rel] = body
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      stage: r.stage,
      progress: r.progress,
      rank: r.rank,
      pinned: r.pinned,
      x: r.x,
      y: r.y,
      filePath: rel,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
      slug: r.slug ?? null,
      description: r.description ?? null,
      skillOptions: r.skill_options ?? null,
      ...(r.graph_id ? { graphId: r.graph_id } : {}),
      ...(r.is_graph ? { isGraph: true, subfolder: r.subfolder ?? null } : {}),
      // severReferences already has a word for "this content used to be live and
      // is now a copy", and it is the word the UI already knows how to show.
      tags: materialised
        ? [...(tagsByNode.get(r.id) ?? []), 'reference-broken'].sort()
        : tagsByNode.get(r.id) ?? [],
      ...(materialised ? { materialised: true } : {})
    }
  })

  // Object key order is insertion order in JSON.stringify, so sorting the paths
  // is what actually makes the bytes deterministic.
  const sortedFiles: Record<string, string> = {}
  for (const k of Object.keys(files).sort()) sortedFiles[k] = files[k]

  const annRows = db.all<AnnRow>(
    `SELECT * FROM annotations
      WHERE (parent_kind = 'node' AND parent_id IN (SELECT id FROM nodes WHERE project_id = ?))
         OR (parent_kind = 'edge' AND parent_id IN (
               SELECT id FROM edges WHERE project_id = ?
                  OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
                  OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)))
      ORDER BY id`,
    [pid, pid, pid, pid]
  )
  const annotations: BundleAnnotation[] = annRows
    // An annotation on an edge we are NOT carrying would arrive parented to
    // nothing. Deferred links carry their own edge, so those are kept.
    .filter(
      (a) =>
        a.parent_kind === 'node' ||
        internalEdgeIds.has(a.parent_id) ||
        deferredLinks.some((d) => d.edge.id === a.parent_id)
    )
    .map((a) => ({
      id: a.id,
      parentKind: a.parent_kind === 'edge' ? 'edge' : 'node',
      parentId: a.parent_id,
      author: a.author,
      body: a.body,
      createdAt: a.created_at
    }))

  const omitted: string[] = []

  let revisions: BundleRevision[] = []
  if (opts.includeRevisions === false) omitted.push('revisions')
  else {
    revisions = db
      .all<RevRow>(
        `SELECT * FROM node_revisions
          WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)
          ORDER BY node_id, at`,
        [pid]
      )
      .map((r) => ({ nodeId: r.node_id, at: r.at, actor: r.actor, sha: r.sha, content: r.content }))
  }

  let activity: BundleActivity[] = []
  if (opts.includeActivity === false) omitted.push('activity')
  else {
    activity = db
      .all<ActRow>('SELECT * FROM activity WHERE project_id = ? ORDER BY at, id', [pid])
      .map((a) => ({
        at: a.at,
        actor: a.actor,
        action: a.action,
        subjectKind: a.subject_kind,
        subjectId: a.subject_id,
        summary: a.summary,
        detail: a.detail
      }))
  }

  // skill_installs is never carried. It records WHERE on a machine's disk a
  // skill was written, as an absolute path — meaningless on the receiving core
  // and, sent the other way, a description of somebody's filesystem.
  omitted.push('skill installs (machine-local paths)')

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    source,
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      folder: project.folder,
      description: project.description,
      createdAt: project.created_at,
      updatedAt: project.updated_at
    },
    nodes: nodes.sort(byId),
    edges: edges.sort(byId),
    annotations: annotations.sort(byId),
    revisions,
    activity,
    files: sortedFiles,
    deferredLinks: deferredLinks.sort((a, b) => byId(a.edge, b.edge)),
    notes: {
      materialisedReferences,
      sharedOut: nodeRows.filter((n) => n.shared).length,
      deferredLinks: deferredLinks.length,
      omitted
    }
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * cleanupOrphans' definition of a broken row, asked as a question instead of run
 * as a sweep. The board's bar for a migration names this directly — "the
 * row-level orphan check that smoke ends with must pass against the migrated
 * database" — so an import that leaves one behind is not finished, and reports
 * it rather than claiming success.
 */
const ORPHAN_CHECKS: [what: string, sql: string][] = [
  ['nodes whose project is gone', 'SELECT COUNT(*) c FROM nodes WHERE project_id NOT IN (SELECT id FROM projects)'],
  [
    'edges with a missing end',
    `SELECT COUNT(*) c FROM edges WHERE project_id NOT IN (SELECT id FROM projects)
       OR source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)`
  ],
  ['tags whose node is gone', 'SELECT COUNT(*) c FROM node_tags WHERE node_id NOT IN (SELECT id FROM nodes)'],
  [
    'annotations with no parent',
    `SELECT COUNT(*) c FROM annotations
      WHERE (parent_kind = 'node' AND parent_id NOT IN (SELECT id FROM nodes))
         OR (parent_kind = 'edge' AND parent_id NOT IN (SELECT id FROM edges))`
  ],
  ['revisions whose node is gone', 'SELECT COUNT(*) c FROM node_revisions WHERE node_id NOT IN (SELECT id FROM nodes)']
]

function integrityProblems(): string[] {
  const problems: string[] = []
  for (const [what, sql] of ORPHAN_CHECKS) {
    const r = db.get<{ c: number }>(sql)
    if (r && r.c > 0) problems.push(`${r.c} ${what}`)
  }
  return problems
}

/**
 * deleteProject's enumeration, in the same order and with the same broad edge
 * WHERE. Kept here rather than calling deleteProject because that one also
 * trashes the folder and emits a deletion the client would see mid-import — but
 * if you change one, change the other.
 */
function deleteProjectRows(pid: string): void {
  db.run(
    `DELETE FROM annotations
      WHERE (parent_kind = 'node' AND parent_id IN (SELECT id FROM nodes WHERE project_id = ?))
         OR (parent_kind = 'edge' AND parent_id IN (
               SELECT id FROM edges WHERE project_id = ?
                  OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
                  OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)))`,
    [pid, pid, pid, pid]
  )
  db.run('DELETE FROM node_revisions WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)', [pid])
  db.run('DELETE FROM node_tags WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)', [pid])
  db.run(
    `DELETE FROM edge_relationships WHERE edge_id IN (
       SELECT id FROM edges WHERE project_id = ?
          OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
          OR target_id IN (SELECT id FROM nodes WHERE project_id = ?))`,
    [pid, pid, pid]
  )
  db.run(
    `DELETE FROM edges WHERE project_id = ?
        OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
        OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)`,
    [pid, pid, pid]
  )
  db.run('DELETE FROM skill_installs WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)', [pid])
  db.run('DELETE FROM nodes WHERE project_id = ?', [pid])
  db.run('DELETE FROM activity WHERE project_id = ?', [pid])
  db.run('DELETE FROM projects WHERE id = ?', [pid])
}

/** Unique against the DB, which is the same rule createProject uses. */
function freeSlug(want: string, exceptId: string): string {
  let slug = slugify(want)
  let i = 2
  while (db.get('SELECT 1 FROM projects WHERE slug = ? AND id <> ?', [slug, exceptId])) {
    slug = `${slugify(want)}-${i++}`
  }
  return slug
}

function freeFolder(want: string, exceptId: string): string {
  const base = vault.sanitizeFileName(want)
  let folder = base
  let i = 2
  while (db.get('SELECT 1 FROM projects WHERE folder = ? AND id <> ?', [folder, exceptId])) {
    folder = `${base} ${i++}`
  }
  return folder
}

/**
 * Take a bundle and make it a project on THIS board.
 *
 * Three properties the board asked for, and how each is kept:
 *
 * - RE-RUNNABLE. "A first attempt that half-completes cannot leave the board
 *   unusable." Ids are preserved, so importing the same bundle twice replaces
 *   rather than duplicates, and a failed attempt is fixed by running it again.
 * - ALL OR NOTHING. Every row lands in one transaction. The files are written
 *   after it commits, and if that fails the rows are removed again, because a
 *   project whose nodes have no bodies is worse than no project.
 * - NOT A SYNC. "A workspace is a place, not a replica." This is a one-shot
 *   transfer that reports exactly what it did, including what it could not
 *   reconnect. It does not reconcile, and running it is always a decision.
 *
 * The whole thing runs with the watcher paused. Writing hundreds of files under
 * a live watcher would fire an `add` per file, and each one rewrites the node's
 * title from its filename — the import would race itself.
 */
export async function importProject(opts: ImportOptions, actor: string): Promise<ImportResult> {
  const problem = bundleProblem(opts.bundle)
  if (problem) throw new ApiError(`this is not a project bundle: ${problem}`, 400)

  const b = opts.bundle
  const mode = opts.onConflict ?? 'replace'
  const existing = db.get<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ?', [b.project.id])

  if (existing && mode === 'refuse') {
    // 409 with the offender named, the way the gate reports a duplicate
    // connection — a client should be able to offer "replace it?" without
    // parsing prose.
    throw new ApiError(`"${existing.name}" is already on this board. Choose replace or duplicate.`, 409, {
      projectId: existing.id,
      projectName: existing.name
    })
  }

  // A type this build does not know would be filed in a folder that does not
  // exist and render as nothing. Refusing names the problem; guessing hides it.
  const unknown = [...new Set(b.nodes.map((n) => n.type))].filter((t) => !(t in NODE_TYPES))
  if (unknown.length) {
    throw new ApiError(`this bundle uses node types this build does not know: ${unknown.join(', ')}`, 400, {
      unknownTypes: unknown
    })
  }

  const remap = !!existing && mode === 'duplicate'
  const outcome: ImportResult['outcome'] = !existing ? 'created' : mode === 'duplicate' ? 'duplicated' : 'replaced'
  const pid = remap ? newId('pr') : b.project.id

  const nodeIds = new Map<string, string>()
  for (const n of b.nodes) nodeIds.set(n.id, remap ? newId('nd') : n.id)
  const edgeIds = new Map<string, string>()
  for (const e of b.edges) edgeIds.set(e.id, remap ? newId('ed') : e.id)
  for (const d of b.deferredLinks) edgeIds.set(d.edge.id, remap ? newId('ed') : d.edge.id)

  const name = remap ? `${b.project.name} (copy)` : b.project.name
  const slug = freeSlug(remap ? name : b.project.slug, pid)
  const folder = freeFolder(remap ? name : b.project.folder, pid)

  // Paths are recomputed here rather than trusted from the bundle. A path in a
  // file that crossed a network is an instruction about somebody's disk; a path
  // built from a sanitised title inside a folder we chose is not. This is also
  // what makes a folder-name collision harmless.
  const usedNames = new Set<string>()
  const relPaths = new Map<string, string>()
  // HOME survives the trip: a node's folder is its chain of sub-graph folders,
  // each name sanitised here (never trusted), homes outside the bundle dropped
  const bundleById = new Map(b.nodes.map((n) => [n.id, n]))
  const homeOf = (n: (typeof b.nodes)[number]): string | null => {
    const g = n.graphId ? bundleById.get(n.graphId) : undefined
    return g && g.isGraph ? g.id : null
  }
  const subOf = (g: (typeof b.nodes)[number]): string => vault.sanitizeFileName(g.subfolder || g.title) || 'Sub-graph'
  const chainOf = (graphId: string | null): string[] => {
    const parts: string[] = []
    const seen = new Set<string>()
    let cur = graphId
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const g = bundleById.get(cur)
      if (!g) break
      parts.unshift(subOf(g))
      cur = homeOf(g)
    }
    return parts
  }
  for (const n of b.nodes) {
    const tf = NODE_TYPES[n.type as keyof typeof NODE_TYPES].folder
    const dir = [...chainOf(homeOf(n)), tf].join('/')
    const base = vault.sanitizeFileName(n.title)
    let leaf = base
    let i = 2
    while (usedNames.has(`${dir}/${leaf}`.toLowerCase())) leaf = `${base} ${i++}`
    usedNames.add(`${dir}/${leaf}`.toLowerCase())
    relPaths.set(n.id, path.join(folder, ...chainOf(homeOf(n)), tf, `${leaf}.md`))
  }

  // Deferred links are only real if this board already holds the far end. The
  // bundle names it by id, which is the only identifier that survives a move.
  const relinkable = b.deferredLinks.filter(
    (d) => !!db.get('SELECT 1 FROM nodes WHERE id = ?', [d.foreign.nodeId])
  )
  const unresolved = b.deferredLinks.length - relinkable.length

  let counts = { nodes: 0, edges: 0, annotations: 0, revisions: 0, activity: 0, files: 0 }

  await vault.withWatcherPaused(() => {
    if (existing && mode === 'replace') {
      emitEvent('project.deleted', existing.id, { id: existing.id, name: existing.name }, actor)
    }

    db.tx(() => {
      if (existing && mode === 'replace') deleteProjectRows(existing.id)

      db.run(
        `INSERT INTO projects (id, name, slug, folder, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pid, name, slug, folder, b.project.description ?? '', b.project.createdAt, b.project.updatedAt]
      )

      for (const n of b.nodes) {
        const id = nodeIds.get(n.id)!
        db.run(
          `INSERT INTO nodes (id, project_id, type, title, progress, pinned, x, y, file_path,
                              created_at, updated_at, created_by, rank, stage, shared,
                              references_node_id, slug, description, skill_options,
                              graph_id, is_graph, subfolder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)`,
          [
            id, pid, n.type, n.title, n.progress, n.pinned, n.x, n.y, relPaths.get(n.id)!,
            n.createdAt, n.updatedAt, n.createdBy, n.rank, n.stage,
            n.slug ?? null, n.description ?? null, n.skillOptions ?? null,
            homeOf(n) ? nodeIds.get(homeOf(n)!) ?? null : null,
            n.isGraph ? 1 : 0, n.isGraph ? subOf(n) : null
          ]
        )
        for (const t of n.tags) db.run('INSERT INTO node_tags (node_id, tag) VALUES (?, ?)', [id, t])
        counts.nodes++
      }

      const insertEdge = (e: (typeof b.edges)[number], sourceId: string, targetId: string): void => {
        const id = edgeIds.get(e.id)!
        db.run(
          `INSERT INTO edges (id, project_id, source_id, target_id, label, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, pid, sourceId, targetId, e.label, e.createdAt, e.createdBy]
        )
        for (const r of e.relationships) {
          db.run(
            `INSERT INTO edge_relationships (edge_id, type, source_id, target_id, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, r.type, nodeIds.get(r.sourceId) ?? r.sourceId, nodeIds.get(r.targetId) ?? r.targetId,
             r.createdAt, r.createdBy]
          )
        }
        counts.edges++
      }

      for (const e of b.edges) {
        insertEdge(e, nodeIds.get(e.sourceId)!, nodeIds.get(e.targetId)!)
      }
      // A relinked edge keeps the far end's ORIGINAL id, because that node is
      // already here under it — only our own side is remapped.
      for (const d of relinkable) {
        const localNew = nodeIds.get(d.localNodeId)!
        const sourceIsLocal = d.edge.sourceId === d.localNodeId
        insertEdge(d.edge, sourceIsLocal ? localNew : d.foreign.nodeId, sourceIsLocal ? d.foreign.nodeId : localNew)
      }

      const liveEdgeIds = new Set([...b.edges, ...relinkable.map((d) => d.edge)].map((e) => edgeIds.get(e.id)!))
      for (const a of b.annotations) {
        const parentId =
          a.parentKind === 'node' ? nodeIds.get(a.parentId) : edgeIds.get(a.parentId)
        if (!parentId) continue
        if (a.parentKind === 'edge' && !liveEdgeIds.has(parentId)) continue // its edge was not relinked
        db.run(
          `INSERT INTO annotations (id, parent_kind, parent_id, author, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [remap ? newId('an') : a.id, a.parentKind, parentId, a.author, a.body, a.createdAt]
        )
        counts.annotations++
      }

      for (const r of b.revisions) {
        const nid = nodeIds.get(r.nodeId)
        if (!nid) continue
        db.run('INSERT INTO node_revisions (node_id, at, actor, sha, content) VALUES (?, ?, ?, ?, ?)',
          [nid, r.at, r.actor, r.sha, r.content])
        counts.revisions++
      }

      for (const a of b.activity) {
        db.run(
          `INSERT INTO activity (project_id, actor, action, subject_kind, subject_id, summary, at, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [pid, a.actor, a.action, a.subjectKind, a.subjectId, a.summary, a.at, a.detail]
        )
        counts.activity++
      }

      // Provenance for the move itself, in the board's own feed rather than a
      // log nobody reads.
      db.run(
        `INSERT INTO activity (project_id, actor, action, subject_kind, subject_id, summary, at, detail)
         VALUES (?, ?, 'project.imported', 'project', ?, ?, ?, ?)`,
        [pid, actor, pid, `imported "${name}"`, Date.now(),
         JSON.stringify({ from: b.source.exportedFrom, exportedAt: b.exportedAt, outcome, unresolved })]
      )
    })

    // ---- files, after the rows are committed --------------------------------
    // frontmatterFor is reused rather than reimplemented: it is a WHITELIST that
    // drops anything not in it, and a second copy of that list is exactly how a
    // field silently evaporates. It reads the rows we just wrote, so links
    // resolve against the edges that now exist.
    try {
      vault.ensureProjectFolders(folder, Object.values(NODE_TYPES).map((m) => m.folder))
      for (const n of b.nodes) {
        const id = nodeIds.get(n.id)!
        const row = db.get<Record<string, unknown>>('SELECT * FROM nodes WHERE id = ?', [id])
        if (!row) continue
        const body = b.files[n.filePath] ?? ''
        vault.writeBody(relPaths.get(n.id)!, body, frontmatterFor(row as never))
        counts.files++
      }
    } catch (e) {
      // Rows without bodies is the one outcome worse than no import at all.
      db.tx(() => deleteProjectRows(pid))
      throw e
    }
  })

  const problems = integrityProblems()
  emitEvent('project.created', pid, { id: pid, name, slug, folder }, actor)

  return {
    projectId: pid,
    projectName: name,
    outcome,
    counts,
    relinked: relinkable.length,
    unresolved,
    integrity: { ok: problems.length === 0, problems }
  }
}

/**
 * A suggested filename, in the shape the document export already uses: the thing
 * it describes, then when, so a folder of them sorts sensibly.
 */
export function bundleFilename(b: ProjectBundle): string {
  const stamp = new Date(b.exportedAt).toISOString().slice(0, 10)
  const safe = b.project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${safe || 'project'} ${stamp}.ozmo.json`
}

/** Vault-relative, POSIX in the bundle, platform separator on this disk. */
export function localPath(posix: string): string {
  return path.join(...posix.split('/'))
}

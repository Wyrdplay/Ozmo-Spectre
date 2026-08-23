// Skills engine — the node is the ORIGINAL, `.claude/skills/<slug>/SKILL.md` is
// a BUILD OUTPUT. Everything here is about keeping those two honest about each
// other without ever surprising the human's repo.
//
// Three rules run through the whole file:
//
//  1. TARGETS CROSS THE WIRE AS IDS. No payload from IPC or REST ever carries a
//     filesystem path (`skills.addTarget` is the single, validated exception).
//     The API is unauthenticated on loopback; a path-taking install verb would
//     be an arbitrary-file-write primitive, so the allowlist is the only source
//     of roots and a path-shaped target id is a 400, never a fallback.
//
//  2. SLUGS ARE REJECTED, NEVER SANITISED. A slug names a directory inside
//     someone's repo. Silently correcting one orphans every directory already
//     installed under the old spelling, so `svc.validateSlug` throws instead.
//
//  3. WE POLL, WE DO NOT WATCH. Target directories are read on demand and never
//     handed to chokidar. Sixteen watchers on sixteen git checkouts is Windows
//     handle pressure for information nobody is looking at — the Agentic page
//     asks `skills.list` when it wants the truth. Please do not "improve" this
//     into a watcher.
//
// Also deliberately absent: `vault.withWatcherPaused()`. Install writes land
// OUTSIDE the vault, so pausing the vault watcher would stop folding Obsidian
// edits for exactly zero benefit.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import matter from 'gray-matter'
import { app } from 'electron'
import { unifiedDiff } from '@shared/diff'
import type {
  InstalledSkill, SkillDriftState, SkillRow, SkillTarget, SkillTargetConfig, SkillsPayload, SpecNode
} from '@shared/types'
import * as db from './db'
import * as svc from './services'
import * as vault from './vault'
import { GLOBAL_SKILL_TARGET_ID, getSettings, getSkillTargets, setSkillTargets } from './settings'
import { emitEvent } from './events'

const SKILL_FILE = 'SKILL.md'
const DEFAULT_SKILLS_DIR = '.claude/skills'
/** hard cap on what we will render or adopt — a SKILL.md is an instruction, not a corpus */
export const MAX_SKILL_BYTES = 256 * 1024
/** a defensive ceiling for the DISCOVERY read; the 256 KB rule is enforced on render/adopt */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const MAX_TARGETS = 64

/**
 * Directory names the one-level scan refuses to descend into.
 *
 * `worktrees` is the load-bearing one: the Ozmo monorepo nests sixteen agent
 * worktrees totalling ~13 GB under `.claude/`. The default skills dir
 * (`.claude/skills`) is a SIBLING of `.claude/worktrees`, so a correctly
 * configured target never sees it — but a target configured with
 * `skillsDir: '.claude'` would walk straight into all of it. One shallow
 * readdir plus this skip list is the difference between an instant page and a
 * multi-minute stat storm.
 */
const SCAN_SKIP = new Set(['worktrees', 'node_modules', '.git', '.venv', 'dist', 'out'])

/**
 * Frontmatter keys owned by the VAULT file. None of them may ever reach a
 * rendered SKILL.md: `id`/`type`/`links`/`tags`/`stage`/`progress` are the spec
 * engine's bookkeeping, and `name`/`description` are written explicitly (and in
 * that order) rather than smuggled in through skillOptions.
 */
const VAULT_ONLY_KEYS = new Set(['id', 'type', 'links', 'tags', 'stage', 'progress', 'name', 'description', 'skill'])

const err = (message: string, status = 400, data?: Record<string, unknown>): svc.ApiError =>
  new svc.ApiError(message, status, data)
const need = (cond: unknown, message: string, status = 400): void => {
  if (!cond) throw err(message, status)
}
const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// Activity. services.logActivity is private, so this is the same INSERT + event
// pair against the `activity` table — never against `nodes`, which are mutated
// exclusively through the exported service verbs.

function logActivity(
  projectId: string, actor: string, action: string, subjectId: string, summary: string, detail?: unknown
): void {
  db.run(
    'INSERT INTO activity (project_id, actor, action, subject_kind, subject_id, summary, at, detail) VALUES (?,?,?,?,?,?,?,?)',
    [projectId, actor, action, 'node', subjectId, summary, Date.now(), detail === undefined ? null : JSON.stringify(detail)]
  )
  emitEvent('activity', projectId, { action, subjectKind: 'node', subjectId, summary, detail }, actor)
}

/**
 * A target is not owned by a project, but `logActivity` requires one (the
 * activity table is project-scoped and the timeline is read per project). The
 * skills home project is the declared owner of homeless skills, so it is the
 * natural home for target bookkeeping; failing that, the first project. With no
 * projects at all the event still fires and only the activity row is skipped.
 */
function targetActivityProject(): string | null {
  const home = getSettings().skillsHomeProjectId
  if (home) {
    try {
      svc.getProject({ id: home })
      return home
    } catch {
      // the home project was deleted — fall through to the first project
    }
  }
  return svc.listProjects()[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Targets

/** git facts for a root. Install writes land on whatever branch is checked out,
 *  so the page must be able to say WHICH — silently committing a skill onto a
 *  feature branch is a bad surprise. Read straight from `.git`; no subprocess. */
function gitFacts(root: string): { isGitRepo: boolean; branch: string | null } {
  const dotGit = path.join(root, '.git')
  let gitDir = dotGit
  try {
    const st = fs.statSync(dotGit)
    if (st.isFile()) {
      // a linked worktree / submodule: `.git` is a file pointing at the real dir
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
      if (!m) return { isGitRepo: false, branch: null }
      gitDir = path.resolve(root, m[1].trim())
    } else if (!st.isDirectory()) {
      return { isGitRepo: false, branch: null }
    }
  } catch {
    return { isGitRepo: false, branch: null }
  }
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (ref) return { isGitRepo: true, branch: ref[1] }
    return { isGitRepo: true, branch: head ? `detached@${head.slice(0, 7)}` : null }
  } catch {
    return { isGitRepo: true, branch: null }
  }
}

/** This app's own checkout, when it is running from one (dev). A packaged build
 *  runs out of an asar with no `.git` and gets no self target. */
function selfRoot(): string | null {
  try {
    const p = app.getAppPath()
    return path.isAbsolute(p) && fs.existsSync(path.join(p, '.git')) ? path.resolve(p) : null
  } catch {
    return null
  }
}

function kindOf(cfg: SkillTargetConfig, self: string | null): SkillTarget['kind'] {
  if (cfg.id === GLOBAL_SKILL_TARGET_ID) return 'global'
  if (self && path.resolve(cfg.root) === self) return 'self'
  return 'repo'
}

/** Config + what is true on disk RIGHT NOW. Purely observational: it stats, it
 *  never creates. A root that has gone missing reports `exists:false` rather
 *  than being dropped from the allowlist behind the user's back. */
function describeTarget(cfg: SkillTargetConfig, self: string | null): SkillTarget {
  const root = path.resolve(cfg.root)
  const skillsDir = cfg.skillsDir || DEFAULT_SKILLS_DIR
  const absSkillsDir = path.resolve(root, skillsDir)
  let exists = false
  try {
    exists = fs.statSync(absSkillsDir).isDirectory()
  } catch {
    exists = false
  }
  let writable = false
  try {
    // when the skills dir is not there yet, writability of the ROOT is what
    // decides whether the first install can create it
    fs.accessSync(exists ? absSkillsDir : root, fs.constants.W_OK)
    writable = true
  } catch {
    writable = false
  }
  return {
    id: cfg.id,
    label: cfg.label,
    root,
    skillsDir,
    enabled: cfg.enabled !== false,
    kind: kindOf(cfg, self),
    absSkillsDir,
    exists,
    writable,
    ...gitFacts(root)
  }
}

/**
 * skills.targets — the allowlist, decorated with disk truth.
 *
 * DISABLED TARGETS ARE STILL LISTED, flagged `enabled: false`. The Settings card
 * has to render the row it is offering to switch back on, and a target that
 * vanished from its own list the moment it was disabled would be unrecoverable
 * except by re-adding it. What `enabled: false` costs a target is participation:
 * `skills.list` neither scans it nor gives it a drift cell (see listSkills), and
 * install/uninstall refuse it outright (see assertWritableTarget). It is listed,
 * never used.
 */
export function listTargets(): SkillTarget[] {
  const self = selfRoot()
  return getSkillTargets().map((cfg) => describeTarget(cfg, self))
}

/** The targets that actually participate: scanned, drifted against, written to. */
const activeTargets = (targets: SkillTarget[]): SkillTarget[] => targets.filter((t) => t.enabled !== false)

/**
 * A disabled target is not an install destination — refused loudly rather than
 * written to. A switch that does not switch anything off is worse than no
 * switch, because the human believes it.
 */
function assertWritableTarget(t: SkillTarget): void {
  need(t.enabled !== false,
    `target "${t.id}" (${t.label}) is disabled and is not an install destination. ` +
    'Turn it back on with skills.setTargetEnabled first.', 400)
}

const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * RULE 1, enforced. A target reference is an id and nothing else: anything that
 * looks like a path (separator, drive colon, `..`, `~`) is refused outright with
 * a message that says why, rather than being resolved, normalised or ignored.
 */
function assertTargetId(v: unknown): string {
  need(typeof v === 'string' && v.trim() !== '', 'target must be a target id (a string) — see skills.targets')
  const id = (v as string).trim()
  need(
    !/[\\/:]/.test(id) && !id.includes('..') && !id.startsWith('~') && !path.isAbsolute(id),
    `"${id}" looks like a filesystem path. Targets cross the wire as IDS ONLY — the app installs into ` +
    'declared roots (skills.targets) and never into a path a caller supplies. Add the root with skills.addTarget first.'
  )
  need(id.length <= 64 && TARGET_ID_RE.test(id), `invalid target id "${id}"`)
  return id
}

function resolveTarget(v: unknown, targets: SkillTarget[]): SkillTarget {
  const id = assertTargetId(v)
  const t = targets.find((x) => x.id === id)
  need(t, `unknown target "${id}" — declared targets: ${targets.map((x) => x.id).join(', ') || '(none)'}`, 404)
  return t as SkillTarget
}

function resolveTargetList(v: unknown, targets: SkillTarget[]): SkillTarget[] {
  need(Array.isArray(v) && v.length > 0, 'targets must be a non-empty array of target ids')
  const list = v as unknown[]
  need(list.length <= MAX_TARGETS, `at most ${MAX_TARGETS} targets per call`)
  const out: SkillTarget[] = []
  for (const raw of list) {
    const t = resolveTarget(raw, targets)
    if (!out.some((x) => x.id === t.id)) out.push(t)
  }
  return out
}

/**
 * Compose `<root>/<skillsDir>/<slug>` and then PROVE it stayed inside. The slug
 * is already validated (rule 2) and skillsDir is sanitised by settings, so this
 * re-verification is belt and braces — which is the right amount of caution for
 * the one function in the app that decides where a file gets written on someone
 * else's disk.
 */
function skillDirFor(t: SkillTarget, slug: string): string {
  svc.validateSlug(slug)
  const base = path.resolve(t.absSkillsDir)
  const abs = path.resolve(base, slug)
  need(
    abs.startsWith(base + path.sep) && path.dirname(abs) === base && path.basename(abs) === slug,
    `refusing to compose "${slug}" — the resolved path escapes ${base}`
  )
  return abs
}

const skillFileFor = (t: SkillTarget, slug: string): string => path.join(skillDirFor(t, slug), SKILL_FILE)

// ---------------------------------------------------------------------------
// Rendering: node → SKILL.md

export interface RenderedSkill {
  /** `<slug>/SKILL.md` — the path relative to a target's skills dir */
  filename: string
  markdown: string
  sha: string
  slug: string
  description: string
}

function skillBody(node: SpecNode): string {
  return svc.getContent({ id: node.id }).content
}

/**
 * The build step. Frontmatter is `name` (the slug) first, `description` second,
 * then whatever `skillOptions` carries — vault keys filtered out, because a
 * leaked `id:` or `tags:` in an installed skill is spec-engine bookkeeping
 * escaping into a user's repo.
 *
 * Then it RE-PARSES its own output and asserts `name` survived. Malformed YAML
 * is the worst failure mode this feature has: the body still loads, `/name`
 * still works, the skill LOOKS installed — and the description, the only thing
 * a model matches on to decide relevance, is silently gone. A skill that fails
 * to round-trip must never reach disk.
 */
export function renderSkill(node: SpecNode, body: string): RenderedSkill {
  need(node.type === 'skill', `"${node.title}" is a ${node.type}, not a skill`)
  const slug = svc.validateSlug(node.slug)
  const description = (node.description ?? '').trim()

  const data: Record<string, unknown> = { name: slug }
  data.description = description
  for (const [k, v] of Object.entries(node.skillOptions ?? {})) {
    if (VAULT_ONLY_KEYS.has(k)) continue
    if (v === undefined) continue
    data[k] = v
  }

  // blank line after the closing `---`, then the body, then exactly one trailing
  // newline. This is not cosmetic: it is the convention every hand-written
  // SKILL.md already follows (and the one vault.serialize uses), so a skill
  // imported or adopted from disk re-renders BYTE-IDENTICAL and reads `clean`
  // instead of a spurious `ahead` that invites a pointless overwrite.
  const trimmed = body.replace(/^\s+/, '').replace(/\s+$/, '')
  let markdown: string
  try {
    markdown = matter.stringify(trimmed ? '\n' + trimmed + '\n' : '\n', data)
  } catch (e) {
    throw err(`skill "${node.title}" could not be serialised to YAML frontmatter: ${String(e)}`, 400)
  }

  // round-trip assertion — see the doc comment
  let back: matter.GrayMatterFile<string>
  try {
    back = matter(markdown)
  } catch (e) {
    throw err(
      `skill "${node.title}" rendered frontmatter that does not parse back (${String(e)}) — ` +
      'fix the skillOptions keys before installing', 400
    )
  }
  const parsed = back.data as Record<string, unknown>
  need(parsed.name === slug,
    `render self-check failed for "${node.title}": frontmatter name is ${JSON.stringify(parsed.name)}, expected "${slug}"`, 500)
  need(parsed.description === description,
    `render self-check failed for "${node.title}": the description did not survive YAML serialisation`, 500)

  const bytes = Buffer.byteLength(markdown, 'utf8')
  need(bytes <= MAX_SKILL_BYTES,
    `skill "${node.title}" renders to ${bytes} bytes, over the ${MAX_SKILL_BYTES} byte cap — ` +
    'move the bulk into reference files beside SKILL.md', 413)

  return { filename: `${slug}/${SKILL_FILE}`, markdown, sha: sha256(markdown), slug, description }
}

function loadSkillNode(nodeId: unknown): SpecNode {
  need(typeof nodeId === 'string' && nodeId, 'nodeId is required')
  const node = svc.getNode({ id: nodeId as string })
  need(node.type === 'skill', `"${node.title}" is a ${node.type}, not a skill`)
  return node
}

/** skills.render — a pure preview. Writes nothing, touches no target. */
export function renderSkillById(p: { nodeId?: string }): { filename: string; markdown: string; sha: string } {
  const node = loadSkillNode(p?.nodeId)
  const r = renderSkill(node, skillBody(node))
  return { filename: r.filename, markdown: r.markdown, sha: r.sha }
}

// ---------------------------------------------------------------------------
// Discovery — ONE LEVEL DEEP, on demand (rule 3)

function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; error: string | null } {
  try {
    const p = matter(text)
    return { data: p.data as Record<string, unknown>, body: p.content, error: null }
  } catch (e) {
    // a half-loading skill is exactly what the page needs to SEE, so a YAML
    // error is reported, never swallowed into an empty-frontmatter lie
    return { data: {}, body: text, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Every SKILL.md directly under a target's skills dir. A directory without a
 * SKILL.md is not a skill and is ignored silently (repos keep all sorts of
 * things in there). Symlinked directories are skipped — following one is how a
 * "one level deep" scan quietly becomes a walk of someone's whole home drive.
 */
export function scanTarget(t: SkillTarget): InstalledSkill[] {
  if (!t.exists) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(t.absSkillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: InstalledSkill[] = []
  for (const e of entries) {
    if (e.isSymbolicLink() || !e.isDirectory()) continue
    if (SCAN_SKIP.has(e.name.toLowerCase())) continue
    const dir = path.join(t.absSkillsDir, e.name)
    const file = path.join(dir, SKILL_FILE)
    let text: string
    try {
      const st = fs.statSync(file)
      if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue // no SKILL.md → not a skill
    }
    let bundled = false
    try {
      bundled = fs.readdirSync(dir).some((n) => n !== SKILL_FILE)
    } catch {
      bundled = false
    }
    const fm = parseFrontmatter(text).data
    out.push({
      targetId: t.id,
      slug: e.name,
      absPath: file,
      sha: sha256(text),
      name: typeof fm.name === 'string' ? fm.name : null,
      description: typeof fm.description === 'string' ? fm.description : null,
      bundled,
      nodeId: null
    })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

function readOnDisk(abs: string): { text: string; sha: string } | null {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return null
    const text = fs.readFileSync(abs, 'utf8')
    return { text, sha: sha256(text) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Install bookkeeping (skill_installs) — OUR table, so plain SQL here is fine.
// Nodes are never touched except through the exported service verbs.

interface InstallRow {
  node_id: string
  target_id: string
  abs_path: string
  sha: string
  installed_at: number
  installed_by: string
}

function installRowsFor(nodeIds: string[]): Map<string, InstallRow> {
  const map = new Map<string, InstallRow>()
  if (!nodeIds.length) return map
  const ph = nodeIds.map(() => '?').join(',')
  for (const r of db.all<InstallRow>(`SELECT * FROM skill_installs WHERE node_id IN (${ph})`, nodeIds)) {
    map.set(`${r.node_id} ${r.target_id}`, r)
  }
  return map
}

function recordInstall(nodeId: string, targetId: string, absPath: string, sha: string, actor: string): void {
  db.run(
    `INSERT INTO skill_installs (node_id, target_id, abs_path, sha, installed_at, installed_by) VALUES (?,?,?,?,?,?)
     ON CONFLICT(node_id, target_id) DO UPDATE SET abs_path = excluded.abs_path, sha = excluded.sha,
       installed_at = excluded.installed_at, installed_by = excluded.installed_by`,
    [nodeId, targetId, absPath, sha, Date.now(), actor]
  )
}

function clearInstall(nodeId: string, targetId: string): void {
  db.run('DELETE FROM skill_installs WHERE node_id = ? AND target_id = ?', [nodeId, targetId])
}

/**
 * The install sha we may TRUST for this (node, target). A row whose abs_path no
 * longer matches where the file would go now (the target was re-pointed at a
 * different root under the same id) is stale: trusting it would report a
 * hand-written file as `clean`, so it is ignored.
 */
function trustedSha(row: InstallRow | undefined, expectedAbs: string): string | null {
  if (!row) return null
  const same = process.platform === 'win32'
    ? row.abs_path.toLowerCase() === expectedAbs.toLowerCase()
    : row.abs_path === expectedAbs
  return same ? row.sha : null
}

// ---------------------------------------------------------------------------
// Drift — six states from three hashes

export function driftState(renderedSha: string | null, diskSha: string | null, lastSha: string | null): SkillDriftState {
  if (!diskSha) return 'missing'
  if (!renderedSha) return 'unmanaged' // a file with no node behind it
  if (diskSha === lastSha) return renderedSha === diskSha ? 'clean' : 'ahead'
  // disk moved without us: agreeing with the node anyway is `converged`
  // (install just restamps), disagreeing is a hand edit we must not clobber
  return diskSha === renderedSha ? 'converged' : 'modified'
}

// ---------------------------------------------------------------------------
// skills.list — ONE call the Agentic page renders from

interface SkillNodeView {
  node: SpecNode
  projectName: string
  rendered: RenderedSkill | null
  /** why the node could not be rendered (no slug, bad options) — surfaced, not hidden */
  renderError: string | null
}

function skillNodeViews(projectIds: { id: string; name: string }[]): SkillNodeView[] {
  const out: SkillNodeView[] = []
  for (const proj of projectIds) {
    for (const n of svc.listNodes({ projectId: proj.id, type: 'skill' })) {
      let rendered: RenderedSkill | null = null
      let renderError: string | null = null
      try {
        rendered = renderSkill(n, skillBody(n))
      } catch (e) {
        renderError = e instanceof Error ? e.message : String(e)
      }
      out.push({ node: n, projectName: proj.name, rendered, renderError })
    }
  }
  return out
}

/**
 * skills.list — `projectId` is OPTIONAL. Omitted, this is a CROSS-PROJECT QUERY
 * (exactly like commons.list): every skill node in every project, each row
 * carrying its own projectId + project name, because a skill installed into
 * `~/.claude/skills` belongs to the machine rather than to one project and the
 * page has to be able to show them all at once.
 */
export function listSkills(p: { projectId?: string } = {}): SkillsPayload {
  const targets = listTargets()
  // disabled targets are listed (the page renders the row) but take no part:
  // not scanned, no drift cell, never an install destination
  const active = activeTargets(targets)

  // one shallow scan per target, reused for every row
  const installed: InstalledSkill[] = []
  const byTarget = new Map<string, Map<string, InstalledSkill>>()
  for (const t of active) {
    const found = scanTarget(t)
    byTarget.set(t.id, new Map(found.map((s) => [s.slug, s])))
    installed.push(...found)
  }

  const allProjects = svc.listProjects()
  let scope = allProjects
  if (p?.projectId !== undefined && p.projectId !== null && p.projectId !== '') {
    need(typeof p.projectId === 'string', 'projectId must be a string')
    scope = allProjects.filter((x) => x.id === p.projectId)
    need(scope.length, `project "${p.projectId}" not found`, 404)
  }

  const views = skillNodeViews(scope.map((x) => ({ id: x.id, name: x.name })))
  const rowsByNode = installRowsFor(views.map((v) => v.node.id))
  const claimed = new Set<string>() // `${targetId} ${slug}`

  const rows: SkillRow[] = views.map((v) => {
    const slug = v.node.slug ?? ''
    const drift: Record<string, SkillDriftState> = {}
    if (slug) {
      for (const t of active) {
        const disk = byTarget.get(t.id)?.get(slug) ?? null
        if (disk) {
          claimed.add(`${t.id} ${slug}`)
          if (disk.nodeId === null) disk.nodeId = v.node.id
        }
        let expectedAbs: string
        try {
          expectedAbs = skillFileFor(t, slug)
        } catch {
          continue // an unusable slug/target pair simply has no cell
        }
        const last = trustedSha(rowsByNode.get(`${v.node.id} ${t.id}`), expectedAbs)
        // a node that cannot render still has honest disk facts: a file that is
        // there was hand-written as far as we can prove, so it reads `modified`
        // (resolvable by adopt) rather than pretending to be clean
        drift[t.id] = v.rendered
          ? driftState(v.rendered.sha, disk?.sha ?? null, last)
          : disk ? 'modified' : 'missing'
      }
    }
    return {
      nodeId: v.node.id,
      projectId: v.node.projectId,
      projectName: v.projectName,
      slug,
      title: v.node.title,
      description: v.node.description ?? '',
      promptOnly: v.node.skillOptions?.['disable-model-invocation'] === true,
      drift
    }
  })

  // UNMANAGED: a file on disk no node claims. It gets a row too (nodeId null) —
  // that row IS the Import affordance, and without it the page would silently
  // hide skills the human can plainly see in their repo.
  const unmanaged = new Map<string, SkillRow>()
  for (const s of installed) {
    if (claimed.has(`${s.targetId} ${s.slug}`)) continue
    const row = unmanaged.get(s.slug) ?? {
      nodeId: null,
      projectId: '',
      projectName: '',
      slug: s.slug,
      title: s.name ?? s.slug,
      description: s.description ?? '',
      promptOnly: false,
      drift: {}
    }
    row.drift[s.targetId] = 'unmanaged'
    unmanaged.set(s.slug, row)
  }

  rows.push(...[...unmanaged.values()].sort((a, b) => a.slug.localeCompare(b.slug)))
  return { rows, targets, installed }
}

// ---------------------------------------------------------------------------
// skills.read / skills.diff

/** skills.read — the installed file VERBATIM, plus its frontmatter as parsed. */
export function readInstalled(p: { targetId?: string; slug?: string }): {
  targetId: string; slug: string; absPath: string; exists: boolean; bundled: boolean
  markdown: string | null; sha: string | null
  frontmatter: Record<string, unknown> | null; frontmatterError: string | null
  body: string | null; files: string[]
} {
  const targets = listTargets()
  const t = resolveTarget(p?.targetId, targets)
  const slug = svc.validateSlug(p?.slug)
  const dir = skillDirFor(t, slug)
  const abs = path.join(dir, SKILL_FILE)
  const disk = readOnDisk(abs)
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).sort()
  } catch {
    files = []
  }
  if (!disk) {
    return {
      targetId: t.id, slug, absPath: abs, exists: false, bundled: false,
      markdown: null, sha: null, frontmatter: null, frontmatterError: null, body: null, files
    }
  }
  const fm = parseFrontmatter(disk.text)
  return {
    targetId: t.id, slug, absPath: abs, exists: true,
    bundled: files.some((n) => n !== SKILL_FILE),
    markdown: disk.text, sha: disk.sha,
    frontmatter: fm.error ? null : fm.data,
    frontmatterError: fm.error,
    body: fm.body,
    files
  }
}

/** skills.diff — disk → rendered, so `+` lines are what an install would write. */
export function diffSkill(p: { nodeId?: string; targetId?: string }): {
  nodeId: string; targetId: string; slug: string; absPath: string; state: SkillDriftState; unified: string
} {
  const targets = listTargets()
  const t = resolveTarget(p?.targetId, targets)
  const node = loadSkillNode(p?.nodeId)
  const rendered = renderSkill(node, skillBody(node))
  const abs = skillFileFor(t, rendered.slug)
  const disk = readOnDisk(abs)
  const last = trustedSha(installRowsFor([node.id]).get(`${node.id} ${t.id}`), abs)
  return {
    nodeId: node.id,
    targetId: t.id,
    slug: rendered.slug,
    absPath: abs,
    state: driftState(rendered.sha, disk?.sha ?? null, last),
    unified: unifiedDiff(disk?.text ?? '', rendered.markdown)
  }
}

// ---------------------------------------------------------------------------
// skills.install

export interface TargetResult {
  targetId: string
  ok: boolean
  state?: SkillDriftState
  absPath?: string
  sha?: string
  /** where the clobbered file was copied before a forced overwrite */
  backedUpTo?: string
  removedDir?: boolean
  error?: string
}

/** Copy an about-to-be-clobbered file into the vault trash. Forcing is the one
 *  destructive path in this module, so it is also the only one that keeps a
 *  copy — a hand-edited skill someone spent an afternoon on must be recoverable. */
function backupToTrash(abs: string, targetId: string, slug: string): string | null {
  try {
    const root = vault.getVaultRoot()
    if (!root) return null
    const dir = path.join(root, '.ozmo', 'trash')
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `${Date.now()}-skill-${targetId}-${slug}-${SKILL_FILE}`)
    fs.copyFileSync(abs, dest)
    return dest
  } catch {
    return null
  }
}

/** Atomic-ish write: temp file in the SAME directory, then rename over. A
 *  half-written SKILL.md is worse than none — the model would load the truncated
 *  half and act on it. */
function writeAtomic(dir: string, file: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${SKILL_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    fs.writeFileSync(tmp, contents, 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort — a stray .tmp is harmless, a thrown cleanup error is not
    }
    throw e
  }
}

/**
 * skills.install — render the node and write it into each target.
 *
 * Two phases on purpose:
 *
 *   PRE-FLIGHT (throws, nothing written): the node renders, every target id
 *   resolves, every root exists, and no target is `modified` unless forced.
 *   These are deterministic caller/config errors — answering them with a
 *   half-done batch would be worse than refusing.
 *
 *   WRITE (per-target try/catch, never aborts): one locked file, one read-only
 *   checkout or one antivirus hold must not cost the other fifteen targets their
 *   install. Failures land in `results[]`.
 */
export function installSkill(
  p: { nodeId?: string; targets?: unknown; force?: boolean },
  actor: string
): { nodeId: string; slug: string; sha: string; results: TargetResult[] } {
  const targets = listTargets()
  const chosen = resolveTargetList(p?.targets, targets)
  for (const t of chosen) assertWritableTarget(t)
  const node = loadSkillNode(p?.nodeId)
  const rendered = renderSkill(node, skillBody(node))
  need(rendered.description,
    `skill "${node.title}" has no description — that is the only thing a model matches on to decide whether ` +
    'to use a skill, so installing without one ships a skill that never fires. Set it first.')

  // never create a root: a target whose root has gone missing (or was a typo)
  // must not have a whole directory tree invented for it
  const missingRoot = chosen.filter((t) => !fs.existsSync(t.root))
  need(!missingRoot.length,
    `root does not exist for ${missingRoot.map((t) => `"${t.id}" (${t.root})`).join(', ')} — ` +
    'the app never creates a target root. Fix the path with skills.addTarget/removeTarget.', 400)

  const installRows = installRowsFor([node.id])
  const plan = chosen.map((t) => {
    const abs = skillFileFor(t, rendered.slug)
    const disk = readOnDisk(abs)
    const last = trustedSha(installRows.get(`${node.id} ${t.id}`), abs)
    return { t, abs, disk, state: driftState(rendered.sha, disk?.sha ?? null, last) }
  })

  // OVERWRITE PROTECTION. Same structured-409 shape the ship gate uses, so an
  // agent handles it with the machinery it already has: read the drift list,
  // diff it, adopt it or re-send with force:true.
  if (!p?.force) {
    const conflicts = plan.filter((x) => x.state === 'modified')
    if (conflicts.length) {
      throw err(
        `${conflicts.length} target${conflicts.length > 1 ? 's have' : ' has'} a hand-edited SKILL.md that ` +
        `"${node.title}" would overwrite: ${conflicts.map((x) => x.t.id).join(', ')}. ` +
        'Inspect with skills.diff, keep the edit with skills.adopt, or re-send with force:true ' +
        '(the old file is copied into the vault trash first).',
        409,
        { drift: conflicts.map((x) => ({ targetId: x.t.id, slug: rendered.slug, state: x.state, absPath: x.abs })) }
      )
    }
  }

  const results: TargetResult[] = []
  for (const { t, abs, disk, state } of plan) {
    try {
      const dir = path.dirname(abs)
      const backedUpTo = disk && state === 'modified' ? backupToTrash(abs, t.id, rendered.slug) ?? undefined : undefined
      writeAtomic(dir, abs, rendered.markdown)

      // RE-PARSE FROM DISK and assert the name matches the DIRECTORY. Everything
      // else about a broken skill is visible; this is the failure that hides.
      const back = readOnDisk(abs)
      if (!back) throw new Error('the file disappeared immediately after writing')
      const fm = parseFrontmatter(back.text)
      if (fm.error) throw new Error(`the written file does not parse as YAML frontmatter: ${fm.error}`)
      const dirName = path.basename(dir)
      if (fm.data.name !== dirName) {
        throw new Error(
          `written frontmatter name ${JSON.stringify(fm.data.name)} does not match the directory "${dirName}" — ` +
          'the skill would half-load (body only, description lost)'
        )
      }

      recordInstall(node.id, t.id, abs, back.sha, actor)
      results.push({ targetId: t.id, ok: true, state: 'clean', absPath: abs, sha: back.sha, backedUpTo })
      logActivity(node.projectId, actor, 'skill.installed', node.id,
        `installed skill "${rendered.slug}" into ${t.label}${t.branch ? ` (${t.branch})` : ''}`,
        { targetId: t.id, slug: rendered.slug, absPath: abs, sha: back.sha, branch: t.branch, forced: !!p?.force })
      emitEvent('skill.installed', node.projectId,
        { nodeId: node.id, targetId: t.id, slug: rendered.slug, absPath: abs, sha: back.sha, branch: t.branch }, actor)
    } catch (e) {
      results.push({ targetId: t.id, ok: false, state, absPath: abs, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { nodeId: node.id, slug: rendered.slug, sha: rendered.sha, results }
}

// ---------------------------------------------------------------------------
// skills.uninstall

/**
 * Removes SKILL.md and NOTHING else. The directory is rmdir'd only when it is
 * empty afterwards: a bundled skill's `scripts/` and `references/` are the
 * human's files, not ours, and deleting them because they sit next to a file we
 * wrote would be the most expensive kind of helpfulness.
 */
export function uninstallSkill(
  p: { nodeId?: string; targets?: unknown },
  actor: string
): { nodeId: string; slug: string; results: TargetResult[] } {
  const targets = listTargets()
  const chosen = resolveTargetList(p?.targets, targets)
  for (const t of chosen) assertWritableTarget(t)
  const node = loadSkillNode(p?.nodeId)
  const slug = svc.validateSlug(node.slug)

  const results: TargetResult[] = []
  for (const t of chosen) {
    try {
      const dir = skillDirFor(t, slug)
      const abs = path.join(dir, SKILL_FILE)
      let removed = false
      try {
        fs.unlinkSync(abs)
        removed = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      let removedDir = false
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir)
          removedDir = true
        }
      } catch {
        // the dir is gone, non-empty, or held — either way SKILL.md is what we
        // promised to remove and that part succeeded
      }
      clearInstall(node.id, t.id)
      results.push({ targetId: t.id, ok: true, state: 'missing', absPath: abs, removedDir })
      if (removed) {
        logActivity(node.projectId, actor, 'skill.uninstalled', node.id,
          `uninstalled skill "${slug}" from ${t.label}`,
          { targetId: t.id, slug, absPath: abs, removedDir })
        emitEvent('skill.uninstalled', node.projectId,
          { nodeId: node.id, targetId: t.id, slug, absPath: abs, removedDir }, actor)
      }
    } catch (e) {
      results.push({ targetId: t.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { nodeId: node.id, slug, results }
}

// ---------------------------------------------------------------------------
// skills.import — adopt a disk skill as a node

/** Frontmatter minus name/description = the skillOptions object, order preserved
 *  so a re-render reproduces the file the human already has. */
function optionsFromFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === 'name' || k === 'description') continue
    if (VAULT_ONLY_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

export function importSkill(
  p: { projectId?: string; targetId?: string; slug?: string; title?: string },
  actor: string
): { node: SpecNode; targetId: string; absPath: string; sha: string } {
  const targets = listTargets()
  const t = resolveTarget(p?.targetId, targets)
  const slug = svc.validateSlug(p?.slug)

  // a skill on disk belongs to no repo in particular, so an unspecified project
  // falls back to the declared skills home rather than guessing
  const projectId = (typeof p?.projectId === 'string' && p.projectId) || getSettings().skillsHomeProjectId || ''
  need(projectId,
    'projectId is required (or set skillsHomeProjectId in settings — the project that adopts homeless skills)')
  svc.getProject({ id: projectId })

  const abs = skillFileFor(t, slug)
  const disk = readOnDisk(abs)
  need(disk, `no ${SKILL_FILE} at ${abs}`, 404)
  need(Buffer.byteLength(disk!.text, 'utf8') <= MAX_SKILL_BYTES,
    `${abs} is over the ${MAX_SKILL_BYTES} byte cap`, 413)

  const fm = parseFrontmatter(disk!.text)
  need(!fm.error, `${abs} has malformed YAML frontmatter (${fm.error}) — fix the file, then import`, 400)
  const fmName = typeof fm.data.name === 'string' ? fm.data.name : null
  need(!fmName || fmName === slug,
    `${abs} declares name "${fmName}" but lives in directory "${slug}" — that skill half-loads today. ` +
    'Fix the file so they agree, then import.', 409)

  const title = (typeof p?.title === 'string' && p.title.trim()) || fmName || slug
  const description = typeof fm.data.description === 'string' ? fm.data.description : ''
  const skillOptions = optionsFromFrontmatter(fm.data)

  const node = svc.createNode({
    projectId,
    type: 'skill',
    title,
    slug,
    description,
    skillOptions: Object.keys(skillOptions).length ? skillOptions : null,
    content: fm.body.replace(/^\n/, '')
  }, actor)

  // record the install so the row reads `clean` immediately: the file we just
  // read IS what is installed, and importing must not present the human's own
  // skill back to them as drift
  recordInstall(node.id, t.id, abs, disk!.sha, actor)

  logActivity(projectId, actor, 'skill.imported', node.id,
    `imported skill "${slug}" from ${t.label}`,
    { targetId: t.id, slug, absPath: abs, sha: disk!.sha })
  emitEvent('skill.imported', projectId, { nodeId: node.id, targetId: t.id, slug, absPath: abs }, actor)
  return { node, targetId: t.id, absPath: abs, sha: disk!.sha }
}

// ---------------------------------------------------------------------------
// skills.adopt — pull a hand-edited disk file back INTO the node

/**
 * NOT optional. Without adopt, `modified` has exactly one resolution — force,
 * which throws the human's edit away. Adopt is the other direction: the edit
 * wins and the node learns it, so the two agree again without anybody losing
 * work. That is the whole reason `modified` and `converged` are separate states.
 */
export function adoptSkill(
  p: { nodeId?: string; targetId?: string },
  actor: string
): { nodeId: string; targetId: string; absPath: string; sha: string; state: SkillDriftState } {
  const targets = listTargets()
  const t = resolveTarget(p?.targetId, targets)
  const node = loadSkillNode(p?.nodeId)
  const slug = svc.validateSlug(node.slug)
  const abs = skillFileFor(t, slug)

  const disk = readOnDisk(abs)
  need(disk, `no ${SKILL_FILE} at ${abs} — nothing to adopt`, 404)
  need(Buffer.byteLength(disk!.text, 'utf8') <= MAX_SKILL_BYTES,
    `${abs} is over the ${MAX_SKILL_BYTES} byte cap`, 413)

  const fm = parseFrontmatter(disk!.text)
  need(!fm.error, `${abs} has malformed YAML frontmatter (${fm.error}) — fix the file, then adopt`, 400)
  const fmName = typeof fm.data.name === 'string' ? fm.data.name : null
  need(!fmName || fmName === slug,
    `${abs} declares name "${fmName}" but "${node.title}" has slug "${slug}" — adopting would move the node's ` +
    'install identity behind its back. Reconcile the names first.', 409)

  const description = typeof fm.data.description === 'string' ? fm.data.description : ''
  const skillOptions = optionsFromFrontmatter(fm.data)

  svc.setContent({ id: node.id, content: fm.body.replace(/^\n/, '') }, actor)
  updateSkillFields({
    id: node.id,
    description,
    skillOptions: Object.keys(skillOptions).length ? skillOptions : null
  }, actor)

  // re-render to find out whether the node now reproduces the file byte for
  // byte. It usually does; when YAML style differs the honest answer is `ahead`
  // (install restamps it), never a `clean` we cannot prove.
  const after = svc.getNode({ id: node.id })
  let state: SkillDriftState = 'clean'
  try {
    const rendered = renderSkill(after, skillBody(after))
    recordInstall(node.id, t.id, abs, disk!.sha, actor)
    state = driftState(rendered.sha, disk!.sha, disk!.sha)
  } catch {
    recordInstall(node.id, t.id, abs, disk!.sha, actor)
    state = 'modified'
  }

  logActivity(node.projectId, actor, 'skill.adopted', node.id,
    `adopted the on-disk edit of "${slug}" from ${t.label}`,
    { targetId: t.id, slug, absPath: abs, sha: disk!.sha, state })
  emitEvent('skill.adopted', node.projectId,
    { nodeId: node.id, targetId: t.id, slug, absPath: abs, sha: disk!.sha, state }, actor)
  return { nodeId: node.id, targetId: t.id, absPath: abs, sha: disk!.sha, state }
}

/**
 * The skill fields go through `services.updateNode` like every other node
 * mutation — nothing in this file writes the `nodes` table. Typed against the
 * @shared/types contract (SpecNode.description / .skillOptions) rather than
 * against services' current parameter list, which is WP-2's file to widen.
 */
type SkillFieldPatch = Parameters<typeof svc.updateNode>[0] & {
  description?: string | null
  skillOptions?: Record<string, unknown> | null
}
function updateSkillFields(patch: SkillFieldPatch, actor: string): SpecNode {
  return svc.updateNode(patch as Parameters<typeof svc.updateNode>[0], actor)
}

// ---------------------------------------------------------------------------
// skills.addTarget / skills.removeTarget
//
// Deliberate VERBS, not a settings field. `skillTargets` is the app's write
// surface on the user's disk; PATCH /api/settings refuses it, so the only way a
// root joins the allowlist is through a call that validates the path, writes an
// activity row and emits an event. An unauthenticated loopback API that took a
// root as a settings blob would be an arbitrary-file-write primitive reachable
// from any web page the human happens to visit.

const RESERVED_TARGET_IDS = new Set([GLOBAL_SKILL_TARGET_ID])

/** Reject an unusable relative skills dir instead of quietly defaulting it —
 *  the caller asked for a specific place and deserves to be told it is refused. */
function validateSkillsDir(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SKILLS_DIR
  need(typeof raw === 'string', 'skillsDir must be a relative path string')
  const trimmed = (raw as string).trim()
  if (!trimmed) return DEFAULT_SKILLS_DIR
  need(!path.isAbsolute(trimmed) && !trimmed.includes(':'),
    `skillsDir "${trimmed}" must be RELATIVE to the target root`)
  const segments = trimmed.split(/[\\/]+/).filter((s) => s && s !== '.')
  need(segments.length > 0, 'skillsDir must name a directory under the root')
  need(!segments.some((s) => s === '..'), `skillsDir "${trimmed}" may not contain ".." — it would climb out of the root`)
  return segments.join('/')
}

export function addTarget(
  p: { id?: string; label?: string; root?: string; skillsDir?: string; enabled?: boolean },
  actor: string
): { target: SkillTarget; targets: SkillTarget[] } {
  need(typeof p?.root === 'string' && p.root.trim(), 'root is required (an absolute path to the checkout)')
  const rawRoot = (p.root as string).trim()
  need(path.isAbsolute(rawRoot), `root "${rawRoot}" must be an absolute path`)
  const root = path.resolve(rawRoot)
  // the app NEVER creates a root. A target that does not exist is a typo, and a
  // typo that silently mkdir -p's a tree in someone's filesystem is how this
  // feature would earn its reputation.
  let stat: fs.Stats | null = null
  try {
    stat = fs.statSync(root)
  } catch {
    stat = null
  }
  need(stat, `root "${root}" does not exist — the app never creates a target root`, 400)
  need(stat!.isDirectory(), `root "${root}" is not a directory`, 400)

  const skillsDir = validateSkillsDir(p?.skillsDir)
  const existing = getSkillTargets()
  need(existing.length < MAX_TARGETS, `at most ${MAX_TARGETS} skill targets`, 400)

  const sameRoot = existing.find((t) => {
    const a = path.resolve(t.root, t.skillsDir ?? DEFAULT_SKILLS_DIR)
    const b = path.resolve(root, skillsDir)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  })
  need(!sameRoot, `${path.resolve(root, skillsDir)} is already declared as target "${sameRoot?.id}"`, 409)

  let id = typeof p?.id === 'string' && p.id.trim() ? p.id.trim() : ''
  if (id) {
    need(id.length <= 64 && TARGET_ID_RE.test(id),
      `invalid target id "${id}" — letters, digits, '-' and '_' only`)
    need(!RESERVED_TARGET_IDS.has(id), `"${id}" is a reserved target id`)
    need(!existing.some((t) => t.id === id), `target id "${id}" is already taken`, 409)
  } else {
    const base = (path.basename(root) || 'target').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    let candidate = `tgt_${base || 'target'}`
    let i = 2
    while (existing.some((t) => t.id === candidate) || RESERVED_TARGET_IDS.has(candidate)) candidate = `tgt_${base}_${i++}`
    id = candidate.slice(0, 64)
  }

  const cfg: SkillTargetConfig = {
    id,
    label: (typeof p?.label === 'string' && p.label.trim()) || path.basename(root) || root,
    root,
    skillsDir,
    enabled: p?.enabled !== false
  }
  setSkillTargets([...existing, cfg])

  const targets = listTargets()
  const target = targets.find((t) => t.id === id)
  need(target, `target "${id}" did not survive validation — check the root and skillsDir`, 500)

  const projectId = targetActivityProject()
  if (projectId) {
    logActivity(projectId, actor, 'skill.target.added', id,
      `added skill target "${cfg.label}" → ${target!.absSkillsDir}`,
      { targetId: id, root, skillsDir, absSkillsDir: target!.absSkillsDir, branch: target!.branch })
  }
  emitEvent('skill.target.added', projectId ?? undefined, { target }, actor)
  return { target: target!, targets }
}

/**
 * skills.setTargetEnabled — the switch behind the Settings card's per-target
 * toggle. Turning a target OFF must never mean deleting it: the allowlist is a
 * decision the human made once, and "not right now" is a different statement
 * from "never again". Removing and re-adding would also lose the target id, and
 * with it every install row keyed to it.
 */
export function setTargetEnabled(
  p: { targetId?: string; id?: string; enabled?: boolean },
  actor: string
): { target: SkillTarget; targets: SkillTarget[] } {
  const id = assertTargetId(p?.targetId ?? p?.id)
  need(typeof p?.enabled === 'boolean', 'enabled must be true or false')
  const enabled = p.enabled as boolean
  const existing = getSkillTargets()
  const current = existing.find((t) => t.id === id)
  need(current, `unknown target "${id}"`, 404)

  setSkillTargets(existing.map((t) => (t.id === id ? { ...t, enabled } : t)))
  const targets = listTargets()
  const target = targets.find((t) => t.id === id)
  need(target, `target "${id}" did not survive the update`, 500)

  const projectId = targetActivityProject()
  if (projectId) {
    logActivity(projectId, actor, 'skill.target.updated', id,
      `${enabled ? 'enabled' : 'disabled'} skill target "${current!.label}"`,
      { targetId: id, enabled, root: current!.root })
  }
  emitEvent('skill.target.updated', projectId ?? undefined, { target, enabled }, actor)
  return { target: target!, targets }
}

export function removeTarget(p: { id?: string }, actor: string): { removed: SkillTargetConfig; targets: SkillTarget[] } {
  const id = assertTargetId(p?.id)
  const existing = getSkillTargets()
  const removed = existing.find((t) => t.id === id)
  need(removed, `unknown target "${id}"`, 404)

  setSkillTargets(existing.filter((t) => t.id !== id))

  // skill_installs rows for this target are KEPT on purpose: removing a target
  // is a change to where we may write, not a claim that the files are gone.
  // Re-adding the same id restores accurate drift instead of reporting every
  // file we ourselves wrote as a stranger's hand edit. (`trustedSha` discards a
  // row whose abs_path no longer matches, so a re-pointed id can never lie.)

  const targets = listTargets()
  const projectId = targetActivityProject()
  if (projectId) {
    logActivity(projectId, actor, 'skill.target.removed', id,
      `removed skill target "${removed!.label}" (${removed!.root})`,
      { targetId: id, root: removed!.root, skillsDir: removed!.skillsDir })
  }
  emitEvent('skill.target.removed', projectId ?? undefined, { targetId: id, target: removed }, actor)
  return { removed: removed!, targets }
}

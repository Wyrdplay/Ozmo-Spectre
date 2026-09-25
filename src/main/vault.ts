import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import matter from 'gray-matter'
import chokidar, { type FSWatcher } from 'chokidar'

export interface NodeFrontmatter {
  id: string
  type: string
  /**
   * the kebab IDENTITY (the node's `slug`) — written for skills, where it names
   * the installed `.claude/skills/<slug>/` directory. Called `name` on disk
   * because that is SKILL.md's own key and the vault file is what a human edits;
   * the title lives in the filename, so without this key the identity would be
   * unrecoverable from the file alone.
   */
  name?: string | null
  /** the frontmatter `description` — for a skill, the only thing a model matches on */
  description?: string | null
  /** warp pipeline stage — written for warps only */
  stage?: string | null
  progress?: number | null
  /** remaining SKILL.md frontmatter (allowed-tools, model, argument-hint, …) */
  skill?: Record<string, unknown> | null
  tags: string[]
  links: string[]
}

// ---------------------------------------------------------------------------
// Slug validation. A slug names a DIRECTORY we create inside someone's repo, so
// it is validated and REJECTED, never sanitised: silently rewriting a slug would
// orphan every directory installed under the old one.

export const SLUG_MAX = 64
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** Windows refuses these as path segments, with or without an extension. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

/** null when the slug is usable; otherwise the reason it is not. */
export function slugProblem(slug: unknown): string | null {
  if (typeof slug !== 'string' || !slug) return 'slug is required'
  if (slug.length > SLUG_MAX) return `slug must be ${SLUG_MAX} characters or fewer (got ${slug.length})`
  if (!SLUG_RE.test(slug)) return `invalid slug "${slug}" — use lowercase letters, digits and single hyphens (e.g. "code-review")`
  if (WINDOWS_RESERVED.has(slug)) return `"${slug}" is a reserved device name on Windows and cannot name a directory`
  return null
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isValidSlug(slug: unknown): boolean {
  return slugProblem(slug) === null
}

/**
 * Best-effort kebab identity from a title, for DERIVING a default only — never
 * for repairing a slug a caller supplied (those are rejected, see slugProblem).
 * Returns null when nothing usable survives.
 */
export function deriveSlug(title: string): string | null {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX).replace(/-+$/g, '')
  return isValidSlug(s) ? s : null
}

export interface ExternalChange {
  /** node id from frontmatter */
  id: string
  relPath: string
  frontmatter: Partial<NodeFrontmatter>
  /** filename without extension — authoritative for title on external renames */
  filenameTitle: string
  kind: 'change' | 'add'
}

let vaultRoot = ''
let watcher: FSWatcher | null = null
let externalChangeHandler: ((c: ExternalChange) => void) | null = null
let fileMissingHandler: ((relPath: string) => void) | null = null

/** sha1 of last content we ourselves wrote, keyed by absolute path */
const selfWrites = new Map<string, string>()
/** unlinked paths awaiting a matching add (rename reconciliation) */
const pendingUnlinks = new Map<string, NodeJS.Timeout>()

const hash = (s: string): string => crypto.createHash('sha1').update(s, 'utf8').digest('hex')

export function initVault(root: string): void {
  vaultRoot = root
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(root, '.ozmo', 'trash'), { recursive: true })
}

export function getVaultRoot(): string {
  return vaultRoot
}

export function absPath(relPath: string): string {
  return path.join(vaultRoot, relPath)
}

export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
  return (cleaned || 'Untitled').slice(0, 120)
}

export function ensureProjectFolders(projectFolder: string, typeFolders: string[]): void {
  for (const f of typeFolders) fs.mkdirSync(path.join(vaultRoot, projectFolder, f), { recursive: true })
}

function writeFileTracked(abs: string, raw: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  selfWrites.set(abs, hash(raw))
  fs.writeFileSync(abs, raw, 'utf8')
}

/**
 * WHITELIST, not a merge: every key written here is rebuilt from the DB row and
 * anything absent from NodeFrontmatter is DROPPED from the file. refreshNodeFile
 * runs this on every node update and every edge change, so a field that is not
 * taught to `serialize` dies the first time anyone touches a tag in the app —
 * not merely on an external edit. Add a field here AND to frontmatterFor AND to
 * handleFsEvent, or it evaporates.
 *
 * Key order is deliberate: id, type, name, description, tags, stage?, progress?,
 * skill?, links. Optional keys stay omitted when unset, so a non-skill node's
 * file is byte-identical to what it was before skills existed.
 */
function serialize(fm: NodeFrontmatter, body: string): string {
  const data: Record<string, unknown> = {
    id: fm.id,
    type: fm.type
  }
  if (fm.name != null && fm.name !== '') data.name = fm.name
  if (fm.description != null && fm.description !== '') data.description = fm.description
  data.tags = fm.tags ?? []
  if (fm.stage != null) data.stage = fm.stage
  if (fm.progress != null) data.progress = fm.progress
  if (fm.skill != null && typeof fm.skill === 'object' && Object.keys(fm.skill).length) data.skill = fm.skill
  data.links = fm.links ?? []
  return matter.stringify(body.startsWith('\n') ? body : '\n' + body, data)
}

export function parseFile(abs: string): { data: Record<string, unknown>; body: string } | null {
  try {
    const raw = fs.readFileSync(abs, 'utf8')
    const parsed = matter(raw)
    return { data: parsed.data as Record<string, unknown>, body: parsed.content.replace(/^\n/, '') }
  } catch {
    return null
  }
}

/** Create a node file with a unique name. Returns the vault-relative path. */
export function createNodeFile(projectFolder: string, typeFolder: string, title: string, fm: NodeFrontmatter, body: string): string {
  const dir = path.join(vaultRoot, projectFolder, typeFolder)
  fs.mkdirSync(dir, { recursive: true })
  const base = sanitizeFileName(title)
  let name = base
  let i = 2
  while (fs.existsSync(path.join(dir, name + '.md'))) name = `${base} ${i++}`
  const rel = path.join(projectFolder, typeFolder, name + '.md')
  writeFileTracked(absPath(rel), serialize(fm, body))
  return rel
}

export function readBody(relPath: string): string {
  const parsed = parseFile(absPath(relPath))
  return parsed ? parsed.body : ''
}

export function writeBody(relPath: string, body: string, fm: NodeFrontmatter): void {
  writeFileTracked(absPath(relPath), serialize(fm, body))
}

/** Rewrite frontmatter, keeping the current body on disk. */
export function writeFrontmatter(relPath: string, fm: NodeFrontmatter): void {
  const body = readBody(relPath)
  writeFileTracked(absPath(relPath), serialize(fm, body))
}

/**
 * One-shot migration helper: drop the legacy `status` key from a file's
 * frontmatter and sync `tags` to the DB truth (which now includes any tag the
 * status migration minted). Without this, the watcher's replace-tags semantics
 * would wipe migrated tags on the next external edit. Preserves every other
 * frontmatter key and the body untouched; no-op when already clean.
 */
export function stripStatusFrontmatter(relPath: string, tags: string[]): void {
  const abs = absPath(relPath)
  const parsed = parseFile(abs)
  if (!parsed) return
  const fileTags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : []
  if (!('status' in parsed.data) && JSON.stringify(fileTags) === JSON.stringify(tags)) return
  delete parsed.data.status
  parsed.data.tags = tags
  const body = parsed.body.startsWith('\n') ? parsed.body : '\n' + parsed.body
  writeFileTracked(abs, matter.stringify(body, parsed.data))
}

/** Rename the file to match a new title. Returns the new relative path. */
export function renameNodeFile(relPath: string, newTitle: string): string {
  const abs = absPath(relPath)
  const dir = path.dirname(abs)
  const base = sanitizeFileName(newTitle)
  let name = base
  let i = 2
  while (fs.existsSync(path.join(dir, name + '.md')) && path.join(dir, name + '.md') !== abs) name = `${base} ${i++}`
  const newAbs = path.join(dir, name + '.md')
  if (newAbs === abs) return relPath
  const prevHash = selfWrites.get(abs)
  fs.renameSync(abs, newAbs)
  if (prevHash) {
    selfWrites.set(newAbs, prevHash)
    selfWrites.delete(abs)
  }
  return path.relative(vaultRoot, newAbs)
}

/**
 * Move a node file into another type folder (type conversion). Keeps the
 * title-based name, collision-suffixing in the destination like createNodeFile.
 * Callers pause the watcher around this — a cross-directory rename otherwise
 * fires unlink+add as an external change. Returns the new relative path.
 */
export function moveNodeFile(relPath: string, projectFolder: string, typeFolder: string, title: string): string {
  const abs = absPath(relPath)
  const dir = path.join(vaultRoot, projectFolder, typeFolder)
  fs.mkdirSync(dir, { recursive: true })
  const base = sanitizeFileName(title)
  let name = base
  let i = 2
  while (fs.existsSync(path.join(dir, name + '.md')) && path.join(dir, name + '.md') !== abs) name = `${base} ${i++}`
  const newAbs = path.join(dir, name + '.md')
  if (newAbs === abs) return relPath
  const prevHash = selfWrites.get(abs)
  fs.renameSync(abs, newAbs)
  if (prevHash) {
    selfWrites.set(newAbs, prevHash)
    selfWrites.delete(abs)
  }
  return path.relative(vaultRoot, newAbs)
}

/** Move a file into .ozmo/trash preserving its project-relative shape. */
export function trashFile(relPath: string): void {
  const abs = absPath(relPath)
  if (!fs.existsSync(abs)) return
  const dest = path.join(vaultRoot, '.ozmo', 'trash', `${Date.now()}-${path.basename(relPath)}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(abs, dest)
  selfWrites.delete(abs)
}

/**
 * ARCHIVE a node file: move it into its project's `.archive/` folder, keeping
 * its project-relative shape (`Spectre/Bugs/X.md` → `Spectre/.archive/Bugs/X.md`).
 * A dot-folder on purpose — the watcher ignores dot segments, so an archived
 * file can never be folded back in as a live node. Returns the new vault-relative
 * path ('' when there was no file to move).
 */
export function archiveFile(relPath: string): string {
  const abs = absPath(relPath)
  if (!relPath || !fs.existsSync(abs)) return ''
  const parts = relPath.split(/[\\/]/)
  const project = parts.shift() ?? ''
  const dir = path.join(vaultRoot, project, '.archive', ...parts.slice(0, -1))
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(relPath, '.md')
  let name = base
  let i = 2
  while (fs.existsSync(path.join(dir, name + '.md'))) name = `${base} ${i++}`
  const dest = path.join(dir, name + '.md')
  fs.renameSync(abs, dest)
  selfWrites.delete(abs)
  return path.relative(vaultRoot, dest)
}

/**
 * RESTORE an archived file to where it lived (or beside it, when a live file
 * has taken that name since). Tracked as our own write so the watcher does not
 * read the move back as an external edit. Returns the live vault-relative path.
 */
export function restoreFile(archivedRel: string, originalRel: string): string {
  const src = archivedRel ? absPath(archivedRel) : ''
  const wanted = absPath(originalRel)
  const dir = path.dirname(wanted)
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(wanted, '.md')
  let name = base
  let i = 2
  while (fs.existsSync(path.join(dir, name + '.md'))) name = `${base} ${i++}`
  const dest = path.join(dir, name + '.md')
  if (src && fs.existsSync(src)) {
    const raw = fs.readFileSync(src, 'utf8')
    selfWrites.set(dest, hash(raw))
    fs.renameSync(src, dest)
  }
  return path.relative(vaultRoot, dest)
}

/** Move a sub-graph's folder (vault-relative) — every file under it travels. */
export function moveFolder(fromRel: string, toRel: string): void {
  const from = absPath(fromRel)
  const to = absPath(toRel)
  if (!fs.existsSync(from) || from === to) return
  fs.mkdirSync(path.dirname(to), { recursive: true })
  moveDir(from, to)
  // tracked self-write hashes are keyed by absolute path — carry them along
  for (const [abs, h] of [...selfWrites]) {
    if (abs.startsWith(from + path.sep)) {
      selfWrites.delete(abs)
      selfWrites.set(to + abs.slice(from.length), h)
    }
  }
}

/** Remove a folder only if nothing but empty folders remain in it. */
export function removeEmptyFolder(rel: string): void {
  const abs = absPath(rel)
  const empty = (dir: string): boolean =>
    fs.readdirSync(dir, { withFileTypes: true }).every((e) => e.isDirectory() && empty(path.join(dir, e.name)))
  try {
    if (fs.existsSync(abs) && empty(abs)) fs.rmSync(abs, { recursive: true, force: true })
  } catch { /* a folder we cannot remove is left, never an error */ }
}

/** Move a directory, falling back to copy+delete when a watcher holds the handle (Windows EPERM). */
function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch {
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

export function trashProjectFolder(projectFolder: string): void {
  const abs = path.join(vaultRoot, projectFolder)
  if (!fs.existsSync(abs)) return
  const dest = path.join(vaultRoot, '.ozmo', 'trash', `${Date.now()}-${projectFolder}`)
  moveDir(abs, dest)
}

export function renameProjectFolder(oldFolder: string, newFolder: string): void {
  const from = path.join(vaultRoot, oldFolder)
  const to = path.join(vaultRoot, newFolder)
  if (fs.existsSync(from) && !fs.existsSync(to)) moveDir(from, to)
}

/** Run fn with the vault watcher stopped — directory renames on Windows need this. */
export async function withWatcherPaused<T>(fn: () => T): Promise<T> {
  const wasRunning = !!watcher
  if (wasRunning) await stopWatcher()
  try {
    return fn()
  } finally {
    if (wasRunning) startWatcher()
  }
}

// ---------------------------------------------------------------------------
// Watcher — folds external (Obsidian / editor) changes back into the system.

export function setWatcherHandlers(onChange: (c: ExternalChange) => void, onMissing: (relPath: string) => void): void {
  externalChangeHandler = onChange
  fileMissingHandler = onMissing
}

function isIgnored(p: string): boolean {
  const rel = path.relative(vaultRoot, p)
  if (rel.startsWith('..')) return true
  const parts = rel.split(path.sep)
  if (parts.some((seg) => seg.startsWith('.'))) return true
  const stat = fs.existsSync(p) ? fs.statSync(p) : null
  if (stat?.isDirectory()) return false
  return !p.toLowerCase().endsWith('.md')
}

function handleFsEvent(kind: 'add' | 'change', abs: string): void {
  const parsed = parseFile(abs)
  if (!parsed) return
  const raw = fs.readFileSync(abs, 'utf8')
  const known = selfWrites.get(abs)
  if (known && known === hash(raw)) return // our own write echoing back
  const id = typeof parsed.data.id === 'string' ? parsed.data.id : null
  if (!id) return // not one of ours
  const rel = path.relative(vaultRoot, abs)
  externalChangeHandler?.({
    id,
    relPath: rel,
    kind,
    filenameTitle: path.basename(abs, '.md'),
    // legacy `status` keys in old frontmatter are deliberately ignored — state lives in tags
    frontmatter: {
      // `name` carries the slug; the service validates it and refuses a collision
      name: typeof parsed.data.name === 'string' ? parsed.data.name : undefined,
      description: typeof parsed.data.description === 'string' ? parsed.data.description : undefined,
      stage: typeof parsed.data.stage === 'string' ? parsed.data.stage : undefined,
      progress: typeof parsed.data.progress === 'number' ? parsed.data.progress : undefined,
      skill: isPlainObject(parsed.data.skill) ? (parsed.data.skill as Record<string, unknown>) : undefined,
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : undefined
    }
  })
}

export function startWatcher(): void {
  stopWatcher()
  watcher = chokidar.watch(vaultRoot, {
    ignored: isIgnored,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 }
  })
  watcher.on('change', (p) => handleFsEvent('change', p))
  watcher.on('add', (p) => {
    // An add shortly after an unlink is a rename — clear the pending delete.
    for (const [oldPath, timer] of pendingUnlinks) {
      const parsed = parseFile(p)
      if (parsed && typeof parsed.data.id === 'string') {
        clearTimeout(timer)
        pendingUnlinks.delete(oldPath)
        break
      }
    }
    handleFsEvent('add', p)
  })
  watcher.on('unlink', (p) => {
    const rel = path.relative(vaultRoot, p)
    const timer = setTimeout(() => {
      pendingUnlinks.delete(p)
      selfWrites.delete(p)
      fileMissingHandler?.(rel)
    }, 2500)
    pendingUnlinks.set(p, timer)
  })
}

export async function stopWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  for (const t of pendingUnlinks.values()) clearTimeout(t)
  pendingUnlinks.clear()
}

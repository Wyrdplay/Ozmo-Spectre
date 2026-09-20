import fs from 'fs'
import path from 'path'
import { newId, type Workspace, type WorkspaceKind, type WorkspaceList } from '@shared/types'
import { userDataDir } from './paths'
import { getSettings, updateSettings } from './settings'

/**
 * THE WORKSPACE REGISTRY.
 *
 * A workspace is a named binding to one core: a vault directory this process
 * opens, or a URL somebody else's process answers. The app chooses one before it
 * asks anything else, because the boot order IS the feature —
 *
 *   WHERE is the board  →  WHO am I there  →  WHAT is on it
 *
 * `store.boot()` already opens with "who am I, before what is on the board".
 * You cannot ask that until you know where, since the answer differs per server.
 *
 * ## Why this is a file and not a table
 *
 * It cannot live in a board database: you need a workspace to have a database.
 * So it sits beside settings.json in userData, per machine, and a served
 * instance has none at all — a container is a core, not a chooser.
 *
 * ## Tokens
 *
 * A server workspace holds its own session token, and it never leaves this
 * process: `publicView()` reports `hasToken` instead. A session belongs to a
 * WORKSPACE, not to an app — the web client's single `ozmo.session` key is the
 * same idea one slot wide, and would hand server A's token to server B the
 * moment there are two.
 */

const FILE = 'workspaces.json'

interface StoredWorkspace extends Omit<Workspace, 'hasToken'> {
  /** server only. Never sent to a renderer; see publicView(). */
  token?: string | null
}

interface StoredFile {
  activeId: string | null
  workspaces: StoredWorkspace[]
}

let cache: StoredFile | null = null

function file(): string {
  return path.join(userDataDir(), FILE)
}

function blank(): StoredFile {
  return { activeId: null, workspaces: [] }
}

function read(): StoredFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<StoredFile>
    const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.filter(valid) : []
    const activeId = workspaces.some((w) => w.id === raw.activeId) ? (raw.activeId as string) : null
    cache = { activeId, workspaces }
  } catch {
    // absent or corrupt. A machine that has been using Spectre already HAS a
    // workspace — the vault in settings — it just never had a name for it.
    cache = migrateFromSettings()
  }
  return cache
}

/** A stored entry we are willing to act on. Anything else is dropped rather than repaired. */
function valid(w: unknown): w is StoredWorkspace {
  if (!w || typeof w !== 'object') return false
  const o = w as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return false
  if (typeof o.name !== 'string' || !o.name.trim()) return false
  if (o.kind === 'local') return typeof o.vaultPath === 'string' && !!o.vaultPath
  if (o.kind === 'server') return typeof o.url === 'string' && !!o.url
  return false
}

/**
 * First run on an existing machine: the vault already in settings becomes a
 * local workspace called "Local", active. Nothing about that board changes and
 * the human is not asked a question they did not have before — the chooser only
 * earns its place once there are two.
 */
function migrateFromSettings(): StoredFile {
  const vaultPath = getSettings().vaultPath
  if (!vaultPath) return blank()
  const ws: StoredWorkspace = {
    id: newId('ws'),
    name: 'Local',
    kind: 'local',
    vaultPath,
    createdAt: Date.now(),
    lastOpenedAt: Date.now()
  }
  const f: StoredFile = { activeId: ws.id, workspaces: [ws] }
  write(f)
  console.log(`[ozmo] workspaces: adopted the existing vault as "Local" (${vaultPath})`)
  return f
}

function write(f: StoredFile): void {
  cache = f
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(f, null, 2), 'utf8')
  } catch (e) {
    console.error('[ozmo] workspaces: could not save the registry', e)
  }
}

/** What a renderer is allowed to see: everything but the credential. */
function publicView(w: StoredWorkspace): Workspace {
  const { token, ...rest } = w
  return w.kind === 'server' ? { ...rest, hasToken: !!token } : rest
}

export function listWorkspaces(): WorkspaceList {
  const f = read()
  return { workspaces: f.workspaces.map(publicView), activeId: f.activeId }
}

/** The stored entry for the active workspace, token included — main process only. */
export function activeWorkspace(): StoredWorkspace | null {
  const f = read()
  return f.workspaces.find((w) => w.id === f.activeId) ?? null
}

export function createWorkspace(p: {
  name?: string
  kind: WorkspaceKind
  vaultPath?: string
  url?: string
}): Workspace {
  const kind = p.kind
  if (kind !== 'local' && kind !== 'server') throw new Error('kind must be "local" or "server"')

  const f = read()
  const ws: StoredWorkspace = {
    id: newId('ws'),
    name: (p.name ?? '').trim(),
    kind,
    createdAt: Date.now()
  }

  if (kind === 'local') {
    const vaultPath = (p.vaultPath ?? '').trim()
    if (!vaultPath) throw new Error('a local workspace needs a vault folder')
    if (!path.isAbsolute(vaultPath)) throw new Error(`"${vaultPath}" must be an absolute path`)
    if (f.workspaces.some((w) => w.kind === 'local' && samePath(w.vaultPath, vaultPath))) {
      throw new Error('that folder is already a workspace')
    }
    ws.vaultPath = vaultPath
    if (!ws.name) ws.name = path.basename(vaultPath) || 'Local'
  } else {
    const url = normaliseUrl(p.url ?? '')
    if (f.workspaces.some((w) => w.kind === 'server' && w.url === url)) {
      throw new Error('that server is already a workspace')
    }
    ws.url = url
    if (!ws.name) ws.name = new URL(url).host
  }

  f.workspaces.push(ws)
  write(f)
  return publicView(ws)
}

/** Trailing slashes and a missing scheme are typos, not intent. */
export function normaliseUrl(raw: string): string {
  const s = raw.trim()
  if (!s) throw new Error('a server workspace needs a URL')
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    throw new Error(`"${raw}" is not a URL`)
  }
  return `${u.protocol}//${u.host}`.replace(/\/+$/, '')
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function removeWorkspace(id: string): WorkspaceList {
  const f = read()
  const before = f.workspaces.length
  f.workspaces = f.workspaces.filter((w) => w.id !== id)
  if (f.workspaces.length === before) throw new Error('no such workspace')
  // Removing the open one leaves nothing active: the chooser is the honest next
  // screen, rather than silently opening somebody else's board.
  if (f.activeId === id) f.activeId = null
  write(f)
  return listWorkspaces()
}

/**
 * Choose the workspace the NEXT boot opens.
 *
 * It does not switch in place. The database, the vault watcher and the HTTP
 * server are all bound at boot, and `updateSettings` already answers a vault
 * change with `relaunchRequired` for exactly that reason. Switching workspace is
 * that same act with a better name; tearing those down live is a lifecycle
 * problem worth solving later and not worth solving first.
 */
export function activateWorkspace(id: string): { workspace: Workspace; relaunchRequired: boolean } {
  const f = read()
  const ws = f.workspaces.find((w) => w.id === id)
  if (!ws) throw new Error('no such workspace')
  const relaunchRequired = f.activeId !== id
  f.activeId = id
  ws.lastOpenedAt = Date.now()
  write(f)
  // A local workspace IS settings.vaultPath — one concept, and keeping them in
  // sync means vault.ts, skills.ts and every path helper keep working untouched.
  if (ws.kind === 'local' && ws.vaultPath && getSettings().vaultPath !== ws.vaultPath) {
    updateSettings({ vaultPath: ws.vaultPath })
  }
  return { workspace: publicView(ws), relaunchRequired }
}

export function setWorkspaceToken(id: string, token: string | null): void {
  const f = read()
  const ws = f.workspaces.find((w) => w.id === id)
  if (!ws) return
  ws.token = token
  write(f)
}

/** Forget the cached file — used by tests and after an external edit. */
export function reloadWorkspaces(): void {
  cache = null
}

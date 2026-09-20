import * as svc from './services'
import * as ws from './workspaces'
import { probe } from './remote'
import { switchWorkspace } from './lifecycle'
import * as fog from './fog'
import { accounts, type Account } from './account'
import * as skills from './skills'
import { buildDocument } from './document'
import { exportProject, importProject } from './transfer'
import { getBoardLock, getSettings, setBoardLock, updateSettings } from './settings'
import { emitEvent } from './events'
import { rolesGrantableBy } from '@shared/types'
import type { AccountRole, AppInfo, SessionInfo } from '@shared/types'

export interface Ctx {
  actor: string
  /** The account this caller's session names, if it presented one that resolves. */
  account?: Account
  /**
   * This caller is the renderer inside the Electron process that owns the
   * database. They are sitting at the machine with the vault on their disk;
   * a login screen between them and their own files is theatre.
   */
  atTheMachine?: boolean
  /** They presented a session token — so they are a person, not an agent. */
  hasSession?: boolean
}

/**
 * Reachable without an approved account, and NOTHING else.
 *
 * This list is the whole gate. It is short on purpose: every method not named
 * here reads or writes the board, and the rule is that an unapproved viewer
 * sees no board at all — not project names, not counts. `app.info` is here
 * because a client cannot boot without it, and it is TRIMMED for callers who
 * are not approved (see below): the untrimmed payload carries the vault path
 * and the owner's name, which is board data by another name.
 */
const OPEN_METHODS = new Set(['session.current', 'session.request', 'session.signOut', 'app.info'])

/**
 * WHAT A METHOD COSTS.
 *
 *   read        look at the board
 *   annotate    join the conversation on it — comments, review feedback
 *   write       change what the board SAYS: specs, tags, links, stages, positions
 *   host        act on the MACHINE the board runs on: its vault path, its port,
 *               the filesystem roots the skill installer may write into
 *   membership  decide who is on the board
 *
 * `host` and `membership` are separate because their answers differ for the one
 * caller that is neither a person nor absent: a tokenless agent on loopback.
 * It has always had `host` — `skills.addTarget` is how agents declare the repos
 * they install into, and taking that away is a tightening nobody asked for.
 * It has never had `membership`, because those verbs did not exist until now,
 * so there is no status quo to preserve and an agent that could approve
 * accounts would be an agent that could let anyone in.
 *
 * A ROLE IS A SET OF THESE, not a rank with special cases (see ALLOWED).
 *
 * ## Default deny, and a test that stops it being silent
 *
 * A method with no entry here requires `owner` — `capabilityOf` says so. That
 * is the safe direction: a new verb that nobody classified must not be readable
 * by everyone, it must be unreachable by almost everyone. But an unclassified
 * verb is still a BUG, because it locks out editors who should have it, so
 * `smoke-accounts.mjs` asserts every registry key appears here. Runtime is safe;
 * the test is what stops the safety being load-bearing.
 */
type Capability = 'read' | 'annotate' | 'write' | 'host' | 'membership'

const CAPABILITY: Record<string, Capability> = {
  // ---- read: looking at the board -----------------------------------------
  'projects.list': 'read',
  'projects.get': 'read',
  'graph.get': 'read',
  'nodes.list': 'read',
  'nodes.get': 'read',
  'nodes.getContent': 'read',
  'nodes.diff': 'read',
  'edges.get': 'read',
  'warps.list': 'read',
  'backlog.list': 'read',
  'scope.get': 'read',
  'impact.get': 'read',
  'fog.get': 'read',
  'fog.node': 'read',
  'commons.list': 'read',
  'activity.list': 'read',
  'search.run': 'read',
  'document.build': 'read',
  // Exporting a project is a READ, for the same reason building a document is:
  // it copies rows and bodies out and writes nothing back. That the copy happens
  // to be round-trippable is a property of the FORMAT, not a privilege — so this
  // is not `host`, and a viewer who may read the board may take a copy of it.
  // The board already decided this: export is the escape hatch that keeps "your
  // words are yours" true, and an escape hatch only the owner can reach is not
  // one.
  'projects.export': 'read',
  'settings.get': 'read',
  // Reading skills is reading the board — a skill IS a node. Rendering and
  // diffing only compute; they touch no disk.
  'skills.list': 'read',
  'skills.render': 'read',
  'skills.read': 'read',
  'skills.diff': 'read',
  'skills.targets': 'read',
  // Pointing at something is how a person says "look at this" to the room. It
  // moves a view and changes nothing.
  'ui.focus': 'read',

  // ---- annotate: joining the conversation ---------------------------------
  // Comments and review observations are a RESPONSE to the board, not authorship
  // of it. A board you cannot answer back to is a document, not a canvas.
  'nodes.annotate': 'annotate',
  'edges.annotate': 'annotate',
  // Deleting an annotation is left at `write` deliberately: this layer cannot
  // see whose comment it is, and "a viewer may delete comments" is a worse
  // default than "a viewer may not". Revisit when authorship is checked.

  // ---- write: changing what the board says --------------------------------
  'projects.create': 'write',
  'projects.update': 'write',
  'projects.delete': 'write',
  // Importing a project writes nodes, edges and markdown — the same things
  // nodes.create writes, in bulk and in one transaction. It is NOT `host`: it
  // touches nothing outside the vault, takes no path from the caller (paths are
  // rebuilt from sanitised titles inside a folder this side chooses), and
  // configures nothing about the machine. An editor who may create a node may
  // bring one in.
  'projects.import': 'write',
  'nodes.create': 'write',
  'nodes.update': 'write',
  'nodes.delete': 'write',
  'nodes.setContent': 'write',
  'nodes.complete': 'write',
  'nodes.prune': 'write',
  'nodes.refer': 'write',
  'nodes.share': 'write',
  'nodes.unshare': 'write',
  'nodes.reference': 'write',
  'nodes.fork': 'write',
  'nodes.waive': 'write',
  'nodes.unwaive': 'write',
  'nodes.fold': 'write',
  'nodes.unfold': 'write',
  'nodes.pass': 'write',
  'nodes.answer': 'write',
  'nodes.convert': 'write',
  'nodes.designate': 'write',
  'nodes.requestSweep': 'write',
  'annotations.delete': 'write',
  'edges.create': 'write',
  'edges.update': 'write',
  'edges.delete': 'write',
  'edges.addRelationship': 'write',
  'edges.updateRelationship': 'write',
  'edges.removeRelationship': 'write',
  'warps.addMember': 'write',
  'warps.removeMember': 'write',
  /**
   * `settings.update` is WRITE, not owner — and the split is by FIELD rather
   * than by verb, because one call carries two different kinds of thing.
   *
   * Most of it is the board: the highlight rules every node renders through,
   * node colours and shapes, type order. Editors and agents change those as
   * ordinary work, and classifying the verb as owner-only broke 74 checks in
   * the agent suite the moment it landed — which is the suite doing its job.
   *
   * The HOST-MACHINE fields inside it — the vault path and the API port —
   * are refused to anyone but the owner, in the handler below, where the
   * payload can actually be looked at. That is the same shape `skillTargets`
   * already had: the verb is reachable, the dangerous field is not.
   */
  'settings.update': 'write',
  'skills.install': 'write',
  'skills.uninstall': 'write',
  'skills.import': 'write',
  'skills.adopt': 'write',

  // ---- membership: who is on the board ------------------------------------
  'accounts.list': 'membership',
  'accounts.approve': 'membership',
  'accounts.reject': 'membership',
  'accounts.setRole': 'membership',
  // Skill TARGETS are an allowlist of filesystem roots the installer writes
  // into: the nearest thing this app has to a privileged operation.
  'skills.addTarget': 'host',
  'skills.removeTarget': 'host',
  'skills.setTargetEnabled': 'host',

  // OPEN_METHODS are listed so the completeness test can see them, and are
  // never consulted — authorise() returns before capability is asked for.
  'session.current': 'read',
  'session.request': 'read',
  'session.signOut': 'read',
  'app.info': 'read',

  // ---- host: the machine, not the board -----------------------------------
  // Workspaces are the most host-shaped state there is, and unlike vaultPath a
  // workspace can carry a stored CREDENTIAL for a remote core. So these are
  // `host` AND guarded to atTheMachine in their handlers — not even a tokenless
  // loopback agent gets them. There is no status quo to preserve (the verbs are
  // new), which is the same reasoning that made membership owner-only.
  // Closing a board is not a change to what it SAYS — nothing in it moves — so
  // it is not `write`, and an editor signed in from elsewhere should not be able
  // to shut the board for everyone. It is `host` for the same reason skill
  // targets are: at the machine, or a loopback agent acting for whoever is.
  'board.lock': 'host',
  'board.unlock': 'host',
  'workspaces.list': 'host',
  'workspaces.create': 'host',
  'workspaces.remove': 'host',
  'workspaces.activate': 'host',
  'workspaces.probe': 'host'
}

/**
 * Some verbs are not about the board at all, and no role should reach them from
 * off-box. `atTheMachine` is true only for the desktop renderer, in the process
 * that owns the database — see the gate below.
 */
function atTheMachineOnly(c: Ctx, method: string): void {
  if (!c.atTheMachine) {
    throw new svc.ApiError(
      `${method} configures the app on this machine, not the board. ` +
        'It is available in the desktop app, at that machine.',
      403
    )
  }
}

/**
 * ADMINS DECIDE ABOUT VIEWERS AND EDITORS; THE OWNER DECIDES ABOUT ADMINS.
 *
 * The capability table answers "may you run the guest list at all". This answers
 * "about whom", and the two are separate because promoting someone to your own
 * level is not a larger version of approving them — it is the step that turns
 * one borrowed display name into unlimited membership control.
 *
 * While a name is asserted rather than proved, an admin account is exactly as
 * private as the name written on it. So an admin decides about people who
 * cannot in turn decide about anyone, and the one account whose name cannot be
 * borrowed over the wire — the owner — decides about the admins.
 */
function assertMayDecideAbout(c: Ctx, targetId: string, granting?: AccountRole): void {
  // The desktop renderer is served as the owner (see sessionInfo), so it lands
  // here as one rather than as an account with no role.
  const callerRole: AccountRole | undefined = c.atTheMachine ? 'owner' : c.account?.role
  if (callerRole === 'owner') return

  const target = accounts().get(targetId)
  if (!target) throw new svc.ApiError('no such account', 404)
  if (target.isOwner) {
    throw new svc.ApiError('the board owner is not an account an admin decides about', 403)
  }
  if (target.role === 'admin') {
    throw new svc.ApiError(
      `another admin is the owner's decision — a display name is asserted rather than proved, so an admin ` +
        `who could appoint admins would turn one borrowed name into the whole guest list`,
      403
    )
  }
  if (granting && !rolesGrantableBy(callerRole).includes(granting)) {
    throw new svc.ApiError(
      `an admin may grant ${rolesGrantableBy(callerRole).join(' or ')} — "${granting}" is the owner's to give`,
      403
    )
  }
}

/** Unclassified means membership — the most restricted. See the note above. */
const capabilityOf = (method: string): Capability => CAPABILITY[method] ?? 'membership'

/**
 * The two verbs that must answer while the board is read-only, or a locked board
 * could never be unlocked and the lock would be a one-way door.
 */
const LOCK_EXEMPT = new Set(['board.lock', 'board.unlock'])

/**
 * A READ-ONLY BOARD REFUSES EVERYTHING BUT READS.
 *
 * Checked before `atTheMachine`, deliberately — unlike every other rule here,
 * which asks whether a caller is trusted enough. This one is not about trust at
 * all: the board is closed, and the person most likely to edit a board that has
 * moved is the one sitting at it, working from habit. A lock that let the
 * desktop through would miss the case it was built for.
 *
 * It is a WORKFLOW gate, not a security boundary — the same thing the README
 * says about agentsUnauthenticated, and for the same reason: anything that can
 * reach this socket can also rewrite settings.json. It stops the accidental
 * edit and it tells the caller where the board went, which is what it is for.
 */
function refuseIfReadOnly(method: string): void {
  const lock = getBoardLock()
  if (!lock) return
  if (LOCK_EXEMPT.has(method)) return
  if (capabilityOf(method) === 'read') return
  throw new svc.ApiError(lock.message, 403, {
    readOnly: true,
    since: lock.since,
    lockedBy: lock.by,
    // named separately from `message` so a client can render the operator's
    // words without the refusal wrapped around them
    lockMessage: lock.message
  })
}

/**
 * What each role may do. A SET, not a rank: reading the table answers "may a
 * viewer do this" without tracing an ordering, and a future role that is not a
 * superset of an earlier one does not break the model.
 *
 * `owner` is not in any grantable role. Deciding who is on the board is the
 * privilege that lets someone let themselves in, and while a display name is
 * asserted rather than proved, granting it remotely would make every other
 * refusal here decoration. It stays with the account at the machine until a
 * person is authenticated.
 */
const ALLOWED: Record<AccountRole, Set<Capability>> = {
  viewer: new Set<Capability>(['read', 'annotate']),
  editor: new Set<Capability>(['read', 'annotate', 'write']),
  // An admin runs the GUEST LIST, not the machine. `host` is the vault path, the
  // port and the filesystem roots the installer writes into — a remote admin
  // changing those is re-homing somebody else's app, which is the objection that
  // keeps host at the machine regardless of who is asking.
  admin: new Set<Capability>(['read', 'annotate', 'write', 'membership']),
  owner: new Set<Capability>(['read', 'annotate', 'write', 'host', 'membership'])
}

/**
 * What a tokenless caller on loopback gets while the carve-out is on: what it
 * always had, minus membership. Not a role — an agent has no account, so it
 * gets a capability set rather than a label.
 */
const AGENT_CAPABILITIES = new Set<Capability>(['read', 'annotate', 'write', 'host'])

/** Exported so the completeness test can hold the registry against it. */
export const capabilityTable = CAPABILITY
export const roleAllows = (role: AccountRole, method: string): boolean => ALLOWED[role].has(capabilityOf(method))

/** What a client knows about itself. The only honest answer to "who am I". */
function sessionInfo(ctx: Ctx): SessionInfo {
  const provider = accounts()
  const account = ctx.atTheMachine ? provider.ownerAtTheMachine(getSettings().humanName) : ctx.account
  return {
    state: account?.state ?? 'none',
    role: account?.role,
    account,
    provider: provider.name,
    providerLabel: provider.label,
    atTheMachine: !!ctx.atTheMachine,
    agentsUnauthenticated: getSettings().agentsUnauthenticated !== false,
    // session.current is open, so this is how any client — signed in or not —
    // learns the board is closed, instead of finding out one refused write at a
    // time.
    readOnly: getBoardLock()
  }
}

/**
 * Refused for who you are, not for what you asked.
 *
 * A distinct class because the client's response is distinct: it shows the
 * onboarding or waiting screen, rather than a toast. `data.accountState`
 * carries which of the three it is, so the screen does not have to parse the
 * message to find out.
 */
export class NotApprovedError extends svc.ApiError {
  constructor(message: string, status: number, data?: Record<string, unknown>) {
    super(message, status, data)
    this.name = 'NotApprovedError'
  }
}

type Handler = (payload: any, ctx: Ctx) => unknown

let appInfoProvider: () => AppInfo = () => {
  throw new Error('app info not ready')
}

export function setAppInfoProvider(fn: () => AppInfo): void {
  appInfoProvider = fn
}

/**
 * The single method registry. IPC and REST are both thin adapters over this,
 * which is what guarantees human–agent parity.
 */
export const registry: Record<string, Handler> = {
  'projects.list': () => svc.listProjects(),
  'projects.create': (p, c) => svc.createProject(p, c.actor),
  'projects.get': (p) => svc.getProject(p),
  'projects.update': (p, c) => svc.updateProject(p, c.actor),
  'projects.delete': (p, c) => svc.deleteProject(p, c.actor),
  'projects.export': (p) => {
    // Provenance for the bundle header. Informational only — an importer must
    // never trust it, and does not.
    const info = appInfoProvider()
    return exportProject(p as never, {
      app: 'Ozmo Spectre',
      version: info.version,
      exportedFrom: info.apiBase,
      platform: process.platform
    })
  },

  'projects.import': (p, c) => importProject(p as never, c.actor),

  'graph.get': (p) => svc.getGraph(p),

  'nodes.list': (p) => svc.listNodes(p),
  'nodes.create': (p, c) => svc.createNode(p, c.actor),
  'nodes.get': (p) => svc.getNode(p),
  'nodes.update': (p, c) => svc.updateNode(p, c.actor),
  'nodes.delete': (p, c) => svc.deleteNode(p, c.actor),
  'nodes.complete': (p, c) => svc.completeAction(p, c.actor),
  'nodes.prune': (p, c) => svc.pruneNode(p, c.actor),
  // refer — the cross-project handoff: copy this node into another project's graph
  'nodes.refer': (p, c) => svc.referNode(p, c.actor),
  // cross-project sharing: share/unshare publish to the commons (a QUERY, not a
  // project); reference pulls a shared node in as a local read-only node; fork
  // takes an editable copy, which is what makes read-only acceptable
  'nodes.share': (p, c) => svc.shareNode(p, c.actor),
  'nodes.unshare': (p, c) => svc.unshareNode(p, c.actor),
  'nodes.reference': (p, c) => svc.addReference(p, c.actor),
  'nodes.fork': (p, c) => svc.forkNode(p, c.actor),
  'commons.list': (p) => svc.listCommons(p),
  // waive — feedback's terminal verb. `fold` was its name until faykarta settled
  // the room's vocabulary; both spellings stay routed so nothing in flight breaks.
  'nodes.waive': (p, c) => svc.waiveNode(p, c.actor),
  'nodes.unwaive': (p, c) => svc.unwaiveNode(p, c.actor),
  'nodes.fold': (p, c) => svc.waiveNode(p, c.actor),
  'nodes.unfold': (p, c) => svc.unwaiveNode(p, c.actor),
  // coverage + designation in one gesture, for a member of an increment
  'nodes.pass': (p, c) => svc.passNode(p, c.actor),
  'nodes.answer': (p, c) => svc.answerQuestion(p, c.actor),
  'nodes.convert': (p, c) => svc.convertNode(p, c.actor),
  // The review room's one gesture: what a note IS, and when it gets done.
  'nodes.designate': (p, c) => svc.designateNode(p, c.actor),
  'nodes.requestSweep': (p, c) => svc.requestSweep(p, c.actor),
  'nodes.getContent': (p) => svc.getContent(p),
  'nodes.setContent': (p, c) => svc.setContent(p, c.actor),
  'nodes.diff': (p) => svc.nodeDiff(p),
  'nodes.annotate': (p, c) => svc.addAnnotation(p, c.actor),
  'annotations.delete': (p, c) => svc.deleteAnnotation(p, c.actor),

  'edges.create': (p, c) => svc.createEdge(p, c.actor),
  'edges.get': (p) => svc.getEdge(p),
  'edges.update': (p, c) => svc.updateEdge(p, c.actor),
  'edges.delete': (p, c) => svc.deleteEdge(p, c.actor),
  'edges.annotate': (p, c) => svc.addEdgeAnnotation(p, c.actor),
  'edges.addRelationship': (p, c) => svc.addEdgeRelationship(p, c.actor),
  'edges.updateRelationship': (p, c) => svc.updateEdgeRelationship(p, c.actor),
  'edges.removeRelationship': (p, c) => svc.removeEdgeRelationship(p, c.actor),

  'warps.list': (p) => svc.listWarps(p),
  'warps.addMember': (p, c) => svc.addWarpMember(p, c.actor),
  'warps.removeMember': (p, c) => svc.removeWarpMember(p, c.actor),

  'backlog.list': (p) => svc.listBacklog(p),

  'scope.get': (p) => svc.getScope(p),

  // the whole graph, a container, a selection or a query — flattened into ONE
  // markdown document. One generator; IPC, REST and the vault write all adapt to it.
  'document.build': (p) => buildDocument(p as never),
  'impact.get': (p) => svc.getImpact(p),
  // FOG — the third district lens beside scope (what is here) and impact (what
  // breaks): what is still UNABSORBED here. Same resolution predicate as the
  // ship gate, so fog and the gate can never disagree about "settled".
  'fog.get': (p) => fog.getFog(p),
  'fog.node': (p) => fog.getNodeFog(p),

  // reviews are NODES now — nodes.create type review, nodes.waive, nodes.pass,
  // nodes.requestSweep; the review-table methods retired with the review-nodes
  // migration

  // SKILLS — the node is the original, `.claude/skills/<slug>/SKILL.md` is a
  // build output. `skills.list` is one call the page renders from and, like
  // commons.list, is a cross-project QUERY when projectId is omitted.
  // Targets cross the wire as IDS ONLY; addTarget/removeTarget are the only
  // write path for the allowlist (PATCH /api/settings refuses skillTargets).
  'skills.targets': () => skills.listTargets(),
  'skills.list': (p) => skills.listSkills(p),
  'skills.render': (p) => skills.renderSkillById(p),
  'skills.read': (p) => skills.readInstalled(p),
  'skills.diff': (p) => skills.diffSkill(p),
  'skills.install': (p, c) => skills.installSkill(p, c.actor),
  'skills.uninstall': (p, c) => skills.uninstallSkill(p, c.actor),
  'skills.import': (p, c) => skills.importSkill(p, c.actor),
  // adopt is the non-destructive resolution for `modified`: the disk edit wins
  // and the node learns it, instead of force throwing the human's work away
  'skills.adopt': (p, c) => skills.adoptSkill(p, c.actor),
  'skills.addTarget': (p, c) => skills.addTarget(p, c.actor),
  // a disabled target is still LISTED (the Settings card renders it) but is
  // never scanned, never drifted against and never written to
  'skills.setTargetEnabled': (p, c) => skills.setTargetEnabled(p, c.actor),
  'skills.removeTarget': (p, c) => skills.removeTarget(p, c.actor),

  'activity.list': (p) => svc.listActivity(p),
  'search.run': (p) => svc.search(p),

  /**
   * TRIMMED unless the caller is approved. The full payload carries the vault
   * path and the owner's display name — that is board data wearing a different
   * hat, and the whole point of the gate is that an unapproved viewer gets
   * none of it. What survives is what a client needs to render an onboarding
   * screen: which app, which version, where it is.
   */
  'app.info': (_p, c) => {
    const full = appInfoProvider()
    if (c.atTheMachine || c.account?.state === 'approved') return full
    return { version: full.version, port: full.port, apiBase: full.apiBase, vaultPath: '', humanName: '', platform: '' }
  },

  // ---- onboarding -------------------------------------------------------
  // Open methods. `session.current` is what every client asks first, and it is
  // the only thing an unapproved viewer ever gets a real answer to.
  'session.current': (_p, c) => sessionInfo(c),
  'session.request': (p, c) => {
    const issued = accounts().request((p as { displayName?: string })?.displayName ?? '', c.actor || 'client')
    return { token: issued.token, session: sessionInfo({ ...c, account: issued.account, hasSession: true }) }
  },
  'session.signOut': (p, c) => {
    const token = (p as { token?: string })?.token
    if (token) accounts().revoke(token)
    return { ok: true, session: sessionInfo({ ...c, account: undefined, hasSession: false }) }
  },

  // ---- who is on the board (owner only; enforced in authorise) ----------
  'accounts.list': () => accounts().list(),
  'accounts.approve': (p, c) => {
    const id = (p as { id: string }).id
    assertMayDecideAbout(c, id)
    return accounts().approve(id, c.actor)
  },
  'accounts.reject': (p, c) => {
    const id = (p as { id: string }).id
    assertMayDecideAbout(c, id)
    return accounts().reject(id, c.actor, (p as { note?: string })?.note)
  },
  'accounts.setRole': (p, c) => {
    const id = (p as { id: string }).id
    const role = (p as { role: AccountRole }).role
    assertMayDecideAbout(c, id, role)
    return accounts().setRole(id, role, c.actor)
  },

  /**
   * Close the board, and say where it went.
   *
   * The message is required rather than optional. The reason this verb exists is
   * a board that has MOVED, and a refusal reading only "read-only" leaves the
   * caller — very often an agent with no human beside it — to work out where to
   * go next. There is no useful default for that sentence, so it is asked for.
   */
  'board.lock': (p, c) => {
    const raw = (p as { message?: unknown })?.message
    const message = typeof raw === 'string' ? raw.trim() : ''
    if (!message) {
      throw new svc.ApiError(
        'board.lock needs a message. It is shown verbatim in every refusal, so say where the board moved ' +
          'and what to do instead — e.g. "Moved to http://127.0.0.1:4821/app — edit there."',
        400
      )
    }
    if (message.length > 500) {
      throw new svc.ApiError('that message is too long (max 500 characters)', 400)
    }
    const lock = { since: Date.now(), message, by: c.actor }
    setBoardLock(lock)
    emitEvent('board.locked', undefined, lock, c.actor)
    console.log(`[ozmo] board LOCKED by ${c.actor} — ${message}`)
    return { readOnly: lock }
  },

  'board.unlock': (_p, c) => {
    const was = getBoardLock()
    setBoardLock(null)
    emitEvent('board.unlocked', undefined, { was }, c.actor)
    console.log(`[ozmo] board unlocked by ${c.actor}`)
    return { readOnly: null, wasLocked: !!was }
  },

  'settings.get': () => getSettings(),
  'settings.update': (p, c) => {
    // The vault path and the API port configure the MACHINE, not the board: one
    // re-homes the app on relaunch, the other moves the port every agent is
    // pointed at. A remote caller changing either is not a smaller version of
    // editing a highlight rule.
    const HOST_FIELDS = ['vaultPath', 'apiPort', 'humanName']
    const touched = HOST_FIELDS.filter((f) => p && typeof p === 'object' && f in (p as object))
    // A tokenless agent keeps this, as above. A signed-in person over the
    // network does not, whatever their role: re-homing the vault or moving the
    // port is not a smaller version of editing a highlight rule.
    const trustedWithTheMachine = c.atTheMachine || c.account?.isOwner || (!c.account && !c.hasSession)
    if (touched.length > 0 && !trustedWithTheMachine) {
      throw new svc.ApiError(
        `${touched.join(' and ')} configure the machine this board runs on, not the board. ` +
          'They are changed in the desktop app, at that machine.',
        403,
        { hostFields: touched }
      )
    }
    const res = updateSettings(p)
    // flag rules live in settings and shape every graph payload — tell the
    // renderer (and SSE listeners) so open views recompute without a relaunch
    emitEvent('settings.updated', undefined, res.settings, c.actor)
    return res
  },

  // WORKSPACES — where the board is, asked before who you are.
  //
  // Refused to anything but the desktop renderer. A caller who could add a
  // workspace could re-point somebody's app at a core they control, or read back
  // a board they were never on; a caller who could remove one could strand it.
  // A served instance answers none of these: a container is a core, not a
  // chooser, and its registry has no list to give.
  'workspaces.list': (_p, c) => {
    atTheMachineOnly(c, 'workspaces.list')
    return ws.listWorkspaces()
  },
  // Ask a URL whether there is a Spectre behind it, BEFORE it becomes a
  // workspace. A typo saved as a workspace is a workspace that strands you on
  // the next boot; better to fail while the URL is still in a text box.
  'workspaces.probe': async (p, c) => {
    atTheMachineOnly(c, 'workspaces.probe')
    try {
      return await probe(ws.normaliseUrl(String(p?.url ?? '')))
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  },
  'workspaces.create': (p, c) => {
    atTheMachineOnly(c, 'workspaces.create')
    try {
      return ws.createWorkspace(p ?? {})
    } catch (e) {
      throw new svc.ApiError(e instanceof Error ? e.message : String(e), 400)
    }
  },
  'workspaces.remove': (p, c) => {
    atTheMachineOnly(c, 'workspaces.remove')
    try {
      return ws.removeWorkspace(String(p?.id ?? ''))
    } catch (e) {
      throw new svc.ApiError(e instanceof Error ? e.message : String(e), 404)
    }
  },
  'workspaces.activate': async (p, c) => {
    atTheMachineOnly(c, 'workspaces.activate')
    let res: { workspace: unknown; relaunchRequired: boolean }
    try {
      res = ws.activateWorkspace(String(p?.id ?? ''))
    } catch (e) {
      throw new svc.ApiError(e instanceof Error ? e.message : String(e), 404)
    }
    // Switch IN PLACE. This used to answer `relaunchRequired` and let the
    // renderer call app.relaunch(), which under electron-vite dev orphaned the
    // app from its own renderer server and left a black window in front of a
    // perfectly healthy core. Nothing about the switch needed a new process.
    if (res.relaunchRequired) await switchWorkspace()
    return { ...res, relaunchRequired: false }
  },

  'ui.focus': (p, c) => {
    emitEvent('ui.focus', p?.projectId, p, c.actor)
    return { ok: true }
  }
}

/**
 * THE GATE — one place, because a gate applied per route is a gate with a hole
 * in it the first time somebody adds a route.
 *
 * Three ways through, in order:
 *
 *  1. **At the machine.** The desktop renderer, in the process that owns the
 *     database. Standing requirement: an existing single-user board keeps
 *     working without anyone logging in.
 *  2. **An approved account.** A session token that resolves to `approved`.
 *     Pending and rejected are refused with their state, so the client can
 *     show the waiting screen rather than an error.
 *  3. **An agent with no session**, while `agentsUnauthenticated` is on. Every
 *     agent in the fleet is one of these today and the standing requirement is
 *     that they remain first-class. This is the carve-out, and it is named
 *     rather than implied: while it is on, THE GATE IS A WORKFLOW GATE AND NOT
 *     A SECURITY BOUNDARY. The boundary is the loopback bind.
 */
export function authorised(method: string, ctx: Ctx): void {
  authorise(method, ctx)
}

function authorise(method: string, ctx: Ctx): void {
  // OPEN_METHODS stay open even when locked: signing in and asking what this
  // board is are how a caller DISCOVERS the lock rather than meeting it as a
  // wall of refusals.
  if (OPEN_METHODS.has(method)) return
  refuseIfReadOnly(method)
  if (ctx.atTheMachine) return

  if (ctx.account) {
    if (ctx.account.state !== 'approved') {
      throw new NotApprovedError(
        ctx.account.state === 'pending'
          ? `"${ctx.account.displayName}" is waiting to be approved.`
          : `"${ctx.account.displayName}" was not approved for this board.`,
        403,
        { accountState: ctx.account.state, displayName: ctx.account.displayName }
      )
    }
    const need = capabilityOf(method)

    // Belt and braces with account-local's refusal to issue an owner session
    // over the wire: deciding who is on the board happens at the machine that
    // holds it. Two checks because they fail differently — that one stops the
    // owner's name being CLAIMED, this one stops an owner session being USED
    // from somewhere else if a future provider ever issues one.
    // `host` is refused to EVERY network caller, the owner included. It is the
    // machine's configuration — vault path, port, the roots the skill installer
    // writes into — and re-homing an app from somewhere else is not a smaller
    // version of using it.
    //
    // `membership` WAS refused here too, and is not any more. A board served to
    // people needs somebody who can let them in, and a container has no caller
    // that is ever `atTheMachine` to be that somebody: a joiner on a served
    // board waited forever, which made invitations a feature that only worked on
    // a desktop. It now falls through to the role check, which grants it to
    // `admin` and `owner` and to nobody else.
    //
    // What that deliberately does NOT open: the owner's name still cannot be
    // claimed over the wire (account-local), `owner` still cannot be granted
    // (setRole), and an admin still cannot make another admin. The step that
    // would let someone let themselves in stays off-box.
    if (need === 'host') {
      throw new svc.ApiError(
        'how the machine running this board is configured is decided at that machine, in the desktop app',
        403
      )
    }

    if (!roleAllows(ctx.account.role, method)) {
      throw new svc.ApiError(
        `"${ctx.account.displayName}" has ${ctx.account.role} access to this board, which does not include ` +
          `${need === 'write' ? 'changing what it says' : 'this'}. Ask the owner for editor access.`,
        403,
        { role: ctx.account.role, needed: need }
      )
    }
    return
  }

  // A caller that PRESENTED a token which did not resolve is not an agent — it
  // is a person holding something stale. Say so, so the client clears it and
  // shows onboarding instead of looping on a refusal it cannot explain.
  if (ctx.hasSession) {
    throw new NotApprovedError('that session is no longer valid — sign in again.', 401, { accountState: 'none' })
  }

  if (getSettings().agentsUnauthenticated !== false) {
    // An agent keeps exactly what it had: the board AND the machine-facing
    // verbs it has always used to declare where skills install. What it never
    // had, and does not get, is membership — an agent that could approve
    // accounts is an agent that could let anyone in.
    if (!AGENT_CAPABILITIES.has(capabilityOf(method))) {
      throw new svc.ApiError('only the board owner decides who is on the board, at the machine it runs on', 403)
    }
    return
  }

  throw new NotApprovedError('this board requires an approved display name.', 401, { accountState: 'none' })
}

export function call(method: string, payload: unknown, ctx: Ctx): unknown {
  const handler = registry[method]
  if (!handler) throw new svc.ApiError(`unknown method "${method}"`, 404)
  authorise(method, ctx)
  return handler(payload ?? {}, ctx)
}

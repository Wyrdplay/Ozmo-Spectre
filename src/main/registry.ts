import * as svc from './services'
import * as fog from './fog'
import { accounts, type Account } from './account'
import * as skills from './skills'
import { buildDocument } from './document'
import { getSettings, updateSettings } from './settings'
import { emitEvent } from './events'
import type { AppInfo, SessionInfo } from '@shared/types'

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

/** Owner-only. Deciding who is on the board is not a thing being on the board grants. */
const OWNER_METHODS = new Set(['accounts.list', 'accounts.approve', 'accounts.reject'])

/** What a client knows about itself. The only honest answer to "who am I". */
function sessionInfo(ctx: Ctx): SessionInfo {
  const provider = accounts()
  const account = ctx.atTheMachine ? provider.ownerAtTheMachine(getSettings().humanName) : ctx.account
  return {
    state: account?.state ?? 'none',
    account,
    provider: provider.name,
    providerLabel: provider.label,
    atTheMachine: !!ctx.atTheMachine,
    agentsUnauthenticated: getSettings().agentsUnauthenticated !== false
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
  'accounts.approve': (p, c) => accounts().approve((p as { id: string }).id, c.actor),
  'accounts.reject': (p, c) => accounts().reject((p as { id: string }).id, c.actor, (p as { note?: string })?.note),

  'settings.get': () => getSettings(),
  'settings.update': (p, c) => {
    const res = updateSettings(p)
    // flag rules live in settings and shape every graph payload — tell the
    // renderer (and SSE listeners) so open views recompute without a relaunch
    emitEvent('settings.updated', undefined, res.settings, c.actor)
    return res
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
  if (OPEN_METHODS.has(method)) return
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
    // Belt and braces with account-local's refusal to issue an owner session
    // over the wire: deciding who is on the board happens at the machine that
    // holds it. Two checks because they fail differently — that one stops the
    // owner's name being CLAIMED, this one stops an owner session being USED
    // from somewhere else if a future provider ever issues one.
    if (OWNER_METHODS.has(method)) {
      throw new svc.ApiError(
        'who is on this board is decided at the machine it runs on, in the desktop app — not over the network',
        403
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
    if (OWNER_METHODS.has(method)) {
      throw new svc.ApiError('only the board owner decides who is on the board', 403)
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

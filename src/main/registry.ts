import * as svc from './services'
import * as skills from './skills'
import { buildDocument } from './document'
import { getSettings, updateSettings } from './settings'
import { emitEvent } from './events'
import type { AppInfo } from '@shared/types'

export interface Ctx {
  actor: string
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

  'app.info': () => appInfoProvider(),
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

export function call(method: string, payload: unknown, ctx: Ctx): unknown {
  const handler = registry[method]
  if (!handler) throw new svc.ApiError(`unknown method "${method}"`, 404)
  return handler(payload ?? {}, ctx)
}

/* End-to-end smoke test against a running Ozmo Spec Engine (npm run dev first).
   Exercises the full agent surface: projects, nodes, content, edges, warps,
   annotations, reviews, activity, search, events. Cleans up after itself. */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const BASE = process.env.OZMO_BASE ?? 'http://127.0.0.1:4820'
const H = { 'Content-Type': 'application/json', 'X-Actor': 'smoke-agent' }

let failures = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const req = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

// connections carry typed relationships; these read them off edge payloads
const rels = (e) => e?.relationships ?? []
const hasRel = (e, type) => rels(e).some((r) => r.type === type)
const relOf = (e, type) => rels(e).find((r) => r.type === type)
const connWith = (edges, type) => (edges ?? []).find((e) => hasRel(e, type))

console.log(`smoke → ${BASE}`)

// health + docs
{
  const { status, json } = await req('GET', '/api/health')
  ok('health', status === 200 && json.ok === true)
  const llms = await req('GET', '/llms.txt')
  ok('llms.txt served', llms.status === 200 && String(llms.json).includes('Agent Guide'))
  ok('llms.txt teaches tags + flags', String(llms.json).includes('State is TAGS') && String(llms.json).includes('FLAGS'))
  const disco = await req('GET', '/api')
  ok('discovery', disco.status === 200 && Array.isArray(disco.json.resources))
}

// events: subscribe and collect
const events = []
const ac = new AbortController()
fetch(`${BASE}/api/events`, { signal: ac.signal }).then(async (res) => {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n\n')) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6)).type) } catch { /* partial */ }
      }
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
  }
}).catch(() => undefined)

// project lifecycle
const proj = await req('POST', '/api/projects', { name: 'Smoke Run', description: 'temp project from smoke test' })
ok('project create', proj.status === 200 && proj.json.id, JSON.stringify(proj.json))
const pid = proj.json.id

const pillar = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'pillar', title: 'Fast Feedback', content: '## Why\n\nSlow loops kill momentum.\n', tags: ['culture']
})
ok('pillar create', pillar.status === 200 && pillar.json.type === 'pillar')

const feat = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Hot Reload', tags: ['dx', 'mvp', 'designed'], content: '## Summary\n\nReload on save.\n'
})
ok('feature create (state in tags)', feat.status === 200 && feat.json.tags.includes('designed') && feat.json.status === undefined)

// status is dead: create, PATCH and list-filter all 400 with a pointer to tags
const stCreate400 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'X', status: 'building' })
ok('status on create 400 + pointer', stCreate400.status === 400 &&
  String(stCreate400.json.error?.message ?? '').includes('tags'), JSON.stringify(stCreate400.json))
const stPatch400 = await req('PATCH', `/api/nodes/${feat.json.id}`, { status: 'done' })
ok('status on PATCH 400 + pointer', stPatch400.status === 400 &&
  String(stPatch400.json.error?.message ?? '').includes('tags'))
const stFilter400 = await req('GET', `/api/projects/${pid}/nodes?status=done`)
ok('?status= filter 400 + pointer', stFilter400.status === 400 &&
  String(stFilter400.json.error?.message ?? '').includes('tags'))

const sub = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'CSS Hot Swap' })
ok('subfeature create', sub.status === 200)

const bug = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Reload loses scroll' })
ok('bug create', bug.status === 200)

// edges — connections with typed relationships
const shapes = await req('POST', `/api/projects/${pid}/edges`, { sourceId: pillar.json.id, targetId: feat.json.id, type: 'shapes' })
ok('shapes connection', shapes.status === 200 && hasRel(shapes.json, 'shapes'))
const derives = await req('POST', `/api/projects/${pid}/edges`, { sourceId: feat.json.id, targetId: sub.json.id, type: 'derives', label: 'split out' })
ok('derives connection + label', derives.status === 200 && derives.json.label === 'split out' &&
  relOf(derives.json, 'derives')?.sourceId === feat.json.id)
const dupe = await req('POST', `/api/projects/${pid}/edges`, { sourceId: feat.json.id, targetId: sub.json.id, type: 'derives' })
ok('duplicate relationship type 409', dupe.status === 409)
ok('409 body carries the connection', dupe.json.error?.connection?.id === derives.json.id, JSON.stringify(dupe.json))
const selfLoop = await req('POST', `/api/projects/${pid}/edges`, { sourceId: feat.json.id, targetId: feat.json.id })
ok('self-loop rejected', selfLoop.status === 400)

const edgeAnn = await req('POST', `/api/edges/${derives.json.id}/annotations`, { body: 'split for independent shipping' })
ok('edge annotation', edgeAnn.status === 200 && edgeAnn.json.author === 'smoke-agent')

// content round-trip
const put = await req('PUT', `/api/nodes/${feat.json.id}/content`, { content: '## Summary\n\nReload on save, under 100ms.\n\n## Acceptance\n\n- [ ] sub-100ms\n' })
ok('content PUT', put.status === 200)
const got = await req('GET', `/api/nodes/${feat.json.id}`)
ok('content round-trip', got.json.content?.includes('under 100ms'))
ok('node detail edges', Array.isArray(got.json.edges) && got.json.edges.length === 2)

// annotate + tags + progress
const ann = await req('POST', `/api/nodes/${feat.json.id}/annotations`, { body: 'measured 80ms in prototype' })
ok('node annotation', ann.status === 200)
const patch = await req('PATCH', `/api/nodes/${feat.json.id}`, { progress: 40, tags: ['dx', 'mvp', 'perf', 'building'] })
ok('node patch', patch.status === 200 && patch.json.progress === 40 && patch.json.tags.includes('perf'))
{
  // tag replacement is logged by name: +added -removed
  const acts = await req('GET', `/api/projects/${pid}/activity?limit=20`)
  ok('tag change logged by name', acts.json.some((a) => a.summary.includes('tags +perf +building -designed')),
    JSON.stringify(acts.json.filter((a) => a.action === 'node.updated').map((a) => a.summary)))
}

// rename → file moves
const rename = await req('PATCH', `/api/nodes/${sub.json.id}`, { title: 'CSS Hot Swap v2' })
ok('rename', rename.status === 200 && rename.json.filePath.includes('CSS Hot Swap v2'))

// warp flow — a warp's lifecycle is its stage, no tags needed
const warp = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'Warp α', content: '## Goal\n\nShip hot reload.\n' })
ok('warp create', warp.status === 200)
const m1 = await req('POST', `/api/warps/${warp.json.id}/members`, { nodeId: feat.json.id })
const m2 = await req('POST', `/api/warps/${warp.json.id}/members`, { nodeId: bug.json.id })
ok('warp members', m1.status === 200 && m2.status === 200)
const warps = await req('GET', `/api/projects/${pid}/warps`)
const w = warps.json.find((x) => x.warp.id === warp.json.id)
ok('warp rollup', w && w.members.length === 2 && typeof w.progress === 'number', JSON.stringify(w?.progress))
const badMember = await req('POST', `/api/warps/${feat.json.id}/members`, { nodeId: bug.json.id })
ok('member must target warp', badMember.status === 400)

// graph
const graph = await req('GET', `/api/projects/${pid}/graph`)
ok('graph payload', graph.json.nodes.length === 5 && graph.json.edges.length === 4)
const warpNode = graph.json.nodes.find((n) => n.id === warp.json.id)
ok('computed warp progress', typeof warpNode.progressComputed === 'number' && warpNode.progressComputed > 0)
ok('graph nodes carry flags[]', graph.json.nodes.every((n) => Array.isArray(n.flags)),
  JSON.stringify(graph.json.nodes.map((n) => [n.title, n.flags])))
ok('graph nodes carry no status', graph.json.nodes.every((n) => n.status === undefined))

// addresses relationships: warp → the thing it is aimed at
const addr = await req('POST', `/api/projects/${pid}/edges`, { sourceId: warp.json.id, targetId: sub.json.id, type: 'addresses' })
ok('addresses connection (warp → node)', addr.status === 200 && hasRel(addr.json, 'addresses'))
const badAddr = await req('POST', `/api/projects/${pid}/edges`, { sourceId: feat.json.id, targetId: bug.json.id, type: 'addresses' })
ok('addresses must start at warp', badAddr.status === 400)
const warp2 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'Warp β' })
const badAddrTgt = await req('POST', `/api/projects/${pid}/edges`, { sourceId: warp.json.id, targetId: warp2.json.id, type: 'addresses' })
ok('addresses must target a non-warp', badAddrTgt.status === 400)
const graphAddr = await req('GET', `/api/projects/${pid}/graph`)
ok('addresses in graph payload', graphAddr.json.edges.some((e) => e.id === addr.json.id && hasRel(e, 'addresses')))

// warp stages: the pipeline field, warps only
ok('warp stage defaults to concept', warp.json.stage === 'concept', JSON.stringify(warp.json.stage))
const stImpl = await req('PATCH', `/api/nodes/${warp.json.id}`, { stage: 'implement' })
ok('stage PATCH accepted', stImpl.status === 200 && stImpl.json.stage === 'implement')
const stFeat = await req('PATCH', `/api/nodes/${feat.json.id}`, { stage: 'implement' })
ok('stage on a non-warp rejected', stFeat.status === 400)
const stBad = await req('PATCH', `/api/nodes/${warp.json.id}`, { stage: 'landing' })
ok('invalid stage rejected', stBad.status === 400)
const stCreate = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'Warp γ', stage: 'design' })
ok('create with explicit stage', stCreate.status === 200 && stCreate.json.stage === 'design')
const stCreateBad = await req('POST', `/api/projects/${pid}/nodes`, { type: 'idea', title: 'Staged idea', stage: 'design' })
ok('stage on non-warp create rejected', stCreateBad.status === 400)
const wl = await req('GET', `/api/projects/${pid}/warps`)
ok('stage in warp summaries', wl.json.find((x) => x.warp.id === warp.json.id)?.warp.stage === 'implement')

// warp progress precedence: explicit > member roll-up (while members exist) > stage-implied
await req('PATCH', `/api/nodes/${warp2.json.id}`, { stage: 'test' })
let g2 = await req('GET', `/api/projects/${pid}/graph`)
const gNode = (id) => g2.json.nodes.find((n) => n.id === id)
ok('memberless warp progress from stage', gNode(warp2.json.id)?.progressComputed === 70,
  JSON.stringify(gNode(warp2.json.id)?.progressComputed))
ok('member roll-up beats stage', gNode(warp.json.id)?.progressComputed === 20,
  JSON.stringify(gNode(warp.json.id)?.progressComputed))
await req('PATCH', `/api/nodes/${warp2.json.id}`, { progress: 33 })
g2 = await req('GET', `/api/projects/${pid}/graph`)
ok('explicit progress beats stage', gNode(warp2.json.id)?.progressComputed === 33)
await req('PATCH', `/api/nodes/${warp2.json.id}`, { progress: null })
g2 = await req('GET', `/api/projects/${pid}/graph`)
ok('cleared progress falls back to stage', gNode(warp2.json.id)?.progressComputed === 70)

// the review tables are RETIRED — the Review STAGE is the review; old routes 410 with a pointer
{
  const r410a = await req('POST', `/api/projects/${pid}/reviews`, { title: 'nope' })
  ok('old reviews route 410 + stage pointer', r410a.status === 410 &&
    String(r410a.json.error?.message ?? '').includes('stage'), JSON.stringify(r410a.json))
  const r410b = await req('PATCH', '/api/review-items/ri_whatever', { status: 'applied' })
  ok('old review-items route 410', r410b.status === 410)
}

// search + activity
const found = await req('GET', `/api/search?projectId=${pid}&q=100ms`)
ok('content search', found.json.contentMatches?.some((m) => m.nodeId === feat.json.id), JSON.stringify(found.json))
const act = await req('GET', `/api/projects/${pid}/activity`)
ok('activity log', act.json.length > 10 && act.json.every((a) => a.actor))
ok('actor attribution', act.json.some((a) => a.actor === 'smoke-agent'))

// backlog: unassigned work not matching the Done flag rule, ordered by rank
const blq = await req('POST', `/api/projects/${pid}/nodes`, { type: 'question', title: 'Backlog Q' })
const bli = await req('POST', `/api/projects/${pid}/nodes`, { type: 'idea', title: 'Backlog I' })
const bldone = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Already Shipped', tags: ['done'] })
ok('backlog fixtures', blq.status === 200 && bli.status === 200 && bldone.status === 200)
let bl = await req('GET', `/api/projects/${pid}/backlog`)
let blIds = bl.json.map((n) => n.id)
ok('unassigned feature in backlog', blIds.includes(sub.json.id))
ok('warp member excluded', !blIds.includes(feat.json.id))
ok('done-tagged node excluded (Done rule)', !blIds.includes(bldone.json.id))
ok('pillar excluded', !blIds.includes(pillar.json.id))
const rank1 = await req('PATCH', `/api/nodes/${bli.json.id}`, { rank: 1 })
ok('rank patch', rank1.status === 200 && rank1.json.rank === 1)
await req('PATCH', `/api/nodes/${sub.json.id}`, { rank: 2 })
await req('PATCH', `/api/nodes/${blq.json.id}`, { rank: 2.5 })
bl = await req('GET', `/api/projects/${pid}/backlog`)
blIds = bl.json.map((n) => n.id)
ok('backlog rank order', JSON.stringify(blIds.slice(0, 3)) === JSON.stringify([bli.json.id, sub.json.id, blq.json.id]),
  JSON.stringify(bl.json.map((n) => [n.title, n.rank])))
const rankClear = await req('PATCH', `/api/nodes/${bli.json.id}`, { rank: null })
ok('rank clear', rankClear.status === 200 && rankClear.json.rank === null)
bl = await req('GET', `/api/projects/${pid}/backlog`)
{
  const firstNull = bl.json.findIndex((n) => n.rank == null)
  const lastRanked = bl.json.map((n) => n.rank != null).lastIndexOf(true)
  ok('null ranks sort after ranked', bl.json.some((n) => n.id === bli.json.id && n.rank == null) &&
    (firstNull === -1 || lastRanked < firstNull), JSON.stringify(bl.json.map((n) => [n.title, n.rank])))
}
const badRank = await req('PATCH', `/api/nodes/${bli.json.id}`, { rank: 'high' })
ok('invalid rank rejected', badRank.status === 400)

// warps are backlog rows too — until their STAGE closes them (done | not_needed)
bl = await req('GET', `/api/projects/${pid}/backlog`)
blIds = bl.json.map((n) => n.id)
ok('live warps rank in backlog', blIds.includes(warp.json.id) && blIds.includes(warp2.json.id))
const wRank = await req('PATCH', `/api/nodes/${warp2.json.id}`, { rank: 0 })
bl = await req('GET', `/api/projects/${pid}/backlog`)
ok('warp rankable', wRank.status === 200 && bl.json[0]?.id === warp2.json.id,
  JSON.stringify(bl.json.map((n) => [n.title, n.rank])))
ok('backlog warp carries stage', bl.json[0]?.stage === 'test')
await req('PATCH', `/api/nodes/${warp2.json.id}`, { stage: 'done' })
bl = await req('GET', `/api/projects/${pid}/backlog`)
ok('done-stage warp leaves backlog', !bl.json.some((n) => n.id === warp2.json.id))
await req('PATCH', `/api/nodes/${warp2.json.id}`, { stage: 'not_needed' })
bl = await req('GET', `/api/projects/${pid}/backlog`)
ok('not_needed warp excluded too', !bl.json.some((n) => n.id === warp2.json.id))

// linked creation: POST nodes with linkTo
const lkWarp = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'Linked Warp', stage: 'implement' })
const lkF1 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Linked Feature A' })
const lkF2 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Linked Feature B' })
ok('linked fixtures', lkWarp.status === 200 && lkF1.status === 200 && lkF2.status === 200)

// (a) defaults only: new bug → [feature, warp] = blocks (bug→feature) + member (bug→warp)
const lkBug = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'bug', title: 'Linked Bug', linkTo: [{ nodeId: lkF1.json.id }, { nodeId: lkWarp.json.id }]
})
ok('linkTo create', lkBug.status === 200, JSON.stringify(lkBug.json))
let lkDetail = await req('GET', `/api/nodes/${lkBug.json.id}`)
const lkBlocks = relOf(connWith(lkDetail.json.edges, 'blocks'), 'blocks')
const lkMember = relOf(connWith(lkDetail.json.edges, 'member'), 'member')
ok('default bug −blocks→ feature', lkBlocks && lkBlocks.sourceId === lkBug.json.id && lkBlocks.targetId === lkF1.json.id,
  JSON.stringify(lkDetail.json.edges))
ok('default bug −member→ warp', lkMember && lkMember.sourceId === lkBug.json.id && lkMember.targetId === lkWarp.json.id)

// (b) explicit type override wins over the matrix — relates = bare connection
const lkQ = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'question', title: 'Linked Question', linkTo: [{ nodeId: lkF1.json.id, type: 'relates' }]
})
lkDetail = await req('GET', `/api/nodes/${lkQ.json.id}`)
ok('linkTo type override (bare connection)', lkQ.status === 200 && lkDetail.json.edges?.length === 1 &&
  rels(lkDetail.json.edges[0]).length === 0)

// (c) invalid nodeId → 400 (validated before the node is created)
const lkBad = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'idea', title: 'Bad LinkTo', linkTo: [{ nodeId: 'nd_doesnotexist' }]
})
ok('linkTo invalid nodeId 400', lkBad.status === 400, JSON.stringify(lkBad.json))
const lkBadGone = await req('GET', `/api/projects/${pid}/nodes?q=${encodeURIComponent('Bad LinkTo')}`)
ok('no node created on invalid linkTo', Array.isArray(lkBadGone.json) && lkBadGone.json.length === 0)

// (d) new feature linked to existing feature → existing −derives→ new
const lkSub = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Linked Subfeature', linkTo: [{ nodeId: lkF2.json.id }]
})
lkDetail = await req('GET', `/api/nodes/${lkSub.json.id}`)
const lkDerives = relOf(connWith(lkDetail.json.edges, 'derives'), 'derives')
ok('feature −derives→ new subfeature', lkSub.status === 200 && lkDerives &&
  lkDerives.sourceId === lkF2.json.id && lkDerives.targetId === lkSub.json.id, JSON.stringify(lkDetail.json.edges))

// (e) partial failure: bad override fails AFTER creation — node + good links survive, 400 says so
const lkPart = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'idea', title: 'Partial LinkTo', linkTo: [{ nodeId: lkF1.json.id }, { nodeId: lkF2.json.id, type: 'member' }]
})
ok('partial link failure 400 mentions creation', lkPart.status === 400 && String(lkPart.json.error?.message ?? '').includes('was created'),
  JSON.stringify(lkPart.json))
const lkPartList = await req('GET', `/api/projects/${pid}/nodes?q=${encodeURIComponent('Partial LinkTo')}`)
const lkPartNode = lkPartList.json?.[0]
ok('node kept on partial failure', !!lkPartNode)
if (lkPartNode) {
  const pd = await req('GET', `/api/nodes/${lkPartNode.id}`)
  ok('successful links kept on partial failure', pd.json.edges?.length === 1 && rels(pd.json.edges[0]).length === 0,
    JSON.stringify(pd.json.edges))
}

// decomposition: derives relationships must stay acyclic (any type mix)
const cycA = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Cycle A' })
const cycB = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Cycle B' })
const cycC = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Cycle C' })
const cAB = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cycA.json.id, targetId: cycB.json.id, type: 'derives' })
const cBC = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cycB.json.id, targetId: cycC.json.id, type: 'derives' })
ok('derives chain created (A→B→C, mixed types)', cAB.status === 200 && cBC.status === 200)
const cCA = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cycC.json.id, targetId: cycA.json.id, type: 'derives' })
ok('derives cycle rejected', cCA.status === 400 && String(cCA.json.error?.message ?? '').includes('acyclic'),
  JSON.stringify(cCA.json))
const cBA = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cycB.json.id, targetId: cycA.json.id, type: 'derives' })
ok('reverse derives (2-cycle) rejected', cBA.status === 400)
// the acyclicity guard runs on relationship ADDS to existing connections too
const cRel = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cycC.json.id, targetId: cycA.json.id, type: 'relates' })
const cRelAdd = await req('POST', `/api/edges/${cRel.json.id}/relationships`, { type: 'derives', sourceId: cycC.json.id })
ok('adding derives that closes a loop rejected', cRel.status === 200 && cRelAdd.status === 400 &&
  String(cRelAdd.json.error?.message ?? '').includes('acyclic'), JSON.stringify(cRelAdd.json))
const cDep = await req('POST', `/api/edges/${cRel.json.id}/relationships`, { type: 'depends', sourceId: cycC.json.id })
ok('non-derives relationship add unaffected', cDep.status === 200 && hasRel(cDep.json, 'depends'))
// flipping a derives relationship re-checks acyclicity IGNORING itself (A→B alone flips fine)
const cFlip = await req('PATCH', `/api/edges/${cBC.json.id}/relationships/derives`, { sourceId: cycC.json.id })
ok('derives flip (no loop) allowed', cFlip.status === 200 && relOf(cFlip.json, 'derives')?.sourceId === cycC.json.id,
  JSON.stringify(cFlip.json.relationships))
const cFlipBack = await req('PATCH', `/api/edges/${cBC.json.id}/relationships/derives`, { sourceId: cycB.json.id })
ok('derives flip back', cFlipBack.status === 200 && relOf(cFlipBack.json, 'derives')?.sourceId === cycB.json.id)
// legacy retype is gone — PATCH {type} points at the relationships API
const cRetype = await req('PATCH', `/api/edges/${cRel.json.id}`, { type: 'derives' })
ok('PATCH edge type 400 + relationships pointer', cRetype.status === 400 &&
  String(cRetype.json.error?.message ?? '').includes('relationships'), JSON.stringify(cRetype.json))

// flags: composable highlight rules (defaults: Done → dim, Blocked → ring)
// evaluated server-side into node.flags on every graph payload
const flgF = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Flag Target' })
const flgB = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'bug', title: 'Flag Blocker', linkTo: [{ nodeId: flgF.json.id, type: 'blocks', outgoing: true }]
})
const flgT = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Tag Blocked', tags: ['blocked'] })
ok('flag fixtures', flgF.status === 200 && flgB.status === 200 && flgT.status === 200)
let fg = await req('GET', `/api/projects/${pid}/graph`)
const fNode = (id) => fg.json.nodes.find((n) => n.id === id)
ok('blocked tag → Blocked flag', fNode(flgT.json.id)?.flags?.includes('Blocked'), JSON.stringify(fNode(flgT.json.id)?.flags))
ok('incoming blocks edge → Blocked flag', fNode(flgF.json.id)?.flags?.includes('Blocked'), JSON.stringify(fNode(flgF.json.id)?.flags))
ok('live blocker itself unflagged', fNode(flgB.json.id)?.flags?.length === 0)
bl = await req('GET', `/api/projects/${pid}/backlog`)
ok('blocked is not done — stays in backlog', bl.json.some((n) => n.id === flgF.json.id))

// resolved-source suppression: a fixed bug stops blocking its target
const flgFix = await req('PATCH', `/api/nodes/${flgB.json.id}`, { tags: ['fixed'] })
ok('blocker tagged fixed', flgFix.status === 200)
fg = await req('GET', `/api/projects/${pid}/graph`)
ok('fixed blocker gains Done flag', fNode(flgB.json.id)?.flags?.includes('Done'))
ok('suppression: target Blocked flag clears', !fNode(flgF.json.id)?.flags?.includes('Blocked'),
  JSON.stringify(fNode(flgF.json.id)?.flags))
ok('tag-blocked node unaffected by suppression', fNode(flgT.json.id)?.flags?.includes('Blocked'))
bl = await req('GET', `/api/projects/${pid}/backlog`)
ok('Done (via fixed tag) leaves backlog', !bl.json.some((n) => n.id === flgB.json.id))
ok('unblocked target stays in backlog', bl.json.some((n) => n.id === flgF.json.id))

// node detail carries computed flags too
const flgDetail = await req('GET', `/api/nodes/${flgT.json.id}`)
ok('node detail carries flags', Array.isArray(flgDetail.json.flags) && flgDetail.json.flags.includes('Blocked'))

// progressComputed precedence: explicit > roll-ups > Done flag > 0
const pgP = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Progress Parent' })
const pgC1 = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Progress Child A', progress: 80,
  linkTo: [{ nodeId: pgP.json.id, type: 'derives', outgoing: false }]
})
const pgC2 = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Progress Child B', progress: 20,
  linkTo: [{ nodeId: pgP.json.id, type: 'derives', outgoing: false }]
})
ok('progress fixtures', pgP.status === 200 && pgC1.status === 200 && pgC2.status === 200)
fg = await req('GET', `/api/projects/${pid}/graph`)
ok('explicit progress wins', fNode(pgC1.json.id)?.progressComputed === 80)
ok('feature rolls up derives children', fNode(pgP.json.id)?.progressComputed === 50,
  JSON.stringify(fNode(pgP.json.id)?.progressComputed))
ok('Done flag implies 100', fNode(bldone.json.id)?.progressComputed === 100 && fNode(flgB.json.id)?.progressComputed === 100)
ok('plain node implies 0', fNode(flgF.json.id)?.progressComputed === 0 && fNode(sub.json.id)?.progressComputed === 0)

// node diff: "what changed since I last saw it"
const dfNode = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Diff Target', content: '## Spec\n\nline one\nline two\nline three\n'
})
const dfPeerA = await req('POST', `/api/projects/${pid}/nodes`, { type: 'idea', title: 'Diff Peer A' })
const dfPeerB = await req('POST', `/api/projects/${pid}/nodes`, { type: 'idea', title: 'Diff Peer B' })
const dfEdgeB = await req('POST', `/api/projects/${pid}/edges`, { sourceId: dfNode.json.id, targetId: dfPeerB.json.id, type: 'relates' })
ok('diff fixtures', dfNode.status === 200 && dfPeerA.status === 200 && dfPeerB.status === 200 && dfEdgeB.status === 200)

await new Promise((r) => setTimeout(r, 10)) // put t0 strictly after the fixtures
const t0 = (await req('GET', '/api/health')).json.at

// mutate after t0: content v2, tags, +edge to A, −edge to B, annotation
const dfPut = await req('PUT', `/api/nodes/${dfNode.json.id}/content`, { content: '## Spec\n\nline one\nline two changed\nline three\n' })
const dfPatch = await req('PATCH', `/api/nodes/${dfNode.json.id}`, { tags: ['building'] })
const dfEdgeA = await req('POST', `/api/projects/${pid}/edges`, { sourceId: dfNode.json.id, targetId: dfPeerA.json.id, type: 'relates' })
const dfDel = await req('DELETE', `/api/edges/${dfEdgeB.json.id}`)
const dfAnn = await req('POST', `/api/nodes/${dfNode.json.id}/annotations`, { body: 'note after t0' })
ok('diff mutations applied', dfPut.status === 200 && dfPatch.status === 200 && dfEdgeA.status === 200 && dfDel.status === 200 && dfAnn.status === 200)

const diff = await req('GET', `/api/nodes/${dfNode.json.id}/diff?since=${t0}`)
ok('diff 200 with now/since', diff.status === 200 && typeof diff.json.now === 'number' && diff.json.since === t0, JSON.stringify(diff.json))
ok('diff content changed', diff.json.content?.changed === true)
const uni = diff.json.content?.unified ?? ''
ok('diff unified hunk shows the change', uni.includes('@@') && uni.includes('\n-line two\n') && uni.includes('\n+line two changed'),
  JSON.stringify(uni))
ok('diff from/to attribution', diff.json.content?.from?.actor === 'smoke-agent' && diff.json.content?.to?.actor === 'smoke-agent' &&
  diff.json.content.to.at > diff.json.content.from.at)
ok('diff meta has tag change', Array.isArray(diff.json.meta) &&
  diff.json.meta.some((m) => m.action === 'node.updated' && m.summary.includes('tags +building')), JSON.stringify(diff.json.meta))
ok('diff edges added (new connection, relationship: null)', diff.json.edges?.added?.length === 1 &&
  diff.json.edges.added[0].targetId === dfPeerA.json.id && diff.json.edges.added[0].targetTitle === 'Diff Peer A' &&
  diff.json.edges.added[0].relationship === null, JSON.stringify(diff.json.edges))
const dfRm = diff.json.edges?.removed?.[0]
ok('diff edges removed names endpoints (whole connection)', diff.json.edges?.removed?.length === 1 &&
  dfRm?.sourceId === dfNode.json.id && dfRm?.targetId === dfPeerB.json.id && dfRm?.targetTitle === 'Diff Peer B' &&
  dfRm?.relationship === null && Array.isArray(dfRm?.relationships) && dfRm.relationships.length === 0,
  JSON.stringify(diff.json.edges?.removed))
ok('diff annotations added', diff.json.annotations?.added?.length === 1 && diff.json.annotations.added[0].body === 'note after t0')

// all-quiet: since = the diff's own `now`
const quiet = await req('GET', `/api/nodes/${dfNode.json.id}/diff?since=${diff.json.now}`)
ok('diff all-quiet at now', quiet.status === 200 && quiet.json.content?.changed === false &&
  quiet.json.meta?.length === 0 && quiet.json.edges?.added?.length === 0 &&
  quiet.json.edges?.removed?.length === 0 && quiet.json.annotations?.added?.length === 0, JSON.stringify(quiet.json))

// since predating revision tracking → oldest snapshot + baselineApproximate
const approx = await req('GET', `/api/nodes/${dfNode.json.id}/diff?since=1`)
ok('diff baselineApproximate', approx.status === 200 && approx.json.content?.baselineApproximate === true &&
  approx.json.content?.changed === true)

// missing since → 400
const noSince = await req('GET', `/api/nodes/${dfNode.json.id}/diff`)
ok('diff missing since 400', noSince.status === 400)

// relationship granularity: a relationship added to a PRE-existing connection
// gets its own added row (relationship set); removing it gets a removed row
// while the connection itself survives
const t1 = (await req('GET', '/api/health')).json.at
await new Promise((r) => setTimeout(r, 10)) // mutations land strictly after t1
const dfRelAdd = await req('POST', `/api/edges/${dfEdgeA.json.id}/relationships`, { type: 'depends', sourceId: dfNode.json.id })
ok('relationship add on old connection', dfRelAdd.status === 200 && hasRel(dfRelAdd.json, 'depends'))
let diffR = await req('GET', `/api/nodes/${dfNode.json.id}/diff?since=${t1}`)
ok('diff added row carries the relationship', diffR.json.edges?.added?.length === 1 &&
  diffR.json.edges.added[0].id === dfEdgeA.json.id && diffR.json.edges.added[0].relationship?.type === 'depends' &&
  diffR.json.edges.added[0].relationship?.sourceId === dfNode.json.id, JSON.stringify(diffR.json.edges))
const dfRelRm = await req('DELETE', `/api/edges/${dfEdgeA.json.id}/relationships/depends`)
ok('relationship remove leaves connection', dfRelRm.status === 200 && rels(dfRelRm.json).length === 0)
diffR = await req('GET', `/api/nodes/${dfNode.json.id}/diff?since=${t1}`)
ok('diff removed row is relationship-granular', diffR.json.edges?.removed?.some((x) =>
  x.id === dfEdgeA.json.id && x.relationship?.type === 'depends'), JSON.stringify(diffR.json.edges?.removed))
ok('connection itself not reported removed', !diffR.json.edges?.removed?.some((x) =>
  x.id === dfEdgeA.json.id && x.relationship === null))

// activity ?since=
const actSince = await req('GET', `/api/projects/${pid}/activity?since=${t0}`)
ok('activity since filters', actSince.status === 200 && actSince.json.length > 0 && actSince.json.every((a) => a.at > t0))
const actAll = await req('GET', `/api/projects/${pid}/activity`)
ok('activity since is a strict subset', actAll.json.length > actSince.json.length)
ok('edge.deleted carries connection detail', actSince.json.some((a) => a.action === 'edge.deleted' &&
  a.detail?.sourceId === dfNode.json.id && a.detail?.targetId === dfPeerB.json.id && Array.isArray(a.detail?.relationships)),
  JSON.stringify(actSince.json.filter((a) => a.action === 'edge.deleted')))
ok('edge.relationship.* activity present', actAll.json.some((a) => a.action === 'edge.relationship.added' &&
  a.detail?.type === 'depends') && actAll.json.some((a) => a.action === 'edge.relationship.removed'),
  JSON.stringify(actAll.json.filter((a) => a.action.startsWith('edge.relationship')).map((a) => [a.action, a.summary])))

// ---------------------------------------------------------------------------
// action nodes: transient instructions — creatable everywhere, backlog-ranked,
// chained with leads-to, and REMOVED on completion

const act1 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'action', title: 'Wire the flux capacitor', content: '## Delta\n\nDo the thing.\n' })
ok('action create', act1.status === 200 && act1.json.type === 'action' && act1.json.filePath.includes('Actions'), JSON.stringify(act1.json))
bl = await req('GET', `/api/projects/${pid}/backlog`)
ok('action ranks in backlog', bl.json.some((n) => n.id === act1.json.id))

// action as a linkTo child of a feature (decomposition preset: parent —derives→ child)
const actChild = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'action', title: 'Child Action', linkTo: [{ nodeId: feat.json.id, type: 'derives', outgoing: false }]
})
let actDetail = await req('GET', `/api/nodes/${actChild.json.id}`)
ok('action linkTo child of feature', actChild.status === 200 &&
  actDetail.json.edges?.some((e) => relOf(e, 'derives')?.sourceId === feat.json.id), JSON.stringify(actDetail.json.edges))

// default link for action+action (linkTo without type): existing —leads-to→ new
const act2 = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'action', title: 'Then calibrate it', linkTo: [{ nodeId: act1.json.id }]
})
actDetail = await req('GET', `/api/nodes/${act2.json.id}`)
const leadRel = relOf(connWith(actDetail.json.edges, 'leads-to'), 'leads-to')
ok('action+action defaults to leads-to (existing first)', act2.status === 200 && leadRel &&
  leadRel.sourceId === act1.json.id && leadRel.targetId === act2.json.id, JSON.stringify(actDetail.json.edges))

// leads-to onto an already-connected pair (feat ↔ sub carry derives) = UPSERT:
// the SAME connection gains the relationship — never a second edge
const ltEdge = await req('POST', `/api/projects/${pid}/edges`, { sourceId: feat.json.id, targetId: sub.json.id, type: 'leads-to', label: 'pipeline' })
ok('leads-to upserts onto the existing connection', ltEdge.status === 200 && ltEdge.json.id === derives.json.id &&
  hasRel(ltEdge.json, 'leads-to') && hasRel(ltEdge.json, 'derives'), JSON.stringify(ltEdge.json))
ok('upsert keeps the existing label (PATCH to change)', ltEdge.json.label === 'split out', JSON.stringify(ltEdge.json.label))
{
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('leads-to in graph payload', g.json.edges.some((e) => e.id === ltEdge.json.id && hasRel(e, 'leads-to')))
  const pairs = new Map()
  for (const e of g.json.edges) {
    const k = e.sourceId < e.targetId ? `${e.sourceId}|${e.targetId}` : `${e.targetId}|${e.sourceId}`
    pairs.set(k, (pairs.get(k) ?? 0) + 1)
  }
  ok('no pair carries two edges', [...pairs.values()].every((c) => c === 1),
    JSON.stringify([...pairs.entries()].filter(([, c]) => c > 1)))
}

// complete flow: the terminal verb for instructions
const cf = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Completion Target' })
const ca = await req('POST', `/api/projects/${pid}/nodes`, { type: 'action', title: 'Update the target spec', linkTo: [{ nodeId: cf.json.id }] })
ok('complete fixtures', cf.status === 200 && ca.status === 200)
let cfDetail = await req('GET', `/api/nodes/${cf.json.id}`)
const cfEdgesBefore = cfDetail.json.edges?.length ?? -1
const notAction = await req('POST', `/api/nodes/${cf.json.id}/complete`, { note: 'nope' })
ok('complete non-action 400', notAction.status === 400)
const done1 = await req('POST', `/api/nodes/${ca.json.id}/complete`, { note: 'spec updated, retry logic moved' })
ok('complete action 200 + linked ids', done1.status === 200 && Array.isArray(done1.json.linkedNodeIds) &&
  done1.json.linkedNodeIds.includes(cf.json.id), JSON.stringify(done1.json))
const caGone = await req('GET', `/api/nodes/${ca.json.id}`)
ok('completed action gone (404)', caGone.status === 404)
cfDetail = await req('GET', `/api/nodes/${cf.json.id}`)
ok('neighbour edges cleaned after complete', (cfDetail.json.edges?.length ?? -1) === cfEdgesBefore - 1, JSON.stringify(cfDetail.json.edges))
{
  const acts = await req('GET', `/api/projects/${pid}/activity?limit=30`)
  const compAct = acts.json.find((a) => a.action === 'action.completed' && a.subjectId === ca.json.id)
  ok('action.completed activity carries note + linked ids', compAct && compAct.summary.includes('spec updated') &&
    Array.isArray(compAct.detail?.linkedNodeIds) && compAct.detail.linkedNodeIds.includes(cf.json.id), JSON.stringify(compAct))
}

// debt flag default (settings flagsVersion 2): tag `debt` → Debt badge in graph flags
const dbtPatch = await req('PATCH', `/api/nodes/${flgF.json.id}`, { tags: ['debt'] })
{
  const g = await req('GET', `/api/projects/${pid}/graph`)
  const n = g.json.nodes.find((x) => x.id === flgF.json.id)
  ok('debt tag → Debt flag', dbtPatch.status === 200 && n?.flags?.includes('Debt'), JSON.stringify(n?.flags))
}

// prune: the negative-resolution verb for records — kept, dimmed, with the why
const prF = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Prune Blocked Target' })
const prB = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Prunable Bug', linkTo: [{ nodeId: prF.json.id, type: 'blocks', outgoing: true }] })
const prSup = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Sufficient Solution' })
ok('prune fixtures', prF.status === 200 && prB.status === 200 && prSup.status === 200)
const noNote = await req('POST', `/api/nodes/${prB.json.id}/prune`, {})
ok('prune without note 400', noNote.status === 400 && String(noNote.json.error?.message ?? '').includes('note'))
const wrpPrune = await req('POST', `/api/nodes/${warp.json.id}/prune`, { note: 'nope' })
ok('prune warp 400 (stage not_needed instead)', wrpPrune.status === 400)
{
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('blocks fires before prune', g.json.nodes.find((x) => x.id === prF.json.id)?.flags?.includes('Blocked'))
}
const pr1 = await req('POST', `/api/nodes/${prB.json.id}/prune`, { note: 'not reproducible on 2b', supersededBy: prSup.json.id })
ok('prune 200 + pruned tag', pr1.status === 200 && pr1.json.tags?.includes('pruned'), JSON.stringify(pr1.json))
{
  const d = await req('GET', `/api/nodes/${prB.json.id}`)
  ok('prune note kept as attributed annotation', d.json.annotations?.some((a) => a.body === 'not reproducible on 2b' && a.author === 'smoke-agent'),
    JSON.stringify(d.json.annotations))
  const supEdge = d.json.edges?.find((e) => e.targetId === prSup.json.id || e.sourceId === prSup.json.id)
  ok('supersededBy bare connection labelled', supEdge && supEdge.label === 'superseded by' && rels(supEdge).length === 0,
    JSON.stringify(d.json.edges))
  const g = await req('GET', `/api/projects/${pid}/graph`)
  const fNodeG = (idv) => g.json.nodes.find((x) => x.id === idv)
  ok('pruned node gains Pruned flag (dim)', fNodeG(prB.json.id)?.flags?.includes('Pruned'), JSON.stringify(fNodeG(prB.json.id)?.flags))
  ok('suppression: pruned blocker stops ringing its target', !fNodeG(prF.json.id)?.flags?.includes('Blocked'),
    JSON.stringify(fNodeG(prF.json.id)?.flags))
  bl = await req('GET', `/api/projects/${pid}/backlog`)
  ok('pruned node leaves backlog', !bl.json.some((n) => n.id === prB.json.id))
  ok('unblocked-by-prune target stays in backlog', bl.json.some((n) => n.id === prF.json.id))
}
const pr2 = await req('POST', `/api/nodes/${prB.json.id}/prune`, { note: 'second look — still dead' })
{
  const d = await req('GET', `/api/nodes/${prB.json.id}`)
  ok('re-prune 200 appends the note', pr2.status === 200 && d.json.annotations?.length === 2, JSON.stringify(d.json.annotations))
}

// answer: the positive-resolution verb for questions — the answer lands in the
// file body as an ## Answer section, the record stays (answered tag → Done rule)
const ansF = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Answer Blocked Target' })
const ansQ = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'question', title: 'Which cache strategy?', content: '## Context\n\nWrite-through vs write-back.\n',
  linkTo: [{ nodeId: ansF.json.id, type: 'blocks', outgoing: true }]
})
ok('answer fixtures', ansF.status === 200 && ansQ.status === 200)
const ansNotQ = await req('POST', `/api/nodes/${ansF.json.id}/answer`, { answer: 'nope' })
ok('answer non-question 400', ansNotQ.status === 400 && String(ansNotQ.json.error?.message ?? '').includes('question'),
  JSON.stringify(ansNotQ.json))
const ansEmpty = await req('POST', `/api/nodes/${ansQ.json.id}/answer`, { answer: '   ' })
ok('empty answer 400', ansEmpty.status === 400)
const ansMissing = await req('POST', `/api/nodes/${ansQ.json.id}/answer`, {})
ok('missing answer 400', ansMissing.status === 400)
{
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('blocking question rings target before answer', g.json.nodes.find((x) => x.id === ansF.json.id)?.flags?.includes('Blocked'))
}
const ans1 = await req('POST', `/api/nodes/${ansQ.json.id}/answer`, { answer: 'Write-through — simpler invalidation.' })
ok('answer 200: answered tag + Done flag + detail', ans1.status === 200 && ans1.json.tags?.includes('answered') &&
  ans1.json.flags?.includes('Done'), JSON.stringify({ tags: ans1.json.tags, flags: ans1.json.flags }))
ok('answer written as ## Answer section', typeof ans1.json.content === 'string' && ans1.json.content.includes('## Answer') &&
  ans1.json.content.includes('Write-through — simpler invalidation.'), JSON.stringify(ans1.json.content))
ok('answer keeps the original body', ans1.json.content.includes('Write-through vs write-back'))
ok('answer attribution line', ans1.json.content.includes('answered by smoke-agent'))
{
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('suppression: answered blocker un-rings its target', !g.json.nodes.find((x) => x.id === ansF.json.id)?.flags?.includes('Blocked'),
    JSON.stringify(g.json.nodes.find((x) => x.id === ansF.json.id)?.flags))
  bl = await req('GET', `/api/projects/${pid}/backlog`)
  ok('answered question leaves backlog', !bl.json.some((n) => n.id === ansQ.json.id))
  ok('unblocked target stays in backlog', bl.json.some((n) => n.id === ansF.json.id))
}
const ans2 = await req('POST', `/api/nodes/${ansQ.json.id}/answer`, { answer: 'Refinement: write-back for the hot path only.' })
ok('re-answer appends under the same heading', ans2.status === 200 &&
  (ans2.json.content.match(/^## Answer/gm) ?? []).length === 1 &&
  ans2.json.content.includes('Refinement: write-back') && ans2.json.content.includes('refined by smoke-agent'),
  JSON.stringify(ans2.json.content))
{
  const acts = await req('GET', `/api/projects/${pid}/activity?limit=30`)
  const qa = acts.json.find((a) => a.action === 'question.answered' && a.subjectId === ansQ.json.id && a.detail?.refinement === false)
  ok('question.answered activity: excerpt + full answer in detail', qa && qa.summary.includes('Write-through') &&
    qa.detail?.answer === 'Write-through — simpler invalidation.', JSON.stringify(qa))
  ok('re-answer logged as refinement', acts.json.some((a) => a.action === 'question.answered' && a.detail?.refinement === true))
}
// refinements land inside the Answer section even when it is no longer last
await req('PUT', `/api/nodes/${ansQ.json.id}/content`, {
  content: '## Answer\n\nfirst.\n\n— *answered by smoke-agent, 2026-01-01*\n\n## Appendix\n\nkeep me last.\n'
})
const ans3 = await req('POST', `/api/nodes/${ansQ.json.id}/answer`, { answer: 'mid-section refinement' })
{
  const b = String(ans3.json.content ?? '')
  ok('refinement inserted before the next section', ans3.status === 200 && b.includes('mid-section refinement') &&
    b.indexOf('mid-section refinement') < b.indexOf('## Appendix') && b.trim().endsWith('keep me last.'),
    JSON.stringify(b))
}

// graduate recipe (two calls, no dedicated endpoint): answered question →
// durable node seeded from the answer (question —derives→ new) → prune supersededBy
const grQ = await req('POST', `/api/projects/${pid}/nodes`, { type: 'question', title: 'Tabs or spaces?' })
const grA = await req('POST', `/api/nodes/${grQ.json.id}/answer`, { answer: 'Spaces. Two of them.' })
ok('graduate fixtures', grQ.status === 200 && grA.status === 200)
const grP = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'principle', title: 'Tabs or spaces',
  content: 'Spaces. Two of them.\n\n— *graduated from the question "Tabs or spaces?"*\n',
  linkTo: [{ nodeId: grQ.json.id, type: 'derives', outgoing: false }]
})
ok('graduate node created linked', grP.status === 200, JSON.stringify(grP.json))
const grPrune = await req('POST', `/api/nodes/${grQ.json.id}/prune`, { note: 'Graduated to "Tabs or spaces"', supersededBy: grP.json.id })
ok('graduate prune 200 + pruned tag', grPrune.status === 200 && grPrune.json.tags?.includes('pruned'))
{
  const qd = await req('GET', `/api/nodes/${grQ.json.id}`)
  // ONE connection between question and graduate: derives relationship + the
  // superseded-by label land on the same edge (no parallel relates row)
  const conns = qd.json.edges?.filter((e) => e.targetId === grP.json.id || e.sourceId === grP.json.id) ?? []
  ok('question↔graduate share ONE connection', conns.length === 1, JSON.stringify(qd.json.edges))
  const dRel = relOf(conns[0], 'derives')
  ok('question —derives→ graduate', dRel && dRel.sourceId === grQ.json.id && dRel.targetId === grP.json.id,
    JSON.stringify(conns))
  ok('superseded-by labels that same connection', conns[0]?.label === 'superseded by', JSON.stringify(conns[0]?.label))
  const pd = await req('GET', `/api/nodes/${grP.json.id}`)
  ok('graduate carries derives + provenance footer', pd.json.edges?.some((e) => relOf(e, 'derives')?.sourceId === grQ.json.id) &&
    pd.json.content.includes('graduated from the question'))
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('graduated question dims (Pruned)', g.json.nodes.find((x) => x.id === grQ.json.id)?.flags?.includes('Pruned'))
}

// convert: identity-preserving type change — same node, new hat. Preserves
// id/tags/edges/annotations/revisions/content/progress/rank; the file moves to
// the new type's folder; warp-ness edges (member/addresses) guard both directions.
const cvI = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'idea', title: 'Seed To Feature', tags: ['spark', 'kept'], content: '## Spark\n\nseed content survives conversion\n'
})
const cvPeer = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Convert Peer' })
const cvEdge = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cvI.json.id, targetId: cvPeer.json.id, type: 'relates', label: 'seeded' })
const cvAnn = await req('POST', `/api/nodes/${cvI.json.id}/annotations`, { body: 'note survives conversion' })
const cvMeta = await req('PATCH', `/api/nodes/${cvI.json.id}`, { progress: 25, rank: 7 })
// a second content revision so the revision CHAIN (not just the latest body) is provably intact after convert
const cvV2 = await req('PUT', `/api/nodes/${cvI.json.id}/content`, { content: '## Spark\n\nseed content survives conversion — v2\n' })
ok('convert fixtures', cvI.status === 200 && cvPeer.status === 200 && cvEdge.status === 200 &&
  cvAnn.status === 200 && cvMeta.status === 200 && cvV2.status === 200)

const cv1 = await req('POST', `/api/nodes/${cvI.json.id}/convert`, { type: 'feature' })
ok('convert idea→feature 200', cv1.status === 200 && cv1.json.type === 'feature', JSON.stringify(cv1.json))
ok('convert preserves id/tags/content', cv1.json.id === cvI.json.id && cv1.json.tags?.includes('spark') &&
  cv1.json.tags?.includes('kept') && String(cv1.json.content ?? '').includes('seed content survives conversion — v2'))
ok('convert preserves progress/rank', cv1.json.progress === 25 && cv1.json.rank === 7,
  JSON.stringify({ progress: cv1.json.progress, rank: cv1.json.rank }))
ok('convert moves file into Features', String(cv1.json.filePath ?? '').includes('Features') &&
  !String(cv1.json.filePath ?? '').includes('Ideas'), JSON.stringify(cv1.json.filePath))
ok('convert preserves edges', cv1.json.edges?.length === 1 && cv1.json.edges[0].id === cvEdge.json.id &&
  cv1.json.edges[0].label === 'seeded' && rels(cv1.json.edges[0]).length === 0, JSON.stringify(cv1.json.edges))
ok('convert preserves annotations', cv1.json.annotations?.some((a) => a.body === 'note survives conversion'))
{
  // revisions survived: diff from the epoch still reaches the pre-convert v1 baseline
  const cvDiff = await req('GET', `/api/nodes/${cvI.json.id}/diff?since=1`)
  ok('convert keeps revisions (v1 baseline still diffable)', cvDiff.status === 200 && cvDiff.json.content?.changed === true &&
    String(cvDiff.json.content?.unified ?? '').includes('+seed content survives conversion — v2'),
    JSON.stringify(cvDiff.json.content))
}
const cvSame = await req('POST', `/api/nodes/${cvI.json.id}/convert`, { type: 'feature' })
ok('same-type convert 400', cvSame.status === 400, JSON.stringify(cvSame.json))
const cvBogus = await req('POST', `/api/nodes/${cvI.json.id}/convert`, { type: 'sparkle' })
ok('bogus type convert 400', cvBogus.status === 400)

// warp guards: converting the warp-end of a member edge away from warp is refused, naming the edge
const cvW = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'Convert Warp' })
const cvM = await req('POST', `/api/warps/${cvW.json.id}/members`, { nodeId: cvPeer.json.id })
ok('convert warp fixtures', cvW.status === 200 && cvM.status === 200)
const cvWFail = await req('POST', `/api/nodes/${cvW.json.id}/convert`, { type: 'feature' })
ok('convert warp with members 400 names edge', cvWFail.status === 400 &&
  String(cvWFail.json.error?.message ?? '').includes(cvM.json.id), JSON.stringify(cvWFail.json))
// the member SOURCE is free to convert — member only constrains its target
const cvPeerConv = await req('POST', `/api/nodes/${cvPeer.json.id}/convert`, { type: 'bug' })
ok('member-source conversion stays legal', cvPeerConv.status === 200 && cvPeerConv.json.type === 'bug' &&
  cvPeerConv.json.edges?.some((e) => hasRel(e, 'member')), JSON.stringify(cvPeerConv.json.edges))
await req('DELETE', `/api/warps/${cvW.json.id}/members/${cvPeer.json.id}`)
const cvW2 = await req('POST', `/api/nodes/${cvW.json.id}/convert`, { type: 'feature' })
ok('warp→feature after member removed: stage cleared', cvW2.status === 200 && cvW2.json.type === 'feature' &&
  cvW2.json.stage === null && cvW2.json.filePath.includes('Features'), JSON.stringify({ stage: cvW2.json.stage, filePath: cvW2.json.filePath }))

// converting TO warp under an incoming addresses edge is refused (addresses must target a non-warp)
const cvAddrFail = await req('POST', `/api/nodes/${sub.json.id}/convert`, { type: 'warp' })
ok('convert to warp under addresses edge 400', cvAddrFail.status === 400 &&
  String(cvAddrFail.json.error?.message ?? '').includes(addr.json.id), JSON.stringify(cvAddrFail.json))

// convert TO warp seeds stage concept and lands on the stage board
const cv2 = await req('POST', `/api/nodes/${cvI.json.id}/convert`, { type: 'warp' })
ok('feature→warp seeds stage concept', cv2.status === 200 && cv2.json.type === 'warp' && cv2.json.stage === 'concept',
  JSON.stringify({ type: cv2.json.type, stage: cv2.json.stage }))
{
  const cvWarps = await req('GET', `/api/projects/${pid}/warps`)
  ok('converted warp on the stage board', cvWarps.json.some((x) => x.warp.id === cvI.json.id && x.warp.stage === 'concept'),
    JSON.stringify(cvWarps.json.map((x) => [x.warp.title, x.warp.stage])))
  const acts = await req('GET', `/api/projects/${pid}/activity?limit=20`)
  const cvAct = acts.json.find((a) => a.action === 'node.converted' && a.subjectId === cvI.json.id && a.detail?.to === 'warp')
  ok('node.converted activity carries from/to', cvAct && cvAct.detail?.from === 'feature' &&
    cvAct.summary.includes('converted feature → warp'), JSON.stringify(cvAct))
}

// ---------------------------------------------------------------------------
// unified connections — the faykarta example, verbatim: "you can have for
// example member-of AND blocks AND leads-to for example on one connection,
// pointing different directions"

const ucA = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'UC Node A' })
const ucW = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'UC Warp' })
ok('unified-connection fixtures', ucA.status === 200 && ucW.status === 200)
const uc1 = await req('POST', `/api/projects/${pid}/edges`, { sourceId: ucA.json.id, targetId: ucW.json.id, type: 'member' })
ok('member A→W creates the connection', uc1.status === 200 && rels(uc1.json).length === 1)
const uc2 = await req('POST', `/api/projects/${pid}/edges`, { sourceId: ucW.json.id, targetId: ucA.json.id, type: 'blocks' })
ok('blocks W→A upserts onto the SAME connection', uc2.status === 200 && uc2.json.id === uc1.json.id &&
  rels(uc2.json).length === 2, JSON.stringify(uc2.json))
const uc3 = await req('POST', `/api/edges/${uc1.json.id}/relationships`, { type: 'leads-to', sourceId: ucA.json.id })
ok('leads-to A→W via relationships endpoint', uc3.status === 200 && rels(uc3.json).length === 3)
{
  const g1 = await req('GET', `/api/edges/${uc1.json.id}`)
  const m = relOf(g1.json, 'member')
  const b = relOf(g1.json, 'blocks')
  const l = relOf(g1.json, 'leads-to')
  ok('one connection: member A→W AND blocks W→A AND leads-to A→W', g1.status === 200 &&
    m?.sourceId === ucA.json.id && m?.targetId === ucW.json.id &&
    b?.sourceId === ucW.json.id && b?.targetId === ucA.json.id &&
    l?.sourceId === ucA.json.id && l?.targetId === ucW.json.id,
    JSON.stringify(g1.json.relationships))
  ok('relationships carry attribution', rels(g1.json).every((r) => r.createdBy === 'smoke-agent' && typeof r.createdAt === 'number'))
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('the pair has exactly one edge in the graph', g.json.edges.filter((e) =>
    [e.sourceId, e.targetId].sort().join() === [ucA.json.id, ucW.json.id].sort().join()).length === 1)
}
// upsert semantics: same type again → 409; relates → idempotent no-op
const ucDup = await req('POST', `/api/projects/${pid}/edges`, { sourceId: ucA.json.id, targetId: ucW.json.id, type: 'member' })
ok('same-type re-POST 409 + connection in body', ucDup.status === 409 && ucDup.json.error?.connection?.id === uc1.json.id,
  JSON.stringify(ucDup.json))
const ucRelates = await req('POST', `/api/projects/${pid}/edges`, { sourceId: ucW.json.id, targetId: ucA.json.id, type: 'relates' })
ok('relates POST is an idempotent ensure', ucRelates.status === 200 && ucRelates.json.id === uc1.json.id &&
  rels(ucRelates.json).length === 3)
// member is warp-validated on the relationships endpoint too
const ucBadMember = await req('POST', `/api/edges/${uc1.json.id}/relationships`, { type: 'member', sourceId: ucW.json.id })
ok('member W→A (non-warp target) rejected', ucBadMember.status === 400)
// flip, then remove down to a bare connection — the association survives
const ucFlip = await req('PATCH', `/api/edges/${uc1.json.id}/relationships/leads-to`, { sourceId: ucW.json.id })
ok('relationship flip', ucFlip.status === 200 && relOf(ucFlip.json, 'leads-to')?.sourceId === ucW.json.id)
const ucFlipNoop = await req('PATCH', `/api/edges/${uc1.json.id}/relationships/leads-to`, { sourceId: ucW.json.id })
ok('flip to the same direction is a no-op 200', ucFlipNoop.status === 200)
const ucBadFlip = await req('PATCH', `/api/edges/${uc1.json.id}/relationships/leads-to`, { sourceId: 'nd_notinpair' })
ok('flip with a foreign sourceId 400', ucBadFlip.status === 400)
const ucRm404 = await req('DELETE', `/api/edges/${uc1.json.id}/relationships/shapes`)
ok('removing an absent relationship 404', ucRm404.status === 404)
await req('DELETE', `/api/edges/${uc1.json.id}/relationships/leads-to`)
await req('DELETE', `/api/edges/${uc1.json.id}/relationships/blocks`)
const ucBare = await req('DELETE', `/api/edges/${uc1.json.id}/relationships/member`)
ok('stripping every relationship leaves a bare connection', ucBare.status === 200 && rels(ucBare.json).length === 0)
{
  const still = await req('GET', `/api/edges/${uc1.json.id}`)
  ok('bare connection still exists', still.status === 200 && still.json.id === uc1.json.id)
}
// removing warp membership keeps the association: the connection goes bare, not away
const ucM = await req('POST', `/api/warps/${ucW.json.id}/members`, { nodeId: ucA.json.id })
ok('re-membering via warps endpoint upserts', ucM.status === 200 && ucM.json.id === uc1.json.id && hasRel(ucM.json, 'member'))
const ucMRm = await req('DELETE', `/api/warps/${ucW.json.id}/members/${ucA.json.id}`)
ok('member removal 200', ucMRm.status === 200)
{
  const still = await req('GET', `/api/edges/${uc1.json.id}`)
  ok('membership removal keeps the bare connection', still.status === 200 && rels(still.json).length === 0)
  const wsum = await req('GET', `/api/projects/${pid}/warps`)
  ok('member gone from the warp summary', !wsum.json.find((x) => x.warp.id === ucW.json.id)?.members?.some((mm) => mm.id === ucA.json.id))
}
// label edits live on the connection (PATCH label only)
const ucLabel = await req('PATCH', `/api/edges/${uc1.json.id}`, { label: 'shared history' })
ok('connection label PATCH', ucLabel.status === 200 && ucLabel.json.label === 'shared history')

// ---------------------------------------------------------------------------
// class-of: taxonomies — classification beside decomposition. Canonical
// direction class → instance, any node types both ends, multiple
// classification allowed, acyclic PER TYPE (derives and class-of don't
// conflict), and rollup: a class with no explicit progress reads as the mean
// over its instances' effective progress.

const clsRunes = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Runes Class', content: '## Rules\n\nEvery rune is subject to these.\n'
})
const clsFire = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Fire Things Class' })
ok('class fixtures', clsRunes.status === 200 && clsFire.status === 200)

// three instances in one POST each via linkTo (outgoing:false = the CLASS is the source)
const instR = []
for (const title of ['Fire Rune', 'Ice Rune', 'Storm Rune']) {
  instR.push(await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feature', title, linkTo: [{ nodeId: clsRunes.json.id, type: 'class-of', outgoing: false }]
  }))
}
ok('3 instances via linkTo class-of', instR.every((r) => r.status === 200), JSON.stringify(instR.map((r) => r.status)))
let coDetail = await req('GET', `/api/nodes/${instR[0].json.id}`)
const coRel = relOf(connWith(coDetail.json.edges, 'class-of'), 'class-of')
ok('direction: class —class of→ instance', coRel && coRel.sourceId === clsRunes.json.id && coRel.targetId === instR[0].json.id,
  JSON.stringify(coDetail.json.edges))

// explicit classification of an EXISTING node = multiple classification (Fire Rune ∈ Runes ∧ Fire Things)
const coMulti = await req('POST', `/api/projects/${pid}/edges`, { sourceId: clsFire.json.id, targetId: instR[0].json.id, type: 'class-of' })
ok('multiple classification allowed', coMulti.status === 200 && hasRel(coMulti.json, 'class-of'))
const coDup = await req('POST', `/api/projects/${pid}/edges`, { sourceId: clsFire.json.id, targetId: instR[0].json.id, type: 'class-of' })
ok('duplicate class-of on one connection 409', coDup.status === 409 && coDup.json.error?.connection?.id === coMulti.json.id)

// class hierarchies stay acyclic — per type, so derives across the same pair is free
const coA = await req('POST', `/api/projects/${pid}/nodes`, { type: 'pillar', title: 'Class A (any type)' })
const coB = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Class B (any type)' })
const coChain = await req('POST', `/api/projects/${pid}/edges`, { sourceId: coA.json.id, targetId: coB.json.id, type: 'class-of' })
ok('class-of between any node types', coChain.status === 200 && hasRel(coChain.json, 'class-of'))
const coCycle = await req('POST', `/api/projects/${pid}/edges`, { sourceId: coB.json.id, targetId: coA.json.id, type: 'class-of' })
ok('class-of cycle 400', coCycle.status === 400 && String(coCycle.json.error?.message ?? '').includes('acyclic'),
  JSON.stringify(coCycle.json))
const coDerOpp = await req('POST', `/api/edges/${coChain.json.id}/relationships`, { type: 'derives', sourceId: coB.json.id })
ok('derives opposite class-of on the same pair OK (per-type graphs)', coDerOpp.status === 200 &&
  hasRel(coDerOpp.json, 'derives') && hasRel(coDerOpp.json, 'class-of'), JSON.stringify(coDerOpp.json.relationships))

// rollup: instances at 0/50/100 → the class (no explicit progress) reads the mean
await req('PATCH', `/api/nodes/${instR[0].json.id}`, { progress: 0 })
await req('PATCH', `/api/nodes/${instR[1].json.id}`, { progress: 50 })
await req('PATCH', `/api/nodes/${instR[2].json.id}`, { progress: 100 })
let cog = await req('GET', `/api/projects/${pid}/graph`)
const coNode = (id) => cog.json.nodes.find((n) => n.id === id)
ok('class rolls up mean over instances (0/50/100 → 50)', coNode(clsRunes.json.id)?.progressComputed === 50,
  JSON.stringify(coNode(clsRunes.json.id)?.progressComputed))
const coExp = await req('PATCH', `/api/nodes/${clsRunes.json.id}`, { progress: 80 })
cog = await req('GET', `/api/projects/${pid}/graph`)
ok('explicit class progress beats instance rollup', coExp.status === 200 && coNode(clsRunes.json.id)?.progressComputed === 80)
await req('PATCH', `/api/nodes/${clsRunes.json.id}`, { progress: null })
cog = await req('GET', `/api/projects/${pid}/graph`)
ok('cleared class progress falls back to rollup', coNode(clsRunes.json.id)?.progressComputed === 50)

// precedence: derives children beat class instances on the same parent
// (mirrors Lists placement, where a derives parent wins over a class)
const coMixP = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Mixed Parent' })
const coMixC = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Mixed Child', progress: 80, linkTo: [{ nodeId: coMixP.json.id, type: 'derives', outgoing: false }]
})
const coMixI = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'feature', title: 'Mixed Instance', progress: 20, linkTo: [{ nodeId: coMixP.json.id, type: 'class-of', outgoing: false }]
})
ok('mixed-parent fixtures', coMixP.status === 200 && coMixC.status === 200 && coMixI.status === 200)
cog = await req('GET', `/api/projects/${pid}/graph`)
ok('derives-children rollup beats class-instances rollup', coNode(coMixP.json.id)?.progressComputed === 80,
  JSON.stringify(coNode(coMixP.json.id)?.progressComputed))

// flip / remove behave like every relationship (acyclicity re-checked ignoring itself)
coDetail = await req('GET', `/api/nodes/${instR[2].json.id}`)
const coConn2 = connWith(coDetail.json.edges, 'class-of')
const coFlip = await req('PATCH', `/api/edges/${coConn2.id}/relationships/class-of`, { sourceId: instR[2].json.id })
ok('class-of flip', coFlip.status === 200 && relOf(coFlip.json, 'class-of')?.sourceId === instR[2].json.id,
  JSON.stringify(coFlip.json.relationships))
const coFlipBack = await req('PATCH', `/api/edges/${coConn2.id}/relationships/class-of`, { sourceId: clsRunes.json.id })
ok('class-of flip back', coFlipBack.status === 200 && relOf(coFlipBack.json, 'class-of')?.sourceId === clsRunes.json.id)
const coRm = await req('DELETE', `/api/edges/${coConn2.id}/relationships/class-of`)
ok('class-of remove leaves bare connection', coRm.status === 200 && rels(coRm.json).length === 0)
cog = await req('GET', `/api/projects/${pid}/graph`)
ok('rollup follows the declassified instance (0/50 → 25)', coNode(clsRunes.json.id)?.progressComputed === 25,
  JSON.stringify(coNode(clsRunes.json.id)?.progressComputed))

// llms.txt documents the taxonomy
{
  const llmsCo = await req('GET', '/llms.txt')
  const s = String(llmsCo.json)
  ok('llms.txt: class-of verbs + taxonomy section + add-instance recipe',
    ['class of', 'instance of', 'Taxonomy:', 'Add an instance to a class', '"type":"class-of","outgoing":false'].every((k) => s.includes(k)),
    JSON.stringify(['class of', 'instance of', 'Taxonomy:', 'Add an instance to a class', '"type":"class-of","outgoing":false'].filter((k) => !s.includes(k))))
  ok('llms.txt: instance node type documented', s.includes('instance   —') && s.includes('catalog'),
    JSON.stringify(['instance   —', 'catalog'].filter((k) => !s.includes(k))))
}

// the instance NODE TYPE: a catalog entry. Its default link beside any
// non-warp node is class-of (the existing node is the class) — a bare
// linkTo {nodeId} is all an agent needs to file one under its class.
const inTy = await req('POST', `/api/projects/${pid}/nodes`, {
  type: 'instance', title: 'Rune Of Smoke', progress: 100, linkTo: [{ nodeId: clsRunes.json.id }]
})
ok('instance create via bare linkTo (matrix default = class-of)', inTy.status === 200 && inTy.json.type === 'instance',
  JSON.stringify(inTy.json))
ok('instance file lands in Instances/', String(inTy.json.filePath ?? '').includes('Instances'), JSON.stringify(inTy.json.filePath))
{
  const d = await req('GET', `/api/nodes/${inTy.json.id}`)
  const rel = relOf(connWith(d.json.edges, 'class-of'), 'class-of')
  ok('matrix default direction: class —class of→ new instance', rel && rel.sourceId === clsRunes.json.id && rel.targetId === inTy.json.id,
    JSON.stringify(d.json.edges))
}
cog = await req('GET', `/api/projects/${pid}/graph`)
ok('instance progress feeds the class rollup (0/50/100 → 50)', coNode(clsRunes.json.id)?.progressComputed === 50,
  JSON.stringify(coNode(clsRunes.json.id)?.progressComputed))
{
  const blIn = await req('GET', `/api/projects/${pid}/backlog`)
  ok('instance ranks in the backlog', blIn.json.some((n) => n.id === inTy.json.id),
    JSON.stringify(blIn.json.map((n) => [n.title, n.type]).slice(0, 12)))
}
// conversion picks the type up from NODE_TYPES automatically — identity preserved
const inConv = await req('POST', `/api/nodes/${inTy.json.id}/convert`, { type: 'feature' })
ok('instance→feature convert preserves identity', inConv.status === 200 && inConv.json.id === inTy.json.id &&
  inConv.json.type === 'feature' && inConv.json.progress === 100 &&
  String(inConv.json.filePath ?? '').includes('Features') &&
  inConv.json.edges?.some((e) => relOf(e, 'class-of')?.sourceId === clsRunes.json.id),
  JSON.stringify({ type: inConv.json.type, filePath: inConv.json.filePath }))
const inConvBack = await req('POST', `/api/nodes/${inTy.json.id}/convert`, { type: 'instance' })
ok('feature→instance convert lands back in Instances/', inConvBack.status === 200 && inConvBack.json.type === 'instance' &&
  String(inConvBack.json.filePath ?? '').includes('Instances'), JSON.stringify(inConvBack.json.filePath))

// settings over REST: agents read and edit flag rules (same registry as the UI).
// self-cleaning: the throwaway rule is removed by restoring the original array.
const st0 = await req('GET', '/api/settings')
ok('settings GET', st0.status === 200 && Array.isArray(st0.json.flags) && (st0.json.flagsVersion ?? 0) >= 2,
  JSON.stringify({ v: st0.json.flagsVersion }))
ok('settings carries Debt + Pruned defaults', ['debt', 'pruned'].every((idv) => st0.json.flags.some((f) => f.id === idv)),
  JSON.stringify(st0.json.flags?.map((f) => f.id)))
const originalFlags = st0.json.flags
const stPatch = await req('PATCH', '/api/settings', {
  flags: [...originalFlags, { id: 'fl_smoke', name: 'SmokeFlag', treatment: 'badge', color: '#123456', conditions: [{ kind: 'tag', tag: 'smokeflag' }] }]
})
ok('settings PATCH adds rule', stPatch.status === 200 && stPatch.json.settings?.flags?.some((f) => f.name === 'SmokeFlag'),
  JSON.stringify(stPatch.json))
await req('PATCH', `/api/nodes/${prF.json.id}`, { tags: ['smokeflag'] })
{
  const g = await req('GET', `/api/projects/${pid}/graph`)
  ok('PATCHed rule fires in graph flags', g.json.nodes.find((x) => x.id === prF.json.id)?.flags?.includes('SmokeFlag'))
}
const stRestore = await req('PATCH', '/api/settings', { flags: originalFlags })
ok('settings PATCH restore cleans up', stRestore.status === 200 && !stRestore.json.settings?.flags?.some((f) => f.name === 'SmokeFlag'))

// flags array ORDER round-trips (rule order = chip order + evaluation order);
// self-cleaning: the original order is restored right after.
{
  const reversed = [...originalFlags].reverse()
  const stRev = await req('PATCH', '/api/settings', { flags: reversed })
  ok('flags order round-trips (reorder persists)', stRev.status === 200 &&
    JSON.stringify(stRev.json.settings?.flags?.map((f) => f.id)) === JSON.stringify(reversed.map((f) => f.id)),
    JSON.stringify(stRev.json.settings?.flags?.map((f) => f.id)))
  const stBack = await req('PATCH', '/api/settings', { flags: originalFlags })
  ok('flags order restored', stBack.status === 200 &&
    JSON.stringify(stBack.json.settings?.flags?.map((f) => f.id)) === JSON.stringify(originalFlags.map((f) => f.id)))
}

// styleOverrides + typeOrder: agents theme the UI over REST. Render-side only —
// the graph payload must not change. Self-cleaning: originals restored below.
const originalStyle = st0.json.styleOverrides ?? null
const originalOrder = st0.json.typeOrder ?? null
{
  const stStyle = await req('PATCH', '/api/settings', {
    styleOverrides: {
      nodes: {
        feature: { color: '#22C55E', shape: 'diamond', radius: 14.4 },
        warp: { shape: 'circle' },
        idea: { color: 'not-a-color', shape: 'star' }, // both invalid → whole entry dropped
        ghost: { color: '#ffffff' } // unknown type → dropped
      },
      relationships: { depends: { color: '#abc' }, relates: { color: '#64748b' }, bogus: { color: '#ffffff' } }
    },
    typeOrder: ['bug', 'feature', 'nope', 'bug']
  })
  const so = stStyle.json.settings?.styleOverrides
  ok('styleOverrides PATCH round-trips (color normalized, radius rounded)', stStyle.status === 200 &&
    so?.nodes?.feature?.color === '#22c55e' && so?.nodes?.feature?.shape === 'diamond' && so?.nodes?.feature?.radius === 14 &&
    so?.nodes?.warp?.shape === 'circle', JSON.stringify(so))
  ok('sanitizer drops junk node types/shapes/colors', so && !('ghost' in (so.nodes ?? {})) && !('idea' in (so.nodes ?? {})),
    JSON.stringify(so?.nodes))
  ok('relationship colours kept incl. bare relates; 3-digit hex expands; junk type dropped',
    so?.relationships?.depends?.color === '#aabbcc' && so?.relationships?.relates?.color === '#64748b' &&
    !('bogus' in (so?.relationships ?? {})), JSON.stringify(so?.relationships))
  ok('typeOrder sanitized (unknown + dupes dropped)',
    JSON.stringify(stStyle.json.settings?.typeOrder) === JSON.stringify(['bug', 'feature']),
    JSON.stringify(stStyle.json.settings?.typeOrder))
  const stGet = await req('GET', '/api/settings')
  ok('styleOverrides + typeOrder persist on GET', stGet.json.styleOverrides?.nodes?.feature?.radius === 14 &&
    JSON.stringify(stGet.json.typeOrder) === JSON.stringify(['bug', 'feature']))
  // styles are render-side: node/edge payload shape is untouched by theming
  const gStyled = await req('GET', `/api/projects/${pid}/graph`)
  ok('graph payload unaffected by styleOverrides (render-side only)', gStyled.status === 200 &&
    gStyled.json.nodes.length > 0 &&
    gStyled.json.nodes.every((n) => n.color === undefined && n.shape === undefined && n.radius === undefined),
    JSON.stringify(Object.keys(gStyled.json.nodes[0] ?? {})))
  // PATCH null resets both to shipped defaults (keys leave the settings JSON)
  const stClear = await req('PATCH', '/api/settings', { styleOverrides: null, typeOrder: null })
  ok('styleOverrides/typeOrder PATCH null resets', stClear.status === 200 &&
    stClear.json.settings?.styleOverrides === undefined && stClear.json.settings?.typeOrder === undefined)
  // restore whatever the instance carried before this run (byte-equal settings)
  const stPut = await req('PATCH', '/api/settings', { styleOverrides: originalStyle, typeOrder: originalOrder })
  ok('styleOverrides/typeOrder restored to pre-run values', stPut.status === 200 &&
    JSON.stringify(stPut.json.settings?.styleOverrides ?? null) === JSON.stringify(originalStyle) &&
    JSON.stringify(stPut.json.settings?.typeOrder ?? null) === JSON.stringify(originalOrder))
}

// cross-writer isolation: updateSettings merges at TOP level, so a PATCH that
// carries only ONE settings slice must never erase the others. This is the
// contract the UI's per-slice autosave (and any agent) depends on.
// Self-cleaning: everything restored byte-equal right after.
{
  const sliceStyle = await req('PATCH', '/api/settings', { styleOverrides: { nodes: { bug: { color: '#112233' } } } })
  ok('slice PATCH styleOverrides lands', sliceStyle.status === 200 &&
    sliceStyle.json.settings?.styleOverrides?.nodes?.bug?.color === '#112233',
    JSON.stringify(sliceStyle.json.settings?.styleOverrides))
  const sliceFlags = await req('PATCH', '/api/settings', {
    flags: [...originalFlags, { id: 'fl_slice', name: 'SliceFlag', treatment: 'badge', color: '#445566', conditions: [{ kind: 'tag', tag: 'sliceflag' }] }]
  })
  ok('flags-only PATCH keeps styleOverrides intact', sliceFlags.status === 200 &&
    sliceFlags.json.settings?.styleOverrides?.nodes?.bug?.color === '#112233' &&
    sliceFlags.json.settings?.flags?.some((f) => f.id === 'fl_slice'),
    JSON.stringify(sliceFlags.json.settings?.styleOverrides))
  const sliceOrder = await req('PATCH', '/api/settings', { typeOrder: ['question', 'bug'] })
  ok('typeOrder-only PATCH keeps styleOverrides + flags intact', sliceOrder.status === 200 &&
    sliceOrder.json.settings?.styleOverrides?.nodes?.bug?.color === '#112233' &&
    sliceOrder.json.settings?.flags?.some((f) => f.id === 'fl_slice') &&
    JSON.stringify(sliceOrder.json.settings?.typeOrder) === JSON.stringify(['question', 'bug']))
  const sliceStyle2 = await req('PATCH', '/api/settings', { styleOverrides: { nodes: { bug: { color: '#334455' } } } })
  ok('styleOverrides-only PATCH keeps flags + typeOrder intact', sliceStyle2.status === 200 &&
    sliceStyle2.json.settings?.flags?.some((f) => f.id === 'fl_slice') &&
    JSON.stringify(sliceStyle2.json.settings?.typeOrder) === JSON.stringify(['question', 'bug']))
  const sliceGet = await req('GET', '/api/settings')
  ok('all three slices coexist on GET', sliceGet.json.styleOverrides?.nodes?.bug?.color === '#334455' &&
    sliceGet.json.flags?.some((f) => f.id === 'fl_slice') &&
    JSON.stringify(sliceGet.json.typeOrder) === JSON.stringify(['question', 'bug']))
  const sliceRestore = await req('PATCH', '/api/settings', { styleOverrides: originalStyle, typeOrder: originalOrder, flags: originalFlags })
  ok('slice probes restored byte-equal', sliceRestore.status === 200 &&
    JSON.stringify(sliceRestore.json.settings?.styleOverrides ?? null) === JSON.stringify(originalStyle) &&
    JSON.stringify(sliceRestore.json.settings?.typeOrder ?? null) === JSON.stringify(originalOrder) &&
    JSON.stringify(sliceRestore.json.settings?.flags) === JSON.stringify(originalFlags))
}

// ---------------------------------------------------------------------------
// Warp 4: areas (WHERE) + components (HOW) — two new axes in the ontology

// both types creatable; vault folders Areas/ and Components/
const arMain = await req('POST', `/api/projects/${pid}/nodes`, { type: 'area', title: 'Combat Area', content: '## Geography\n\nEverything combat.\n' })
ok('area create + Areas/ folder', arMain.status === 200 && arMain.json.type === 'area' &&
  String(arMain.json.filePath ?? '').includes('Areas'), JSON.stringify(arMain.json.filePath))
const cmpMain = await req('POST', `/api/projects/${pid}/nodes`, { type: 'component', title: 'Damage Resolver', content: '## Job\n\nResolves damage.\n' })
ok('component create + Components/ folder', cmpMain.status === 200 && cmpMain.json.type === 'component' &&
  String(cmpMain.json.filePath ?? '').includes('Components'), JSON.stringify(cmpMain.json.filePath))
ok('area carries no stage', arMain.json.stage === null)

// member targets warp OR area — and nothing else
const arM1 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Area Member A', progress: 0 })
const arM2 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Area Member B', progress: 50 })
const arM3 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Area Member C', progress: 100 })
ok('area member fixtures', [arM1, arM2, arM3].every((r) => r.status === 200))
const arE1 = await req('POST', `/api/projects/${pid}/edges`, { sourceId: arM1.json.id, targetId: arMain.json.id, type: 'member' })
ok('member → area accepted', arE1.status === 200 && hasRel(arE1.json, 'member'))
await req('POST', `/api/projects/${pid}/edges`, { sourceId: arM2.json.id, targetId: arMain.json.id, type: 'member' })
await req('POST', `/api/projects/${pid}/edges`, { sourceId: arM3.json.id, targetId: arMain.json.id, type: 'member' })
const arBadTgt = await req('POST', `/api/projects/${pid}/edges`, { sourceId: arMain.json.id, targetId: arM1.json.id, type: 'member' })
ok('member → feature rejected (warp or area only)', arBadTgt.status === 400 &&
  String(arBadTgt.json.error?.message ?? '').includes('warp or an area'), JSON.stringify(arBadTgt.json))

// area rollup: mean over members' effective progress; explicit wins; hasProgress false is UI-only
{
  let ag = await req('GET', `/api/projects/${pid}/graph`)
  const aNode = (idv) => ag.json.nodes.find((n) => n.id === idv)
  ok('area rolls up mean over members (0/50/100 → 50)', aNode(arMain.json.id)?.progressComputed === 50,
    JSON.stringify(aNode(arMain.json.id)?.progressComputed))
  const arExp = await req('PATCH', `/api/nodes/${arMain.json.id}`, { progress: 90 })
  ag = await req('GET', `/api/projects/${pid}/graph`)
  ok('explicit area progress beats member rollup', arExp.status === 200 && aNode(arMain.json.id)?.progressComputed === 90)
  await req('PATCH', `/api/nodes/${arMain.json.id}`, { progress: null })
  ag = await req('GET', `/api/projects/${pid}/graph`)
  ok('cleared area progress falls back to rollup', aNode(arMain.json.id)?.progressComputed === 50)
}

// backlog: components rank, areas never do, and AREA membership hides nothing
{
  const blW4 = await req('GET', `/api/projects/${pid}/backlog`)
  const ids = blW4.json.map((n) => n.id)
  ok('component ranks in backlog', ids.includes(cmpMain.json.id))
  ok('area excluded from backlog', !ids.includes(arMain.json.id))
  ok('area membership does NOT hide work from backlog', ids.includes(arM1.json.id) && ids.includes(arM2.json.id),
    JSON.stringify(blW4.json.filter((n) => [arM1.json.id, arM2.json.id].includes(n.id)).map((n) => n.title)))
  // warp membership still hides: put one area member into a warp too
  await req('POST', `/api/warps/${lkWarp.json.id}/members`, { nodeId: arM3.json.id })
  const blW4b = await req('GET', `/api/projects/${pid}/backlog`)
  ok('warp membership still hides (dual area+warp member)', !blW4b.json.some((n) => n.id === arM3.json.id))
}

// matrix rules — all four new defaults via bare linkTo
{
  // (1) new component + selected feature → selected feature —depends→ new component
  const mxF = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Matrix Feature' })
  const mxC = await req('POST', `/api/projects/${pid}/nodes`, { type: 'component', title: 'Matrix Component', linkTo: [{ nodeId: mxF.json.id }] })
  let d = await req('GET', `/api/nodes/${mxC.json.id}`)
  let rel = relOf(connWith(d.json.edges, 'depends'), 'depends')
  ok('matrix: new component + feature → feature —depends→ component', mxC.status === 200 && rel &&
    rel.sourceId === mxF.json.id && rel.targetId === mxC.json.id, JSON.stringify(d.json.edges))
  // (2) new feature + selected component → new feature —depends→ component
  const mxF2 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Matrix Feature 2', linkTo: [{ nodeId: mxC.json.id }] })
  d = await req('GET', `/api/nodes/${mxF2.json.id}`)
  rel = relOf(connWith(d.json.edges, 'depends'), 'depends')
  ok('matrix: new feature + component → new —depends→ component', mxF2.status === 200 && rel &&
    rel.sourceId === mxF2.json.id && rel.targetId === mxC.json.id, JSON.stringify(d.json.edges))
  // (3) new anything + selected area → new —member→ area
  const mxB = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Matrix Bug', linkTo: [{ nodeId: arMain.json.id }] })
  d = await req('GET', `/api/nodes/${mxB.json.id}`)
  rel = relOf(connWith(d.json.edges, 'member'), 'member')
  ok('matrix: new bug + area → new —member→ area', mxB.status === 200 && rel &&
    rel.sourceId === mxB.json.id && rel.targetId === arMain.json.id, JSON.stringify(d.json.edges))
  // (4) new area + selected work → selected —member→ new area
  const mxA = await req('POST', `/api/projects/${pid}/nodes`, { type: 'area', title: 'Matrix Area', linkTo: [{ nodeId: mxF.json.id }] })
  d = await req('GET', `/api/nodes/${mxA.json.id}`)
  rel = relOf(connWith(d.json.edges, 'member'), 'member')
  ok('matrix: new area + feature → feature —member→ new area', mxA.status === 200 && rel &&
    rel.sourceId === mxF.json.id && rel.targetId === mxA.json.id, JSON.stringify(d.json.edges))
}

// convert guards around area-ness
{
  // area with members → cannot leave containerhood
  const cvA = await req('POST', `/api/nodes/${arMain.json.id}/convert`, { type: 'feature' })
  ok('convert area with members → 400 naming them', cvA.status === 400 &&
    String(cvA.json.error?.message ?? '').includes(arE1.json.id), JSON.stringify(cvA.json))
  // area → warp keeps members legal (member targets warp OR area)
  const cvAW = await req('POST', `/api/nodes/${arMain.json.id}/convert`, { type: 'warp' })
  ok('area → warp with members allowed (stage seeded)', cvAW.status === 200 && cvAW.json.type === 'warp' && cvAW.json.stage === 'concept',
    JSON.stringify({ type: cvAW.json.type, stage: cvAW.json.stage }))
  const cvBack = await req('POST', `/api/nodes/${arMain.json.id}/convert`, { type: 'area' })
  ok('warp → area with members allowed back (stage cleared)', cvBack.status === 200 && cvBack.json.type === 'area' && cvBack.json.stage === null)
  // warp with outgoing addresses → cannot become an area (addresses must start at a warp)
  const cvW = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'Addressing Warp' })
  const cvT = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Addressed Bug' })
  const cvAddr = await req('POST', `/api/projects/${pid}/edges`, { sourceId: cvW.json.id, targetId: cvT.json.id, type: 'addresses' })
  const cvWA = await req('POST', `/api/nodes/${cvW.json.id}/convert`, { type: 'area' })
  ok('warp → area with outgoing addresses → 400', cvAddr.status === 200 && cvWA.status === 400 &&
    String(cvWA.json.error?.message ?? '').includes(cvAddr.json.id), JSON.stringify(cvWA.json))
}

// square shape: settings accepts it for any type; restore byte-equal after
{
  const stSq = await req('PATCH', '/api/settings', { styleOverrides: { nodes: { bug: { shape: 'square' } } } })
  ok('square shape accepted by settings sanitizer', stSq.status === 200 &&
    stSq.json.settings?.styleOverrides?.nodes?.bug?.shape === 'square', JSON.stringify(stSq.json.settings?.styleOverrides))
  const stSqRestore = await req('PATCH', '/api/settings', { styleOverrides: originalStyle, typeOrder: originalOrder })
  ok('square-shape probe restored settings', stSqRestore.status === 200 &&
    JSON.stringify(stSqRestore.json.settings?.styleOverrides ?? null) === JSON.stringify(originalStyle))
}

// rendering modes + inner glyphs: outer fill solid|outline, optional inner
// glyph (any shape or a ?|!|+|x|. symbol) with its own colour/fill, and the
// triangle-down shape — outer and inner. Self-cleaning: restored byte-equal.
{
  const stRM = await req('PATCH', '/api/settings', {
    styleOverrides: { nodes: {
      feature: { fill: 'outline', inner: { glyph: 'triangle-down', color: '#ABC', fill: 'outline' } },
      bug: { shape: 'triangle-down', inner: { glyph: '?', color: '#e6eaf2', fill: 'outline' } },
      warp: { inner: { glyph: '!' } }, // colour + fill omitted → defaults
      idea: { fill: 'sparkly', inner: { glyph: 'star', color: '#ffffff' } }, // all junk → entry vanishes
      question: { color: '#123456', fill: 'dotted' } // junk fill dropped, colour kept
    } }
  })
  const rm = stRM.json.settings?.styleOverrides?.nodes
  ok('outer fill + inner glyph round-trip (triangle-down inner, 3-digit hex expands)', stRM.status === 200 &&
    rm?.feature?.fill === 'outline' && rm?.feature?.inner?.glyph === 'triangle-down' &&
    rm?.feature?.inner?.color === '#aabbcc' && rm?.feature?.inner?.fill === 'outline', JSON.stringify(rm?.feature))
  ok('triangle-down accepted as an outer shape', rm?.bug?.shape === 'triangle-down', JSON.stringify(rm?.bug))
  ok('text-glyph inner fill normalizes to solid', rm?.bug?.inner?.glyph === '?' && rm?.bug?.inner?.fill === 'solid',
    JSON.stringify(rm?.bug?.inner))
  ok('inner colour/fill default when omitted', rm?.warp?.inner?.glyph === '!' && rm?.warp?.inner?.color === '#e6eaf2' &&
    rm?.warp?.inner?.fill === 'solid', JSON.stringify(rm?.warp))
  ok('junk fill + junk glyph dropped (emptied entry vanishes)', !!rm && !('idea' in rm), JSON.stringify(rm?.idea))
  ok('junk fill dropped while valid colour lands', rm?.question?.color === '#123456' && !('fill' in (rm?.question ?? {})),
    JSON.stringify(rm?.question))
  // untouched defaults stay byte-identical: a colour-only write sprouts no fill/inner keys
  const stPlain = await req('PATCH', '/api/settings', { styleOverrides: { nodes: { bug: { color: '#112233' } } } })
  const plainBug = stPlain.json.settings?.styleOverrides?.nodes?.bug
  ok('untouched entry carries no fill/inner keys (defaults byte-identical)', stPlain.status === 200 &&
    plainBug?.color === '#112233' && !('fill' in (plainBug ?? {})) && !('inner' in (plainBug ?? {})) &&
    !('shape' in (plainBug ?? {})), JSON.stringify(plainBug))
  const stRMRestore = await req('PATCH', '/api/settings', { styleOverrides: originalStyle, typeOrder: originalOrder })
  ok('rendering-mode probes restored byte-equal', stRMRestore.status === 200 &&
    JSON.stringify(stRMRestore.json.settings?.styleOverrides ?? null) === JSON.stringify(originalStyle))
}

// scope: one district as one payload — the agent context boundary
{
  // member-to-member connection inside the area (membership edges must NOT appear)
  const scDep = await req('POST', `/api/projects/${pid}/edges`, { sourceId: arM1.json.id, targetId: arM2.json.id, type: 'depends' })
  ok('scope fixture: member-to-member depends', scDep.status === 200)

  const sc = await req('GET', `/api/nodes/${arMain.json.id}/scope`)
  ok('scope 200 on an area', sc.status === 200 && sc.json.container?.id === arMain.json.id && typeof sc.json.now === 'number',
    JSON.stringify(sc.status))
  const scIds = (sc.json.members ?? []).map((m) => m.id)
  ok('area scope lists members with flags + progressComputed', scIds.includes(arM1.json.id) && scIds.includes(arM2.json.id) &&
    scIds.includes(arM3.json.id) && sc.json.members.every((m) => Array.isArray(m.flags) && typeof m.progressComputed === 'number'),
    JSON.stringify(sc.json.members?.map((m) => m.title)))
  ok('scope members sorted by title', JSON.stringify(scIds) ===
    JSON.stringify([...sc.json.members].sort((a, b) => a.title.localeCompare(b.title)).map((m) => m.id)))
  ok('scope connections = member-to-member only', sc.json.connections?.length === 1 &&
    sc.json.connections[0].id === scDep.json.id, JSON.stringify(sc.json.connections?.map((c) => c.id)))
  ok('scope without content flag omits bodies', sc.json.members.every((m) => m.content === undefined) &&
    sc.json.container.content === undefined)

  const scC = await req('GET', `/api/nodes/${arMain.json.id}/scope?content=1`)
  ok('scope content=1 includes bodies', scC.status === 200 && scC.json.members.every((m) => typeof m.content === 'string') &&
    String(scC.json.container.content ?? '').includes('Everything combat'), JSON.stringify(scC.json.container.content))

  // since-filtered activity: member + container rows only, strictly after T
  const tScope = (await req('GET', '/api/health')).json.at
  await new Promise((r) => setTimeout(r, 10))
  await req('PATCH', `/api/nodes/${arM1.json.id}`, { progress: 5 })
  await req('PATCH', `/api/nodes/${lkF2.json.id}`, { progress: 7 }) // NOT a member of the area
  const scS = await req('GET', `/api/nodes/${arMain.json.id}/scope?since=${tScope}`)
  ok('scope activity since-filtered to the member set', scS.status === 200 && scS.json.since === tScope &&
    scS.json.activity.some((a) => a.subjectId === arM1.json.id) &&
    !scS.json.activity.some((a) => a.subjectId === lkF2.json.id) &&
    scS.json.activity.every((a) => a.at > tScope),
    JSON.stringify(scS.json.activity.map((a) => [a.subjectId, a.summary])))
  const scAll = await req('GET', `/api/nodes/${arMain.json.id}/scope`)
  ok('scope activity includes the container itself', scAll.json.activity.some((a) => a.subjectId === arMain.json.id),
    JSON.stringify([...new Set(scAll.json.activity.map((a) => a.subjectId))]))

  // class container: class-of targets are the member set
  const scCls = await req('GET', `/api/nodes/${clsRunes.json.id}/scope`)
  const clsMemberIds = (scCls.json.members ?? []).map((m) => m.id)
  ok('class scope lists its instances', scCls.status === 200 && clsMemberIds.includes(instR[0].json.id) &&
    clsMemberIds.includes(instR[1].json.id) && clsMemberIds.includes(inTy.json.id) && !clsMemberIds.includes(instR[2].json.id),
    JSON.stringify(scCls.json.members?.map((m) => m.title)))

  // warp container: member relationships targeting the warp
  const scW = await req('GET', `/api/nodes/${lkWarp.json.id}/scope`)
  const wMemberIds = (scW.json.members ?? []).map((m) => m.id)
  ok('warp scope lists its members', scW.status === 200 && wMemberIds.includes(lkBug.json.id) && wMemberIds.includes(arM3.json.id),
    JSON.stringify(scW.json.members?.map((m) => m.title)))

  // non-container → valid, empty
  const scN = await req('GET', `/api/nodes/${cmpMain.json.id}/scope`)
  ok('non-container scope is valid + empty', scN.status === 200 && scN.json.members?.length === 0 &&
    scN.json.connections?.length === 0, JSON.stringify(scN.json.members))
  const scBad = await req('GET', `/api/nodes/${arMain.json.id}/scope?since=notanumber`)
  ok('scope bad since 400', scBad.status === 400)
}

// impact: blast radius — blocks (while unresolved) + reversed depends, transitive
{
  // (1) blocks chain A —blocks→ B —blocks→ C —blocks→ D; resolving C must cut D off
  const imA = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'Impact Root Bug' })
  const imB = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Impact Hop B' })
  const imC = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Impact Hop C' })
  const imD = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Impact Hop D' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imA.json.id, targetId: imB.json.id, type: 'blocks' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imB.json.id, targetId: imC.json.id, type: 'blocks' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imC.json.id, targetId: imD.json.id, type: 'blocks' })
  // membership annotations: B in an area, B in an open warp
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imB.json.id, targetId: arMain.json.id, type: 'member' })
  await req('POST', `/api/warps/${lkWarp.json.id}/members`, { nodeId: imB.json.id })
  let im = await req('GET', `/api/nodes/${imA.json.id}/impact`)
  const flatIds = (payload) => Object.values(payload.groups ?? {}).flat().map((e) => e.id)
  ok('impact walks the whole unresolved blocks chain', im.status === 200 &&
    [imB.json.id, imC.json.id, imD.json.id].every((idv) => flatIds(im.json).includes(idv)),
    JSON.stringify(im.json.groups))
  const imEntryB = Object.values(im.json.groups).flat().find((e) => e.id === imB.json.id)
  const imEntryD = Object.values(im.json.groups).flat().find((e) => e.id === imD.json.id)
  ok('impact tiers: direct at 1 hop, transitive beyond', imEntryB?.tier === 'direct' && imEntryD?.tier === 'transitive' &&
    imEntryD?.depth === 3, JSON.stringify([imEntryB?.tier, imEntryD?.tier, imEntryD?.depth]))
  ok('impact paths are title chains', imEntryD?.paths?.[0] === 'Impact Root Bug → Impact Hop B → Impact Hop C → Impact Hop D',
    JSON.stringify(imEntryD?.paths))
  ok('impact annotates containing areas + open warps', imEntryB?.areas?.some((a) => a.id === arMain.json.id) &&
    imEntryB?.warps?.some((w) => w.id === lkWarp.json.id) && im.json.counts.areas >= 1 && im.json.counts.warps >= 1,
    JSON.stringify({ areas: imEntryB?.areas, warps: imEntryB?.warps }))
  // resolve C → its blocks stop propagating: D leaves the blast radius, C stays in it
  await req('PATCH', `/api/nodes/${imC.json.id}`, { tags: ['done'] })
  im = await req('GET', `/api/nodes/${imA.json.id}/impact`)
  ok('resolved node breaks blocks propagation', flatIds(im.json).includes(imC.json.id) && !flatIds(im.json).includes(imD.json.id),
    JSON.stringify(flatIds(im.json)))

  // (2) reversed depends is transitive: cmp ←depends— F1 ←depends— F2
  const imF1 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Impact Requirer 1' })
  const imF2 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Impact Requirer 2' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imF1.json.id, targetId: cmpMain.json.id, type: 'depends' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imF2.json.id, targetId: imF1.json.id, type: 'depends' })
  const imCmp = await req('GET', `/api/nodes/${cmpMain.json.id}/impact`)
  ok('reversed depends walks requirers transitively', imCmp.status === 200 &&
    [imF1.json.id, imF2.json.id].every((idv) => flatIds(imCmp.json).includes(idv)),
    JSON.stringify(flatIds(imCmp.json)))
  ok('impact byType groups under plural keys', (imCmp.json.counts.byType.features ?? 0) >= 2,
    JSON.stringify(imCmp.json.counts))

  // (3) mixed traversal: from a blocks hit the walk continues over depends-in
  const imMix = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'Impact Mixed Requirer' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: imMix.json.id, targetId: imB.json.id, type: 'depends' })
  im = await req('GET', `/api/nodes/${imA.json.id}/impact`)
  ok('walk mixes blocks and reversed depends', flatIds(im.json).includes(imMix.json.id), JSON.stringify(flatIds(im.json)))

  // (4) depth cap + truncated flag: an 8-link depends chain off a fresh root
  const chain = []
  for (let i = 0; i <= 7; i++) {
    chain.push(await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: `Impact Chain ${i}` }))
  }
  for (let i = 0; i < 7; i++) {
    await req('POST', `/api/projects/${pid}/edges`, { sourceId: chain[i + 1].json.id, targetId: chain[i].json.id, type: 'depends' })
  }
  const imChain = await req('GET', `/api/nodes/${chain[0].json.id}/impact`)
  const chainIds = flatIds(imChain.json)
  ok('impact depth-capped at 6', imChain.status === 200 && chainIds.includes(chain[6].json.id) &&
    !chainIds.includes(chain[7].json.id) && imChain.json.depthCap === 6, JSON.stringify(chainIds.length))
  ok('truncated flag set at the cap', imChain.json.truncated === true)
  const imShort = await req('GET', `/api/nodes/${chain[5].json.id}/impact`)
  ok('truncated false inside the cap', imShort.status === 200 && imShort.json.truncated === false &&
    flatIds(imShort.json).length === 2, JSON.stringify(flatIds(imShort.json)))

  // (5) no downstream → clean empty payload
  const imNone = await req('GET', `/api/nodes/${chain[7].json.id}/impact`)
  ok('no-impact node returns empty groups', imNone.status === 200 && imNone.json.counts.total === 0 &&
    Object.keys(imNone.json.groups).length === 0)
}

// llms.txt documents the Warp 4 surface: axes, placement, conventions, scope,
// impact, sweep recipes, member-to-area semantics, the two new ontology entries
{
  const llmsW4 = await req('GET', '/llms.txt')
  const s = String(llmsW4.json)
  const keys = [
    'component  —', 'area       —',                       // ontology entries
    'The AXES', 'WHERE     areas', 'HOW       components', // axes table
    'PLACEMENT', 'a part that does a defined job',        // decision guide
    'Conventions (recognized, NEVER enforced',            // conventions
    'areas are FEW and STABLE', 'components are SINGULAR', 'instances are PLURAL',
    'member must target a warp OR',                       // validation
    'Member-to-area semantics',                           // semantics paragraph
    '/api/nodes/:id/scope', '/api/nodes/:id/impact',      // endpoints
    'Working a district', 'BLAST RADIUS',
    'Sweep checks', 'Orphan components', 'Unrealised features', 'Stale areas',
    'feature -depends→ new component'                     // matrix additions documented
  ]
  ok('llms.txt: Warp 4 keys all present', keys.every((k) => s.includes(k)),
    JSON.stringify(keys.filter((k) => !s.includes(k))))
  ok('llms.txt: area rollup in the progress paragraph', s.includes('areas roll up as the MEAN'))
  ok('llms.txt: areas routes note (member via edges)', s.includes('Areas            no dedicated routes'))
}

// ---------------------------------------------------------------------------
// THE REVIEW FLOW — "REVIEW is a stage of a Warp, which is a node." Feedback
// members attach to the node under review; synthesis is derives (N-to-1);
// dispositions are graph position; the forward-restage out of Review is the
// gated close; not_needed bypasses with auto-fold; a shipped warp with folded
// feedback IS the archived review.

{
  // the four record types creatable, right folders; no review type exists
  const thN = await req('POST', `/api/projects/${pid}/nodes`, { type: 'threat', title: 'RF Threat' })
  ok('threat creatable + Threats/', thN.status === 200 && String(thN.json.filePath ?? '').includes('Threats'), JSON.stringify(thN.json.filePath))
  const flN = await req('POST', `/api/projects/${pid}/nodes`, { type: 'flaw', title: 'RF Flaw' })
  ok('flaw creatable + Flaws/', flN.status === 200 && String(flN.json.filePath ?? '').includes('Flaws'), JSON.stringify(flN.json.filePath))
  const rvGone = await req('POST', `/api/projects/${pid}/nodes`, { type: 'review', title: 'nope' })
  ok('review node type does not exist', rvGone.status === 400)

  // threat + flaw rank in the backlog; feedback will not
  const blRF = await req('GET', `/api/projects/${pid}/backlog`)
  ok('threat + flaw in backlog', blRF.json.some((n) => n.id === thN.json.id) && blRF.json.some((n) => n.id === flN.json.id))

  // the warp under review + work member + a question for non-warp feedback
  const rfW = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'RF Warp', stage: 'implement' })
  const rfWork = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'RF Work', progress: 80, linkTo: [{ nodeId: rfW.json.id }] })
  const rfQ = await req('POST', `/api/projects/${pid}/nodes`, { type: 'question', title: 'RF Question' })
  ok('review-flow fixtures', rfW.status === 200 && rfWork.status === 200 && rfQ.status === 200)

  // feedback matrix default beside ANY node = member (it attaches to what it reviews)
  const fb1 = await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feedback', title: 'RF Obs 1', content: 'observation body', linkTo: [{ nodeId: rfW.json.id }]
  })
  ok('feedback creatable + Feedback/ + members the warp', fb1.status === 200 &&
    String(fb1.json.filePath ?? '').includes('Feedback'), JSON.stringify(fb1.json))
  let fbd = await req('GET', `/api/nodes/${fb1.json.id}`)
  const fbMem = relOf(connWith(fbd.json.edges, 'member'), 'member')
  ok('matrix: feedback —member→ warp', fbMem && fbMem.sourceId === fb1.json.id && fbMem.targetId === rfW.json.id, JSON.stringify(fbd.json.edges))

  // feedback may member ANY node; other types may not
  const fb2 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'RF Obs on question', linkTo: [{ nodeId: rfQ.json.id }] })
  ok('feedback member → question legal', fb2.status === 200, JSON.stringify(fb2.json))
  const badMem = await req('POST', `/api/projects/${pid}/edges`, { sourceId: rfWork.json.id, targetId: rfQ.json.id, type: 'member' })
  ok('non-feedback member → non-container still 400', badMem.status === 400 &&
    String(badMem.json.error?.message ?? '').includes('feedback'), JSON.stringify(badMem.json))

  // "discusses" association: bare labelled connection
  const disc = await req('POST', `/api/projects/${pid}/edges`, { sourceId: fb1.json.id, targetId: rfWork.json.id, type: 'relates', label: 'discusses' })
  ok('discusses association (labelled bare connection)', disc.status === 200 && disc.json.label === 'discusses' && rels(disc.json).length === 0)

  // feedback is invisible to work accounting: rollup, warp summary, backlog
  let gRF = await req('GET', `/api/projects/${pid}/graph`)
  const nRF = (id) => gRF.json.nodes.find((n) => n.id === id)
  ok('warp rollup excludes feedback (80 not 40)', nRF(rfW.json.id)?.progressComputed === 80, JSON.stringify(nRF(rfW.json.id)?.progressComputed))
  const wlRF = await req('GET', `/api/projects/${pid}/warps`)
  const wsRF = wlRF.json.find((x) => x.warp.id === rfW.json.id)
  ok('warp summary members exclude feedback', wsRF?.members?.length === 1 && wsRF.members[0].id === rfWork.json.id,
    JSON.stringify(wsRF?.members?.map((m) => m.title)))
  const blRF2 = await req('GET', `/api/projects/${pid}/backlog`)
  ok('feedback not in backlog', !blRF2.json.some((n) => n.id === fb1.json.id || n.id === fb2.json.id))

  // scope of the warp returns feedback members alongside the work
  const scRF = await req('GET', `/api/nodes/${rfW.json.id}/scope`)
  ok('warp scope lists feedback + work members', scRF.status === 200 &&
    scRF.json.members.some((m) => m.id === fb1.json.id) && scRF.json.members.some((m) => m.id === rfWork.json.id),
    JSON.stringify(scRF.json.members?.map((m) => [m.title, m.type])))

  // THE GATE: review→ship 409s with offender lists until fully actioned
  await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'review' })
  let gate = await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'ship' })
  ok('review→ship 409 on undesignated feedback', gate.status === 409, JSON.stringify(gate.status))
  ok('409 offenders name the feedback', gate.json.error?.offenders?.undesignated?.some((o) => o.id === fb1.json.id),
    JSON.stringify(gate.json.error?.offenders))
  const back = await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'implement' })
  ok('backward restage always free', back.status === 200 && back.json.stage === 'implement')
  await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'review' })

  // synthesis N-to-1: one action derived from TWO feedback (fb1 + fb3)
  const fb3 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'RF Obs 2', linkTo: [{ nodeId: rfW.json.id }] })
  const act = await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'action', title: 'RF Synthesized Fix', linkTo: [{ nodeId: fb1.json.id }, { nodeId: fb3.json.id }]
  })
  ok('synthesis: action created from 2 feedback', act.status === 200, JSON.stringify(act.json))
  const actD = await req('GET', `/api/nodes/${act.json.id}`)
  const derIn = actD.json.edges.flatMap((e) => rels(e).filter((x) => x.type === 'derives' && x.targetId === act.json.id))
  ok('derives provenance N-to-1 (both feedback → one action)', derIn.length === 2 &&
    [fb1.json.id, fb3.json.id].every((idv) => derIn.some((x) => x.sourceId === idv)), JSON.stringify(actD.json.edges))

  // Synthesis scopes NOTHING (faykarta): the new action carries its derives
  // provenance and no disposition — no member edge into the warp, no blocks
  // edge. Choosing "action now" / "action later" is a separate, explicit
  // gesture in the lens. (The 409 test immediately below is the other half of
  // the rule: an UNDISPOSED action still counts as outstanding at the gate.)
  const actTouching = actD.json.edges.flatMap((e) => rels(e)).filter((r) =>
    (r.sourceId === act.json.id || r.targetId === act.json.id) &&
    (r.sourceId === rfW.json.id || r.targetId === rfW.json.id))
  ok('synthesis leaves the action undisposed (no member/blocks into the warp)',
    !actTouching.some((r) => r.type === 'member' || r.type === 'blocks'), JSON.stringify(actTouching))

  // considered-but-pending: the gate still refuses while the action lives
  gate = await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'ship' })
  ok('409 while synthesized action pends', gate.status === 409 &&
    gate.json.error?.offenders?.pendingActions?.some((o) => o.id === act.json.id &&
      o.feedbackIds.includes(fb1.json.id) && o.feedbackIds.includes(fb3.json.id)),
    JSON.stringify(gate.json.error?.offenders))

  // action-now disposition: the action blocks the warp → Blocked ring
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: act.json.id, targetId: rfW.json.id, type: 'blocks' })
  gRF = await req('GET', `/api/projects/${pid}/graph`)
  ok('action-now: warp rings Blocked', nRF(rfW.json.id)?.flags?.includes('Blocked'), JSON.stringify(nRF(rfW.json.id)?.flags))

  // WAIVE: 400 without note; covered (into) labels the edge; distinct activity
  const waiveBad = await req('POST', `/api/nodes/${fb1.json.id}/waive`, {})
  ok('waive without note 400', waiveBad.status === 400 && String(waiveBad.json.error?.message ?? '').includes('note'))
  const waiveNon = await req('POST', `/api/nodes/${rfWork.json.id}/waive`, { note: 'nope' })
  ok('waive non-record 400', waiveNon.status === 400)
  const done1 = await req('POST', `/api/nodes/${act.json.id}/complete`, { note: 'absorbed' })
  ok('synthesized action completes', done1.status === 200)
  const waive1 = await req('POST', `/api/nodes/${fb1.json.id}/waive`, { note: 'covered by the fix', into: rfWork.json.id })
  ok('waive covered 200 + pruned tag', waive1.status === 200 && waive1.json.tags?.includes('pruned'), JSON.stringify(waive1.json.tags))
  fbd = await req('GET', `/api/nodes/${fb1.json.id}`)
  const waiveEdge = fbd.json.edges.find((e) => e.label.includes('waived into'))
  ok('waived-into edge labelled, bare', !!waiveEdge && rels(waiveEdge).length === 0, JSON.stringify(fbd.json.edges))
  // fb1 already DISCUSSED rfWork, and one pair carries one connection: the waive
  // composes onto the label instead of erasing the review trail it found there
  ok('waiving into a node it discusses keeps both facts on the connection',
    !!waiveEdge && waiveEdge.label.includes('discusses') && waiveEdge.label.includes('waived into'),
    JSON.stringify(waiveEdge?.label))
  const waive2 = await req('POST', `/api/nodes/${fb3.json.id}/waive`, { note: 'observation waived — superseded by the fix' })
  ok('flat waive 200 (no into)', waive2.status === 200 && waive2.json.tags?.includes('pruned'))
  {
    const acts = await req('GET', `/api/projects/${pid}/activity?limit=30`)
    ok('node.waived activity distinct from node.pruned', acts.json.some((a) => a.action === 'node.waived' && a.subjectId === fb1.json.id) &&
      acts.json.some((a) => a.action === 'node.waived' && a.detail?.into === rfWork.json.id),
      JSON.stringify(acts.json.filter((a) => a.action === 'node.waived').map((a) => a.summary)))
    ok('activity phrasing says waived, never folded',
      acts.json.filter((a) => a.subjectId === fb1.json.id).every((a) => !/fold/i.test(a.summary)),
      JSON.stringify(acts.json.filter((a) => a.subjectId === fb1.json.id).map((a) => a.summary)))
  }
  gRF = await req('GET', `/api/projects/${pid}/graph`)
  ok('waived feedback dims (Pruned) + warp un-blocks after complete', nRF(fb1.json.id)?.flags?.includes('Pruned') &&
    !nRF(rfW.json.id)?.flags?.includes('Blocked'), JSON.stringify([nRF(fb1.json.id)?.flags, nRF(rfW.json.id)?.flags]))

  // Designation must not silently scope a finding into the increment
  // (faykarta): convert PRESERVES warp memberships, so the lens now removes the
  // member RELATIONSHIP unless the human ticks "keep it inside this warp".
  // Removing it leaves the bare connection — association survives membership —
  // and the unscoped finding becomes free backlog work. A designated finding is
  // out of the fully-actioned math either way (it is no longer feedback).
  {
    const dFb = await req('POST', `/api/projects/${pid}/nodes`,
      { type: 'feedback', title: 'RF Designate Me', linkTo: [{ nodeId: rfW.json.id }] })
    const dConv = await req('POST', `/api/nodes/${dFb.json.id}/convert`, { type: 'bug' })
    const dAfterConv = await req('GET', `/api/nodes/${dFb.json.id}`)
    const memberEdge = connWith(dAfterConv.json.edges, 'member')
    ok('designate: convert alone would keep the warp membership', dConv.status === 200 && !!memberEdge,
      JSON.stringify(dAfterConv.json.edges))
    const rm = await req('DELETE', `/api/edges/${memberEdge.id}/relationships/member`)
    ok('designate: unscoping drops only the membership', rm.status === 200, JSON.stringify(rm.json))
    const dAfterRm = await req('GET', `/api/nodes/${dFb.json.id}`)
    const bare = dAfterRm.json.edges.find((e) => e.id === memberEdge.id)
    ok('unscoped finding keeps a bare connection back to the warp',
      !!bare && rels(bare).length === 0, JSON.stringify(dAfterRm.json.edges))
    const bk = await req('GET', `/api/projects/${pid}/backlog`)
    ok('unscoped finding becomes free backlog work', bk.json.some((n) => n.id === dFb.json.id),
      JSON.stringify(bk.json.map((n) => n.id)))
  }

  // DESIGNATION: convert keeps warp membership; non-container membership guards it
  // (filed BEFORE the close — a warp past Review takes no new feedback, below)
  const fb4 = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'RF Becomes Flaw', linkTo: [{ nodeId: rfW.json.id }] })
  const desig = await req('POST', `/api/nodes/${fb4.json.id}/convert`, { type: 'flaw' })
  ok('designation feedback→flaw keeps warp membership', desig.status === 200 && desig.json.type === 'flaw' &&
    desig.json.edges.some((e) => hasRel(e, 'member')), JSON.stringify(desig.json.edges))
  const desigBad = await req('POST', `/api/nodes/${fb2.json.id}/convert`, { type: 'bug' })
  ok('designation guarded by non-container membership (fb on question)', desigBad.status === 400 &&
    String(desigBad.json.error?.message ?? '').includes('membership'), JSON.stringify(desigBad.json))

  // A finding designated IN PLACE and KEPT inside the warp is work in the
  // increment now — so coverage wants a line of feedback about it like any other
  // member. (The lens's default is the other way: designating unscopes, and an
  // unscoped finding is not part of what was built.)
  gate = await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'ship' })
  ok('a designated finding kept in the warp is a member coverage applies to',
    gate.status === 409 && gate.json.error?.offenders?.uncovered?.some((o) => o.id === fb4.json.id),
    JSON.stringify(gate.json.error?.offenders?.uncovered))
  const fbFlaw = await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feedback', title: 'RF flaw noted', linkTo: [{ nodeId: fb4.json.id }]
  })
  await req('POST', `/api/nodes/${fbFlaw.json.id}/waive`, { note: 'the flaw is the observation' })

  // fully actioned → the gate opens; shipping IS the close
  gate = await req('PATCH', `/api/nodes/${rfW.json.id}`, { stage: 'ship' })
  ok('review→ship passes at fully-actioned', gate.status === 200 && gate.json.stage === 'ship', JSON.stringify(gate.json))

  // CLOSED REVIEW takes no new material — the service refuses it, so agents and
  // the lens hit the same wall (the lens simply does not offer shipped warps)
  const lateFb = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'RF Too Late', linkTo: [{ nodeId: rfW.json.id }] })
  ok('feedback onto a SHIPPED warp refused (closed review)', lateFb.status === 400 &&
    String(lateFb.json.error?.message ?? '').includes('closed review'), JSON.stringify(lateFb.json))
  {
    // the node was created before the link failed — it exists, unassigned
    const orphanId = lateFb.json.error?.nodeId ?? lateFb.json.id
    if (orphanId) {
      const mem = await req('POST', `/api/projects/${pid}/edges`, { sourceId: orphanId, targetId: rfW.json.id, type: 'member' })
      ok('member edge onto a shipped warp refused too (same guard, edge route)', mem.status === 400 &&
        String(mem.json.error?.message ?? '').includes('closed review'), JSON.stringify(mem.json))
    } else {
      ok('member edge onto a shipped warp refused too (same guard, edge route)', false, 'no node id returned')
    }
  }

  // THREATENED: threat-blocks ring; bug-blocks stay plain Blocked
  const thTarget = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'RF Threatened Warp' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: thN.json.id, targetId: thTarget.json.id, type: 'blocks' })
  const bugTarget = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'RF Bug Blocked' })
  const rfBug = await req('POST', `/api/projects/${pid}/nodes`, { type: 'bug', title: 'RF Blocker', linkTo: [{ nodeId: bugTarget.json.id, type: 'blocks', outgoing: true }] })
  ok('threatened fixtures', thTarget.status === 200 && bugTarget.status === 200 && rfBug.status === 200)
  gRF = await req('GET', `/api/projects/${pid}/graph`)
  ok('threat-blocked warp rings Threatened + Blocked', nRF(thTarget.json.id)?.flags?.includes('Threatened') &&
    nRF(thTarget.json.id)?.flags?.includes('Blocked'), JSON.stringify(nRF(thTarget.json.id)?.flags))
  ok('bug-blocked node stays plain Blocked (no Threatened)', nRF(bugTarget.json.id)?.flags?.includes('Blocked') &&
    !nRF(bugTarget.json.id)?.flags?.includes('Threatened'), JSON.stringify(nRF(bugTarget.json.id)?.flags))
  // resolve the threat → both rings clear (suppression)
  await req('PATCH', `/api/nodes/${thN.json.id}`, { tags: ['done'] })
  gRF = await req('GET', `/api/projects/${pid}/graph`)
  ok('resolved threat un-rings Threatened', !nRF(thTarget.json.id)?.flags?.includes('Threatened') &&
    !nRF(thTarget.json.id)?.flags?.includes('Blocked'), JSON.stringify(nRF(thTarget.json.id)?.flags))

  // sourceType condition sanitizer: junk sourceType drops to any-source
  {
    const st0RF = await req('GET', '/api/settings')
    const withJunk = [...st0RF.json.flags, { id: 'fl_srctest', name: 'SrcTest', treatment: 'badge', color: '#123123',
      conditions: [{ kind: 'incoming-edge', edgeType: 'blocks', sourceType: 'threat' }, { kind: 'incoming-edge', edgeType: 'depends', sourceType: 'bogus' }] }]
    const stP = await req('PATCH', '/api/settings', { flags: withJunk })
    const rule = stP.json.settings?.flags?.find((f) => f.id === 'fl_srctest')
    ok('sourceType condition round-trips; junk sourceType dropped', stP.status === 200 &&
      rule?.conditions?.[0]?.sourceType === 'threat' && rule?.conditions?.[1]?.sourceType === undefined,
      JSON.stringify(rule?.conditions))
    const stR = await req('PATCH', '/api/settings', { flags: st0RF.json.flags })
    ok('sourceType probe restored', stR.status === 200 && !stR.json.settings?.flags?.some((f) => f.id === 'fl_srctest'))
  }

  // NOT-NEEDED bypass: open feedback auto-folds "warp abandoned"
  const abW = await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'RF Abandoned', stage: 'review' })
  const abF = await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'RF Orphan Obs', linkTo: [{ nodeId: abW.json.id }] })
  const abGate = await req('PATCH', `/api/nodes/${abW.json.id}`, { stage: 'not_needed' })
  ok('not_needed bypass allowed with open feedback', abGate.status === 200 && abGate.json.stage === 'not_needed')
  {
    const d = await req('GET', `/api/nodes/${abF.json.id}`)
    ok('abandoned feedback auto-folded with the note', d.json.tags?.includes('pruned') &&
      d.json.annotations?.some((a) => a.body.includes('warp abandoned')), JSON.stringify(d.json.annotations))
  }

  // sweep: warps only; event lands on SSE (checked in the events section below)
  const sw = await req('POST', `/api/nodes/${abW.json.id}/request-sweep`)
  ok('request-sweep on a warp 200 + warpId', sw.status === 200 && sw.json.warpId === abW.json.id, JSON.stringify(sw.json))
  const swBad = await req('POST', `/api/nodes/${rfWork.json.id}/request-sweep`)
  ok('request-sweep on a non-warp 400', swBad.status === 400)
}

// ---------------------------------------------------------------------------
// FULLY-ACTIONED, the four requirements. The loop is: prioritise, designate
// every piece of feedback (an action, or a waive — waive IS an action and it
// undoes), dispose of every action (address-now = member + blocks · address-
// later = converted), and clear the blockers. The gate reads all four; a warp
// sent back keeps its review, and the gate follows it.

{
  const W = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'CL Warp', stage: 'review' })).json
  const workA = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'CL Work A', linkTo: [{ nodeId: W.id }] })).json
  const workB = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'feature', title: 'CL Work B', linkTo: [{ nodeId: W.id }] })).json
  const gateOf = async () => req('PATCH', `/api/nodes/${W.id}`, { stage: 'ship' })

  // 1. COVERAGE — an increment nobody reviewed is not a reviewed increment.
  //    The old gate was vacuous here: no feedback meant nothing to action.
  let g1 = await gateOf()
  ok('coverage: a warp with unreviewed members cannot ship', g1.status === 409, JSON.stringify(g1.status))
  ok('coverage: offenders name every uncovered member',
    [workA.id, workB.id].every((idv) => g1.json.error?.offenders?.uncovered?.some((o) => o.id === idv)),
    JSON.stringify(g1.json.error?.offenders?.uncovered))

  // a feedback that DISCUSSES a member covers it — confirmation counts, so
  // "this matches the spec" is a legitimate review result
  const fbA = (await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feedback', title: 'CL A looks right', content: '## Observed\n\nMatches the spec.\n',
    // explicit relates: the matrix default for feedback beside a node is MEMBER,
    // and this half of the test is the "discusses" association instead
    linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }, { nodeId: workA.id, type: 'relates' }]
  })).json
  {
    const d = await req('GET', `/api/nodes/${fbA.id}`)
    const bare = d.json.edges.find((e) => rels(e).length === 0 &&
      (e.sourceId === workA.id || e.targetId === workA.id))
    ok('feedback can "discusses"-associate a member (bare connection)', !!bare, JSON.stringify(d.json.edges))
    await req('PATCH', `/api/edges/${bare.id}`, { label: 'discusses' })
  }
  g1 = await gateOf()
  ok('coverage: a "discusses" feedback covers its member', g1.status === 409 &&
    !g1.json.error?.offenders?.uncovered?.some((o) => o.id === workA.id) &&
    g1.json.error?.offenders?.uncovered?.some((o) => o.id === workB.id),
    JSON.stringify(g1.json.error?.offenders?.uncovered))

  // feedback membering a node covers it too (it attaches to what it reviews).
  // This one reviews workB WITHOUT joining the warp: it is not review material
  // for this gate, only coverage of the node it is about.
  const fbCov = (await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feedback', title: 'CL B needs a rename', linkTo: [{ nodeId: workB.id }]
  })).json
  g1 = await gateOf()
  ok('coverage: feedback membering a member covers it', g1.status === 409 &&
    (g1.json.error?.offenders?.uncovered ?? []).length === 0,
    JSON.stringify(g1.json.error?.offenders?.uncovered))

  // 2. DESIGNATION — every feedback derives something, or is waived.
  ok('designation: undesignated feedback holds the gate',
    g1.json.error?.offenders?.undesignated?.some((o) => o.id === fbA.id),
    JSON.stringify(g1.json.error?.offenders?.undesignated))

  // a second warp-membering observation, so the gate keeps holding while the
  // designation of the first one is exercised (this run must never ship early)
  const fbHold = (await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feedback', title: 'CL second observation',
    linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }]
  })).json

  //    WAIVE IS AN ACTION: settling with a rationale designates it.
  const wv = await req('POST', `/api/nodes/${fbA.id}/waive`, { note: 'confirmation — nothing to change' })
  ok('waive 200 + pruned tag', wv.status === 200 && wv.json.tags?.includes('pruned'))
  g1 = await gateOf()
  ok('designation: a waived feedback is designated',
    g1.status === 409 && !g1.json.error?.offenders?.undesignated?.some((o) => o.id === fbA.id) &&
    g1.json.error?.offenders?.undesignated?.some((o) => o.id === fbHold.id),
    JSON.stringify(g1.json.error?.offenders?.undesignated))

  //    UNDO — waive must be reversible while the review is open, through a real
  //    verb (unwaive), not by hand-editing tags.
  const unfBad = await req('POST', `/api/nodes/${fbHold.id}/unwaive`, {})
  ok('unwaive on a node that is not waived 400', unfBad.status === 400 &&
    String(unfBad.json.error?.message ?? '').includes('nothing to undo'), JSON.stringify(unfBad.json))
  const unf = await req('POST', `/api/nodes/${fbA.id}/unwaive`, { note: 'reopened — it deserves an action after all' })
  ok('unwaive 200 + pruned tag gone', unf.status === 200 && !unf.json.tags?.includes('pruned'), JSON.stringify(unf.json.tags))
  g1 = await gateOf()
  ok('undo-waive re-opens the designation requirement',
    g1.json.error?.offenders?.undesignated?.some((o) => o.id === fbA.id),
    JSON.stringify(g1.json.error?.offenders?.undesignated))
  {
    const acts = await req('GET', `/api/projects/${pid}/activity?limit=30`)
    ok('node.unwaived is logged, distinct from node.waived',
      acts.json.some((a) => a.action === 'node.unwaived' && a.subjectId === fbA.id),
      JSON.stringify(acts.json.slice(0, 5).map((a) => a.action)))
  }
  //    unwaive also takes the "waived into" edge with it
  {
    await req('POST', `/api/nodes/${fbA.id}/waive`, { note: 'covered', into: workA.id })
    const waived = await req('GET', `/api/nodes/${fbA.id}`)
    ok('waive-covered marks the connection "waived into"', waived.json.edges.some((e) => e.label.includes('waived into')))
    await req('POST', `/api/nodes/${fbA.id}/unwaive`, {})
    const back = await req('GET', `/api/nodes/${fbA.id}`)
    ok('unwaive drops the waive label', !back.json.edges.some((e) => e.label.includes('waived into')),
      JSON.stringify(back.json.edges.map((e) => e.label)))
    // the waive landed on the connection that already said "discusses" — undoing
    // the waive must not take the review trail (and the coverage) with it
    ok('unwaive keeps the association it found there ("discusses" survives)',
      back.json.edges.some((e) => e.label === 'discusses' && (e.sourceId === workA.id || e.targetId === workA.id)),
      JSON.stringify(back.json.edges.map((e) => [e.label, rels(e).length])))
    ok('unwaive keeps the rationale trail (annotations survive)', (back.json.annotations ?? []).length >= 2,
      JSON.stringify((back.json.annotations ?? []).map((a) => a.body)))
    // a waive that DREW its own connection takes it away again
    const solo = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'CL Solo Waive' })).json
    await req('POST', `/api/nodes/${solo.id}/waive`, { note: 'covered', into: workB.id })
    await req('POST', `/api/nodes/${solo.id}/unwaive`, {})
    const soloBack = await req('GET', `/api/nodes/${solo.id}`)
    ok('unwaive deletes a connection the waive itself drew',
      !soloBack.json.edges.some((e) => e.sourceId === workB.id || e.targetId === workB.id),
      JSON.stringify(soloBack.json.edges.map((e) => e.label)))
  }

  // ---- the `fold` ALIAS: the verb was renamed, nothing in flight may break --
  // Every spelling of the old verb still has to reach the new handler, and a
  // connection an OLD waive labelled "folded into" still has to unwaive.
  {
    const al = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'feedback', title: 'CL Alias observation',
      linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }]
    })).json
    const aliasFold = await req('POST', `/api/nodes/${al.id}/fold`, { note: 'waived through the legacy verb', into: workA.id })
    ok('alias: POST /fold still waives', aliasFold.status === 200 && aliasFold.json.tags?.includes('pruned'),
      JSON.stringify(aliasFold.json?.tags ?? aliasFold.json))
    const aliasDetail = await req('GET', `/api/nodes/${al.id}`)
    ok('alias: the legacy verb writes the NEW label',
      aliasDetail.json.edges.some((e) => e.label.includes('waived into')),
      JSON.stringify(aliasDetail.json.edges.map((e) => e.label)))
    const aliasUnfold = await req('POST', `/api/nodes/${al.id}/unfold`, { note: 'and back again' })
    ok('alias: POST /unfold still unwaives', aliasUnfold.status === 200 && !aliasUnfold.json.tags?.includes('pruned'),
      JSON.stringify(aliasUnfold.json?.tags ?? aliasUnfold.json))
    // legacy DATA: a connection labelled "folded into" by an older waive
    const legacyConn = (await req('POST', `/api/projects/${pid}/edges`, {
      sourceId: al.id, targetId: workB.id, type: 'relates', label: 'folded into'
    })).json
    await req('POST', `/api/nodes/${al.id}/waive`, { note: 'legacy-label check' })
    await req('POST', `/api/nodes/${al.id}/unwaive`, {})
    const legacyBack = await req('GET', `/api/nodes/${al.id}`)
    ok('unwaive clears a legacy "folded into" label too',
      !legacyBack.json.edges.some((e) => e.id === legacyConn.id),
      JSON.stringify(legacyBack.json.edges.map((e) => e.label)))
    await req('POST', `/api/nodes/${al.id}/waive`, { note: 'settled, so the gate math is unchanged' })
  }

  // ---- PASS: coverage + designation in ONE call ----------------------------
  // The coverage rule's ergonomic answer (faykarta: "Need to be able to waive
  // items directly on the INCREMENT panel"). One POST does what used to be
  // three: file the feedback, label the pair so coverage counts it, waive it.
  {
    const passWork = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'bug', title: 'CL Pass target (a BUG, the type filing used to miss)',
      linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }]
    })).json
    let gp = await gateOf()
    ok('pass: the fresh member starts UNCOVERED',
      gp.status === 409 && gp.json.error?.offenders?.uncovered?.some((o) => o.id === passWork.id),
      JSON.stringify(gp.json.error?.offenders?.uncovered))

    const passed = await req('POST', `/api/nodes/${passWork.id}/pass`, {
      warpId: W.id, body: 'matches the spec — nothing to raise'
    })
    ok('pass 200 + the shipped title', passed.status === 200 && passed.json.title === 'Pass - Feedback Waived',
      JSON.stringify(passed.json?.title ?? passed.json))
    ok('pass waives on the spot (pruned tag)', passed.json.tags?.includes('pruned'), JSON.stringify(passed.json.tags))
    const pd = await req('GET', `/api/nodes/${passed.json.id}`)
    ok('pass: the typed text IS the body', String(pd.json.content).includes('matches the spec'), JSON.stringify(pd.json.content))
    ok('pass: the typed text IS the waive rationale',
      (pd.json.annotations ?? []).some((a) => a.body.includes('matches the spec')),
      JSON.stringify((pd.json.annotations ?? []).map((a) => a.body)))
    ok('pass: members the warp AND discusses the node',
      pd.json.edges.some((e) => rels(e).some((r) => r.type === 'member' && r.targetId === W.id)) &&
      pd.json.edges.some((e) => e.label.includes('discusses') &&
        (e.sourceId === passWork.id || e.targetId === passWork.id)),
      JSON.stringify(pd.json.edges.map((e) => [e.label, rels(e).map((r) => r.type)])))

    gp = await gateOf()
    ok('pass: the member is COVERED and the feedback DESIGNATED — the gate stops naming both',
      !gp.json.error?.offenders?.uncovered?.some((o) => o.id === passWork.id) &&
      !gp.json.error?.offenders?.undesignated?.some((o) => o.id === passed.json.id),
      JSON.stringify(gp.json.error?.offenders))

    // pass without warpId resolves the one open warp the node members
    const passWork2 = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'feature', title: 'CL Pass target 2', linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }]
    })).json
    const passed2 = await req('POST', `/api/nodes/${passWork2.id}/pass`, { body: 'confirmed' })
    ok('pass: warpId optional when the member sits in exactly one open warp', passed2.status === 200,
      JSON.stringify(passed2.json))
    // and it refuses review MATERIAL — pass covers reviewed work, not observations
    const passBad = await req('POST', `/api/nodes/${passed.json.id}/pass`, { warpId: W.id, body: 'x' })
    ok('pass on a feedback node 400', passBad.status === 400 &&
      String(passBad.json.error?.message ?? '').includes('review material'), JSON.stringify(passBad.json))
    // an unwaive puts the observation back in front of the gate, so the toast's Undo is real
    await req('POST', `/api/nodes/${passed2.json.id}/unwaive`, {})
    gp = await gateOf()
    ok('pass undoes: unwaiving the pass re-opens the designation',
      gp.json.error?.offenders?.undesignated?.some((o) => o.id === passed2.json.id),
      JSON.stringify(gp.json.error?.offenders?.undesignated))
    await req('POST', `/api/nodes/${passed2.json.id}/waive`, { note: 'confirmed (re-waived)' })
  }

  // ---- FILING a labelled association in ONE call ---------------------------
  // The room files an observation and then links it to the member it covers.
  // That link used to be create-then-refetch-then-PATCH-the-label; it is one
  // labelled edges.create now, because a half-done filing left the member
  // uncovered with nothing the reviewer could act on.
  {
    const fbTarget = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'bug', title: 'CL Filing target (bug)', linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }]
    })).json
    const obs = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'feedback', title: 'CL Filed against a bug',
      linkTo: [{ nodeId: W.id, type: 'member', outgoing: true }]
    })).json
    const conn = await req('POST', `/api/projects/${pid}/edges`, {
      sourceId: obs.id, targetId: fbTarget.id, type: 'relates', label: 'discusses'
    })
    ok('filing: one call creates the association ALREADY labelled "discusses"',
      conn.status === 200 && conn.json.label === 'discusses' && rels(conn.json).length === 0,
      JSON.stringify([conn.status, conn.json?.label]))
    const gf = await gateOf()
    ok('filing: a bug-type member is covered by that association',
      !gf.json.error?.offenders?.uncovered?.some((o) => o.id === fbTarget.id),
      JSON.stringify(gf.json.error?.offenders?.uncovered))
    await req('POST', `/api/nodes/${obs.id}/waive`, { note: 'filed, covered, settled' })
  }

  // 3. DISPOSITION — an action must be addressed now or later; undisposed pends.
  const act = (await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'action', title: 'CL Rename B', linkTo: [{ nodeId: fbA.id }, { nodeId: fbHold.id }]
  })).json
  g1 = await gateOf()
  ok('disposition: an UNDISPOSED action holds the gate, and says so',
    g1.json.error?.offenders?.pendingActions?.some((o) => o.id === act.id && o.disposition === 'undisposed'),
    JSON.stringify(g1.json.error?.offenders?.pendingActions))
  //    address now = member + blocks (it joins the increment AND gates it)
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: act.id, targetId: W.id, type: 'member' })
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: act.id, targetId: W.id, type: 'blocks' })
  g1 = await gateOf()
  ok('disposition: address-now still pends, now labelled',
    g1.json.error?.offenders?.pendingActions?.some((o) => o.id === act.id && o.disposition === 'address-now'),
    JSON.stringify(g1.json.error?.offenders?.pendingActions))
  ok('an address-now action is not double-listed as a blocker',
    !g1.json.error?.offenders?.blockers?.some((o) => o.id === act.id),
    JSON.stringify(g1.json.error?.offenders?.blockers))
  ok('an action member is exempt from the coverage rule (it is review output)',
    !g1.json.error?.offenders?.uncovered?.some((o) => o.id === act.id),
    JSON.stringify(g1.json.error?.offenders?.uncovered))
  const doneAct = await req('POST', `/api/nodes/${act.id}/complete`, { note: 'renamed' })
  ok('completing an action removes it — and its derives go with it', doneAct.status === 200)
  g1 = await gateOf()
  ok('a completed action leaves its feedback undesignated again (waive or re-derive)',
    g1.status === 409 && [fbA.id, fbHold.id].every((idv) =>
      g1.json.error?.offenders?.undesignated?.some((o) => o.id === idv)),
    JSON.stringify(g1.json.error?.offenders?.undesignated))

  // 4. BLOCKS — the gate reads blocks edges now (it did not before): an
  //    unresolved node blocking the warp holds the ship, and a FIXED one stops.
  const blocker = (await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'bug', title: 'CL Blocking Bug', linkTo: [{ nodeId: W.id, type: 'blocks', outgoing: true }]
  })).json
  await req('POST', `/api/nodes/${fbA.id}/waive`, { note: 'covered by the rename' })
  await req('POST', `/api/nodes/${fbHold.id}/waive`, { note: 'covered by the rename' })
  g1 = await gateOf()
  ok('blocks: an unresolved blocker refuses the close', g1.status === 409 &&
    g1.json.error?.offenders?.blockers?.some((o) => o.id === blocker.id && o.type === 'bug'),
    JSON.stringify(g1.json.error?.offenders))
  //    the blocker is also a work member here — but it came from no feedback, so
  //    coverage wants one; file it, then resolve the bug
  await req('POST', `/api/projects/${pid}/edges`, { sourceId: blocker.id, targetId: W.id, type: 'member' })
  const fbC = (await req('POST', `/api/projects/${pid}/nodes`, {
    type: 'feedback', title: 'CL blocker seen', linkTo: [{ nodeId: blocker.id }]
  })).json
  await req('POST', `/api/nodes/${fbC.id}/waive`, { note: 'raised as the bug itself' })
  g1 = await gateOf()
  ok('blocks: still refused while the bug is unresolved', g1.status === 409 &&
    g1.json.error?.offenders?.blockers?.some((o) => o.id === blocker.id), JSON.stringify(g1.json.error?.offenders))
  await req('PATCH', `/api/nodes/${blocker.id}`, { tags: ['fixed'] })
  g1 = await gateOf()
  ok('blocks: a FIXED blocker stops blocking — the gate opens (same resolved-set as the flags)',
    g1.status === 200 && g1.json.stage === 'ship', JSON.stringify(g1.json.error?.offenders ?? g1.json.stage))

  // THE GATE FOLLOWS A SENT-BACK WARP: a review stays open through a send-back,
  // so shipping from the stage it was sent back to is refused too.
  {
    const sb = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'CL SentBack', stage: 'review' })).json
    const sbFb = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'feedback', title: 'CL open observation', linkTo: [{ nodeId: sb.id, type: 'member', outgoing: true }]
    })).json
    const backTo = await req('PATCH', `/api/nodes/${sb.id}`, { stage: 'implement' })
    ok('send-back is free (review → implement)', backTo.status === 200 && backTo.json.stage === 'implement')
    const shipFromImplement = await req('PATCH', `/api/nodes/${sb.id}`, { stage: 'ship' })
    ok('the gate follows the warp: shipping from implement with an open review 409s',
      shipFromImplement.status === 409 &&
      shipFromImplement.json.error?.offenders?.undesignated?.some((o) => o.id === sbFb.id),
      JSON.stringify(shipFromImplement.status))
    // a warp that was NEVER reviewed still ships freely — the gate owns reviews,
    // not the pipeline
    const plain = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'CL Unreviewed', stage: 'implement' })).json
    const plainShip = await req('PATCH', `/api/nodes/${plain.id}`, { stage: 'ship' })
    ok('a warp with no review ships without the gate', plainShip.status === 200 && plainShip.json.stage === 'ship')
  }

  // PRIORITISATION — rank persists on feedback and actions, per list.
  {
    const r1 = await req('PATCH', `/api/nodes/${fbA.id}`, { rank: 2 })
    const r2 = await req('PATCH', `/api/nodes/${fbHold.id}`, { rank: 1 })
    ok('rank persists on feedback (agents set it over the API)', r1.status === 200 && r2.status === 200 &&
      r1.json.rank === 2 && r2.json.rank === 1, JSON.stringify([r1.json.rank, r2.json.rank]))
    const frac = await req('PATCH', `/api/nodes/${fbA.id}`, { rank: 1.5 })
    ok('fractional rank round-trips (inserting between neighbours)', frac.json.rank === 1.5, JSON.stringify(frac.json.rank))
    const readBack = await req('GET', `/api/nodes/${fbA.id}`)
    ok('rank survives a re-read', readBack.json.rank === 1.5, JSON.stringify(readBack.json.rank))
    const cleared = await req('PATCH', `/api/nodes/${fbA.id}`, { rank: null })
    ok('rank clears back to unranked', cleared.status === 200 && cleared.json.rank === null)
  }

  // EDITING — parity: humans and agents write the same bodies and titles on
  // review material, for as long as the review is open.
  {
    const ed = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'CL Editing', stage: 'review' })).json
    const f = (await req('POST', `/api/projects/${pid}/nodes`, {
      type: 'feedback', title: 'CL first phrasing', content: '## Observed\n\nfirst\n',
      linkTo: [{ nodeId: ed.id, type: 'member', outgoing: true }]
    })).json
    const put = await req('PUT', `/api/nodes/${f.id}/content`, { content: '## Observed\n\nsharpened\n' })
    const got = await req('GET', `/api/nodes/${f.id}/content`)
    ok('feedback body is writable and re-readable', put.status === 200 && got.json.content.includes('sharpened'),
      JSON.stringify(got.json.content))
    const ren = await req('PATCH', `/api/nodes/${f.id}`, { title: 'CL sharper phrasing' })
    ok('feedback title is editable while the review is open', ren.status === 200 && ren.json.title === 'CL sharper phrasing')
    const a = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'action', title: 'CL act', linkTo: [{ nodeId: f.id }] })).json
    const aPut = await req('PUT', `/api/nodes/${a.id}/content`, { content: '## Delta\n\ndo the thing\n' })
    const aRen = await req('PATCH', `/api/nodes/${a.id}`, { title: 'CL act, renamed' })
    ok('synthesized actions are editable too (body + title)',
      aPut.status === 200 && aRen.status === 200 && aRen.json.title === 'CL act, renamed')
  }

  // THE INBOX — untriaged only, and one call gets it (agent parity).
  {
    const loose = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'CL Untriaged' })).json
    const inbox = await req('GET', `/api/projects/${pid}/nodes?type=feedback&unassigned=1`)
    ok('unassigned=1 returns the untriaged feedback', inbox.status === 200 && inbox.json.some((n) => n.id === loose.id),
      JSON.stringify(inbox.json.map((n) => n.title)))
    ok('unassigned=1 excludes warp-assigned feedback (it lives in its room)',
      !inbox.json.some((n) => n.id === fbA.id || n.id === fbHold.id), JSON.stringify(inbox.json.map((n) => n.title)))
    ok('unassigned=1 excludes feedback membering a non-warp (it belongs to what it reviews)',
      !inbox.json.some((n) => n.id === fbCov.id), JSON.stringify(inbox.json.map((n) => n.title)))
    // send to warp: the member relationship IS the triage; it leaves the inbox
    const openW = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'warp', title: 'CL Destination', stage: 'implement' })).json
    const send = await req('POST', `/api/projects/${pid}/edges`, { sourceId: loose.id, targetId: openW.id, type: 'member' })
    ok('send-to-warp: member onto a warp with an open review 200', send.status === 200 && hasRel(send.json, 'member'))
    const after = await req('GET', `/api/projects/${pid}/nodes?type=feedback&unassigned=1`)
    ok('triaged feedback leaves the inbox', !after.json.some((n) => n.id === loose.id),
      JSON.stringify(after.json.map((n) => n.title)))
    // and a waived one is not inbox material either
    const waived = (await req('POST', `/api/projects/${pid}/nodes`, { type: 'feedback', title: 'CL Waived Loose' })).json
    await req('POST', `/api/nodes/${waived.id}/waive`, { note: 'not worth pursuing' })
    const after2 = await req('GET', `/api/projects/${pid}/nodes?type=feedback&unassigned=1`)
    ok('unassigned=1 excludes resolved feedback', !after2.json.some((n) => n.id === waived.id),
      JSON.stringify(after2.json.map((n) => n.title)))
  }
}

// migration integrity: the review tables became graph state (guarded on the live
// project existing — these read the REAL migrated data, not fixtures)
{
  const live = await req('GET', '/api/projects/pr_73a19765b0')
  if (live.status === 200) {
    const g = await req('GET', '/api/projects/pr_73a19765b0/graph')
    const byId = new Map(g.json.nodes.map((n) => [n.id, n]))
    const w2members = []
    for (const e of g.json.edges) {
      for (const r of rels(e)) {
        if (r.type === 'member' && r.targetId === 'nd_f132953000' && byId.get(r.sourceId)?.type === 'feedback') {
          w2members.push(byId.get(r.sourceId))
        }
      }
    }
    // ">= 7", not "=== 7": this asserts the MIGRATION carried the exit-review
    // feedback across, on a project humans and agents keep filing into. An exact
    // count fails the moment anyone files (or a mistaken designation is reverted)
    // — which is a live-data change, not a regression.
    ok('migration: Warp 2 carries its exit-review feedback members', w2members.length >= 7, JSON.stringify(w2members.length))
    // the finding itself must still be THERE. Whether it is still open is live
    // state the human owns — waiving it is the review working, not a regression
    const liveFinding = w2members.find((n) => n.title.startsWith('Close the record'))
    ok('migration: the live finding survived as a feedback member of Warp 2',
      !!liveFinding, JSON.stringify(w2members.map((n) => [n.title.slice(0, 40), n.tags])))
    ok('migration: no review-type nodes remain', !g.json.nodes.some((n) => n.type === 'review'))
    // the gate holds on real data — but ONLY attempt the restage when the live state
    // PREDICTS a 409 (an undesignated feedback member exists): the check must never
    // mutate the human's board, and designating/waiving legitimately opens the gate.
    const w2 = byId.get('nd_f132953000')
    const derivesOut = new Set()
    for (const e of g.json.edges) {
      for (const r of rels(e)) if (r.type === 'derives') derivesOut.add(r.sourceId)
    }
    const undesignated = w2members.filter((n) => !n.tags.includes('pruned') && !derivesOut.has(n.id))
    if (w2?.stage === 'review' && undesignated.length > 0) {
      const gateLive = await req('PATCH', '/api/nodes/nd_f132953000', { stage: 'ship' })
      ok('migration: Warp 2 ship gated by its undesignated feedback', gateLive.status === 409 &&
        gateLive.json.error?.offenders?.undesignated?.some((o) => undesignated.some((u) => u.id === o.id)),
        JSON.stringify(gateLive.status))
    } else {
      console.log(`  (live gate check skipped — Warp 2 stage=${w2?.stage}, undesignated=${undesignated.length}: nothing to safely assert)`)
    }
    // Warp 3 holds its own defects: they member it AND block it — institutional
    // records that keep their blocks edges after the fix. What must hold in BOTH
    // states is the suppression: a defect tagged `fixed` keeps the edge and stops
    // counting. Read-only — the human moves that warp, this never restages it.
    {
      const w3 = byId.get('nd_0df0c9db25')
      const blocksIn = []
      const w3work = []
      const w3actions = []
      for (const e of g.json.edges) {
        for (const r of rels(e)) {
          if (r.type === 'blocks' && r.targetId === 'nd_0df0c9db25') {
            const s = byId.get(r.sourceId)
            if (s) blocksIn.push(s)
          }
          if (r.type === 'member' && r.targetId === 'nd_0df0c9db25') {
            const s = byId.get(r.sourceId)
            if (s && s.type === 'action') w3actions.push(s)
            else if (s && s.type !== 'feedback') w3work.push(s)
          }
        }
      }
      const resolved = (n) => (n.flags ?? []).includes('Done') || (n.flags ?? []).includes('Pruned')
      const live = blocksIn.filter((n) => !resolved(n))
      const members = new Set(w3work.map((n) => n.id))
      const actionMembers = new Set(w3actions.map((n) => n.id))
      // Blockers arrive in two legitimate shapes and the assertion must not
      // confuse them: DEFECT records (bug/flaw) that also MEMBER the warp — the
      // institutional records that keep their blocks edge after the fix — and
      // address-now ACTIONS, which member and block by definition (that IS the
      // disposition). A flaw may additionally block a plan WITHOUT membering it,
      // which is the documented threat/flaw convention, so unmembered flaws are
      // not a violation. What must hold in every shape is the suppression below.
      const defects = blocksIn.filter((n) => n.type === 'bug' || n.type === 'flaw')
      ok('live: Warp 3 carries its own defects as blocking members',
        !!w3 && w3work.length > 0 && defects.length > 0 && defects.some((n) => members.has(n.id)) &&
        blocksIn.filter((n) => n.type === 'action').every((n) => actionMembers.has(n.id)),
        JSON.stringify({
          stage: w3?.stage, blocksIn: blocksIn.length, work: w3work.length,
          defects: defects.length, memberDefects: defects.filter((n) => members.has(n.id)).length,
          actionBlockers: blocksIn.filter((n) => n.type === 'action').length
        }))
      ok('live: a defect tagged fixed keeps its blocks edge and stops counting',
        live.length === blocksIn.filter((n) => !resolved(n)).length &&
        blocksIn.filter(resolved).every((n) => !live.some((l) => l.id === n.id)),
        JSON.stringify({ blocksIn: blocksIn.length, live: live.length }))
    }
  } else {
    console.log('  (live project pr_73a19765b0 absent — migration-integrity checks skipped)')
  }
}

// orphan-zero guard: deleting a project leaves NOTHING behind. deleteProject
// removes every dependent row explicitly in one transaction (cascades are not
// load-bearing — the foreign_keys pragma is per-connection and sql.js export()
// resets it). The 404s below prove reachability died; the row-level check at
// the end of this run (reads the DB file directly) proves the rows died.
let probeProjectId = ''
{
  const p2 = await req('POST', '/api/projects', { name: 'Orphan Probe', description: 'temp probe from smoke test' })
  const p2id = p2.json.id
  probeProjectId = p2id
  const n1 = await req('POST', `/api/projects/${p2id}/nodes`, { type: 'feature', title: 'Probe A', content: 'v1' })
  const n2 = await req('POST', `/api/projects/${p2id}/nodes`, { type: 'bug', title: 'Probe B' })
  const e1 = await req('POST', `/api/projects/${p2id}/edges`, { sourceId: n2.json.id, targetId: n1.json.id, type: 'blocks' })
  await req('POST', `/api/nodes/${n1.json.id}/annotations`, { body: 'probe note' })
  await req('POST', `/api/edges/${e1.json.id}/annotations`, { body: 'probe edge note' })
  await req('PUT', `/api/nodes/${n1.json.id}/content`, { content: 'v2 — first revision' })
  await req('PUT', `/api/nodes/${n1.json.id}/content`, { content: 'v3 — second revision' })
  // review material rides the graph now — a feedback member + fold exercises those tables
  const pfb = await req('POST', `/api/projects/${p2id}/nodes`, { type: 'feedback', title: 'Probe Obs', linkTo: [{ nodeId: n1.json.id }] })
  await req('POST', `/api/nodes/${pfb.json.id}/waive`, { note: 'probe waive' })
  ok('orphan-probe fixtures', n1.status === 200 && n2.status === 200 && e1.status === 200 && pfb.status === 200)
  const delP2 = await req('DELETE', `/api/projects/${p2id}`)
  ok('probe project delete', delP2.status === 200)
  const gn1 = await req('GET', `/api/nodes/${n1.json.id}`)
  const gn2 = await req('GET', `/api/nodes/${n2.json.id}`)
  const ge1 = await req('GET', `/api/edges/${e1.json.id}`)
  const gg1 = await req('GET', `/api/projects/${p2id}/graph`)
  const gfb = await req('GET', `/api/nodes/${pfb.json.id}`)
  ok('probe nodes 404 after project delete (cascade held)', gn1.status === 404 && gn2.status === 404,
    JSON.stringify([gn1.status, gn2.status]))
  ok('probe edge 404 after project delete', ge1.status === 404)
  ok('probe graph 404 after project delete', gg1.status === 404)
  ok('probe feedback 404 after project delete', gfb.status === 404)
}

// llms.txt documents the new surface
{
  const llms2 = await req('GET', '/llms.txt')
  const s = String(llms2.json)
  ok('llms.txt: verb pairs, terminal verbs, settings route',
    ['leads-to', 'leads from', '/api/nodes/:id/complete', '/api/nodes/:id/prune', '/api/settings'].every((k) => s.includes(k)))
  // the amended review model: stage-is-the-review, fold, the gate, the sweep, the resolution table
  const reviewKeys = [
    'REVIEW is a STAGE of a warp',
    '/api/nodes/:id/waive', 'waived into', '/api/nodes/:id/pass', 'Pass - Feedback Waived',
    'The review process — verbs on the graph',
    'CLOSE = SHIP', 'error.offenders',
    // the four fully-actioned requirements, the waive/undo pair, the inbox query
    'COVERAGE', 'DESIGNATION', 'DISPOSITION', 'BLOCKS',
    'CONFIRMATION COUNTS',
    '/api/nodes/:id/unwaive', 'node.unwaived',
    // the old verb stays documented as an alias so agents mid-flight are not stranded
    'ALIAS',
    'unassigned=1', 'closed review',
    'address-now',
    'warp abandoned',
    'review.sweep.requested',
    'completeness', 'fidelity', 'harvest',
    'The HEALTH resolution table',
    'sourceType', 'Threatened',
    'discusses',
    'feedback, which may member ANY node'
  ]
  ok('llms.txt: amended review-model keys all present', reviewKeys.every((k) => s.includes(k)),
    JSON.stringify(reviewKeys.filter((k) => !s.includes(k))))
  ok('llms.txt: no stale review-node/close-review surface',
    !s.includes('close-review') && !s.includes('"type":"review"'), 'stale review-node docs found')
  ok('llms.txt: answer + graduate recipes', ['/api/nodes/:id/answer', '## Answer', 'Graduate an answered question'].every((k) => s.includes(k)))
  ok('llms.txt: convert endpoint + decision paragraph',
    ['/api/nodes/:id/convert', 'Convert vs graduate vs create-linked'].every((k) => s.includes(k)))
  ok('llms.txt: connections + relationships model',
    ['Connections + relationships', '/api/edges/:id/relationships', 'Stack relationships on ONE connection', 'bare'].every((k) => s.includes(k)),
    JSON.stringify(['Connections + relationships', '/api/edges/:id/relationships', 'Stack relationships on ONE connection', 'bare'].filter((k) => !s.includes(k))))
  ok('llms.txt: styleOverrides + typeOrder documented (folders never change)',
    ['styleOverrides', 'typeOrder', 'circle|hexagon|diamond|square|triangle|triangle-down|ring|chevron', 'FOLDERS never change'].every((k) => s.includes(k)),
    JSON.stringify(['styleOverrides', 'typeOrder', 'circle|hexagon|diamond|square|triangle|triangle-down|ring|chevron', 'FOLDERS never change'].filter((k) => !s.includes(k))))
  ok('llms.txt: fill modes + inner glyphs + warp-number caveat documented',
    ['solid|outline', '?|!|+|x|.', 'replaces the progress number'].every((k) => s.includes(k)),
    JSON.stringify(['solid|outline', '?|!|+|x|.', 'replaces the progress number'].filter((k) => !s.includes(k))))
  // the naming guard: titles carry no version/increment phrasing — evolving a
  // capability is an EDIT to its living spec, the increment is the warp
  const namingKeys = ['NAMING:', 'PRESENT-TENSE', 'NO version or increment phrasing', 'legacy node']
  ok('llms.txt: naming convention (no v2/round-N titles) documented',
    namingKeys.every((k) => s.includes(k)), JSON.stringify(namingKeys.filter((k) => !s.includes(k))))
}

// The TAGS filter section (graph toolbar) is computed entirely client-side —
// there is no tag-filter API to test. What IS an API contract is the DATA it
// reads: every graph node carries its tags, and a histogram over that payload
// must agree with the server's own tag index, or the chips' counts would lie.
{
  const gTags = await req('GET', `/api/projects/${pid}/graph`)
  const tagNodes = gTags.json.nodes ?? []
  ok('graph payload: every node carries a tags array',
    tagNodes.length > 0 && tagNodes.every((n) => Array.isArray(n.tags)),
    `${tagNodes.filter((n) => !Array.isArray(n.tags)).length} of ${tagNodes.length} missing tags`)
  const hist = new Map()
  for (const n of tagNodes) for (const t of n.tags ?? []) hist.set(t, (hist.get(t) ?? 0) + 1)
  const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const mismatched = []
  for (const [tag, count] of ranked.slice(0, 6)) {
    const byTag = await req('GET', `/api/projects/${pid}/nodes?tag=${encodeURIComponent(tag)}`)
    if (byTag.status !== 200 || byTag.json.length !== count) {
      mismatched.push(`${tag}: payload ${count} vs index ${byTag.json?.length} (${byTag.status})`)
    }
  }
  ok('tag chip counts match the server tag index', ranked.length >= 3 && mismatched.length === 0,
    JSON.stringify({ distinct: ranked.length, mismatched }))
}

// events arrived?
await new Promise((r) => setTimeout(r, 400))
ac.abort()
ok('SSE received events', events.length > 5, `got ${events.length}`)
ok('question.answered event emitted', events.includes('question.answered'), JSON.stringify([...new Set(events)]))
ok('node.converted event emitted', events.includes('node.converted'), JSON.stringify([...new Set(events)]))
ok('node.waived event emitted', events.includes('node.waived'), JSON.stringify([...new Set(events)]))
ok('node.unwaived event emitted', events.includes('node.unwaived'), JSON.stringify([...new Set(events)]))
// the legacy names keep firing alongside the new ones: an SSE subscriber written
// against `fold` must not go silent because the verb was renamed
ok('legacy node.folded/node.unfolded events still emitted (alias)',
  events.includes('node.folded') && events.includes('node.unfolded'), JSON.stringify([...new Set(events)]))
ok('review.sweep.requested event emitted', events.includes('review.sweep.requested'), JSON.stringify([...new Set(events)]))
ok('edge.relationship events emitted', ['edge.relationship.added', 'edge.relationship.updated', 'edge.relationship.removed']
  .every((t) => events.includes(t)), JSON.stringify([...new Set(events)]))
// every settings PATCH above must have pushed settings.updated to SSE listeners —
// that event is what live-refreshes open windows (canvas restyles without reload)
ok('settings.updated event emitted on PATCH', events.includes('settings.updated'), JSON.stringify([...new Set(events)]))

// migration + uniqueness sanity across EVERY project on this instance (covers
// the live project as well as this run's fixtures): no unordered pair may
// appear twice in any graph payload
{
  const projects = await req('GET', '/api/projects')
  let dupPairs = 0
  let scanned = 0
  for (const pr of projects.json) {
    const g = await req('GET', `/api/projects/${pr.id}/graph`)
    if (g.status !== 200) continue
    scanned++
    const seen = new Set()
    for (const e of g.json.edges) {
      const k = e.sourceId < e.targetId ? `${e.sourceId}|${e.targetId}` : `${e.targetId}|${e.sourceId}`
      if (seen.has(k)) dupPairs++
      seen.add(k)
    }
  }
  ok(`pair uniqueness across all ${scanned} projects`, scanned > 0 && dupPairs === 0, `${dupPairs} duplicate pairs`)
}

// ---------------------------------------------------------------------------
// CROSS-PROJECT CONNECTIONS — describing may cross a project boundary,
// scheduling may not. Two throwaway projects, deleted before the row-level scan
// below so the orphan check covers them too.
{
  const xa = await req('POST', '/api/projects', { name: 'Smoke XProj A' })
  const xb = await req('POST', '/api/projects', { name: 'Smoke XProj B' })
  const xaId = xa.json.id
  const xbId = xb.json.id

  // SAME TITLE on both sides on purpose: this is the wikilink ambiguity case
  const xaN = await req('POST', `/api/projects/${xaId}/nodes`, { type: 'feature', title: 'Shared Name' })
  const xbN = await req('POST', `/api/projects/${xbId}/nodes`, { type: 'component', title: 'Shared Name' })
  const xaLocal = await req('POST', `/api/projects/${xaId}/nodes`, { type: 'feature', title: 'XA local neighbour' })
  const xaWarp = await req('POST', `/api/projects/${xaId}/nodes`, { type: 'warp', title: 'XA warp' })
  const xbWarp = await req('POST', `/api/projects/${xbId}/nodes`, { type: 'warp', title: 'XB warp' })

  // one SAME-project link (must stay bare) and one CROSS-project link (must be
  // qualified) on the very same node, so the frontmatter check compares both
  await req('POST', `/api/projects/${xaId}/edges`, { sourceId: xaN.json.id, targetId: xaLocal.json.id, type: 'depends' })
  const xdep = await req('POST', `/api/projects/${xaId}/edges`, { sourceId: xaN.json.id, targetId: xbN.json.id, type: 'depends' })
  ok('cross-project: depends is created', xdep.status === 200 && hasRel(xdep.json, 'depends'), JSON.stringify(xdep.json).slice(0, 160))

  // real in BOTH graphs, with the foreign endpoint carried so the edge has ends
  for (const [id, label, foreignId] of [[xaId, 'A', xbN.json.id], [xbId, 'B', xaN.json.id]]) {
    const g = await req('GET', `/api/projects/${id}/graph`)
    ok(`cross-project: connection is in project ${label}'s graph`, (g.json.edges ?? []).some((e) => e.id === xdep.json.id))
    const f = (g.json.nodes ?? []).find((n) => n.id === foreignId)
    ok(`cross-project: foreign endpoint rides along in ${label}'s payload`, !!f)
    ok(`cross-project: foreign node in ${label} keeps its own projectId`, !!f && f.projectId !== id)
  }

  // SCHEDULING must not cross — a foreign member would feed a roll-up with work
  // the project cannot finish, and addresses aims a warp at a goal it owns
  const xMem = await req('POST', `/api/projects/${xaId}/edges`, { sourceId: xbN.json.id, targetId: xaWarp.json.id, type: 'member' })
  ok('cross-project: member is refused', xMem.status === 400)
  ok('cross-project: member refusal explains why', /cannot cross a project boundary/.test(JSON.stringify(xMem.json)))
  const xAddr = await req('POST', `/api/projects/${xaId}/edges`, { sourceId: xaWarp.json.id, targetId: xbN.json.id, type: 'addresses' })
  ok('cross-project: addresses is refused', xAddr.status === 400)
  const xLocalMem = await req('POST', `/api/projects/${xaId}/edges`, { sourceId: xaN.json.id, targetId: xaWarp.json.id, type: 'member' })
  ok('cross-project: same-project member still works', xLocalMem.status === 200 && hasRel(xLocalMem.json, 'member'))

  // a foreign node must not leak into project-scoped views. graphInternal now
  // computes flags/progress over the union but returns foreign nodes SEPARATELY
  // for exactly this reason — folding them in put another project's work in the
  // backlog and another project's warp on the board.
  const xBacklog = await req('GET', `/api/projects/${xaId}/backlog`)
  const xbRows = Array.isArray(xBacklog.json) ? xBacklog.json : (xBacklog.json.nodes ?? [])
  ok('cross-project: foreign node stays out of the local backlog', !xbRows.some((n) => n.id === xbN.json.id))
  const xNodes = await req('GET', `/api/projects/${xaId}/nodes`)
  const xnRows = Array.isArray(xNodes.json) ? xNodes.json : (xNodes.json.nodes ?? [])
  ok('cross-project: foreign node stays out of the local node list', !xnRows.some((n) => n.id === xbN.json.id))
  // link a warp across projects (bare relates is legal) then prove it does not
  // appear on the other project's stage board
  await req('POST', `/api/projects/${xaId}/edges`, { sourceId: xaN.json.id, targetId: xbWarp.json.id })
  const xWarps = await req('GET', `/api/projects/${xaId}/warps`)
  const xwRows = Array.isArray(xWarps.json) ? xWarps.json : (xWarps.json.warps ?? [])
  ok('cross-project: foreign warp stays off the local warps board', !xwRows.some((w) => (w.id ?? w.warpId) === xbWarp.json.id))

  // frontmatter: a bare [[Title]] resolves vault-wide with same-folder
  // preference, so with the SAME title on both sides a bare cross-project link
  // would silently resolve to the WRONG file in Obsidian — wrong only in the
  // vault, invisible from the app. Same-project links must stay bare (no churn).
  {
    await new Promise((r) => setTimeout(r, 300))
    const stg2 = await req('GET', '/api/settings')
    const det = await req('GET', `/api/nodes/${xaN.json.id}`)
    const fp = path.join(String(stg2.json.vaultPath ?? ''), String(det.json.filePath ?? ''))
    if (!fs.existsSync(fp)) {
      ok('cross-project: node file reachable for frontmatter check', false, fp)
    } else {
      const head = fs.readFileSync(fp, 'utf8').slice(0, 600)
      ok('cross-project: same-project wikilink stays bare', head.includes('[[XA local neighbour]]'), head.slice(0, 220))
      ok('cross-project: cross-project wikilink is project-qualified',
        head.includes('[[Smoke XProj B/Components/Shared Name]]'), head.slice(0, 220))
      ok('cross-project: the ambiguous bare link is NOT written',
        !/- '\[\[Shared Name\]\]'/.test(head), head.slice(0, 220))
    }
  }

  // both feeds see it — the far project must not discover a link into its graph
  // only by noticing it on the canvas
  for (const [id, label] of [[xaId, 'A'], [xbId, 'B']]) {
    const act = await req('GET', `/api/projects/${id}/activity?limit=60`)
    const rows = Array.isArray(act.json) ? act.json : (act.json.activity ?? [])
    ok(`cross-project: project ${label} activity records the connection`, rows.some((r) => r.action === 'edge.created'))
  }

  // deleting the far project takes the crossing with it (the orphan hazard:
  // ON DELETE CASCADE alone would leave A's edge pointing at a deleted node)
  const xdelB = await req('DELETE', `/api/projects/${xbId}`)
  ok('cross-project: far project deletes', xdelB.status === 200)
  const gAfter = await req('GET', `/api/projects/${xaId}/graph`)
  ok('cross-project: crossing is gone from the surviving project',
    !(gAfter.json.edges ?? []).some((e) => e.id === xdep.json.id))
  ok('cross-project: deleted project\'s node is gone from the surviving payload',
    !(gAfter.json.nodes ?? []).some((n) => n.id === xbN.json.id))
  ok('cross-project: surviving project keeps its own nodes',
    (gAfter.json.nodes ?? []).some((n) => n.id === xaN.json.id))
  const xdelA = await req('DELETE', `/api/projects/${xaId}`)
  ok('cross-project: near project deletes', xdelA.status === 200)
}

// ---------------------------------------------------------------------------
// REFERRAL — the cross-project handoff. A COPY joined to its origin by
// provenance, not a live alias: once it lands the receiver owns it.
{
  const rd = await req('POST', '/api/projects', { name: 'Smoke Refer From' })
  const rs = await req('POST', '/api/projects', { name: 'Smoke Refer To' })
  const rdId = rd.json.id
  const rsId = rs.json.id
  const rSrc = await req('POST', `/api/projects/${rdId}/nodes`, {
    type: 'idea', title: 'Referred capability', content: '## Summary\n\nA thing the other project wants.\n'
  })

  const refd = await req('POST', `/api/nodes/${rSrc.json.id}/refer`,
    { toProjectId: rsId, note: 'belongs to you more than us' })
  ok('refer: lands in the target project', refd.status === 200 && refd.json.projectId === rsId, JSON.stringify(refd.json).slice(0, 140))
  ok('refer: arrives as an idea by default', refd.json.type === 'idea')
  ok('refer: tagged referred for the inbox', (refd.json.tags ?? []).includes('referred'))
  ok('refer: creates a NEW node, does not move the original', refd.json.id !== rSrc.json.id)

  const refDet = await req('GET', `/api/nodes/${refd.json.id}`)
  ok('refer: body carried across', /A thing the other project wants/.test(refDet.json.content ?? ''))
  ok('refer: note landed as an attributed annotation',
    (refDet.json.annotations ?? []).some((a) => /belongs to you more than us/.test(a.body)))
  const prov = (refDet.json.edges ?? []).find((e) => e.label === 'referred from')
  ok('refer: provenance connection labelled "referred from"', !!prov)
  ok('refer: provenance points at the origin',
    !!prov && (prov.sourceId === rSrc.json.id || prov.targetId === rSrc.json.id))

  const origin = await req('GET', `/api/nodes/${rSrc.json.id}`)
  ok('refer: origin stays in the sending project', origin.json.projectId === rdId)
  ok('refer: origin is not retagged', !(origin.json.tags ?? []).includes('referred'))

  const inbox = await req('GET', `/api/projects/${rsId}/nodes?tag=referred`)
  const inboxRows = Array.isArray(inbox.json) ? inbox.json : (inbox.json.nodes ?? [])
  ok('refer: receiver inbox is one call (?tag=referred)', inboxRows.some((n) => n.id === refd.json.id))

  for (const [id, label] of [[rdId, 'sender'], [rsId, 'receiver']]) {
    const act = await req('GET', `/api/projects/${id}/activity?limit=40`)
    const rows = Array.isArray(act.json) ? act.json : (act.json.activity ?? [])
    ok(`refer: ${label} activity records node.referred`, rows.some((r) => r.action === 'node.referred'))
  }

  const sameProj = await req('POST', `/api/nodes/${rSrc.json.id}/refer`, { toProjectId: rdId })
  ok('refer: refusing a referral into its own project', sameProj.status === 400)
  const rWarp = await req('POST', `/api/projects/${rdId}/nodes`, { type: 'warp', title: 'Refer warp' })
  const warpRef = await req('POST', `/api/nodes/${rWarp.json.id}/refer`, { toProjectId: rsId })
  ok('refer: warps cannot be referred', warpRef.status === 400)

  // the receiver OWNS it — convert and rank, which a live alias could never allow
  const refConv = await req('POST', `/api/nodes/${refd.json.id}/convert`, { type: 'feature' })
  ok('refer: receiver can convert the landed node', refConv.status === 200 && refConv.json.type === 'feature')
  await req('PATCH', `/api/nodes/${refd.json.id}`, { rank: 3 })
  const refBacklog = await req('GET', `/api/projects/${rsId}/backlog`)
  const refRows = Array.isArray(refBacklog.json) ? refBacklog.json : (refBacklog.json.nodes ?? [])
  ok('refer: receiver can rank it in their own backlog',
    refRows.some((n) => n.id === refd.json.id && n.rank === 3))

  await req('DELETE', `/api/projects/${rdId}`)
  await req('DELETE', `/api/projects/${rsId}`)
}

// ---------------------------------------------------------------------------
// SHARED CANON — share a node, reference it from another project read-only,
// fork to diverge, and prove SEVERANCE keeps the referring project's data.
{
  const co = await req('POST', '/api/projects', { name: 'Smoke Canon Owner' })
  const cu = await req('POST', '/api/projects', { name: 'Smoke Canon Consumer' })
  const coId = co.json.id
  const cuId = cu.json.id
  const pil = await req('POST', `/api/projects/${coId}/nodes`, {
    type: 'pillar', title: 'Smoke Branch Rules', content: '## Commitment\n\nBranches are cheap.\n'
  })
  const cLocal = await req('POST', `/api/projects/${cuId}/nodes`, { type: 'feature', title: 'Consumer feature' })
  const cWarp = await req('POST', `/api/projects/${cuId}/nodes`, { type: 'warp', title: 'Consumer warp' })

  const tooEarly = await req('POST', `/api/projects/${cuId}/references`, { nodeId: pil.json.id })
  ok('canon: referencing an unshared node is refused', tooEarly.status === 400)

  const shared = await req('POST', `/api/nodes/${pil.json.id}/share`)
  ok('canon: share sets the field', shared.status === 200 && shared.json.shared === true)
  const commons = await req('GET', `/api/commons?excludeProjectId=${cuId}`)
  const cRows = Array.isArray(commons.json) ? commons.json : []
  ok('canon: the commons lists shared nodes across projects', cRows.some((n) => n.id === pil.json.id))
  ok('canon: commons carries the owning project name',
    cRows.find((n) => n.id === pil.json.id)?.projectName === 'Smoke Canon Owner')

  const ref = await req('POST', `/api/projects/${cuId}/references`, { nodeId: pil.json.id, x: 10, y: 20 })
  ok('canon: reference is a LOCAL node in the consuming project', ref.status === 200 && ref.json.projectId === cuId)
  ok('canon: reference points at the owned node', ref.json.referencesNodeId === pil.json.id)
  ok('canon: reference mirrors the owner\'s type and title',
    ref.json.type === 'pillar' && ref.json.title === 'Smoke Branch Rules')
  const twice = await req('POST', `/api/projects/${cuId}/references`, { nodeId: pil.json.id })
  ok('canon: referencing twice is idempotent', twice.json.id === ref.json.id)

  // the reference file EMBEDS rather than mirrors — one source of truth, no
  // fan-out writer waking the vault watcher on every edit to a shared node
  {
    const stg3 = await req('GET', '/api/settings')
    const rf = path.join(String(stg3.json.vaultPath ?? ''), String(ref.json.filePath ?? ''))
    if (!fs.existsSync(rf)) ok('canon: reference file reachable', false, rf)
    else {
      const txt = fs.readFileSync(rf, 'utf8')
      ok('canon: reference file embeds the owner\'s file', /!\[\[Smoke Canon Owner\/Pillars\/Smoke Branch Rules\]\]/.test(txt), txt.slice(0, 200))
      ok('canon: reference file does NOT duplicate the owner\'s text', !/Branches are cheap/.test(txt))
    }
  }

  ok('canon: renaming a reference is refused', (await req('PATCH', `/api/nodes/${ref.json.id}`, { title: 'Mine' })).status === 400)
  ok('canon: editing a reference spec is refused', (await req('PUT', `/api/nodes/${ref.json.id}/content`, { content: 'mine' })).status === 400)
  ok('canon: position IS local — moving a reference is allowed', (await req('PATCH', `/api/nodes/${ref.json.id}`, { x: 99 })).status === 200)
  ok('canon: ranking a reference is refused', (await req('PATCH', `/api/nodes/${ref.json.id}`, { rank: 1 })).status === 400)
  ok('canon: a reference cannot join a warp',
    (await req('POST', `/api/projects/${cuId}/edges`, { sourceId: ref.json.id, targetId: cWarp.json.id, type: 'member' })).status === 400)
  const cbl = await req('GET', `/api/projects/${cuId}/backlog`)
  const cblRows = Array.isArray(cbl.json) ? cbl.json : (cbl.json.nodes ?? [])
  ok('canon: a reference never appears in the backlog', !cblRows.some((n) => n.id === ref.json.id))

  const shp = await req('POST', `/api/projects/${cuId}/edges`, { sourceId: ref.json.id, targetId: cLocal.json.id, type: 'shapes' })
  ok('canon: the shared pillar shapes a local feature', shp.status === 200 && hasRel(shp.json, 'shapes'))

  const fork = await req('POST', `/api/projects/${cuId}/forks`, { nodeId: ref.json.id, title: 'Our branch rules' })
  ok('canon: fork is a normal local node', fork.status === 200 && !fork.json.referencesNodeId)
  const forkDet = await req('GET', `/api/nodes/${fork.json.id}`)
  ok('canon: fork carries the owner\'s text', /Branches are cheap/.test(forkDet.json.content ?? ''))
  ok('canon: fork keeps a "forked from" connection', (forkDet.json.edges ?? []).some((e) => e.label === 'forked from'))
  ok('canon: a fork is editable', (await req('PUT', `/api/nodes/${fork.json.id}/content`, { content: '## Ours\n\nDiverged.\n' })).status === 200)

  // SEVERANCE — the owner deletes; the consumer loses nothing
  await req('DELETE', `/api/nodes/${pil.json.id}`)
  const after = await req('GET', `/api/nodes/${ref.json.id}`)
  ok('canon: severed reference stops being a reference', after.json.referencesNodeId === null)
  ok('canon: severed reference is tagged reference-broken', (after.json.tags ?? []).includes('reference-broken'))
  ok('canon: the CONTENT PERSISTED after the owner deleted the node', /Branches are cheap/.test(after.json.content ?? ''))
  ok('canon: local links survived severance',
    (after.json.edges ?? []).some((e) => (e.relationships ?? []).some((r) => r.type === 'shapes')))
  const cg = await req('GET', `/api/projects/${cuId}/graph`)
  const cgn = (cg.json.nodes ?? []).find((n) => n.id === ref.json.id)
  ok('canon: the broken state is highlighted by a flag rule', (cgn?.flags ?? []).includes('Reference broken'))
  ok('canon: after severance the consumer owns it outright',
    (await req('PATCH', `/api/nodes/${ref.json.id}`, { title: 'Now mine' })).status === 200)

  await req('DELETE', `/api/projects/${coId}`)
  await req('DELETE', `/api/projects/${cuId}`)
}

// cleanup
const del = await req('DELETE', `/api/projects/${pid}`)
ok('project delete', del.status === 200)
const gone = await req('GET', `/api/projects/${pid}`)
ok('project gone', gone.status === 404)

// row-level orphan-zero: open the DB file directly (after the 400ms debounced
// save settles) and prove BOTH deleted projects took every dependent row with
// them — including annotations/node_revisions, which the API can't reach once
// their parents 404. The DB path comes from the running app's own settings;
// OZMO_DB overrides it when smoke targets an instance on another machine.
{
  await new Promise((r) => setTimeout(r, 1500))
  const stg = await req('GET', '/api/settings')
  const dbFile = process.env.OZMO_DB ?? path.join(String(stg.json.vaultPath ?? ''), '.ozmo', 'spec.db')
  if (!fs.existsSync(dbFile)) {
    ok('row-level orphan check: DB file reachable', false, dbFile)
  } else {
    const require = createRequire(import.meta.url)
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) })
    const sdb = new SQL.Database(fs.readFileSync(dbFile))
    const count = (sql, params = []) => {
      const stmt = sdb.prepare(sql)
      stmt.bind(params)
      stmt.step()
      const n = stmt.get()[0]
      stmt.free()
      return n
    }
    const orphans = {
      nodes: count('SELECT COUNT(*) FROM nodes WHERE project_id NOT IN (SELECT id FROM projects)'),
      edges: count('SELECT COUNT(*) FROM edges WHERE project_id NOT IN (SELECT id FROM projects) OR source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)'),
      edge_relationships: count('SELECT COUNT(*) FROM edge_relationships WHERE edge_id NOT IN (SELECT id FROM edges)'),
      node_tags: count('SELECT COUNT(*) FROM node_tags WHERE node_id NOT IN (SELECT id FROM nodes)'),
      node_revisions: count('SELECT COUNT(*) FROM node_revisions WHERE node_id NOT IN (SELECT id FROM nodes)'),
      annotations: count("SELECT COUNT(*) FROM annotations WHERE (parent_kind = 'node' AND parent_id NOT IN (SELECT id FROM nodes)) OR (parent_kind = 'edge' AND parent_id NOT IN (SELECT id FROM edges))")
    }
    ok('row-level: zero orphans in every child table', Object.values(orphans).every((n) => n === 0), JSON.stringify(orphans))
    // the review tables are GONE — retired by the review-nodes migrations, counts in meta
    const reviewTables = count("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('reviews','review_items','review_comments')")
    ok('row-level: review tables dropped', reviewTables === 0, `${reviewTables} still present`)
    const metaOf = (key) => {
      try {
        const stmt = sdb.prepare('SELECT value FROM meta WHERE key = ?')
        stmt.bind([key])
        const v = stmt.step() ? stmt.get()[0] : null
        stmt.free()
        return v ? JSON.parse(v) : null
      } catch { return null }
    }
    const mv1 = metaOf('review_nodes_v1')
    const mv2 = metaOf('review_nodes_v2')
    ok('review migration v1 counts recorded in meta', mv1 !== null && typeof mv1.reviews === 'number' && typeof mv1.feedback === 'number',
      JSON.stringify(mv1))
    ok('review migration v2 (stage-is-the-review) counts recorded', mv2 !== null &&
      typeof mv2.reviewNodesRemoved === 'number' && mv2.reviewNodesRemoved === (mv1?.reviews ?? -1) &&
      typeof mv2.membersMerged === 'number' && typeof mv2.membersDropped === 'number', JSON.stringify(mv2))
    ok('row-level: no review-type nodes anywhere', count("SELECT COUNT(*) FROM nodes WHERE type = 'review'") === 0)
    // connections migration ran exactly once and recorded its counts
    const metaRow = (() => {
      try {
        const stmt = sdb.prepare("SELECT value FROM meta WHERE key = 'edge_connections_v1'")
        stmt.bind([])
        const v = stmt.step() ? stmt.get()[0] : null
        stmt.free()
        return v ? JSON.parse(v) : null
      } catch { return null }
    })()
    ok('edges→connections migration counts recorded in meta',
      metaRow !== null && typeof metaRow.pairs === 'number' && typeof metaRow.relationships === 'number' &&
      typeof metaRow.rowsAbsorbed === 'number', JSON.stringify(metaRow))
    // relationship endpoints must equal their connection's node pair
    const relMismatch = count(
      `SELECT COUNT(*) FROM edge_relationships r JOIN edges e ON e.id = r.edge_id
       WHERE NOT ((r.source_id = e.source_id AND r.target_id = e.target_id)
               OR (r.source_id = e.target_id AND r.target_id = e.source_id))`)
    ok('row-level: relationships stay on their pair', relMismatch === 0, `${relMismatch} mismatched`)
    // storage-level pair uniqueness (the expression index backs this)
    const dbDupPairs = count(
      `SELECT COUNT(*) FROM (SELECT min(source_id, target_id) a, max(source_id, target_id) b, COUNT(*) c
        FROM edges GROUP BY a, b HAVING c > 1)`)
    ok('row-level: no duplicate pairs in the edges table', dbDupPairs === 0, `${dbDupPairs} duplicated`)
    const leftover = count(
      `SELECT (SELECT COUNT(*) FROM projects WHERE id IN (?,?))
            + (SELECT COUNT(*) FROM nodes WHERE project_id IN (?,?))
            + (SELECT COUNT(*) FROM edges WHERE project_id IN (?,?))
            + (SELECT COUNT(*) FROM activity WHERE project_id IN (?,?))`,
      [pid, probeProjectId, pid, probeProjectId, pid, probeProjectId, pid, probeProjectId])
    ok('row-level: deleted projects left zero rows', leftover === 0, `${leftover} rows remain (pid=${pid}, probe=${probeProjectId}, db=${dbFile})`)
    sdb.close()
  }
}

console.log(failures === 0 ? '\nall smoke checks passed ✓' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

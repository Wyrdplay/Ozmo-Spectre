import * as svc from './services'

/**
 * Seeds a starter project on first run — the tool documenting itself.
 * Fully deletable; exists so the first launch shows a living board.
 * State is tags (user vocabulary), highlighted by the flag rules in Settings;
 * warps carry a stage. The jitter bug —blocks→ Graph Canvas edge exercises
 * the Blocked flag's incoming-edge condition out of the box.
 */
export function seedIfEmpty(): void {
  if (svc.listProjects().length > 0) return
  const actor = 'seed'
  const proj = svc.createProject({
    name: 'Spectre',
    description: 'The tool, specced in the tool. Delete this project any time.'
  }, actor)
  const pid = proj.id

  const mk = (type: Parameters<typeof svc.createNode>[0]['type'], title: string, opts: Partial<Parameters<typeof svc.createNode>[0]> = {}): string =>
    svc.createNode({ projectId: pid, type, title, ...opts }, actor).id

  const parity = mk('pillar', 'Human-Agent Parity', {
    x: -260, y: -180,
    content: '## Commitment\n\nOne service core. The UI calls it over IPC, agents call it over REST — same operations, same validation, same events. If a human can do it on the canvas, an agent can do it with `curl`.\n',
    tags: ['core']
  })
  const filesTruth = mk('pillar', 'Files Are The Spec', {
    x: 260, y: -200,
    content: '## Commitment\n\nSpec content is markdown in an Obsidian vault. The database only holds shape: links, tags, positions, process state.\n',
    tags: ['core']
  })
  const everythingNode = mk('principle', 'Everything Is A Node', {
    x: 0, y: -260,
    content: 'Ideas, pillars, features, bugs, questions — and warps — are all nodes in one graph. Sub-features are `derives` edges. Warp membership is a `member` edge.\n'
  })
  const canvas = mk('feature', 'Graph Canvas', {
    x: -180, y: 40, progress: 60,
    content: '## Summary\n\nForce-directed canvas of the whole project. Type-shaped nodes, directed edges, drag-to-pin, shift-drag to link.\n\n## Acceptance\n\n- [ ] 60fps with 500 nodes\n- [x] pin/unpin\n- [ ] edge labels on hover\n',
    tags: ['canvas', 'mvp', 'building']
  })
  const api = mk('feature', 'REST Agent API', {
    x: 180, y: 60,
    content: '## Summary\n\nEverything the UI can do, over HTTP on localhost. `X-Actor` header attributes work. `/llms.txt` teaches agents the ropes.\n',
    tags: ['agents', 'mvp', 'designed']
  })
  const sse = mk('feature', 'SSE Event Stream', {
    x: 330, y: 190,
    content: '## Summary\n\n`GET /api/events` server-sent events so agents react to humans in real time (and vice versa).\n',
    tags: ['agents']
  })
  const reviews = mk('feature', 'Review Rooms', {
    x: 0, y: 220,
    content: '## Summary\n\nDedicated space where humans and agents file items, argue in comments, and drive each item open → accepted → applied (or declined).\n',
    tags: ['process']
  })
  const voice = mk('idea', 'Voice capture of ideas', {
    x: -380, y: -60,
    content: 'Speak an idea, it lands on the board as an `idea` node. Non-binding, like all ideas.\n'
  })
  const mcp = mk('idea', 'MCP server mode', {
    x: 420, y: -60,
    content: 'The method registry is transport-agnostic — an MCP adapter is one file away.\n',
    tags: ['agents']
  })
  // confirmed but unfixed — its blocks edge below rings Graph Canvas via the
  // Blocked flag's incoming-edge condition (tag the bug `fixed` and the ring clears)
  const jitter = mk('bug', 'Graph jitters on drag', {
    x: -320, y: 160,
    content: '## Repro\n\nDrag a node fast while the simulation is hot.\n\n## Suspicion\n\nAlpha target not decaying after drag ends.\n',
    tags: ['canvas', 'confirmed']
  })
  const autoClose = mk('question', 'Should warps auto-close when all members are done?', {
    x: 140, y: 320,
    content: 'Or is closing a warp a deliberate human ritual? Leaning: suggest, never auto-close.\n'
  })
  const warp1 = mk('warp', 'Warp 1 — Skeleton', {
    x: -40, y: 120, stage: 'implement',
    content: '## Goal\n\nA walking skeleton: canvas + API + vault round-trip. Ship ugly, ship connected.\n',
    tags: ['mvp']
  })

  const link = (sourceId: string, targetId: string, type: Parameters<typeof svc.createEdge>[0]['type'], label = ''): void => {
    svc.createEdge({ sourceId, targetId, type, label }, actor)
  }
  link(parity, api, 'shapes', 'parity is why the API exists')
  link(parity, reviews, 'shapes')
  link(filesTruth, canvas, 'shapes')
  link(everythingNode, canvas, 'shapes')
  link(api, sse, 'derives')
  link(voice, canvas, 'relates')
  link(mcp, api, 'relates')
  link(jitter, canvas, 'blocks', 'ship-blocker for canvas polish')
  link(autoClose, warp1, 'relates')
  link(canvas, warp1, 'member')
  link(api, warp1, 'member')
  link(jitter, warp1, 'member')

  svc.addAnnotation({ id: canvas, body: 'Pinning defaults to ON after drag — felt right in testing, revisit if boards get crowded.' }, 'faykarta')
  svc.addAnnotation({ id: api, body: 'Bound to 127.0.0.1 only. Auth token is future work if we ever bind wider.' }, 'claude-code')

  // The review IS the warp's Review stage: feedback members attach to the warp
  // itself (alongside the work), "discusses" edges point at what they concern —
  // one open, one synthesized into an action, one folded, showing the pipeline.
  const fb1 = svc.createNode({
    projectId: pid, type: 'feedback', title: 'Pin behaviour is undiscoverable',
    content: 'Nothing tells you that dragging pins a node. Needs a toolbar hint or a first-run tooltip.\n',
    linkTo: [{ nodeId: warp1, type: 'member', outgoing: true }]
  }, 'claude-code')
  svc.createEdge({ sourceId: fb1.id, targetId: canvas, type: 'relates', label: 'discusses' }, 'claude-code')
  svc.addAnnotation({ id: fb1.id, body: 'Agreed — a pin toggle in the graph controls would make it visible state.' }, 'faykarta')
  const fb2 = svc.createNode({
    projectId: pid, type: 'feedback', title: 'Agents should learn the whole surface from one GET',
    linkTo: [{ nodeId: warp1, type: 'member', outgoing: true }]
  }, 'faykarta')
  svc.createEdge({ sourceId: fb2.id, targetId: api, type: 'relates', label: 'discusses' }, 'faykarta')
  const act = svc.createNode({
    projectId: pid, type: 'action', title: 'Ship /llms.txt with curl recipes',
    content: '## Delta\n\nServe an agent guide at /llms.txt: ontology, endpoints, recipes.\n',
    linkTo: [{ nodeId: fb2.id, type: 'derives', outgoing: false }]
  }, 'claude-code')
  void act
  const fb3 = svc.createNode({
    projectId: pid, type: 'feedback', title: 'Paginate the activity feed?',
    content: 'Feed is capped at 500. Good enough until it is not.\n',
    linkTo: [{ nodeId: warp1, type: 'member', outgoing: true }]
  }, 'claude-code')
  svc.foldNode({ id: fb3.id, note: 'Waived for v1 — the cap is fine, revisit with real usage.' }, 'faykarta')
}

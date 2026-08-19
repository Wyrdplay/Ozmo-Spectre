# Ozmo Spec Engine — Design

A desktop canvas for shaping software with AI agents. Humans and agents work the same board through
the same operations: humans through the UI, agents through a local REST API that mirrors it 1:1.
Spec content lives as plain markdown in an Obsidian vault; structure and process state live in SQLite.

## 1. Philosophy

Three commitments drive every decision below:

1. **Human–agent parity.** There is one service core. The UI calls it over IPC; agents call it over
   HTTP. Same operations, same validation, same events. Anything a human can do on the canvas, an
   agent can do with `curl` — and every mutation records *who* did it (the `actor`), so the activity
   feed reads like a shared work log between you and your agents.
2. **Files are the spec, the database is the shape.** Node content (design docs, warp goals, bug
   write-ups) is markdown files in your Obsidian vault — greppable, syncable, editable in Obsidian
   while the app runs (a watcher folds external edits back in). The graph (links, tags, stage,
   progress, positions, activity) lives in SQLite at `<vault>/.ozmo/spec.db`. Files answer
   "what are we building?"; the DB answers "how does it connect and where is it?"
3. **Everything is a node.** Ideas, pillars, principles, features, bugs, questions — and warps —
   are all nodes in one graph, differentiated by type. Sub-features are just features with a
   `derives` relationship from their parent; warp membership is just a `member` relationship. This
   keeps the model small, makes the whole system graph-visible, and means the API surface is
   uniform.

## 2. Ontology

### Node types

| Type | Role | Notes |
|---|---|---|
| `idea` | Non-binding sparks; explorable, never enforcing | Adopting an idea usually spawns a feature linked `derives` |
| `pillar` | Load-bearing commitments that shape direction | Few, stable; drawn large (hexagon) |
| `principle` | Rules of taste/constraint applied across work | Drawn as diamonds; `shapes` edges point at what they govern |
| `feature` | A buildable capability with a design spec | Has `progress` 0–100 (manual, or rolled up from sub-features) |
| `instance` | One of many kinds in a class — a catalog entry | Usually classified via `class-of`; feeds the class's roll-up |
| `component` | A one-of-one part that does a defined job | The architecture layer; features `depends` on it |
| `bug` | The IMPLEMENTATION diverges from a correct spec | Fix the implementation; usually `blocks` a feature |
| `flaw` | The DESIGN itself is wrong | Fix the spec — bug's sibling (crimson triangle-down) |
| `threat` | A plan endangered by uncertainty | Retire the unknown or replan; `blocks` the plans it endangers (amber Threatened ring) |
| `question` | A neutral unknown that needs an answer | The answer verb writes into its body; threats/flaws convert freely from questions |
| `feedback` | A pure observation about built work | `member`s the node under review (feedback may member ANY node); "discusses" what it concerns; terminal state = waived; excluded from roll-ups and the backlog |
| `warp` | A deliverable: grouped work around goal(s) — sprint-like | Members join via `member` edges; progress is rolled up; carries a `stage` (concept → … → ship · done · not_needed). **The Review stage IS the review** — feedback members are its room, and the forward-restage out of Review is the gated close |
| `area` | A stable grouping of features in space — product geography | Same `member` verb as warps; hulls on the canvas; rolls up from members |
| `action` | A transient instruction — a delta to apply | Completing it REMOVES the node (activity keeps the story) |

There is deliberately **no review node type**: "REVIEW is a stage of a Warp, which is a node."
A warp entering Review opens its review; `fully_actioned(warp)` is the gate that lets it leave
forward — four requirements: every member of the increment COVERED by feedback, every feedback
DESIGNATED (it derives work, or it is waived), every action DISPOSED of (address-now = member +
blocks · address-later = converted and ranked), and nothing unresolved BLOCKING the warp. A
review outlives the stage — sending a warp back does not close it, and the gate follows the
warp — while a review past Review takes no new feedback at all. A shipped warp with waived
(dimmed) feedback IS the archived review.

### State: tags + flags (no status enum)

Nodes have **no status field** — this tool tracks the Spec, not tasks. State is expressed in
**tags**: free, lowercase, user-defined vocabulary (`building`, `blocked`, `done`, `fixed`,
`needs-design`, …). The API rejects `status` on create/update with a pointer to tags; warps are
the exception — their lifecycle is the first-class `stage` field driving the Warps board.

**Flags** turn that vocabulary into highlights. A flag rule (configured in Settings, stored in
app settings) = name + treatment + one or more conditions, and fires when **any** condition
holds:

- **tag condition** — node has tag X.
- **incoming-edge condition** — node has an incoming edge of type Y, *ignoring edges whose
  source node itself matches the Done or Pruned rule* (a fixed bug stops blocking its target).
  An optional `sourceType` narrows the condition to sources of one node type — "blocks from
  threats" can ring differently than a plain block.

Treatments: `ring` (colored dashed ring on canvas, colored edge on rows/cards) · `dim` (the
done look) · `badge` (named chip on rows/cards, dot on canvas). Shipped defaults, fully
editable: **Done** → dim on tags done|fixed|answered|adopted|wontfix; **Blocked** → red ring on
tag `blocked` OR an incoming `blocks` edge; **Debt** → amber badge on tag `debt`; **Pruned** →
dim on tag `pruned`; **Threatened** → amber ring on incoming `blocks` from sourceType `threat`
(Blocked stays type-agnostic, so a threat-blocked plan rings red *and* amber). The rule with id `done` *defines done-ness*: it
drives backlog exclusion, the progress fallback, and the edge suppression above. Every graph
payload carries computed `flags: string[]` per node, so agents see exactly what humans see.

### Connections & relationships

Two nodes share **at most one edge** — the *connection*, unique per unordered pair (app-checked
and locked in by a unique expression index on `(min(source,target), max(source,target))`). The
connection carries the free-text `label` and the threaded **annotations**. Typed direction lives
in **relationships** ON the connection: `edge_relationships(edge_id, type, source_id, target_id)`
— each type at most once per connection, each with its *own* direction. One line can therefore
carry `member A→W` **and** `blocks W→A` **and** `leads-to A→W` simultaneously. A connection with
zero relationships is the bare association — the old `relates` type retired into it.

| Relationship | Meaning |
|---|---|
| `derives` | Parent → child (feature → sub-feature, feedback → the action synthesized from it); acyclic per type |
| `class-of` | Class → instance (classification); acyclic per type |
| `depends` | A depends on B |
| `blocks` | A blocks B (bugs blocking features, threats blocking plans, action-now blocking a warp) |
| `shapes` | Pillar/principle → the work it governs |
| `member` | Node → the warp (time) or area (space) it belongs to; feedback → ANY node it reviews |
| `addresses` | Warp → the goal it is aimed at (must start at a warp, target a non-warp) |
| `leads-to` | Pipeline flow — source comes first |
| *(none)* | Bare connection = general association ("relates"); a feedback's labelled "discusses" is one |

Per-relationship validation re-runs on every mutation (add/flip). Removing a warp membership
removes only the `member` relationship — a connection left bare stays: association survives
membership. Node/edge annotations are timestamped, actor-attributed comments — process residue.
The markdown body is the durable spec; annotations are the conversation around it.

### The workflow this encodes

```
ideas  ──explore──▶  pillars & principles  ──shape──▶  features ──derive──▶ sub-features
  ▲                                                        │
  └── questions / bugs / flaws / threats surface the wrong ┤
                                                           ▼
                          warps group work into deliverables (stage pipeline)
                                                           ▼
        the Review STAGE digests the increment: feedback ──derives──▶ actions ──▶ the spec
         (cover every member · designate every observation · dispose of every action ·
              waive what needs no delta · the forward-restage is the gate that ships)
```

Nothing else is enforced — ideas never block, pillars don't gate — but the graph makes drift
visible: a feature with no `shapes` edge from any pillar is a smell you can *see*. The one
deliberate gate is the restage out of Review: a warp does not ship while any part of its
increment is unreviewed, any observation undesignated, any action unsettled, or anything
unresolved blocking it (and abandoning to not_needed auto-waives what remains).

**Naming** — spec titles are present-tense and carry no version or increment phrasing (`v2`,
`2a`, `(Warp 4)`, `round 3`): a spec node is the current truth, so evolving a capability means
editing its living spec, the increment is the warp, and old behaviour that must survive gets
copied out into an explicit legacy node.

## 3. Storage

### Vault layout

```
<vault>/
  .ozmo/
    spec.db              # SQLite (sql.js) — graph, activity, positions, revisions
    trash/               # soft-deleted node files (nothing is ever hard-deleted)
  <Project Name>/
    Ideas/  Pillars/  Principles/  Features/  Instances/  Components/  Bugs/  Flaws/
    Threats/  Questions/  Feedback/  Warps/  Areas/  Actions/
      <Title>.md         # one file per node
```

Node files carry app-managed frontmatter and a free markdown body:

```markdown
---
id: nd_4f3a9c81e2
type: feature
progress: 60
tags: [canvas, mvp, building]
links:
  - "[[Human-Agent Parity]]"
  - "[[SSE Event Stream]]"
---
## Summary
...your spec, entirely yours...
```

`links` mirrors the graph as pure wikilinks, so **Obsidian's own graph view shows the same
structure** and backlinks work natively. Dot-folders (`.ozmo`) are invisible to Obsidian.

### Sync rules (single-writer sanity)

- The app owns frontmatter and filenames; the body is yours (or your agent's).
- Rename in-app → file renamed, neighbours' wikilinks rewritten.
- Edit in Obsidian → watcher picks it up (self-writes suppressed by content hash), adopts valid
  `tags`/`progress`/`stage` changes from frontmatter (legacy `status` keys are ignored), and
  emits `node.content.updated` so open editors and SSE subscribers refresh.
- External rename → reconciled by frontmatter `id` (unlink+add pairing, 2s grace window).
- Delete in-app → file moved to `.ozmo/trash/`, never destroyed.

## 4. Architecture

```
┌────────────────────────── Electron main ──────────────────────────┐
│  settings.json   VaultFS (gray-matter, chokidar)   SQLite (sql.js)│
│                        └──────────┬──────────┘                    │
│                            Service core  ── activity log          │
│                          (one method registry)                    │
│         ┌──────────────┬──────────┴───────────┐                   │
│      ipcMain      Express :4820          Event bus                │
│         │       REST + /llms.txt + SSE        │ broadcast         │
└─────────┼────────────────┼────────────────────┼───────────────────┘
          ▼                ▼                    ▼
   Renderer (React)   curl / agents      SSE clients + webContents
```

- **One method registry** (`method name → handler(payload, {actor})`). IPC and REST are thin
  adapters over it. Adding a capability in one place adds it everywhere.
- **Actor model.** REST callers send `X-Actor: claude-code` (default `agent`); the UI uses your
  configured name. Every annotation, review comment, and activity entry is attributed.
- **Events.** Every mutation emits `{type, projectId, data, actor, at}` — pushed to the renderer
  (live UI) and to `GET /api/events` (SSE) so agents can react to humans in real time, and vice
  versa. `POST /api/ui/focus` lets an agent literally point at a node on your screen.
- **Server binds 127.0.0.1 only.** Port 4820 by default (auto-increments if busy), configurable.

## 5. REST API (agent surface)

Discovery: `GET /api` (JSON index) and `GET /llms.txt` — a complete agent-oriented guide served by
the running app, including workflow conventions and curl recipes. Highlights:

```
GET    /api/health                          GET    /api/events?projectId= (SSE)
GET|POST /api/projects                      GET|PATCH|DELETE /api/projects/:id
GET    /api/projects/:id/graph              GET    /api/projects/:id/activity
GET|POST /api/projects/:id/nodes            GET    /api/search?projectId=&q=
GET|PATCH|DELETE /api/nodes/:id             PUT    /api/nodes/:id/content
GET    /api/nodes/:id/diff?since=<epoch ms>        — content diff + meta + edges ± + annotations since T
GET    /api/nodes/:id/scope                 GET    /api/nodes/:id/impact
POST   /api/nodes/:id/complete              POST   /api/nodes/:id/prune
POST   /api/nodes/:id/waive                 POST   /api/nodes/:id/answer
POST   /api/nodes/:id/unwaive               POST   /api/nodes/:id/pass
POST   /api/nodes/:id/convert               POST   /api/nodes/:id/request-sweep
POST   /api/nodes/:id/annotations           DELETE /api/annotations/:id
GET|POST /api/projects/:id/edges            GET|PATCH|DELETE /api/edges/:id
POST   /api/edges/:id/relationships         PATCH|DELETE /api/edges/:id/relationships/:type
POST   /api/edges/:id/annotations
GET    /api/projects/:id/warps              POST|DELETE /api/warps/:id/members[/:nodeId]
GET    /api/projects/:id/backlog
POST   /api/ui/focus                        GET    /api/debug/screenshot
```

Reviews have no dedicated CRUD — the Review stage is the review; the retired `/api/reviews*`
routes answer 410 with a pointer. The gate lives on the warp restage: PATCHing stage to
ship/done answers 409 with `error.offenders` — `{uncovered, undesignated, pendingActions,
blockers}` — until the review is fully actioned. Two calls carry the rest of the loop:
`POST /api/nodes/:id/unwaive` undoes a waive (the designation has to be reversible), and
`GET /api/projects/:id/nodes?type=feedback&unassigned=1` is the triage inbox agents share with
the lens. `POST /api/nodes/:id/pass` is the coverage rule's one-call answer for a member of an
increment: it files a feedback titled "Pass - Feedback Waived" against the node (the posted
`body` becomes its markdown body), members it on the warp under review, labels the pair
"discusses" so coverage counts it, and waives it with the same text — the three writes a
confirmation used to cost, made atomic and given to agents and the room alike.

**One word, end to end: WAIVE.** The verb was called `fold` while the loop was being designed;
it is `waive` everywhere now — the endpoints, the registry methods (`nodes.waive` /
`nodes.unwaive`), the activity (`node.waived` / `node.unwaived`), the edge label a covered waive
writes ("waived into"), and the room. The old spelling stays an ACCEPTED ALIAS so nothing in
flight breaks: `/api/nodes/:id/fold` and `/unfold` still route to the same handlers, the
`nodes.fold` / `nodes.unfold` methods still resolve, `node.folded` / `node.unfolded` events
still fire alongside the new ones, and connections labelled "folded into" by older waives
unwaive correctly.

`GET /api/debug/screenshot` returns a PNG of the live window — agents can *see* the canvas they're
editing. Errors are `{"error": {"message"}}` with proper status codes. Timestamps are epoch ms.

## 6. UI

Dark, quiet, type-colour-coded. Left rail (project switcher + views), content, right inspector.

- **Graph** — force-directed canvas (d3-force on `<canvas>`, DPR-aware). Type-shaped nodes
  (hexagon pillars, diamond principles, ringed warps with a progress arc, triangle bugs). ONE
  line per connection: bare draws the quiet relates gray; exactly one relationship draws that
  type's classic look (color, dash, arrowhead oriented by the relationship's own direction); 2+
  draw a neutral bright line with per-relationship chevron glyphs spaced along it, each in its
  type color, each pointing at its own target. Hover/selection shows every verb (+ label). Drag
  pins (toggleable), wheel zoom, drag-pan. Double-click empty space → quick-add at that spot.
  Shift-drag node→node → link popover (upserts: an existing connection gains the picked
  relationship). Right-click → context menu (link, add to warp/area, open review of this, file
  feedback in a review, unpin, delete). Filters bar top-left: node-type chips, relationship-type
  chips (a visual-only lens — the simulation keeps every link so the layout holds still while
  lensing), flag chips. Controls bar bottom-right: pin toggle, fit-to-view, re-layout, + node.
  Flag treatments render live: dim rules fade nodes and
  labels, ring rules draw colored dashed rings (stacked when several fire), badge rules dot the rim.
- **Inspector** — selected node: title, stage (warps), fired flags, progress, tags (the primary
  state control), then tabs: **Spec** (CodeMirror markdown editor with preview toggle, Ctrl+S /
  autosave), **Notes** (annotations thread), **Links** (one row per connection, every verb read
  from this node's side). Selected connection: a relationship editor — one row per relationship
  (verb + direction + flip + remove), an add row (type + direction toggle), the label, and the
  annotation thread.
- **Lists** — the same graph as grouped lists per type with tag chips, flag highlights (colored
  edge / dim / badge chips), progress bars, text filters, inline quick-add. Click-through to the
  inspector.
- **Backlog** — prioritised list of actionable nodes (features/bugs/questions/ideas) in no warp and
  not yet done. Drag to reorder (persists a fractional `rank` on the node — agents PATCH the same
  field), filter, quick-add, and a "→ warp" menu that pulls a row into a planning/active warp,
  which removes it from the backlog.
- **Warps** — ONE board, a column per stage (Concept → Design → Implement → Test → Review →
  Ship · Done · Not Needed), every warp a card with roll-up progress, member count, addressing
  chips and flag highlights. Dragging a card restages the warp; click opens it in the inspector
  (goal spec, members and addressed nodes under Links). Warps track increments, not tasks.
- **Reviews** — the review LENS. Index: every warp holding an OPEN review — those at the Review
  stage plus any open warp still carrying unresolved feedback, because a send-back does not close
  a review — each with its stage, coverage and fully-actioned meter. Below it the **inbox**:
  UNTRIAGED feedback only (no `member` relationship at all), each row offering "send to warp…"
  over the warps whose review is still open. A warp opens as the **four-panel room**: top-left
  **Increment** (the warp node first, then an accordion per node type with generated stats and a
  coverage mark on every row) · top-right **Content** (the full body of the selection, editable
  while the review is open, with its thread, a diff peek since the increment started, and the one
  explicit way out to the canvas) · bottom-left **Feedback** (capture with a markdown body,
  rank-ordered drag-to-reorder rows, waive + undo-waive, designate = convert, multi-select →
  "+ action from N") · bottom-right **Actions** (dispositions, provenance chips) with the
  **door**: the % actioned line, Close (ship), Send back — and nothing else. The standing
  offender lists are gone (the other three panels already carry that visibility); the gate's
  409 renders its offender lists right under the button that earned them, which is the one
  moment the detail is wanted. Every row in the room — increment, feedback, action — carries the
  graph inspector's **id chip** plus a copy-the-API-URL chip, because the room is where a human
  finds a problem and an agent is handed it. An increment row also carries **✓ pass**: one
  gesture that covers the member and settles it (`nodes.pass`). Selecting anything anywhere in
  the lens updates the Content panel and never navigates away; selecting a *work member* also
  arms it as the filing target, and that arming is STICKY — reading a feedback row in between
  no longer silently un-links the next observation from the member it was meant to cover.
  The Content panel renders the editor OR the preview, never both. Dropping a warp into the board's Review column OFFERS a sweep
  (entering the stage IS the open — never auto-creates anything); right-click any node → "File
  feedback on this…".
- **Activity** — reverse-chron feed of everything, actor-badged (you vs. each agent), click to
  jump to the subject.
- **Command palette** (Ctrl+K) — fuzzy jump to any node; Ctrl+N quick-add. Graph keys:
  Ctrl+A selects every visible node (filters, find lens and collapse respected); Ctrl+P
  pin-toggles the selection (any unpinned → pin all where they sit, else unpin all);
  Ctrl+F find; Esc clears; Delete removes (confirmed). The canvas '?' button (bottom-left)
  opens the gestures-and-keys panel; its rows and the key handlers read one shortcut table, so a
  binding is declared once.
- **Settings** — vault path, API port, display name, and the **Flags** card: add/edit/delete
  highlight rules (name, treatment, color, tag / incoming-edge conditions). Saving refreshes
  every open view immediately — no relaunch. Shows the live API base URL.

## 7. Progress model

- Explicit `progress` (0–100) wins when set.
- Warps without it roll up from members; memberless warps take stage-implied progress
  (concept 5 → ship 95, done/not_needed 100).
- Areas roll up as the mean over their members' effective progress.
- **Feedback members never feed a roll-up** — observations about the work are not the work. The
  review lens paints its own fully-actioned fraction over the gate's four requirements (coverage,
  designation, disposition, blocks); the same math, server-side, is the ship gate. An address-now
  action DOES member the warp, so it counts in the roll-up: an increment with an outstanding fix
  is not finished.
- Features without it roll up from `derives` children; classes roll up from their instances.
- Otherwise a node matching the **Done** flag rule counts 100; everything else 0 — tags imply
  no progress beyond done-ness.
- Roll-ups are computed in the graph payload (`progressComputed`), never stored — no stale
  denormalised numbers. The renderer never re-derives progress.

## 8. Tech

Electron 34 + electron-vite · React 18 + zustand · d3-force · CodeMirror 6 · marked + DOMPurify ·
Express 4 + SSE · sql.js (SQLite-in-WASM: real `.db` file, zero native builds) · gray-matter ·
chokidar. Context isolation on; renderer talks only through the typed preload bridge.

## 9. Future

MCP server mode (same registry, one adapter away) · content full-text index · one-call
scope-seeded curation reviews · warp burn-up from activity history · multi-vault switching ·
packaging (electron-builder) · auth token for non-localhost binds.

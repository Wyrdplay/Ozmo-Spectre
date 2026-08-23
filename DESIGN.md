# Ozmo Spectre — Design

*The Agentic Human Canvas.*

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
| `skill` | A standing instruction agents follow — how a kind of work gets done | Authored here, **installed** as `.claude/skills/<slug>/SKILL.md` in declared repos. Carries `slug` (the installed directory's identity), `description` (what a model matches on) and `skillOptions`. A *prompt* is the same node with `disable-model-invocation` — one type, not two |

There is deliberately **no review node type**: "REVIEW is a stage of a Warp, which is a node."
A warp entering Review opens its review; `fully_actioned(warp)` is the gate that lets it leave
forward — **five** requirements: every member of the increment COVERED by feedback, every
feedback DESIGNATED (it derives work, or it is waived), every action DISPOSED of (address-now =
member + blocks · address-later = converted and ranked), nothing unresolved BLOCKING the warp,
and every COMPLETABLE member actually resolved. A
review outlives the stage — sending a warp back does not close it, and the gate follows the
warp — while a review past Review takes no new feedback at all. A shipped warp with waived
(dimmed) feedback IS the archived review.

**Completion** is the fifth and newest requirement, and it exists because the other four could
all pass over an unfinished increment. A warp built out of `action` members is exempt from
coverage by construction (actions are completed by *removal*, so nothing is left to review), so
without this rule such a warp could ship having been reviewed and finished by nobody. It reads:
every member whose type can be completed — feature, instance, component, bug, question, idea,
action, threat, flaw, and warp (a warp may member another warp) — must be RESOLVED under the
same done ∪ pruned set the flag rules use. Standing types (`pillar`, `principle`, `area`,
`skill`) are exempt: they never "done". `feedback` is exempt too, because DESIGNATION is already
its requirement and nothing should be named by two rules — the same reason a node in
`pendingActions` or `blockers` is never also listed in `incomplete`.

### The axes — and a note on how `skill` got in

Every node type answers one question, and the rule for adding a type is that it must claim an
empty axis rather than crowd an occupied one: **WHY** (pillars, principles) · **WHAT** (features,
instances) · **HOW** (components) · **WHERE** (areas) · **WHEN** (warps) · **HEALTH** (bugs,
flaws, threats, questions) · **JUDGMENT** (feedback) · **CHANGE** (actions).

`skill` claims a ninth: **METHOD** — how the work itself is done. Being honest about the
sequence: the *need* came first (standing instructions had to live somewhere, and the app that
specs agent work should be the app that authors what agents follow), and the axis was named
afterwards to satisfy the rule. That is inventing an axis, not discovering one, and it is worth
saying out loud because the axes rule is only useful while it can still refuse a type.

What makes the invention defensible is that the distinction it draws is real and load-bearing in
the code, not just in prose. A skill is not an `action`: an action is a *transient* instruction
about the product that vanishes the moment it is executed, while a skill is a *standing*
instruction about the practice that is never completed at all — which is why `skill` is in
neither `BACKLOG_TYPES` nor `COMPLETABLE_TYPES`, has no terminal verb, and is exempt from the
ship gate. And it is not a `component`: a component is a one-of-one part *of the product*, where
a skill is part of *how the product gets built* and its artifact lands outside the vault
entirely, in someone's repo. Two existing types were genuinely wrong for it; that, rather than
the tidiness of a nine-row table, is the argument.

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
- **stage condition** — a warp sitting at a pipeline stage. Stage is a *field*, not a tag, so
  without this kind no rule could reach a finished warp and it carried no flag at all.

Treatments: `ring` (colored dashed ring on canvas, colored edge on rows/cards) · `dim` (the
done look) · `badge` (named chip on rows/cards, dot on canvas). Shipped defaults, fully
editable: **Done** → dim on tags done|fixed|answered|adopted|wontfix *plus* stage done|not_needed,
so a finished warp is finished work under the same one rule; **Blocked** → red ring on
tag `blocked` OR an incoming `blocks` edge; **Debt** → amber badge on tag `debt`; **Pruned** →
dim on tag `pruned`; **Threatened** → amber ring on incoming `blocks` from sourceType `threat`
(Blocked stays type-agnostic, so a threat-blocked plan rings red *and* amber); **Reference
broken** → red ring on tag `reference-broken`, the severance state (see *The commons* below).
The rule with id `done` *defines done-ness*: it
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
    Threats/  Questions/  Feedback/  Warps/  Areas/  Actions/  Skills/
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

Frontmatter is a **whitelist rebuilt from the DB row, not a merge**: every key is emitted by one
`serialize()` and anything it does not know is dropped the next time any node update or edge
change touches the file. Key order is fixed — `id, type, name?, description?, tags, stage?,
progress?, skill?, links` — and the optional keys stay omitted when unset, so a non-skill node's
file is byte-identical to what it was before skills existed. A skill's slug is written as `name`
because that is SKILL.md's own key and the title already lives in the filename. Adding a field
means teaching `serialize`, `frontmatterFor` **and** the watcher's `handleFsEvent`, or it
evaporates on the first unrelated edit.

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
GET    /api/commons?q=&excludeProjectId=    POST   /api/nodes/:id/share · /unshare
POST   /api/projects/:id/references         POST   /api/projects/:id/forks
POST   /api/nodes/:id/refer
GET    /api/projects/:id/document           GET    /api/nodes/:id/document
POST   /api/projects/:id/document                  — all three accept ?format=json|md and the
                                                     resolved/bodies/links/contents flags
GET    /api/skills?projectId=               GET|POST /api/skills/targets
PATCH|DELETE /api/skills/targets/:id        GET    /api/skills/:nodeId/render[?format=md]
GET    /api/skills/installed/:targetId/:slug  GET  /api/skills/:nodeId/diff?target=
POST   /api/skills/:nodeId/install · /uninstall · /adopt
POST   /api/skills/import
GET|PATCH /api/settings                     GET    /llms.txt
POST   /api/ui/focus                        GET    /api/debug/screenshot
ALL    /api/reviews*                               — 410 with a pointer (the Review stage is the review)
```

Reviews have no dedicated CRUD — the Review stage is the review; the retired `/api/reviews*`
routes answer 410 with a pointer. The gate lives on the warp restage: PATCHing stage to
ship/done answers 409 with `error.offenders` — **five** lists: `{uncovered, undesignated,
pendingActions, blockers, incomplete}` — until the review is fully actioned. All five are always
present, empty or not: the review room mirrors the same groups client-side and renders them
before the close is pressed, so an absent group would silently drop a whole requirement from the
advisory list. Two calls carry the rest of the loop:
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

### The commons — sharing across projects

One vault holds several projects, and the same truth keeps getting retyped into each of them.
The commons is the answer, and its shape is one decision: **the commons is a QUERY, not a
place.** `GET /api/commons` returns every node anywhere carrying the `shared` flag, each stamped
with its owning `projectName`. Nothing is ever migrated into a commons project, because a
commons project would immediately need an owner, a backlog and a review of its own. Sharing
publishes *nothing*: it only makes a node discoverable, and nothing enters another graph until
someone deliberately pulls it in.

`shared` is a **column, not a tag**. Tags are replace-semantic — a routine read-modify-write on
some unrelated tag would sever another project's live references as a side effect — so this one
piece of state is kept out of the tag vocabulary on purpose.

Four verbs, and the choice between them is the whole design:

| Verb | What lands | When |
|---|---|---|
| `share` / `unshare` | nothing / severance | Mark a node discoverable in the commons, or stop |
| `reference` | a **live** local node showing the owner's spec **read-only** | You want to depend on someone else's truth and keep tracking it |
| `fork` | an **editable** local copy, connection labelled "forked from" | You need to diverge — the sanctioned alternative to copy-paste |
| `refer` | a copy in **another** project, tagged `referred`, "referred from" back | You found something that belongs to a project that is not yours |

A **reference** *is* a node: it has its own position and its own connections, and its vault file
*embeds* the owner's file rather than copying it, so Obsidian shows live text. It never ranks and
never joins a warp or an area — it is not this project's work to schedule — and `updateNode`
refuses `title`/`tags`/`progress`/`stage`/`rank`/`slug`/`description` on one with a 400 pointing
at fork. Position and pin stay yours. Adding a reference is idempotent, and it 400s on a node
that is not shared.

A **fork** exists because read-only is only acceptable when divergence has a sanctioned door.
Without it people copy-paste, and the drift comes back invisibly.

**Refer** is the cross-project handoff and it deliberately *copies* rather than moving or
aliasing: a new node in the target project (type `idea` unless told otherwise), tagged
`referred`, with a "referred from" connection back to the origin, which stays put. There is no
approval queue — attribution over access control — so it simply lands, in both activity feeds,
and the receiving owner triages it (`GET /nodes?tag=referred` is the inbox). Warps cannot be
referred: a warp is one project's schedule.

**Severance** is the hard case, and the rule is that severing is always *allowed*, never
*silent*, and never *destructive*. An owner is not held hostage by other projects, so unshare
always succeeds and delete is never refused. But before the rows and the file go, every
reference to that node: (1) **materialises** — the owner's markdown is written into the
reference's own file, which is why the text persists at all, since a live reference only embeds;
(2) stops being a reference, becoming an ordinary local node the project now owns outright; and
(3) gains the `reference-broken` tag, firing a shipped flag rule. Every local connection
survives. The referring project inherits a spec nobody maintains — highlighted, so that is
acknowledged rather than discovered later.

The graph payload is the one place this leaks: `GET /projects/:id/graph` appends the **foreign
endpoints** of cross-project connections after the local nodes, because a cross-project line
needs something to attach to on the canvas. They keep their own `projectId`, which is how a
consumer tells them apart. Every other project-scoped read — nodes, backlog, warps, scope,
impact, document, the review gate — is computed from the local set only, and flags and progress
are computed over the *union* first so a local feature that derives a foreign child still rolls
up correctly.

### The document export

`GET /projects/:id/document`, `GET /nodes/:id/document` and `POST /projects/:id/document` are
three scopes over **one generator**: the whole project (optionally filtered `?type=&tag=&q=`),
one container (area, warp or class) and everything in it, or an explicit set of `nodeIds` — which
is what the canvas selection sends. Default response is `text/markdown` so `curl -o spec.md`
just works; `?format=json` adds `{title, suggestedFilename, stats}`.

Linearisation: a node's parent is the first of *the area containing it*, *its `derives` parent*,
*its `class-of` class* — that is also in the set. Parentless nodes become chapters and the rest
nest under them, ordered by the settings' `typeOrder`, then `rank`, then title. So a whole
project comes out geography-first, a warp comes out as its members, and an arbitrary selection
comes out with whatever structure genuinely exists among it.

The governing rule is that **nothing is silently dropped**. A node under two parents renders once
and is cross-referenced from the other. Anything the walk cannot reach lands in a trailing "Also
in this document" section and is counted in `stats.unplaced`. Excluding resolved nodes prints the
count it left out (`stats.omittedResolved`) rather than quietly shrinking. Ids the project does
not have — a stale id, or one pasted from another graph — are counted in `stats.unknown` and
stated in the document itself. The generator is deterministic: same graph, same bytes, so a
document people diff or re-send does not churn. It is a pure read and writes nothing, not even
an activity row.

### Skills — the app writes into repos

Every other artifact this app produces lives in the vault. A skill's does not: its output is
`<target-root>/.claude/skills/<slug>/SKILL.md` inside somebody's git checkout. That single fact
drives the whole design, because the app is now a program that writes into other people's
repositories through an **unauthenticated loopback API**.

**Targets are the allowlist.** A target is a declared root — `{id, label, kind: repo|global|self,
root, skillsDir, enabled}` — and installs may only land inside one. Crucially, `skillTargets`
lives in settings but is **not editable through `PATCH /api/settings`**: a filesystem allowlist
reachable from an unauthenticated endpoint is an arbitrary-write primitive. It is managed by
`skills.addTarget` / `skills.setTargetEnabled` / `skills.removeTarget`, which validate and log.
For the same reason **ids cross the wire, never paths** — `install`/`uninstall` take
`targets: [id, …]` and an absolute path in that array is a 400, not a convenience. `addTarget` is
the single exception that accepts a path at all: it demands an absolute root that already exists
(the app never *creates* a target root), rejects a `skillsDir` containing `..`, and 409s on a
directory already declared. Disabling is separate from removing, because "not right now" is not
"never again" — and re-adding would mint a new id and orphan every install row keyed to the old
one. A disabled target is still listed but is never scanned, drifted against or written to.
Targets are resolved on read with what is true on disk right now (`exists`, `writable`,
`isGitRepo`, `branch`); `branch` matters because an install lands in the working tree of whatever
is checked out at that moment.

**The scan is one level deep and skips the obvious traps.** `.claude/skills/*/SKILL.md`, no
recursion, no symlinked directories followed, and a skip list (`worktrees`, `node_modules`,
`.git`, `dist`, …) — because the default skills dir is a *sibling* of `.claude/worktrees`, and a
target misconfigured as `skillsDir: '.claude'` would otherwise walk thirteen gigabytes of nested
worktrees on every page load.

**Slugs are validated, never sanitised.** A slug names a directory created inside a repo. Quietly
rewriting a bad one would orphan every directory already installed under the old name, and a slug
that escaped its shape (`../evil`, a Windows device name like `CON`) would be the arbitrary-write
primitive the target allowlist exists to prevent. So `slugProblem()` rejects with a reason: 400.
It is also a **column, not a derivation** — deriving it live from the title would mean a rename
silently orphaned sixteen installs across sixteen repos, so it defaults from the title once, at
creation, and only ever moves when someone changes it on purpose.

**Drift is three hashes**, per (node × target): what the node renders to now, what is on disk, and
what *we* last wrote (`skill_installs.sha`). That third hash is why the table exists — 1-to-N and
written at a completely different cadence from the node, so it is a table and never frontmatter,
which would rewrite the vault file on every install and let the watcher fold it straight back.
Render is byte-stable by design (frontmatter, blank line, body, one trailing newline — the
convention hand-written SKILL.md files already follow), so a skill adopted or imported from disk
re-renders identically and reads `clean` instead of a spurious `ahead` inviting a pointless
overwrite. A rendered skill is capped at 256 KB (413 over it): an instruction, not a corpus.

| State | Meaning | Move |
|---|---|---|
| `missing` | no file | install |
| `clean` | disk = last = rendered | nothing |
| `ahead` | disk = last, the node moved on | install (nobody touched the file) |
| `modified` | disk ≠ last **and** ≠ rendered — hand-edited | the fork below |
| `converged` | disk ≠ last but = rendered — hand-edited *into* agreement | install restamps, no bytes change |
| `unmanaged` | a SKILL.md no node claims | import, or leave it alone |

**The fork is the point.** Installing over a `modified` file answers **409 with `error.drift`** —
a per-target array, the same structured-offender shape the ship gate's `error.offenders` uses, so
an agent handles it with machinery it already has — rather than winning by default. The caller
then picks a direction: `adopt` pulls the hand-edit back into the node so the disk wins and the
learning is kept, or `install {force: true}` overwrites so the node wins (copying the old file
into the vault trash first — forcing is the one destructive path in the module, so it is also the
only one that keeps a copy). Neither is the default, because a hand-edit is evidence that somebody
changed something deliberately at the place they were using it.

**Install is two phases, and the second one never aborts.** Pre-flight throws having written
nothing: the node must render, every target id must resolve and be enabled, every root must still
exist, the skill must *have* a description (without one it never fires, so installing it ships
nothing), and no target may be `modified` unless forced — all deterministic caller errors, where a
half-done batch would be worse than a refusal. Then the write loop runs per target and catches per
target: one locked file or one read-only checkout must not cost the other fifteen targets their
install. So per-target outcomes ride in `results[]`, and **a 200 can still contain failures** —
callers must read them.

**Two paranoid self-checks bracket the write**, both aimed at the same failure: a SKILL.md whose
YAML is subtly wrong still loads its *body*, so the skill looks installed while the description —
the only thing a model matches on — is silently gone. Render re-parses its own output and refuses
to hand back frontmatter that did not round-trip; and after writing, the file is read back from
disk and its `name` checked against the **directory** name. Writes are atomic (temp file in the
same directory, then rename), because a half-written instruction file is worse than none.

**The app owns SKILL.md and nothing else.** Uninstall removes that file and the install record,
and removes the directory only when SKILL.md was the last thing in it — a bundled skill's
`scripts/` and `references/` are not ours. `installed[].bundled` reports when a directory holds
more, so the UI can say so rather than implying ownership of the bundle. `skills.import` is the
way in for skills already hand-written in a repo: they come under management without a rewrite,
and the install row is recorded immediately so the row reads `clean` — presenting somebody's own
file back to them as drift is the first thing they would distrust about the feature. Import and
adopt both 409 when a file's frontmatter `name` disagrees with its directory: that skill
half-loads *today*, and laundering a live bug into the graph is not adoption.

`skills.list` is a **cross-project query** when `projectId` is omitted, exactly like
`commons.list`, because a skill installed into `~/.claude/skills` belongs to the machine rather
than to one project. Unmanaged files get a row of their own with `nodeId: null` — that row *is*
the import affordance, and without it the page would hide skills the human can plainly see in
their repo. A node that fails to render still gets honest disk facts rather than a fabricated
`clean`, and its render error is surfaced rather than swallowed.

**A prompt is a skill with `disable-model-invocation: true`** — one type, one folder, one install
path, one toggle. Two types would mean two of everything: two ontology rows, two install paths,
two drift tables, and a conversion verb between them for a distinction that is one frontmatter
key in the format itself.

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
- **Backlog** — prioritised list of actionable nodes (features, instances, components, bugs,
  questions, ideas, actions, threats, flaws) in no warp and resolved by neither the Done nor the
  Pruned rule, plus open warps; references never rank. Drag to reorder (persists a fractional `rank` on the node — agents PATCH the same
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
  review lens paints its own fully-actioned fraction over the gate's five requirements (coverage,
  designation, disposition, blocks, completion); the same math, server-side, is the ship gate. An address-now
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

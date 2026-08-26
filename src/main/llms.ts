export function llmsTxt(base: string): string {
  return `# Ozmo Spectre — The Agentic Human Canvas · Agent Guide

You are talking to a running desktop app where a human shapes software specs on a canvas.
You have exactly the same powers they do. Base URL: ${base}

## Etiquette

- Send \`X-Actor: <your-name>\` on every request (e.g. \`X-Actor: claude-code\`). Everything you
  do is attributed in the shared activity feed and in annotations/comments.
- All bodies are JSON. Errors: \`{"error":{"message":"..."}}\` with 4xx/5xx. Timestamps are epoch ms.
- Spec content is markdown, stored as files in the human's Obsidian vault. Write good markdown.

## The ontology

Node types and what they mean:
- idea       — non-binding sparks; explorable, never enforcing
- pillar     — load-bearing commitments that shape direction
- principle  — rules of taste applied across work
- feature    — buildable capability with a design spec; has progress 0-100
- instance   — one of many kinds in a class (a rune type, a seal, an element): a catalog entry
               with its own spec + progress 0-100. Usually created with linkTo class-of — the
               default link for a new instance is class-of, but ONLY beside a node that is
               neither a warp NOR an area: the container rules run first, so an instance created
               beside an area MEMBERS that area instead of being classified by it (see below)
- component  — a ONE-OF-ONE part that does a defined job (the damage resolver, the save system):
               the architecture layer, perpendicular to instances' one-of-many. Its spec IS the
               job definition; progress 0-100. Features link to the components that realize them
               with plain \`depends\` (feature —depends→ component). Backlog-ranked work.
- bug        — the IMPLEMENTATION diverges from a correct spec: fix the implementation
- flaw       — the DESIGN itself is wrong: fix the spec (crimson triangle-down — bug's sibling,
               pointing the other way)
- threat     — a plan endangered by uncertainty: retire the unknown or replan. Convention:
               a threat \`blocks\` the PLANS it endangers (warps/features/areas) — the default
               Threatened rule rings those targets amber
- question   — a neutral unknown needing an answer
- feedback   — a PURE OBSERVATION about built work. It MEMBERS the node under review (a warp in
               its Review stage, usually — feedback-typed sources may member ANY node) and links
               relates (label "discusses") to the nodes it concerns. Threaded via annotations.
               Not backlog work; excluded from progress roll-ups and board member counts.
               Every one ends with a DESIGNATION: it derives work, or it is WAIVED (the waive verb
               — undoable with unwaive while the review is open). Diagnosis converts it (reviews below)
- action     — a transient INSTRUCTION: a delta to apply ("update X", "pay down Y"). Actioning it
               brings spec and implementation into sync, then the node is REMOVED (see completion
               below). Full node powers while alive: spec, tags, links, warp membership, backlog.
- warp       — a deliverable: grouped work around goals (sprint-like). Warps carry a \`stage\` —
               the increment pipeline: concept|design|implement|test|review|ship|done|not_needed.
               Stage is warp-only (PATCHing it on other types is a 400). done/not_needed close the warp.
- skill      — a STANDING INSTRUCTION agents follow: how a kind of work gets done here (the
               review checklist, the commit convention, the release drill). Authored as a node,
               INSTALLED as \`.claude/skills/<slug>/SKILL.md\` in one or more repos. Carries
               \`slug\` (the kebab identity that names the installed directory — a FIELD, so a
               retitle never orphans the installs), \`description\` (the ONLY thing a model
               matches on to decide the skill is relevant) and \`skillOptions\`. A PROMPT is the
               same type with \`disable-model-invocation: true\` — one type, not two. See § Skills
- area       — a stable grouping of features in SPACE: product geography (Combat, Economy, the
               Editor). Belonging is the same \`member\` verb warps use — warps group in time,
               areas in space, and one node can be in both at once. Areas roll progress up from
               members, never rank in the backlog, and do NOT hide members from it (geography is
               not scheduling). On the canvas an area draws its members inside a translucent hull.

There is NO review node type — REVIEW is a STAGE of a warp. A warp entering the Review stage IS
the open review; its feedback members are the room; the forward-restage is the gated close.

The AXES — every type answers one question; a new type must claim an empty axis
or extend an occupied one (this table is the test):

  WHY       pillars, principles          what we believe; what shapes the work
  WHAT      features, instances          capabilities and the catalog entries under them
  HOW       components                   the one-of-one parts that do the jobs
  WHERE     areas                        product geography — stable groupings in space
  WHEN      warps                        deliverables — groupings in time, with a stage pipeline
                                         (the Review stage doubles as the review room)
  HEALTH    bugs, flaws, threats,        what is wrong (implementation vs design), endangered,
            questions, flags             unknown, or highlighted
  JUDGMENT  feedback                     observations about built reality, digesting into actions
                                         on the spec while the warp sits in Review
  CHANGE    actions                      transient instructions that update the spec, then vanish
  METHOD    skills                       how the work itself is done — standing instructions that
                                         PERSIST and are installed into repos for agents to follow

METHOD vs CHANGE vs HOW — the three that get confused:
  action (CHANGE)  a TRANSIENT instruction about the product: "update the retry spec". Executing
                   it makes it meaningless, so completing it REMOVES the node.
  skill  (METHOD)  a STANDING instruction about the practice: "this is how we review". It is
                   never completed — it is edited, versioned and re-installed. It describes the
                   work, not the product, so it is in no backlog and no ship gate.
  component (HOW)  a one-of-one part OF THE PRODUCT. A skill is not part of what you are
                   building; it is part of how you build it.

The HEALTH resolution table — four kinds of wrong, four different fixes:

  type      the finding                        the resolution
  bug       implementation diverges from spec  fix the implementation (tag fixed)
  flaw      the design itself is wrong         fix the SPEC (edit it; tag done / waive)
  threat    a plan endangered by uncertainty   retire the unknown or replan (it blocks the plans
                                               it endangers until resolved — Threatened ring)
  question  neutral unknown                    answer it (POST /answer); threats/flaws convert
                                               freely from questions/feedback as diagnosis sharpens

PLACEMENT — file things where they belong (decide by what the thing IS):
  a capability someone uses            → feature
  a part that does a defined job       → component   (one-of-one; its spec is the job)
  one of many kinds in a class         → instance    (one-of-many; class-of links it)
  a grouping in space (geography)      → area
  a grouping in time (deliverable)     → warp
  a belief or constraint               → pillar (direction) / principle (taste)
  the implementation is wrong          → bug
  the design itself is wrong           → flaw
  a plan endangered by uncertainty     → threat      (link it blocks→ the plan)
  an unknown needing an answer         → question
  an observation about built work      → feedback    (member it on the node under review)
  an instruction to change the spec    → action      (transient: completing it removes it)
  a standing instruction for agents    → skill       (permanent: how the work is done; installs
                                                      to .claude/skills — a prompt is one of these
                                                      with disable-model-invocation)
  none of the above yet                → idea (seeds convert later — POST /convert)

FOG is deliberately NOT a row in that table. There is no \`fog\` node type and adding one would
be refused by the axes rule: HEALTH already carries "what is wrong or unknown" and JUDGMENT
already carries "observations about built reality", so \`fog\` would claim no empty axis — it
would put a fifth name on things those two axes already hold, and every item would then have to
be filed twice or filed wrong. Fog is a LENS over the types above: an UNRESOLVED question,
threat, flaw or bug, or an UNDESIGNATED feedback, IS fog the moment it exists. Nothing to tag,
nothing to remember, nothing to keep in sync — file the thing precisely by the table and the fog
report finds it. (The one hand-applied part is the \`fog\` TAG, which marks an item as not yet
sharply phrasable — see § Fog, and do NOT apply it yourself.)

Conventions (recognized, NEVER enforced — keep the graph honest, not policed):
- areas are FEW and STABLE: single-digit count, renamed rarely — geography, not folders
- components are SINGULAR: one node per part that exists once in the architecture
- instances are PLURAL: mass-populate catalogs under a class; collapse keeps the canvas readable
- NAMING: spec titles are PRESENT-TENSE and carry NO version or increment phrasing — never
  "v2", "2a", "(Warp 4)", "round 3", "new". A spec node IS the current truth, so evolving a
  capability means EDITING its living spec, not forking a numbered copy; the increment lives
  in the WARP (that is what warps are for), and the activity log plus the diff API keep the
  history. Still supporting the OLD behaviour? Copy the OLD behaviour out into its own
  explicit legacy node (title it for what it is, e.g. "Legacy X") and leave the living spec
  describing what the thing does NOW.

Instructions vs records — and the terminal verbs. Bugs, flaws, threats, questions, feedback,
ideas, features are RECORDS: they are kept after resolution because history informs; resolve them
positively with tags (done|fixed|answered|adopted) or negatively by PRUNING (below). Actions are
INSTRUCTIONS: meaningless once executed, so completing one REMOVES it (file to vault trash, never
oblivion — the activity log keeps the note and the linked node ids, and the diff API on its former
neighbours shows what it changed). Choose the verb:
- complete  (POST /api/nodes/:id/complete, actions only) — the instruction was executed; node removed
- answer    (POST /api/nodes/:id/answer, questions only) — positive resolution: the answer is written
                                                           into the spec body + \`answered\` tag; node kept, dimmed
- waive     (POST /api/nodes/:id/waive, record family:   — feedback's terminal verb, a flavored prune:
             feedback|bug|question|threat|flaw|idea)       {into?, note} — covered (into = what absorbed
                                                           it, edge labelled "waived into") or flat
                                                           (note only). Distinct node.waived activity.
                                                           ALIAS: /fold + nodes.fold still route here
- unwaive   (POST /api/nodes/:id/unwaive, same family)   — the way back: drops the \`pruned\` tag and the
                                                           "waived into" trail, keeps every annotation.
                                                           A waive is a review DESIGNATION, so it has to
                                                           undo. Activity: node.unwaived. ALIAS: /unfold
- pass      (POST /api/nodes/:id/pass, a warp member)    — coverage + designation in ONE call: files
                                                           feedback "Pass - Feedback Waived" against the
                                                           node (body = your text), members it on the warp
                                                           under review, labels the pair "discusses" and
                                                           waives it. {warpId?, body?, title?}
- prune     (POST /api/nodes/:id/prune, any non-warp)    — the record is dead; node kept, dimmed, with the why
- delete    (DELETE /api/nodes/:id)                      — it should never have existed (mistakes, noise)
Skills are NEITHER instruction nor record: a standing instruction has no terminal verb at all.
It is edited and re-installed while the practice lives, and UNINSTALLED from the repos when it
stops (then pruned like anything else if the practice is retired outright). Do not "complete" one.

State is TAGS, not a status enum. There is no \`status\` field on nodes — sending one on
create/PATCH, or filtering \`?status=\`, is a 400 (this is the migration note: if you used
\`{"status":"building"}\` before, PATCH \`{"tags":[...,"building"]}\` now). Tags are free,
lowercase, user-defined vocabulary: \`building\`, \`blocked\`, \`done\`, \`fixed\`, \`wontfix\`,
\`needs-design\` — whatever the project speaks. Replace-semantics: PATCH \`tags\` sends the FULL
new array (read the node first, add/remove, send back). Warps are the exception: their lifecycle
is the \`stage\` field, not tags.

FLAGS turn tags and edges into highlights. Flag rules live in app Settings (editable by humans
AND by you — GET/PATCH /api/settings); each rule = name + treatment (ring | dim | badge) +
conditions, and FIRES when ANY condition holds:
- tag condition:            node has tag X
- incoming-edge condition:  node has an incoming RELATIONSHIP of type Y — ignoring relationships
                            whose SOURCE node is itself resolved: matching the Done rule OR the
                            Pruned rule (a fixed bug stops blocking its target; so does a pruned
                            idea). Optional \`sourceType\` narrows to sources of ONE node type:
                            {"kind":"incoming-edge","edgeType":"blocks","sourceType":"threat"}
                            fires only for blocks arriving FROM threats
- stage condition:          a WARP sitting at this pipeline stage: {"kind":"stage","stage":"done"}.
                            Stage is a FIELD, not a tag — tags are user vocabulary, stage is the
                            warp pipeline — so without this kind no rule could reach a finished
                            warp and it carried no flag at all. Inert on every other type.
Shipped defaults (editable): "Done" → dim, tags done|fixed|answered|adopted|wontfix, PLUS stage
done|not_needed, so a finished warp is finished work under the same one rule.
"Blocked" → red ring, tag \`blocked\` OR incoming \`blocks\` edge — so a node is Blocked either
by saying so or by a live blocker pointing at it. "Debt" → amber badge, tag \`debt\` — mark
paydown candidates (typical shape: the debt-tagged node derives an action that pays it down).
"Pruned" → dim, tag \`pruned\` — the negative-resolution look (see prune above; waive stamps the
same tag). "Threatened" → amber ring, incoming \`blocks\` from sourceType \`threat\` — a
threat-blocked plan rings BOTH red and amber (Blocked stays type-agnostic on purpose); a
bug-blocked one stays plain Blocked.
"Reference broken" → red ring, tag \`reference-broken\` — the SIXTH shipped rule: a reference
whose owner unshared or deleted the node it pointed at. The text and every local link survived
(see SEVERANCE below), so this is a state to ACKNOWLEDGE — adopt the orphan, repoint it, or
prune it — not a failure to repair.
Every node in the graph payload carries computed \`flags: ["Done","Blocked",...]\` (rule names,
rule order) — you see exactly the highlights the human sees. The rule with id "done" DEFINES
done-ness (progress fallback below); done OR pruned defines RESOLUTION: backlog exclusion and
the edge suppression above. To finish work: tag it (e.g. \`done\` or \`fixed\`) — visuals,
backlog and progress all follow.

Progress (\`progressComputed\` on graph nodes): explicit \`progress\` wins; else warps roll up
from members (else stage implies: concept 5, design 20, implement 50, test 70, review 85,
ship 95, done/not_needed 100); areas roll up as the MEAN over their members' effective progress
(no slider in the UI — the API can still set explicit progress, and explicit wins); features
roll up from \`derives\` children; else a node with \`class-of\` instances rolls up as the MEAN
over its instances' effective progress (design ten runes, watch the Runes class fill); else a
node matching the Done rule counts 100; else 0. Tags imply no other progress — set \`progress\`
yourself as you build.

Connections + relationships. Two nodes share AT MOST ONE edge — the CONNECTION (unique per
unordered pair, app- and index-enforced). The connection carries the free-text \`label\` and the
annotation thread. Typed direction lives in \`relationships\`: a list ON the connection, each
entry \`{type, sourceId, targetId, createdAt, createdBy}\` — each type at most once per
connection, each with its OWN direction. So one line can carry member A→W AND blocks W→A AND
leads-to A→W simultaneously. A connection with ZERO relationships is the bare association
("relates") — \`relates\` is not a relationship type; asking for it just ensures the connection
exists. The connection's own sourceId/targetId are the pair as first created — presentation
order only, no direction implied.

Relationship types — one arrow, two verbs. Reading a relationship from its target's side uses
the INVERSE verb (the UI does this everywhere, so should you):

  type       forward verb   inverse verb   meaning
  derives    derives        derived from   parent→child decomposition (sub-features, spawned work,
                                           feedback → the actions synthesized from it)
  class-of   class of       instance of    class→instance classification (the class's spec is the
                                           rulebook all its instances share)
  depends    depends on     required by    A depends on B
  shapes     shapes         shaped by      pillar/principle → the work it governs
  blocks     blocks         blocked by     A blocks B (threats block the plans they endanger;
                                           "action now" blocks the warp with the action)
  member     member of      contains       node → the warp (time) or area (space) it belongs to;
                                           feedback → ANY node it reviews (the exception)
  addresses  addresses      addressed by   warp → the goal/bug/question it is aimed at (warp is source)
  leads-to   leads to       leads from     pipeline flow: source comes first (sequenced actions,
                                           staged data paths, feature pipelines)
  (bare connection = "relates to" both ways — general association, symmetric; a feedback's
   labelled "discusses" association is one of these)

Per-relationship validation, re-run on EVERY mutation (add/flip): member must target a warp OR an
area — UNLESS its source is feedback, which may member ANY node (feedback attaches to what it
reviews); addresses must start at a warp and target a non-warp; derives and class-of must each
stay acyclic ACROSS relationships — PER TYPE (each type's graph is its own relationship set, so
a node can be a derives-child and an instance at once). Self-loops are banned at the connection
level.

Member-to-area semantics — one belonging verb, two kinds of belonging. member → warp means
SCHEDULED (in the deliverable: hides from the backlog, feeds the warp's rollup, shows on the
board). member → area means PLACED (in the geography: feeds the area's rollup, draws inside its
hull, loads with its scope — but stays in the backlog and off the warp board). A node can carry
both at once on different connections. The inverse verb "contains" reads right from either
container. Convert guards protect containerhood: converting a warp/area away from both types
with members attached is a 400 naming them (warp ⇄ area conversions keep members legal; a warp
with outgoing addresses cannot become an area — addresses must start at a warp).

The workflow: ideas get explored; pillars/principles shape direction; features carry designs and
derive sub-features; warps group work into deliverables; reviews digest feedback about built
increments into actions, and their gate is what ships a warp. Nothing else is enforced — keep the
graph honest: link features to the pillars that shape them, put in-flight work into a warp, file
wrongness precisely (bug vs flaw vs threat vs question) and observations as feedback. Link a warp
—addresses→ the things it is aimed at: member = scheduled on the board, addresses = what the
warp is about.

Decomposition: \`derives\` IS the breakdown mechanism — parent —derives→ child, any type pair
(a bug can be a child of a feature). Children are full nodes; the Lists view just nests them
under their parent. derives must stay acyclic — adding (or flipping) a derives relationship that
closes a loop is a 400. Create a child in one POST with linkTo:
\`{"type":"feature","title":"Child","linkTo":[{"nodeId":"PARENT_ID","type":"derives","outgoing":false}]}\`
(outgoing:false = the PARENT is the edge source, i.e. parent derives new node).

Taxonomy: three hierarchies, three meanings — \`class-of\` CLASSIFIES (Runes —class of→ Fire
Rune: what KIND of thing it is; the class's spec is the rulebook every instance shares),
\`derives\` DECOMPOSES (what PARTS a thing breaks into), \`member\` GROUPS (into a warp = what
increment the work ships in; into an area = where it lives in the product geography). A node
can be all of these at once — instance of a class, child of a feature, member of a warp AND an
area. Any node types on both class-of ends; MULTIPLE classification is allowed
(Fire Rune instance-of Runes AND Fire Things); class hierarchies stay acyclic per type. The
\`instance\` NODE TYPE is the natural class member — mass-populating a catalog means POSTing
type instance with linkTo class-of (or just linkTo {"nodeId":"CLASS_ID"}: the default link for
a new instance is class-of) — but classification is not restricted to it. Nothing is enforced
from class to instance — the app recognizes the taxonomy (Lists nests instances under their
class when no derives parent claims them; a class with no explicit progress rolls up from its
instances), it never enforces it. On the canvas a class can COLLAPSE its instances behind a
count badge (that is per-machine UI state, not data) — with 10s or 100s of instances, collapse
is what keeps the graph readable, so classify honestly rather than sparingly.

Backlog: every actionable node (feature|instance|component|bug|question|idea|action|threat|flaw)
that is in no warp and matches neither the Done nor the Pruned flag rule sits in the project
backlog, ordered by the nullable node field \`rank\` (lower = higher priority; null = unranked,
sorts last). Feedback never ranks here — observations are review material, not scheduled work
(the review lens's inbox collects the open ones). Warps rank here too: a warp stays in the
backlog until its \`stage\` is done or not_needed — prioritise whole deliverables against
individual items. PATCH \`rank\` to reprioritise — fractional values are fine for inserting
between neighbours. Pull from the top of the backlog into a warp when planning.

## Endpoints

Discovery        GET  /api
Health           GET  /api/health
Events (SSE)     GET  /api/events?projectId=<id>     — live stream of every mutation
Point at the UI  POST /api/ui/focus                  {"view":"graph|lists|backlog|warps|reviews|activity|settings","projectId":..,"nodeId":..,"edgeId":..,"warpId":..,"reviewId":..,"tab":"spec|notes|links","modal":"answer|graduate|convert"}
                                                     edgeId selects that connection — its relationship editor opens;
                                                     warpId opens the Warps stage board with that warp selected in the inspector;
                                                     tab (with nodeId) opens that inspector tab — point at a node's links or notes;
                                                     modal (with a nodeId) opens a dialog for the human — propose, they confirm
                                                     (answer: unanswered questions; graduate: answered questions; convert: any node)
See the screen   GET  /api/debug/screenshot          — PNG of the live window

Projects         GET|POST /api/projects              POST {"name","description?"}
                 GET|PATCH|DELETE /api/projects/:id  PATCH {"name?","description?"}
Whole graph      GET  /api/projects/:id/graph        — {nodes:[],edges:[]}; nodes carry progressComputed
                                                       and flags (computed highlight-rule names)
                                                     NOT ONLY THIS PROJECT'S NODES. The payload also
                                                     carries FOREIGN nodes — the far endpoints of
                                                     cross-project connections (references, forks,
                                                     referrals) — appended after the local ones, plus
                                                     the edges that reach them. They are there so the
                                                     canvas has something to attach a cross-project
                                                     line to; they are NOT this project's graph.
                                                     FILTER ON \`projectId\` before you count, sweep,
                                                     export or mutate anything from this payload:
                                                     nodes.filter(n => n.projectId === PROJ). Every
                                                     other read (nodes.list, backlog, scope, document)
                                                     is already project-scoped — the graph is the one
                                                     that is not.
Activity         GET  /api/projects/:id/activity?limit=100&since=<epoch ms>  — since: only entries after T;
                                                       edge.created/deleted carry the connection endpoints (deleted
                                                       also lists the relationships it carried); edge.relationship.
                                                       added/updated/removed carry {type,sourceId,targetId}
Search           GET  /api/search?projectId=<id>&q=<text>   — titles, tags, and spec content.
                                                     TWO LISTS, not one, and both are CAPPED SILENTLY:
                                                     { nodes: [ ...full SpecNode rows whose TITLE or a
                                                                TAG contains q — at most 50 ],
                                                       contentMatches: [ {nodeId, title, type, snippet}
                                                                — the BODY contains q; snippet is ±60
                                                                chars around the first hit, whitespace
                                                                collapsed, elided with … — at most 30 ] }
                                                     Matching is substring, case-insensitive, NOT fuzzy
                                                     and NOT tokenised: "hot reload" never matches
                                                     "Reload, hot". A node can appear in BOTH lists.
                                                     THE CAPS ARE HARD AND UNSIGNALLED — no total, no
                                                     \`truncated\` flag, no paging: exactly 50 nodes back
                                                     means you are probably looking at a truncated
                                                     answer, so narrow q rather than concluding
                                                     anything from the count. \`q\` is required (400
                                                     without it). Need completeness instead of a
                                                     search? GET /nodes?type=&tag=&q= (uncapped —
                                                     but q is a TITLE substring only, and tag is an
                                                     exact match) or the document export.

Nodes            GET  /api/projects/:id/nodes?type=&tag=&q=&unassigned=1
                                                     unassigned=1 — in NO container at all (no outgoing
                                                     \`member\`: no warp, no area, attached to no reviewed
                                                     node) and not resolved. With type=feedback this IS
                                                     the review lens's triage inbox, in one call.
                 POST /api/projects/:id/nodes        {"type","title","stage?","tags?","content?","progress?","x?","y?",
                                                      "pinned?","slug?","description?","skillOptions?",
                                                      "linkTo?":[{"nodeId","type?","outgoing?"}]}  — create pre-linked, see recipe
                                                     stage is warp-only (defaults to "concept"); no status field exists
                                                     pinned:true parks the node where x/y put it instead of letting the
                                                     force layout move it — the same pin Ctrl+P toggles. Pin a node you
                                                     placed deliberately; leave it out and the layout decides.
                                                     slug/description/skillOptions are SKILL fields (§ Skills): slug
                                                     defaults from the title, is validated not sanitised (400), and is
                                                     unique per project among skills (409)
                 GET  /api/nodes/:id                 — full detail: content, annotations, edges, flags
                 PATCH /api/nodes/:id                {"title?","stage?","progress?","rank?","tags?","x?","y?","pinned?",
                                                      "slug?","description?","skillOptions?"}
                                                     tags REPLACE the node's tag set — send the full array
                                                     slug/description/skillOptions: skills only (§ Skills). Retitling
                                                     NEVER moves the slug — the installs would orphan — so rename the
                                                     directory deliberately by PATCHing slug, and reinstall.
                                                     stage: warps only — concept|design|implement|test|review|ship|done|not_needed
                 DELETE /api/nodes/:id               — file goes to vault trash, never destroyed
Spec content     PUT  /api/nodes/:id/content         {"content":"markdown"}   (GET also available)
What changed     GET  /api/nodes/:id/diff?since=<epoch ms>  — one call, everything since T:
                   { nodeId, since, now,
                     content: { changed, baselineApproximate?, from{at,actor}?, to{at,actor}?, unified? },
                     meta: [this node's activity rows, oldest first, detail parsed],
                     edges: { added: [...], removed: [...] },   — RELATIONSHIP granularity, see below
                     annotations: { added: [...] } }
                   edges.added rows are connections (with titles + relationships) plus a \`relationship\`
                   field: null = the connection itself is new since T (its \`relationships\` array is the
                   payload); set = that relationship was added to a connection that predates T.
                   edges.removed rows: \`relationship\` set = only that relationship was removed (the
                   connection remains, possibly bare); \`relationship: null\` = the whole connection was
                   deleted, with \`relationships\` listing what it carried.
                   \`unified\` is a standard unified diff of the markdown body. \`baselineApproximate: true\`
                   means T predates revision tracking, so the diff runs from the oldest snapshot we have.
                   Store the returned \`now\` as your next \`since\`.
Complete action  POST /api/nodes/:id/complete        {"note?"}  — ACTIONS ONLY (400 otherwise).
                                                     Removes the node (file → vault trash, edges cleaned,
                                                     neighbours' frontmatter refreshed); logs
                                                     action.completed with your note + the linked node ids.
Waive record     POST /api/nodes/:id/waive           {"note","into?"} — the record family only
                                                     (feedback|bug|question|threat|flaw|idea); note
                                                     REQUIRED. A flavored prune: tag \`pruned\` lands
                                                     (dim + resolution), the note becomes your
                                                     annotation, \`into\` links a bare connection
                                                     labelled "waived into" to what absorbed it.
                                                     No \`into\` = a flat waive. Activity: node.waived.
                                                     Re-waiving appends the note. Waiving INTO a node the
                                                     feedback already discusses composes the labels
                                                     ("discusses · waived into") instead of erasing the
                                                     review trail.
Unwaive          POST /api/nodes/:id/unwaive         {"note?"} — undo a waive (same family; 400 if it
                                                     is not waived). Removes the \`pruned\` tag and the
                                                     "waived into" label — deleting that connection when
                                                     the waive drew it, keeping it when it predates the
                                                     waive. Annotations stay (the rationale is history).
                                                     Activity: node.unwaived.
                                                     ALIASES — the verb was called \`fold\` until the room
                                                     settled its vocabulary: /api/nodes/:id/fold and
                                                     /unfold (and the nodes.fold / nodes.unfold methods)
                                                     still route here, node.folded / node.unfolded events
                                                     still fire alongside the new ones, and connections
                                                     labelled "folded into" by older waives unwaive fine.
Pass a member    POST /api/nodes/:id/pass            {"warpId?","body?","title?"} — the coverage rule's
                                                     one-gesture answer, for a NON-feedback, NON-action
                                                     member of a warp under review. Files a feedback
                                                     titled "Pass - Feedback Waived" (override with
                                                     title) carrying \`body\` as its markdown body, members
                                                     it on the warp, labels the pair "discusses" so
                                                     coverage counts it, and waives it with the same text
                                                     as the rationale. Returns the (already waived)
                                                     feedback. warpId is optional when the node members
                                                     exactly one warp whose review is still open.
                                                     CONFIRMATION IS A REVIEW RESULT — this is how you
                                                     say "looks right" sixteen times without sixteen
                                                     ceremonies.
Request sweep    POST /api/nodes/:id/request-sweep   — WARPS only. Emits review.sweep.requested
                                                     {warpId,title,stage} on /api/events — subscribe
                                                     and sweep (file feedback) when it fires.
Answer question  POST /api/nodes/:id/answer          {"answer"} — QUESTIONS ONLY (400 otherwise); answer
                                                     markdown REQUIRED. Writes an \`## Answer\` section
                                                     with attribution (you + date) into the file body —
                                                     the answer is part of the spec, diffable, visible in
                                                     Obsidian. Re-POSTing appends a refinement under the
                                                     SAME heading. Adds the \`answered\` tag, and the
                                                     machinery composes: \`answered\` is in the Done rule,
                                                     so the question dims and leaves the backlog, and
                                                     anything it was blocking un-rings automatically.
                                                     Activity: question.answered (full answer in detail).
                                                     Returns the updated node detail.
Prune            POST /api/nodes/:id/prune           {"note","supersededBy?"} — any non-warp node.
                                                     note REQUIRED (the why; kept as your annotation);
                                                     adds the \`pruned\` tag (Pruned rule dims it, backlog
                                                     drops it, its blocks edges stop ringing targets);
                                                     supersededBy links relates "superseded by" to the
                                                     node that made it unnecessary. Reversible: remove
                                                     the tag via PATCH; the annotation trail stays.
Commons          GET  /api/commons?q=&excludeProjectId=  — every SHARED node across every
                                                     project, with its owning projectName. The commons is
                                                     a QUERY, not a project: nothing is migrated into it.
                                                     This is how you DISCOVER what can be referenced.
Share / unshare  POST /api/nodes/:id/share           — mark a node referenceable from other projects.
                 POST /api/nodes/:id/unshare           \`shared\` is a FIELD, not a tag (tags are
                                                     replace-semantic, so a routine read-modify-write
                                                     could sever another project's references). Sharing
                                                     publishes nothing: nothing enters another graph until
                                                     someone adds a reference. Unshare always succeeds —
                                                     it SEVERS live references rather than refusing.
Reference        POST /api/projects/:id/references   {"nodeId","x?","y?"} — pull a SHARED node into this
                                                     project as a local node showing the owner's spec
                                                     READ-ONLY. The reference IS a node: it carries its
                                                     own position and its own connections, and its file
                                                     EMBEDS the owner's file rather than copying it.
                                                     It never ranks and never joins a warp or an area —
                                                     it is not your work to schedule. Idempotent.
                                                     400 if the node is not shared. Link YOUR nodes to it
                                                     (shapes/depends) — that is the point.
Fork             POST /api/projects/:id/forks        {"nodeId","title?"} — an EDITABLE local copy, with a
                                                     bare connection labelled "forked from". This is the
                                                     sanctioned way to diverge; without it people
                                                     copy-paste and the drift comes back invisibly.
SEVERANCE — when an owner unshares or DELETES a shared node, every reference to it:
  materialises (the owner's text is written into the reference's own file, so the content PERSISTS),
  stops being a reference, keeps every local connection, and gains the \`reference-broken\` tag, which
  fires a shipped flag rule. Nothing is deleted in the referring project: it inherits an ordinary local
  node it now owns outright, highlighted so the loss is acknowledged rather than discovered later.
Refer to project POST /api/nodes/:id/refer           {"toProjectId","note?","type?","title?"} — the
                                                     CROSS-PROJECT handoff. You are working in one project
                                                     and find something that belongs to another: send it.
                                                     COPIES (does not move, does not alias): a new node is
                                                     created in the target — type \`idea\` unless you say
                                                     otherwise — carrying the body, tagged \`referred\`, with
                                                     a bare connection labelled "referred from" back to the
                                                     origin. \`note\` becomes an attributed annotation.
                                                     The original STAYS in your project, so the provenance
                                                     link answers "what did we send them, and did they act
                                                     on it?". It LANDS — no approval queue (attribution over
                                                     access control) — in both activity feeds, and the
                                                     receiving owner triages it: rank, convert, or prune.
                                                     Receivers: \`GET /nodes?tag=referred\` IS your inbox.
                                                     A copy, NOT a live reference: once it lands the
                                                     receiving project owns it and will rewrite it. 400 on
                                                     the same project, and warps cannot be referred (a warp
                                                     is one project's schedule — refer what it is about).
                                                     Activity/event: \`node.referred\`, in BOTH projects.
Convert type     POST /api/nodes/:id/convert         {"type"} — the SAME node changes type in place.
                                                     Preserves id, title, spec body, tags, progress,
                                                     rank, pin/position, annotations, revisions, edges,
                                                     createdAt/createdBy; the file moves to the new
                                                     type's folder (wikilinks keep resolving — title
                                                     unchanged). TO warp seeds stage \`concept\`; FROM
                                                     warp clears stage. Refused (400, naming the edges)
                                                     when an edge depends on warp-ness: converting away
                                                     a warp that has members or outgoing addresses
                                                     links, or converting TO warp under an incoming
                                                     addresses link — remove those first. Same type or
                                                     unknown type: 400. Activity: node.converted
                                                     {from,to}; no content revision (body unchanged).
                                                     Returns the full node detail.
Annotations      POST /api/nodes/:id/annotations     {"body"}   — timestamped, attributed to you
                 DELETE /api/annotations/:id

Connections      POST /api/projects/:id/edges        {"sourceId","targetId","type?","label?"} — UPSERT:
(edges)                                              finds or creates the pair's single connection. A
                                                     type ≠ relates ADDS that relationship, directed
                                                     sourceId→targetId (409 ONLY if that type is already
                                                     on the connection — the error body carries the
                                                     connection under error.connection). type absent or
                                                     "relates" just ensures the connection (200,
                                                     idempotent). Response = the connection:
                                                     {id, sourceId, targetId, label, relationships:
                                                      [{type,sourceId,targetId,createdAt,createdBy}],
                                                      sourceTitle, targetTitle, ..., annotationCount}
                 GET /api/edges/:id                  — the connection (shape above) + annotations
                 PATCH /api/edges/:id                {"label"} — label ONLY; sending "type" is a 400
                                                     (types live on relationships now)
                 DELETE /api/edges/:id               — removes the WHOLE connection (all relationships
                                                     + annotations)
Relationships    POST /api/edges/:id/relationships   {"type","sourceId?"} — add a typed relationship;
                                                     sourceId picks the direction and must be one of the
                                                     pair (defaults to the connection's stored source);
                                                     409 on duplicate type
                 PATCH /api/edges/:id/relationships/:type   {"sourceId"} — flip the direction
                                                     (re-validated: member/addresses shape, derives
                                                     acyclicity)
                 DELETE /api/edges/:id/relationships/:type  — remove that relationship; the connection
                                                     STAYS even if now bare (association survives —
                                                     DELETE the edge to sever the pair entirely)
Annotations      POST /api/edges/:id/annotations     {"body"}   — annotations sit on the connection

Warps            GET  /api/projects/:id/warps        — each with stage, members[] and rolled-up progress.
                                                       Warp progress precedence: explicit progress > member
                                                       roll-up (while members exist) > stage-implied
                                                       (concept 5, design 20, implement 50, test 70,
                                                        review 85, ship 95, done/not_needed 100)
                 POST /api/warps/:id/members         {"nodeId"} — upserts a member relationship onto the
                                                       pair's connection (same as POST edges type member)
                 DELETE /api/warps/:id/members/:nodeId — removes ONLY the member relationship; a
                                                       connection left bare stays (association survives
                                                       membership)
Areas            no dedicated routes — areas are plain nodes. Membership is the same member verb:
                 POST /api/projects/:id/edges {"sourceId":"NODE","targetId":"AREA","type":"member"}
                 (remove: DELETE /api/edges/:connId/relationships/member). Load a whole district
                 in one call with GET /api/nodes/AREA_ID/scope (above).
Backlog          GET  /api/projects/:id/backlog      — unassigned work, ordered by rank (nulls last, then
                                                       updatedAt DESC). NINE types rank here — features,
                                                       instances, components, bugs, questions, ideas,
                                                       ACTIONS, THREATS and FLAWS — when they are in no
                                                       WARP and are UNRESOLVED, where unresolved means
                                                       matching NEITHER the Done rule NOR the Pruned rule
                                                       (resolution is done ∪ pruned everywhere in this API;
                                                       a pruned bug leaves the backlog exactly like a fixed
                                                       one). Plus warps, by a different test entirely: a
                                                       warp is backlog until its STAGE is done/not_needed —
                                                       tags and warp membership never apply to warps.
                                                       NOT here: feedback (review material, not scheduled
                                                       work — the lens inbox collects it), pillars,
                                                       principles, areas, skills (standing instructions
                                                       are never "done"), and REFERENCES — a reference to
                                                       another project's node is filtered out whatever its
                                                       type, because it cannot be finished here. Schedule
                                                       around one with a LOCAL node that \`depends\` on it.
                                                       AREA membership hides nothing (geography ≠
                                                       scheduling); areas themselves never rank here.
Scope            GET  /api/nodes/:id/scope?since=&content=1
                                                     — ONE DISTRICT AS ONE PAYLOAD, the context-budget
                                                       boundary: load one container, not the whole project.
                                                       Valid for any CONTAINER: area or warp (member
                                                       relationships targeting it) or class (class-of leaving
                                                       it) — the member set is the union. A warp under review
                                                       returns its feedback members alongside the work
                                                       (filter by type). Returns
                                                       { container, members[], connections[], activity[],
                                                         since, now }: members carry tags, flags,
                                                       progressComputed (+ full spec bodies with content=1 —
                                                       bodies are BIG, budget accordingly); connections =
                                                       member-to-member edges only; activity is filtered to
                                                       the members AND the container itself (since optional,
                                                       ≤200 rows, newest first). Non-container → valid empty
                                                       members. Store \`now\` as your next \`since\`.
Impact           GET  /api/nodes/:id/impact          — BLAST RADIUS: what breaks or stalls if this node
                                                       changes. Transitive, cycle-safe walk over (a) blocks
                                                       source→target while the source is UNRESOLVED (same
                                                       suppression as the flag rules — a fixed bug's chain
                                                       stops) and (b) depends REVERSED (whoever requires the
                                                       node, and their requirers, onward — no resolution
                                                       gate). Depth-capped at 6 with a \`truncated\` flag.
                                                       Returns { counts: {total, areas, warps, byType},
                                                       groups: {features: [...], components: [...], ...} } —
                                                       each entry with tier direct|transitive, depth, up to 5
                                                       title-chain \`paths\`, and the containing \`areas\` +
                                                       OPEN \`warps\`. Ask before touching a component: an
                                                       empty payload means the change is contained.
Fog              GET  /api/projects/:id/fog?bodies=1&area=&limit=
                 GET  /api/nodes/:id/fog             — WHAT THE SPEC DOES NOT YET ABSORB, in one
                                                       report: unresolved question|threat|flaw|bug
                                                       plus undesignated feedback, each classified
                                                       unknown|undecided|unabsorbed, split into the
                                                       FRONTIER (takeable now) and BLOCKED. A LENS,
                                                       not a node type. \`bodies=1\` carries the spec
                                                       prose inline — one call instead of N+1.
                                                       Full shapes, the classes and the signals: § Fog.

Document         GET  /api/projects/:id/document      — THE WHOLE GRAPH AS ONE MARKDOWN DOCUMENT.
                 GET  /api/nodes/:id/document           Returns text/markdown by default (so \`curl -o
                 POST /api/projects/:id/document        spec.md\` just works); add ?format=json for
                                                        {title, markdown, suggestedFilename, stats}.
                                                        THREE SCOPES, one generator:
                                                          /projects/:id/document            the whole project
                                                          /projects/:id/document?type=&tag=&q=  a query over it
                                                          /nodes/:id/document               one CONTAINER (area,
                                                            warp or class) and everything in it
                                                          POST {"nodeIds":[...]}            an explicit set
                                                        LINEARISATION — a node's PARENT is the first of: the
                                                        area containing it, its \`derives\` parent, its
                                                        \`class-of\` class, THAT IS ALSO IN THE SET. Parentless
                                                        nodes are chapters; the rest nest. Order is the
                                                        settings' typeOrder, then rank, then title. So a whole
                                                        project comes out geography-first, a warp comes out as
                                                        its members, and an arbitrary set comes out with
                                                        whatever structure genuinely exists among it.
                                                        NOTHING IS SILENTLY DROPPED: a node under two parents
                                                        renders ONCE and is cross-referenced from the other;
                                                        anything the walk cannot reach lands in a trailing
                                                        "Also in this document" section. Each node carries a
                                                        meta line (type · id · members · tags · progress ·
                                                        flags) and its relationships read from ITS side, with
                                                        the INVERSE verb where it is the target. Body headings
                                                        are re-levelled to nest under their node's heading.
                                                        Flags (all default ON, set ?x=0 to drop):
                                                          resolved  include Done/Pruned nodes — they are MARKED,
                                                                    not hidden; excluding them prints the count
                                                                    it left out rather than quietly shrinking
                                                          bodies    the spec text (bodies=0 gives an outline)
                                                          links     the relationship lines
                                                          contents  the generated table of contents
                                                        This is a READ. It writes nothing and is safe to call
                                                        on anything.

Reviews          no dedicated CRUD — the Review STAGE is the review (old /api/reviews* routes 410).
                 Open:  PATCH the warp {"stage":"review"} — entering the stage IS opening
                 List:  GET /api/projects/:id/nodes?type=warp then filter stage "review" — but a
                        review OUTLIVES the stage (a send-back does not close it), so the open
                        reviews are those warps PLUS any open warp with unresolved feedback members
                 Inbox: GET /api/projects/:id/nodes?type=feedback&unassigned=1 — the UNTRIAGED
                        feedback, in one call: no \`member\` relationship at all (no warp, no area,
                        attached to no reviewed node) and not resolved. This is exactly what the
                        lens inbox shows. \`unassigned=1\` composes with any \`type\`.
                 Triage: POST /api/projects/:id/edges {"sourceId":FEEDBACK,"targetId":WARP,"type":"member"}
                        — sends it to that warp's room. Refused 400 when the warp is PAST Review
                        (ship|done|not_needed): a closed review takes no new material.
                 File:  POST nodes {"type":"feedback","title":"<observation>","content":"<detail>",
                        "linkTo":[{"nodeId":WARP,"type":"member","outgoing":true},
                                  {"nodeId":<node it concerns>,"type":"relates"}]}
                        — then PATCH the relates connection's label to "discusses"
                 Read:  GET /api/nodes/WARP/scope — the whole room in one payload
                 Rank:  PATCH /api/nodes/:id {"rank": n} — feedback and actions are prioritised
                        lists in the room (lower first, fractional values insert between neighbours)
                 Close: PATCH the warp {"stage":"ship"} — the gate 409s until fully actioned

Skills           GET  /api/skills?projectId=<id>     — THE WHOLE PICTURE IN ONE CALL. projectId is
                                                       OPTIONAL: omit it and this is a CROSS-PROJECT
                                                       query like /api/commons, because a skill
                                                       installed to ~/.claude belongs to the machine,
                                                       not to one project. Returns
                                                       {rows, targets, installed}:
                                                       rows[]      {nodeId, projectId, projectName, slug,
                                                                    title, description, promptOnly,
                                                                    drift:{<targetId>: state}} — one per
                                                                    skill NODE, PLUS one per UNMANAGED
                                                                    slug on disk with nodeId NULL and
                                                                    drift "unmanaged" (that row IS the
                                                                    import affordance — never hide it)
                                                       targets[]   {id, label, kind:"repo"|"global"|"self",
                                                                    root, skillsDir, absSkillsDir, enabled,
                                                                    exists, writable, isGitRepo, branch}
                                                       installed[] {targetId, slug, absPath, sha, name,
                                                                    description, bundled, nodeId} — every
                                                                    SKILL.md actually found on disk
                                                     DISABLED targets are still LISTED but are never
                                                     scanned, never drifted against and never written to,
                                                     so they carry no drift cell at all.
Skill targets    GET  /api/skills/targets            — the targets alone (same shape as above)
                 POST /api/skills/targets            {"root","label?","skillsDir?","id?","enabled?"} —
                                                     declare a root the app may write into. root must be
                                                     ABSOLUTE and must ALREADY EXIST (400 — the app never
                                                     creates a target root); skillsDir is relative, no
                                                     "..", defaults ".claude/skills"; 409 when that
                                                     absSkillsDir or that id is already declared; 64
                                                     targets max. Returns {target, targets}.
                                                     THIS IS THE ONLY WRITE PATH FOR THE ALLOWLIST —
                                                     PATCH /api/settings REFUSES skillTargets, because
                                                     this API is unauthenticated on loopback and a
                                                     filesystem allowlist reachable that way is an
                                                     arbitrary-write primitive.
                 PATCH /api/skills/targets/:id       {"enabled":true|false} — turn a target off without
                                                     losing it. "Not right now" is not "never again":
                                                     removing and re-adding would lose the target id and
                                                     with it every install row keyed to it.
                 DELETE /api/skills/targets/:id      — forget the target. NOTHING on disk is deleted;
                                                     uninstall first if that is what you meant.
                                                     Returns {removed, targets}.
Render a skill   GET  /api/skills/:nodeId/render     — the EXACT SKILL.md this node produces:
                                                       {filename:"<slug>/SKILL.md", markdown, sha}.
                                                     ?format=md sends the text itself. A pure read —
                                                     writes nothing, touches no target. Frontmatter is
                                                     \`name\` (the slug) then \`description\` then your
                                                     skillOptions; the vault's own keys (id, type, links,
                                                     tags, stage, progress) are FILTERED OUT — spec-engine
                                                     bookkeeping must never escape into a user's repo.
                                                     The renderer re-parses its own output and 500s
                                                     rather than shipping frontmatter that does not round
                                                     -trip: a half-loading SKILL.md keeps its body and
                                                     silently loses its description, which is the one
                                                     failure that hides. 413 over 256 KB — a skill is an
                                                     instruction, not a corpus; put bulk in reference
                                                     files beside SKILL.md.
Read what is     GET  /api/skills/installed/:targetId/:slug
installed                                            — the installed file VERBATIM: {targetId, slug,
                                                       absPath, exists, bundled, markdown, sha,
                                                       frontmatter, frontmatterError, body, files[]}.
                                                     frontmatterError is SET (and frontmatter null) when
                                                     the YAML is the half-loading kind — that is a fact to
                                                     show, not an empty-frontmatter lie.
Diff before you  GET  /api/skills/:nodeId/diff?target=<targetId>
write                                                — {nodeId, targetId, slug, absPath, state, unified}.
                                                     The diff runs disk → rendered, so \`+\` lines are
                                                     exactly what an install would write. READ THIS
                                                     BEFORE FORCING ANYTHING.
Install          POST /api/skills/:nodeId/install    {"targets":["TARGET_ID",...],"force?":false} —
                                                     targets is a NON-EMPTY ARRAY of target IDS (never a
                                                     path; ≤64). Returns
                                                     {nodeId, slug, sha, results:[{targetId, ok, state,
                                                      absPath, sha, backedUpTo?, error?}]}.
                                                     TWO PHASES. Pre-flight throws and writes NOTHING:
                                                     the node must render, every target id must resolve
                                                     (404) and be enabled, every root must still exist
                                                     (400), the skill must HAVE a description (400 — a
                                                     skill without one never fires, so installing it
                                                     ships nothing), and no target may be \`modified\`
                                                     unless forced. Then the write loop runs per target
                                                     and NEVER aborts: one locked file does not cost the
                                                     other fifteen targets their install, so read
                                                     results[] — a 200 can still contain failures.
                                                     Writes are atomic (temp file + rename) and each one
                                                     is re-read from disk and checked that frontmatter
                                                     \`name\` matches the DIRECTORY name before the sha is
                                                     recorded.
                                                     409 when any chosen target holds a HAND-EDITED
                                                     SKILL.md: \`error.drift\` is an ARRAY —
                                                     [{targetId, slug, state, absPath}] — the same
                                                     structured-offender shape the ship gate uses. Diff
                                                     it, adopt it, or re-send with force:true (which
                                                     copies the old file into the vault trash first).
                                                     An install that changes nothing reports state
                                                     "clean" and rewrites the same bytes.
Uninstall        POST /api/skills/:nodeId/uninstall  {"targets":["TARGET_ID",...]} — removes SKILL.md and
                                                     the install record. Same per-target results[]. The
                                                     DIRECTORY goes only when it is empty afterwards: a
                                                     bundled skill's scripts/ and references/ are the
                                                     human's files, not ours.
Adopt a disk     POST /api/skills/:nodeId/adopt      {"targetId"} — the OTHER resolution for \`modified\`,
edit                                                 and the non-destructive one: the hand-edited file
                                                     wins and the NODE learns it (body, description,
                                                     skillOptions), so the two agree again without
                                                     anybody losing work. Returns {nodeId, targetId,
                                                     absPath, sha, state} — state is honest: \`clean\`
                                                     when the node now re-renders the file byte for byte,
                                                     \`ahead\` when only YAML style differs (install
                                                     restamps it). 409 if the file's \`name\` disagrees
                                                     with the node's slug — adopting would move the
                                                     node's install identity behind its back.
Import           POST /api/skills/import             {"targetId","slug","projectId?","title?"} — turn an
                                                     UNMANAGED SKILL.md into a node without rewriting it.
                                                     projectId falls back to settings.skillsHomeProjectId
                                                     (a skill on disk belongs to no repo in particular).
                                                     Records the install immediately, so the row reads
                                                     \`clean\` rather than presenting the human's own file
                                                     back to them as drift. 404 with no such file, 400 on
                                                     malformed YAML, 409 when the file's \`name\`
                                                     disagrees with its directory (that skill half-loads
                                                     TODAY — fix the file first).
                 EVERY route above takes target IDS, never paths. The declared roots ARE the allowlist;
                 an install verb that accepted a path would be an arbitrary-file-write primitive on an
                 unauthenticated loopback API. Unknown target → 404 naming the declared ids.
                 Slugs are validated, never sanitised — "../evil", "Foo Bar", "CON" and anything over 64
                 characters are all 400s on the NODE (POST/PATCH nodes), long before any path is built.
                 See § Skills for the model.

Settings         GET  /api/settings                  — vault path, port, human name, flag rules,
                                                       styleOverrides, typeOrder, skillTargets (READ-ONLY
                                                       here — see POST /api/skills/targets),
                                                       skillsIncludeGlobal, skillsHomeProjectId
                 PATCH /api/settings                 {"flags?": [...], "styleOverrides?": {...}, "typeOrder?": [...]}
                                                     flags: replace the flag-rule array (send the FULL
                                                     array, read-modify-write like tags); rule order IS
                                                     chip order and evaluation order. Rules are
                                                     {id,name,treatment:"ring"|"dim"|"badge",color?,
                                                      conditions:[{kind:"tag",tag}|{kind:"incoming-edge",edgeType}
                                                                  |{kind:"stage",stage}]}
                                                     Returns {settings, relaunchRequired}.
                 styleOverrides — theme the UI (canvas nodes, chips, dots, lines), merged over the
                 shipped defaults; render-side ONLY (graph payloads and vault FOLDERS never change):
                   {"nodes":{"feature":{"color":"#22c55e","shape":"diamond","radius":14,"fill":"outline",
                     "inner":{"glyph":"?","color":"#e6eaf2","fill":"solid"}}},
                    "relationships":{"depends":{"color":"#eab308"},"relates":{"color":"#64748b"}}}
                   shapes: circle|hexagon|diamond|square|triangle|triangle-down|ring|chevron · fill:
                   solid|outline (outline = stroke-only in the type colour; glow and click area
                   unchanged) · inner: optional glyph drawn INSIDE the node at ~0.45× its radius —
                   any shape, or a bold text symbol ?|!|+|x|. — with its own color and its own
                   solid|outline fill (fill is ignored for text symbols; color defaults to #e6eaf2;
                   omit inner for none) · colors hex (normalized to 6-digit) · radius 4-40 ·
                   "relates" colors the bare connection. Unknown types/shapes/glyphs, bad fills and
                   non-hex colors are silently dropped. Omit a field to keep its default; PATCH
                   styleOverrides null (or {}) to reset everything. Caveats: the warp progress arc
                   only renders on the ring shape — restyling warp away from ring hides it (reset
                   restores) — and an inner glyph on a warp replaces the progress number in the ring.
                 typeOrder — node-type display order (graph toolbar chips, quick-add picker, Lists
                   sections): e.g. ["bug","feature","warp",...]. Unknown entries drop, missing types
                   append in default order; null resets. Flag-chip order = the flags array order itself.

## The review process — verbs on the graph

REVIEW is a STAGE of a warp, which is a node. The review digests FEEDBACK about the built
increment into ACTIONS on the spec — everything is nodes and edges; there are no review rows,
item statuses or verdict enums.

1. OPEN — the warp enters the Review stage (drag the card; the board offers a sweep). That IS
   the open. Reviewing a non-warp node needs no stage: file feedback straight onto it.
   A review OUTLIVES the stage: sending the warp back does not close it, and the gate follows.
   Past Review (ship|done|not_needed) the review is CLOSED and takes no new feedback — the
   member relationship is refused with a 400 naming the warp and its stage.
2. FILE — anyone (you included) files feedback: pure observations, \`member\` of the warp under
   review (alongside the work members — type keeps them apart), "discusses" edges to the nodes
   they concern. Thread in annotations. Sweeps are exactly this (review.sweep.requested on SSE
   invites you; the six angles below are your checklist). Feedback with NO container is
   UNTRIAGED — the lens inbox, and yours in one call: nodes?type=feedback&unassigned=1.
   Title and body stay editable while the review is open; feedback and actions carry \`rank\`.
3. DESIGNATE — every piece of feedback ends with at least one designation, or the gate holds it:
     derive work  → N feedback → one action (feedback —derives→ action, many-to-many), or
                    convert it (feedback → bug | flaw | threat | question | action), after which
                    the record lives its own institutional life (backlog, flags)
     WAIVE        → POST /api/nodes/:id/waive {note, into?} — settle it with a rationale instead
                    of a delta. Waive IS an action, and it UNDOES: POST /api/nodes/:id/unwaive
                    drops the \`pruned\` tag + the "waived into" trail, keeps every annotation,
                    logs node.unwaived — and the feedback is back in front of the gate.
                    Covering a member with a confirmation is one call: /api/nodes/:id/pass.
4. DISPOSE — every action is addressed now or later; undisposed counts as open:
     ADDRESS NOW   → the action \`member\`s the warp AND \`blocks\` it: in this increment, and the
                     ship waits for it (completing it removes the action and its derives edges,
                     so the feedback behind it needs a waive or fresh work)
     ADDRESS LATER → convert the action to persistent work (feature/flaw/…) and PATCH rank; it
                     is no longer transient, so it leaves this review's math
5. CLOSE = SHIP — the forward-restage IS the close: PATCHing a warp to ship/done is legal only at
   FULLY-ACTIONED, five requirements:
     COVERAGE    — every non-feedback, non-action member of the warp has ≥1 feedback ABOUT it:
                   a bare association with a feedback node ("discusses"), a feedback membering
                   it, or a record that feedback derived. CONFIRMATION COUNTS — "this matches the
                   spec" is a review result, so file it. An unreviewed increment does not ship.
     DESIGNATION — every feedback member derives something, or is waived (step 3)
     DISPOSITION — no live \`action\` derived from this warp's feedback remains (step 4)
     BLOCKS      — nothing UNRESOLVED holds a \`blocks\` relationship into the warp; same
                   resolved-set as the flag rules, so a bug tagged \`fixed\` stops blocking
     COMPLETION  — every COMPLETABLE member of the warp (feature, instance, component, bug,
                   question, idea, action, threat, flaw, warp — a warp may member another warp)
                   is RESOLVED, same resolved-set as BLOCKS. Standing types (pillar, principle,
                   area, skill) are exempt — they never "done" — and so is feedback, which already
                   carries DESIGNATION. This is what stops a warp built out of \`action\`
                   members — COVERAGE_EXEMPT, completed by REMOVAL — from shipping having been
                   reviewed and finished by nobody: complete()/waive/tag-done the member, or
                   drop it from the warp.
   Otherwise 409 with error.offenders {uncovered:[{id,title,type}], undesignated:[{id,title}],
   pendingActions:[{id,title,feedbackIds,disposition}], blockers:[{id,title,type}],
   incomplete:[{id,title,type}]} — disposition is "address-now" | "undisposed". A node already
   named in pendingActions or blockers is never also named in incomplete (named once).
   The gate fires from the Review stage AND from wherever else the warp sits while unresolved
   feedback members remain; a warp that was never reviewed ships freely. Backward restage is
   always free (send-back needs no verb). Restage to not_needed always bypasses: remaining open
   feedback auto-waives with a "warp abandoned" note. A shipped warp with waived (dimmed)
   feedback members IS the archived review — nothing else is stored.

The SIX ANGLES — the sweep checklist and the closing summary's skeleton, NEVER items to file:
  completeness — everything the trigger promised exists
  fidelity     — specs match built reality (diff the scope members)
  integrity    — no unresolved blocks, no open member questions
  consequence  — what this changed beyond its scope
  record       — the graph tells the story (tags, progress, provenance)
  harvest      — nothing discovered along the way died in a comment

Curation is a review too: seed one feedback per record from any node query (all unadopted ideas,
stale questions…), each "discusses" its target; adopt = synthesize/convert; waive = waive the
feedback AND prune the target with the same rationale (the waive dialog offers this in one
gesture whenever the feedback discusses a record).

## Fog — what the spec does not yet absorb

Fog is everything the spec has not yet taken in: the open question, the live threat, the unfixed
flaw, the standing bug, the feedback nobody designated. One call gives you the whole pile,
classified and ordered, so you can pick up uncertainty deliberately instead of tripping over it
halfway through a build.

  GET /api/projects/:id/fog?bodies=1&area=<AREA_ID>&limit=<n>
  GET /api/nodes/:id/fog                   — the same report, scoped to ONE container

A LENS, NOT A TYPE. There is no \`fog\` node type and there is not going to be one — the axes
rule refuses it (see § The ontology). Fog is computed on read from types that already exist:

  question   unresolved                            threat   unresolved
  flaw       unresolved                            bug      unresolved
  feedback   UNDESIGNATED — derives nothing and is not waived

"Unresolved" is exactly the resolved-set the flag rules and the ship gate use: NOT matching the
Done rule (tags done|fixed|answered|adopted|wontfix, or a done/not_needed warp stage) and NOT
matching the Pruned rule (tag \`pruned\`, which waive stamps). This is not a coincidence to be
tidied later — it is the point. Answer a question and it leaves the fog; prune a node and it
leaves the fog; waive a feedback and it leaves the fog, the same instant each stops holding the
gate. FOG AND THE SHIP GATE NEVER DISAGREE ABOUT WHAT IS SETTLED. If you find a case where they
do, that is a bug worth filing, not a nuance to work around.

THE THREE CLASSES (\`fogClass\`) — not severity, three different NEXT MOVES:

  unknown      nobody knows the answer                    → go and find out (research, a spike,
                                                             a measurement). An agent can do this.
  undecided    the options are known, nobody has chosen   → a HUMAN decides. Researching harder
                                                             does not help; this one is not yours.
  unabsorbed   we know what is wrong, the spec does not   → do the work: edit the spec, fix the
               say so yet                                    code, designate the observation.

The class is DERIVED from what the item is, so it cannot rot by someone forgetting to tag:

  question                → unknown       the default: an unknown needing an answer
  question + \`undecided\`  → undecided     the ONE hand-applied input, because it is genuinely
                                          invisible from the type: "which cache do we use" and
                                          "how fast is the cache" are both questions, and only
                                          one of them is answerable by going and looking
  threat                  → unknown       NOT unabsorbed. A threat is a plan endangered by
                                          something nobody has PINNED DOWN — go and find out is
                                          what retires it, exactly the unknown move
  flaw | bug              → unabsorbed    we already know what is wrong (the spec / the code);
                                          the work is missing, not the knowledge
  feedback (undesignated) → unabsorbed    an observation nobody turned into work. DESIGNATED
                                          feedback — anything with an outgoing \`derives\` — is
                                          not fog at all: it was absorbed into what it spawned,
                                          and counting both would double-count one uncertainty

Cross-project REFERENCES are excluded outright: a node you cannot answer, fix or waive here is
not this project's fog, the same call the backlog already makes.

SHARPNESS (\`hazy\`) IS NOT DERIVED — AND YOU MUST NOT SET IT. \`hazy: true\` means the item
carries the \`hazy\` tag: the human cannot state it precisely yet. The test is

    "can you state the question precisely NOW — not whether you can answer it now"

Everything in this report is unanswered by construction, so answerability would flag all of it
and mean nothing. Phrasability is the real line, and it reads differently from inside a problem
than from outside it, so it is the ONE judgement in this feature an agent must not make on the
human's behalf. Never PATCH the \`hazy\` tag onto someone's node. What you CAN do — and should —
is sharpen a hazy item: read its body, propose a precise phrasing as an annotation or via
POST /api/ui/focus, and let the human drop the tag when it is sharp. \`hazy\` is a to-be-sharpened
marker, not a severity.

THE FRONTIER is fog that nothing unresolved is blocking — takeable RIGHT NOW. Every item lands
in exactly one of \`frontier\` or \`blocked\`, so \`counts.frontier + counts.blocked === counts.total\`
and \`byClass\` sums to \`total\`; if your arithmetic disagrees you are reading a filtered payload
(\`limit\`/\`area\` cap the LISTS; the counts stay honest about the whole scope). Blocking uses the
same resolution suppression as the flag rules: a blocker that is done or pruned stops holding its
target down, and the item returns to the frontier by itself with nobody editing an edge.

  Start here: frontier + fogClass unknown   → the research an agent can just do
              frontier + fogClass undecided → what to ASK THE HUMAN (batch these; do not guess)
              frontier + fogClass unabsorbed → spec work waiting to be written
              blocked                        → read \`blockedBy\` before touching any of it

THE FRONTIER IS SORTED AS A QUEUE — work it down from the top and you are working in a defensible
order without thinking about it: (1) \`blocks.length\` DESCENDING — leverage, the only measure of
worth comparable across projects: clearing something that holds four nodes down releases four
nodes. (2) sharp before hazy — a hazy item STAYS in the frontier (it is genuinely unblocked, and
its count is the honest measure of how much of the pile is unspeakable) but it does not sit above
work that can start now. (3) class unabsorbed → unknown → undecided: cheapest-to-clear first, and
descending by who can clear it — undecided sits last because it is the class an agent cannot move
at all, which is about YOUR queue, not about its importance. (4) age descending. (5) id, so two
identical calls diff cleanly. \`blocked\` is a SEPARATE list, never merged — merging would let a
blocked item outrank a takeable one — sorted by \`blockedBy.length\` ASCENDING first: nearest to
becoming frontier at the top.

THE SIGNALS (\`signals[]\`) are meta-observations about the SHAPE of the pile, not about any one
item. Four kinds:

  no-decision-order      \`count\` = how many OPEN QUESTIONS have no question→question \`blocks\`
                         at either end. Fires only when there are ≥6 open questions in scope —
                         five or fewer genuinely can all be takeable at once, so below that the
                         absence of order is a coincidence and above it it is a claim. Read it
                         carefully; see below.
  unlocated-fog          \`count\` = items in NO AREA (a warp does not count — geography is what
                         density is measured against). Every figure in \`areas\` covers only the
                         located remainder, so it UNDERSTATES the real load until these are
                         membered into a district. Counted, never hidden (\`counts.unlocated\`).
  stale-fog              \`count\` = items open longer than 14 DAYS; the detail names the oldest and
                         its age. Work has been routed AROUND these rather than through them, which
                         is a different problem from a young open question and wants a different
                         response: decide whether it still MATTERS before answering it. (Two weeks
                         was measured, not chosen by taste — it sits just beyond everything
                         currently in flight in this vault, so healthy churn stays silent.)
  undesignated-feedback  \`count\` = observations nobody derived work from or waived — the same set
                         the ship gate's \`undesignated\` offender list holds, seen before the 409.

READ \`no-decision-order\` HONESTLY. It fires when open questions carry no recorded prerequisite
order between them, and its usual companion is a frontier holding nearly everything. The
tempting reading is "this work is all parallel". THAT IS ALMOST NEVER TRUE. The real reading is
"nobody ever recorded prerequisite order between the decisions", and the frontier is therefore
overstating what is genuinely takeable. Measured on a live project the day this shipped: 43 open
questions, 19 \`blocks\` relationships starting at a question, and EVERY ONE OF THEM pointing at
work rather than at another question. That graph correctly says the questions gate the building.
It says nothing whatsoever about which question gates which — so 43 decisions read as takeable
when the real number is smaller and ordered.

The fix is a habit, and it is yours as much as the human's: WHEN ONE DECISION GENUINELY GATES
ANOTHER, RECORD IT.

  curl -s -X POST ${base}/api/projects/PROJ/edges -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"sourceId":"Q_STORAGE_ENGINE","targetId":"Q_INDEX_STRATEGY","type":"blocks"}'
  # "we cannot choose an index strategy until we have chosen the storage engine"

Do this while the reasoning is in front of you — noticing that Q2 only makes sense after Q1 is
a discovery, and the graph is where discoveries go. Two cautions: \`blocks\` between questions
means PREREQUISITE, not "related" (a bare connection says related); and the blocks graph is the
frontier, so a wrong arrow parks real work. When you are unsure whether one gates the other,
leave it — an overstated frontier is a smaller lie than a fabricated dependency.

\`bodies=1\` — WHY IT EXISTS. \`fogClass\` tells you what KIND of fog an item is; only the prose
tells you what it actually ASKS. Without bodies you would read the report and then GET each item
to find out whether it matters: a district with 30 open questions is 31 calls and 31 round trips.
With \`bodies=1\` it is ONE call and you can triage the whole district's uncertainty in a single
pass. Bodies are BIG, so budget: take them when you intend to triage, leave them off when you
only want counts, and narrow with \`area=\` or \`limit=\` before reaching for the whole project's
prose. \`body\` is present ONLY when you ask — absent otherwise, not empty-string.

THE PROSE BUDGET IS 256KB PER REPORT (~60k tokens), spent in output order so the frontier's prose
is the prose that survives a tight budget. NOTHING IS DROPPED SILENTLY: the one item that straddles
the budget keeps a truncated body with a marker naming the byte counts, and every item past it gets
a body that SAYS it was omitted and where to fetch it —

  "[…body truncated by the fog endpoint: 4021 of 90311 bytes — GET /api/nodes/nd_x/content for the rest]"
  "[body omitted — the fog report's 256KB prose budget was exhausted before this item; GET /api/nodes/nd_y/content for it]"

So a \`body\` that starts with "[body omitted" is a POINTER, not the spec. If you see either marker,
you asked for too much at once: narrow with \`area=\`/\`limit=\` and call again rather than reasoning
from a half-read district.

\`limit=<n>\` (positive integer; anything else is a 400) trims the \`frontier\` and \`blocked\` ARRAYS
— each to n, independently. It NEVER touches \`counts\`, which stay true about the whole scope. That
is the intended way to read a big project: exact numbers, a bounded queue.

RESPONSE — GET /api/projects/:id/fog?bodies=1

  {
    "projectId": "pr_17fee7cb20",
    "at": 1787681174524,
    "counts": {
      "total": 31,
      "byClass": { "unknown": 18, "undecided": 6, "unabsorbed": 7 },
      "byType":  { "question": 24, "threat": 2, "flaw": 1, "bug": 3, "feedback": 1 },
      "frontier": 27, "blocked": 4,     // TRUE totals — \`limit\` trims the arrays, never these
      "unlocated": 5,          // in no AREA (a warp does not count)
      "hazy": 3                // carrying the \`hazy\` tag
    },
    "areas": [                 // fog DENSITY per district — size-independent, so districts compare.
                               // EVERY area in the project, densest first — a district with NO fog
                               // is information too. \`members\` is the district's whole membership
                               // (the closure, following nested containers), \`total\` its fog.
      { "id": "nd_1a2b3c4d5e", "title": "Storage & Sync", "members": 24, "total": 9,
        "byClass": { "unknown": 6, "undecided": 2, "unabsorbed": 1 }, "density": 0.375 }
    ],
    "frontier": [              // takeable now — nothing unresolved holds these down
      { "id": "nd_9f8e7d6c5b", "type": "question", "title": "Which cache backend?",
        "fogClass": "undecided", "hazy": false,
        "areaId": "nd_1a2b3c4d5e", "areaTitle": "Storage & Sync",
        "warpId": null, "warpTitle": null,
        "blockedBy": [], "blocks": [ { "id": "nd_44aa55bb66", "title": "Session Tokens", "type": "feature" } ],
        "tags": ["undecided","storage"], "createdAt": 1786000000000, "age": 1681174524,
        "body": "## Options\\n\\nRedis, or the embedded store...\\n" }
    ],
    "blocked": [               // read blockedBy before touching any of these
      { "id": "nd_77cc88dd99", "type": "flaw", "title": "Token refresh races",
        "fogClass": "unabsorbed", "hazy": true,
        "areaId": null, "areaTitle": null, "warpId": "nd_2233445566", "warpTitle": "Warp 7",
        "blockedBy": [ { "id": "nd_9f8e7d6c5b", "title": "Which cache backend?", "type": "question" } ],
        "blocks": [], "tags": ["hazy"], "createdAt": 1786500000000, "age": 1181174524 }
    ],
    "signals": [                        // absent entirely when a signal does not fire
      { "kind": "no-decision-order", "count": 24,
        "detail": "24 of 24 open questions have no recorded prerequisite order (0 question→question \`blocks\` relationships in scope). Not one question is recorded as needing another answered first, so every one of them reads as takeable — which is almost never true. Draw \`blocks\` between the questions that actually gate each other before treating this frontier as a work queue." },
      { "kind": "unlocated-fog", "count": 5, "detail": "5 fog items belong to no area. ..." },
      { "kind": "stale-fog", "count": 2, "detail": "2 items open longer than 14 days (oldest: \\"Which cache backend?\\" nd_9f8e7d6c5b, 47 days). ..." },
      { "kind": "undesignated-feedback", "count": 1, "detail": "1 feedback item with no designation: ..." }
    ]
  }

\`age\` is MILLISECONDS SINCE CREATION, already computed — do not subtract \`createdAt\` from
\`at\` yourself and do not read it as a timestamp. \`areaId\`/\`warpId\` are null when the item is
in no such container; both null means it is counted in \`unlocated\`. Every id is a real node id:
GET /api/nodes/:id works on any of them, and so does /impact if you want the blast radius of the
thing a question is holding up.

SCOPING — GET /api/nodes/:id/fog is the THIRD DISTRICT LENS, beside /scope (what is here) and
/impact (what breaks if this changes): what is still UNABSORBED here. \`:id\` must be a CONTAINER,
an AREA or a WARP — anything else is a 400 that names the type and points you at the container it
belongs to. Membership follows through NESTED containers, so a warp membering an area contributes
its fog to that area's report.

  curl -s "${base}/api/nodes/AREA_ID/fog?bodies=1"      # this district's uncertainty, prose included
  curl -s "${base}/api/nodes/WARP_ID/fog"               # what is unabsorbed inside this increment

\`area=\` on the PROJECT report narrows the same way without changing endpoints, but it takes an
AREA only — pass a warp id and you get a 400 pointing at /api/nodes/:id/fog, which reaches any
container. An id the project does not have is a 404. When a report is scoped, \`areas\` lists only
the districts actually represented instead of every area in the project.

FOG IS REPORTED, NEVER GATED. No fog check exists in the ship gate and none is coming. Every gate
category is a FACT ABOUT THE GRAPH — you can point at the edge or the tag that decides it. "Is
this fog?" shades into judgement at the edges, and a 409 on a judgement teaches people to satisfy
the checker rather than to resolve the fog: don't file the question, tag it resolved early, keep
the uncertainty out of the graph where the tool cannot see it. That is exactly what this feature
exists to prevent. So read the fog before you plan, cite it when you argue about readiness, and
never treat it as permission.

## Skills — standing instructions, authored here, installed into repos

A SKILL is how a kind of work gets done here. It is a node (type \`skill\`, the METHOD axis), and
its OUTPUT is a file: \`<target-root>/.claude/skills/<slug>/SKILL.md\`. The node is the original;
the installed file is a BUILD OUTPUT. Editing the node and re-installing is the normal loop.
Skills are never "done": no backlog, no progress, no ship gate, no completion verb — they are
edited, versioned and re-installed for as long as the practice lives.

A PROMPT IS A SKILL. There is one node type, not two. A "prompt" is a skill whose frontmatter
carries \`disable-model-invocation: true\` — the model may not select it on its own, so a human
(or you) invokes it deliberately. One type, one folder, one install path, one toggle:

  PATCH /api/nodes/:id {"skillOptions":{"disable-model-invocation":true}}   # → a prompt
  PATCH /api/nodes/:id {"skillOptions":{}}                                  # → a skill again

\`rows[].promptOnly\` in GET /api/skills is exactly that flag read back. Do not create a second
type, a tag vocabulary or a naming convention to mean "prompt" — the flag is the whole mechanism.

THE THREE FIELDS that make a skill node different from every other node:
  slug            the kebab IDENTITY that names the installed directory. A FIELD, never derived
                  live from the title — retitling a skill must not silently orphan sixteen
                  install directories in sixteen repos. Defaults from the title AT CREATION only.
                  VALIDATED, NEVER SANITISED: lowercase letters, digits, single hyphens, ≤64
                  chars, not a Windows device name. Anything else is a 400 with the reason —
                  because a sanitiser that quietly turned "../evil" into "evil" would orphan the
                  installs it did not match, and a slug that escaped its shape would be an
                  arbitrary-write primitive on an unauthenticated loopback API. Unique per project
                  among skills (409 naming the node that already owns it).
  description     the frontmatter \`description\`. For a SKILL this is THE ONLY THING a model
                  matches on to decide the skill is relevant — write it as a trigger, not a
                  summary ("Use when reviewing a PR for…", not "PR review helper"). For a PROMPT
                  it is just a label. A skill with a vague description is a skill nobody invokes.
  skillOptions    the rest of the SKILL.md frontmatter as an object — \`allowed-tools\`, \`model\`,
                  \`disable-model-invocation\`, \`argument-hint\`, \`arguments\`. Written through
                  verbatim; the app adds none of them and reads only the one above.

TARGETS — a target is a declared ROOT the app may write into: {id, label, kind, root, skillsDir,
absSkillsDir, enabled, exists, writable, isGitRepo, branch}. kind is \`repo\` (a checkout),
\`global\` (~/.claude/skills, on by default) or \`self\` (this app's own repo). IDS CROSS THE
WIRE, NEVER PATHS — the declared roots ARE the allowlist, so every skill call takes a targetId
and a raw path where a targetId belongs is a 400. Targets are managed by POST /api/skills/targets,
PATCH /api/skills/targets/:id (enable/disable without losing the id and its install rows) and
DELETE /api/skills/targets/:id — and are deliberately NOT reachable through PATCH /api/settings.
A DISABLED target is still listed but is never scanned, drifted against or written to. \`branch\`
matters: an install writes into the working tree of whatever branch that root is checked out on
right now, and it shows up as an untracked/modified file there — read \`branch\` before installing
into someone's repo, and say which branch you wrote to.

THE SIX DRIFT STATES. Drift is computed per (node × target) from THREE hashes: what the node
RENDERS to now, what is ON DISK, and what we LAST WROTE (\`skill_installs.sha\`):

  missing    no file at all                          → install
  clean      disk = last = rendered                  → nothing to do
  ahead      disk = last, the NODE moved on          → install (safe: nobody touched the file)
  modified   disk ≠ last AND disk ≠ rendered         → HAND-EDITED. install 409s. Choose.
  converged  disk ≠ last BUT disk = rendered         → someone hand-edited the file into exactly
                                                       what the node now says. Install restamps
                                                       the sha and no bytes change.
  unmanaged  a SKILL.md with no node claiming it     → import it, or leave it alone

THE FORK — this is the whole point of the state machine. When a file is \`modified\`, install
refuses with 409 + \`error.drift\` and you pick one of two directions, both non-destructive by
intent:

  ADOPT   POST /api/skills/:nodeId/adopt {"targetId"} — the DISK wins. The hand-edit is pulled
          back into the node (body + frontmatter) and becomes the spec. Use this when someone
          improved the skill where they were using it: that is where the learning happened.
  FORCE   POST /api/skills/:nodeId/install {"targets":["ID"],"force":true} — the NODE wins. The
          hand-edit is overwritten (the old file is copied into the vault trash first, so it is
          recoverable). Only after you have READ it — GET /api/skills/:nodeId/diff?target=ID.
          Never force to clear a 409 you did not investigate: the 409 is telling you a human
          changed something on purpose, at the place they were using it.

UNINSTALL removes SKILL.md and the install record. The DIRECTORY goes only if SKILL.md was the
last thing in it: a bundled skill's \`scripts/\` and \`references/\` are not ours and survive. The
app manages SKILL.md and nothing else — \`installed[].bundled\` says when a directory holds more,
so you can say so rather than implying the app owns the whole bundle.

IMPORT is the way in for skills that already exist: POST /api/skills/import {"targetId","slug"}
turns an unmanaged SKILL.md into a node without rewriting it. Everything hand-written in a repo
can come under management without a migration.

Recipe — author a skill and install it into a repo:

  # 1. see what exists and where you are allowed to write (check each target's \`branch\`:
  #    an install lands in whatever working tree that root is checked out on right now)
  curl -s ${base}/api/skills
  # 2. author the node (slug defaults from the title; description is the model's TRIGGER)
  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"skill","title":"Review a PR","slug":"review-a-pr",
         "description":"Use when reviewing a pull request for correctness and spec drift.",
         "content":"## Steps\\n\\n1. Read the diff...\\n"}'
  # 3. see the exact bytes before touching anyone's repo
  curl -s ${base}/api/skills/NODE_ID/render?format=md
  # 4. install — targets is an ARRAY OF TARGET IDS, never a path
  curl -s -X POST ${base}/api/skills/NODE_ID/install -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"targets":["TARGET_ID"]}'
  #    a 200 can still carry per-target failures: READ results[], do not assume.
  # 5. later, a 409 with error.drift (an ARRAY) means a file was hand-edited. LOOK first:
  curl -s "${base}/api/skills/NODE_ID/diff?target=TARGET_ID"          # + lines = what install would write
  curl -s -X POST ${base}/api/skills/NODE_ID/adopt -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"targetId":"TARGET_ID"}'                                    # the DISK wins, nobody loses work
  #   ...or re-send /install with "force":true                       # the NODE wins (old file → vault trash)
  # 6. stop shipping it somewhere (SKILL.md only — bundled siblings stay):
  curl -s -X POST ${base}/api/skills/NODE_ID/uninstall -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"targets":["TARGET_ID"]}'

## Recipes

Create a feature with a spec, shaped by a pillar, inside the active warp:

  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"feature","title":"Session Tokens","tags":["auth"],"content":"## Summary\\n\\nShort-lived tokens..."}'
  curl -s -X POST ${base}/api/projects/PROJ/edges -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"sourceId":"PILLAR_ID","targetId":"NEW_ID","type":"shapes"}'
  curl -s -X POST ${base}/api/warps/WARP_ID/members -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"nodeId":"NEW_ID"}'

Create a node already linked to existing nodes, in one POST (\`linkTo\`):

  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"bug","title":"Reload loses scroll","linkTo":[{"nodeId":"FEATURE_ID"},{"nodeId":"WARP_ID"}]}'

  Each linkTo entry is {"nodeId","type?","outgoing?"}. Omitted type/direction resolve from the
  node-type pair (first match wins): new action + other feedback → feedback -derives→ new action
  (synthesis) · new feedback + ANY other → new -member→ other (feedback attaches to what it
  reviews) · other is warp → new -member→ warp · new is warp → selection
  -member→ new warp · warp+warp → relates · other is area → new -member→ area · new is area →
  selection -member→ new area (grouping gesture, like warp creation) · area+area → relates ·
  new instance + any other that is NOT a warp and NOT an area → other -class-of→ new (the
  existing node is the class; the warp/area rules above already claimed those pairs, so an
  instance created beside an area MEMBERS it — pass an explicit type to classify instead) ·
  new component + other feature → feature -depends→ new component (the feature is realized by
  it) · new feature + other component → new -depends→ component · other is pillar/principle →
  other -shapes→ new · new is pillar/principle → new -shapes→ other · new bug + other feature →
  new -blocks→ feature · new feature + other feature → other -derives→ new (sub-feature) ·
  action + action → other -leads-to→ new (the existing action comes first in the pipeline) ·
  else relates.
  "outgoing": true means the NEW node is the relationship source. Each entry upserts exactly like
  POST edges: relates (explicit or via the matrix) = bare connection; a typed entry adds that
  relationship. Explicit overrides still obey the relationship rules (member must target a warp,
  addresses must start at one, one relationship per type per connection). The node is created
  first, then the links: if one fails you get a 400 naming the failed link(s) AND the created
  node's id — the node and its successful links exist, so recover by POSTing the missing
  edges/relationships individually; do not re-POST the node.

Add an instance to a class (the UI's "Add instance…" does exactly this via quick-add):

  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"instance","title":"Fire Rune","linkTo":[{"nodeId":"CLASS_ID","type":"class-of","outgoing":false}]}'
  # outgoing:false = the CLASS is the relationship source: class —class of→ new instance. For a
  # type:"instance" node the explicit type/outgoing are optional — {"nodeId":"CLASS_ID"} alone
  # resolves to class-of via the matrix. Any node type can be classified the same way.
  # Classifying two EXISTING nodes instead: POST edges {"sourceId":"CLASS_ID","targetId":"INSTANCE_ID","type":"class-of"}.
  # Design the class node's spec as the rulebook; give each instance its own spec + progress —
  # the class's progressComputed then tracks the mean across instances.

Stack relationships on ONE connection (there is never more than one edge per node pair):

  # A is a member of warp W, W blocks A, and A leads to W — one line on the canvas, three arrows:
  curl -s -X POST ${base}/api/projects/PROJ/edges -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"sourceId":"A_ID","targetId":"W_ID","type":"member"}'      # creates the connection + member A→W
  curl -s -X POST ${base}/api/projects/PROJ/edges -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"sourceId":"W_ID","targetId":"A_ID","type":"blocks"}'      # SAME connection gains blocks W→A
  curl -s -X POST ${base}/api/edges/CONN_ID/relationships -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"leads-to","sourceId":"A_ID"}'                      # equivalent add, by connection id
  # flip one arrow / drop one arrow — the connection and its other relationships stay:
  curl -s -X PATCH ${base}/api/edges/CONN_ID/relationships/blocks -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"sourceId":"A_ID"}'
  curl -s -X DELETE ${base}/api/edges/CONN_ID/relationships/leads-to -H "X-Actor: claude-code"
  # re-POSTing a type already on the connection is a 409; the error body carries the connection
  # under error.connection — read it, then flip/remove instead of re-adding.

Work an action to completion (create linked → do the work → complete with a note → verify):

  # 1. an action that pays down debt on a feature (existing FEAT_ID), sequenced after ACT1_ID:
  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"action","title":"Extract the retry logic","content":"## Delta\\n\\nMove retry into lib/net...",
         "linkTo":[{"nodeId":"FEAT_ID"},{"nodeId":"ACT1_ID"}]}'
  #    (two actions linked without a type default to ACT1 —leads-to→ new: pipelines read in creation order)
  # 2. do the work: edit the target specs/implementation, PATCH progress/tags on the records
  # 3. the instruction is spent — remove it, leaving the story in the activity log:
  curl -s -X POST ${base}/api/nodes/ACTION_ID/complete -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"note":"retry logic now lives in lib/net; feature spec updated"}'
  # 4. see what it changed: diff the nodes it was linked to (ids are in the action.completed activity detail)
  curl -s "${base}/api/nodes/FEAT_ID/diff?since=T"

Work a review end to end (open → cover → designate → dispose → complete → ship; W = the warp under review):

  # 1. the warp enters Review — that IS the open (the human usually drags the card):
  curl -s -X PATCH ${base}/api/nodes/W -H "X-Actor: claude-code" -H "Content-Type: application/json" -d '{"stage":"review"}'
  # 2. COVER the increment: one observation per member, confirmation included — a member with no
  #    feedback about it holds the gate. Load the room first: GET /api/nodes/W/scope?content=1
  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"feedback","title":"Spec of X drifted from the build","content":"## Observed\\n\\n...",
         "linkTo":[{"nodeId":"W","type":"member","outgoing":true},{"nodeId":"X","type":"relates"}]}'
  #    (then label that bare connection: PATCH /api/edges/CONN {"label":"discusses"})
  # 3. DESIGNATE every feedback — derive work, or waive it:
  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"action","title":"Realign the X spec","linkTo":[{"nodeId":"FB1"},{"nodeId":"FB2"}]}'
  curl -s -X POST ${base}/api/nodes/FB3/waive -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"note":"confirmation — the spec matches what shipped"}'      # waive; unwaive undoes it
  #    covering a member with a confirmation is ONE call (file + label + waive):
  curl -s -X POST ${base}/api/nodes/MEMBER_ID/pass -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"warpId":"W","body":"matches the spec — nothing to raise"}'  
  # 4. DISPOSE of every action:
  #    address now?   it joins the increment AND gates it — two edges:
  #      POST edges {"sourceId":"ACTION","targetId":"W","type":"member"}
  #      POST edges {"sourceId":"ACTION","targetId":"W","type":"blocks"}
  #    address later? institutionalize it:  POST /api/nodes/ACTION/convert {"type":"feature"} + PATCH rank
  # 5. do the work, complete the action, waive the feedback it covered (completing an action
  #    removes its derives edges, so its feedback needs a designation again):
  curl -s -X POST ${base}/api/nodes/ACTION/complete -H "X-Actor: claude-code" -H "Content-Type: application/json" -d '{"note":"spec realigned"}'
  curl -s -X POST ${base}/api/nodes/FB1/waive -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"note":"covered — spec realigned","into":"X"}'
  # 6. COMPLETE every completable member (feature/instance/component/bug/question/idea/action/
  #    threat/flaw/warp): tag it done/fixed/answered, complete() it if it's an action, or drop it
  #    from the warp — an unresolved completable member holds the gate via error.offenders.incomplete
  curl -s -X PATCH ${base}/api/nodes/MEMBER_ID -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"tags":["done"]}'
  # 7. ship = close (the gate): 409 lists offenders until fully-actioned:
  curl -s -X PATCH ${base}/api/nodes/W -H "X-Actor: claude-code" -H "Content-Type: application/json" -d '{"stage":"ship"}'

Prune a dead record (kept, dimmed, with the why — never silently deleted):

  curl -s -X POST ${base}/api/nodes/IDEA_ID/prune -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"note":"superseded by the leads-to pipeline model","supersededBy":"FEATURE_ID"}'

Answer a question (the record stays, dimmed, its answer in the spec body):

  curl -s -X POST ${base}/api/nodes/QUESTION_ID/answer -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"answer":"Stage drives the columns — one board, all warps.\\n\\nSee the stage board spec."}'
  # composition, for free: \`answered\` is in the Done rule → the question dims and leaves the
  # backlog; if it was —blocks→ anything, those targets un-ring. Re-POST to refine: the new text
  # appends under the same ## Answer heading with fresh attribution.

Graduate an answered question into durable spec (two calls — no dedicated endpoint):

  # 1. create the durable node (principle is the usual landing type), seeded from the answer,
  #    linked question —derives→ new (outgoing:false = the QUESTION is the edge source):
  curl -s -X POST ${base}/api/projects/PROJ/nodes -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"type":"principle","title":"Stage drives the board","content":"<answer text>\\n\\n— *graduated from the question \\"...?\\"*",
         "linkTo":[{"nodeId":"QUESTION_ID","type":"derives","outgoing":false}]}'
  #    (was the question in a warp? carry the membership: add {"nodeId":"WARP_ID"} to linkTo)
  # 2. optionally retire the question, pointing at what its answer became:
  curl -s -X POST ${base}/api/nodes/QUESTION_ID/prune -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"note":"Graduated to \\"Stage drives the board\\"","supersededBy":"NEW_ID"}'
  # activity trail: question.answered → node.created + edge.created → node.pruned; the question
  # keeps its history and points forward via the "superseded by" label.

Convert vs graduate vs create-linked — three ways forward; choose by where the identity lives:

  convert        POST /api/nodes/ID/convert {"type":"feature"} — the SAME node puts on a new hat.
                 Ideas are seeds: an explored idea that turned out to BE a feature becomes that
                 feature — id, links, tags, notes, spec and history intact, file moved to the new
                 type's folder. Use when the existing node IS the thing, just mislabelled by time.
  graduate       (recipe above) — a NEW node grows out of a question's answer; the question stays
                 behind as provenance (question —derives→ new, pruned superseded-by). Use when the
                 answer spawns durable spec but the question remains a meaningful record.
  create-linked  POST nodes with linkTo — NEW related work beside the original, which continues
                 unchanged. Use when something additional exists, not a transformation of anything.

Report state as you build (tags replace, so read-modify-write):

  curl -s ${base}/api/nodes/NEW_ID                    # read current tags, e.g. ["auth"]
  curl -s -X PATCH ${base}/api/nodes/NEW_ID -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"tags":["auth","building"],"progress":40}'
  # done? swap the state tag — the Done rule dims it and clears it from the backlog:
  curl -s -X PATCH ${base}/api/nodes/NEW_ID -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"tags":["auth","done"],"progress":100}'

Sweep checks (run these periodically; each is one or two calls + a filter):

  # Unrealised features — features with NO depends on any component (designs nothing implements).
  # Walk the graph payload: for each feature, look for a depends relationship whose source is the
  # feature and whose target is a component:
  curl -s ${base}/api/projects/PROJ/graph | python3 -c "
  import json,sys; g=json.load(sys.stdin)
  t={n['id']:n['type'] for n in g['nodes']}; title={n['id']:n['title'] for n in g['nodes']}
  realized={r['sourceId'] for e in g['edges'] for r in e['relationships']
            if r['type']=='depends' and t.get(r['targetId'])=='component'}
  print([title[n['id']] for n in g['nodes'] if n['type']=='feature' and n['id'] not in realized])"
  # Orphan components — components NOTHING depends on: impact.get returns an empty payload.
  curl -s ${base}/api/nodes/COMPONENT_ID/impact        # counts.total == 0 → orphan candidate
  # Stale areas — districts with no recent activity: scope.get with since = e.g. 14 days ago.
  curl -s "${base}/api/nodes/AREA_ID/scope?since=T"    # activity: [] → nothing moved in the district

Working a district (assigned to one area/warp/class? load THAT, not the project):

  curl -s "${base}/api/nodes/AREA_ID/scope?content=1"          # 1. one call = your working context:
                                                               #    container spec, every member's spec/tags/
                                                               #    flags/progress, member-to-member links
  # 2. work: edit specs, PATCH progress/tags, add edges — normal API calls on the member nodes
  curl -s "${base}/api/nodes/AREA_ID/scope?since=T"            # 3. re-sync cheaply: activity since T on
                                                               #    exactly this member set (no bodies)
  # 4. per changed node, precise catch-up: GET /api/nodes/NODE_ID/diff?since=T
  # 5. store the scope's \`now\` as your next \`since\` — the loop never re-reads the district.

Taking on a district's UNCERTAINTY (the fog loop — read § Fog first; do NOT set the \`hazy\` tag):

  # 1. ONE call: what this district has not absorbed, class + location + blocking + PROSE.
  #    Without bodies=1 this is 1 + N calls; with it you triage 30 questions in one read.
  curl -s "${base}/api/nodes/AREA_ID/fog?bodies=1&limit=20"
  # 2. TRIAGE the frontier top-down — it is already sorted by leverage (blocks.length):
  #      fogClass unabsorbed → do the work: edit the spec, then tag the item done/fixed
  #      fogClass unknown    → go and find out, then answer it:
  curl -s -X POST ${base}/api/nodes/Q_ID/answer -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"answer":"Redis. Measured 4ms p99 against the embedded store's 31ms — see the benchmark node."}'
  #      fogClass undecided  → NOT YOURS. Batch these and put them in front of the human:
  curl -s -X POST ${base}/api/ui/focus -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"projectId":"PROJ","view":"graph","nodeId":"Q_ID","modal":"answer"}'
  #      hazy: true          → do not answer and do not untag: propose a SHARPER PHRASING and let
  #                            the human drop the \`hazy\` tag if they agree it is now sayable:
  curl -s -X POST ${base}/api/nodes/Q_ID/annotations -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"body":"Trying to sharpen this: is the question \\"which store\\", or \\"what p99 must we hit\\"?"}'
  # 3. RECORD THE ORDER YOU DISCOVERED. If \`signals\` carries no-decision-order, the frontier is
  #    overstating what is takeable — and you have just read every body, so you are the one who
  #    knows which decision gates which. Draw it (prerequisite, NOT "related"):
  curl -s -X POST ${base}/api/projects/PROJ/edges -H "X-Actor: claude-code" -H "Content-Type: application/json" \\
    -d '{"sourceId":"Q_STORAGE_ENGINE","targetId":"Q_INDEX_STRATEGY","type":"blocks"}'
  #    → Q_INDEX_STRATEGY leaves the frontier and returns by itself when the storage question is
  #      answered (\`answered\` is a Done tag, and a resolved blocker stops blocking). Unsure which
  #      gates which? Leave it: an overstated frontier is a smaller lie than a fabricated dependency.
  # 4. re-read and check your work — counts are TRUE totals, \`limit\` only trims the arrays:
  curl -s "${base}/api/nodes/AREA_ID/fog" | python3 -c "
  import json,sys; r=json.load(sys.stdin); c=r['counts']
  assert c['frontier']+c['blocked']==c['total']
  print(c['total'],'fog ·',c['byClass'],'· hazy',c['hazy'],'· unlocated',c['unlocated'])
  print([s['kind'] for s in r['signals']])"
  # Ship-readiness question? Read the fog, cite it, and DO NOT treat it as permission: fog is
  # reported, never gated (§ Fog). The gate is /warps and the review closure, as it always was.

Catching up after time away (T = the \`now\` you stored last session, epoch ms):

  curl -s "${base}/api/projects/PROJ/activity?since=T"     # 1. what happened, project-wide
  curl -s "${base}/api/nodes/NODE_ID/diff?since=T"         # 2. per interesting node: content diff,
                                                           #    tag changes, edges ±, new annotations
  # 3. store the diff's \`now\` as your next \`since\` — the loop never misses or re-reads anything.

Export a graph, or part of one, as ONE document (a read — writes nothing):

  # the whole project, straight to a file
  curl -s "${base}/api/projects/PROJ/document" -o spec.md
  # one district — an area, a warp, or a class and its instances
  curl -s "${base}/api/nodes/AREA_ID/document" -o area.md
  # a query: every open bug, as a report
  curl -s "${base}/api/projects/PROJ/document?type=bug&resolved=0" -o bugs.md
  # an outline with no spec bodies — cheap to scan when you only need the shape
  curl -s "${base}/api/projects/PROJ/document?bodies=0&links=0"
  # an explicit set (what the canvas selection does), and the counts with it
  curl -s -X POST "${base}/api/projects/PROJ/document?format=json" -H "X-Actor: claude-code" \
    -H "Content-Type: application/json" -d '{"nodeIds":["nd_a","nd_b"]}'
  # -> {"title":..., "markdown":"# ...", "suggestedFilename":"...md",
  #     "stats":{"nodes":2,"chapters":2,"unplaced":0,"omittedResolved":0,"unknown":0,"generatedAt":...}}
  # ALWAYS read stats.unplaced, stats.omittedResolved and stats.unknown before quoting a
  # document as complete. stats.unknown counts ids you asked for that this project does not
  # have — a stale id, or one pasted from another graph. The document says so too.

Watch what the human is doing and react:

  curl -N ${base}/api/events?projectId=PROJ

Point at what you mean, on their screen:

  curl -s -X POST ${base}/api/ui/focus -H "Content-Type: application/json" \\
    -d '{"view":"graph","projectId":"PROJ","nodeId":"NEW_ID"}'
`
}

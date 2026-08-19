export function llmsTxt(base: string): string {
  return `# Ozmo Spec Engine — Agent Guide

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
               default link for a new instance beside any non-warp node IS class-of (see below)
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
  an instruction to change the spec    → action
  none of the above yet                → idea (seeds convert later — POST /convert)

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
Shipped defaults (editable): "Done" → dim, tags done|fixed|answered|adopted|wontfix.
"Blocked" → red ring, tag \`blocked\` OR incoming \`blocks\` edge — so a node is Blocked either
by saying so or by a live blocker pointing at it. "Debt" → amber badge, tag \`debt\` — mark
paydown candidates (typical shape: the debt-tagged node derives an action that pays it down).
"Pruned" → dim, tag \`pruned\` — the negative-resolution look (see prune above; waive stamps the
same tag). "Threatened" → amber ring, incoming \`blocks\` from sourceType \`threat\` — a
threat-blocked plan rings BOTH red and amber (Blocked stays type-agnostic on purpose); a
bug-blocked one stays plain Blocked.
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
Activity         GET  /api/projects/:id/activity?limit=100&since=<epoch ms>  — since: only entries after T;
                                                       edge.created/deleted carry the connection endpoints (deleted
                                                       also lists the relationships it carried); edge.relationship.
                                                       added/updated/removed carry {type,sourceId,targetId}
Search           GET  /api/search?projectId=<id>&q=<text>   — titles, tags, and spec content

Nodes            GET  /api/projects/:id/nodes?type=&tag=&q=&unassigned=1
                                                     unassigned=1 — in NO container at all (no outgoing
                                                     \`member\`: no warp, no area, attached to no reviewed
                                                     node) and not resolved. With type=feedback this IS
                                                     the review lens's triage inbox, in one call.
                 POST /api/projects/:id/nodes        {"type","title","stage?","tags?","content?","progress?","x?","y?",
                                                      "linkTo?":[{"nodeId","type?","outgoing?"}]}  — create pre-linked, see recipe
                                                     stage is warp-only (defaults to "concept"); no status field exists
                 GET  /api/nodes/:id                 — full detail: content, annotations, edges, flags
                 PATCH /api/nodes/:id                {"title?","stage?","progress?","rank?","tags?","x?","y?","pinned?"}
                                                     tags REPLACE the node's tag set — send the full array
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
Backlog          GET  /api/projects/:id/backlog      — unassigned work: features/instances/components/bugs/
                                                       questions/ideas in no WARP and not matching the Done rule,
                                                       ordered by rank — plus warps whose stage is not done/
                                                       not_needed. AREA membership hides nothing (geography ≠
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

Settings         GET  /api/settings                  — vault path, port, human name, flag rules,
                                                       styleOverrides, typeOrder
                 PATCH /api/settings                 {"flags?": [...], "styleOverrides?": {...}, "typeOrder?": [...]}
                                                     flags: replace the flag-rule array (send the FULL
                                                     array, read-modify-write like tags); rule order IS
                                                     chip order and evaluation order. Rules are
                                                     {id,name,treatment:"ring"|"dim"|"badge",color?,
                                                      conditions:[{kind:"tag",tag}|{kind:"incoming-edge",edgeType}]}
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
   FULLY-ACTIONED, four requirements:
     COVERAGE    — every non-feedback, non-action member of the warp has ≥1 feedback ABOUT it:
                   a bare association with a feedback node ("discusses"), a feedback membering
                   it, or a record that feedback derived. CONFIRMATION COUNTS — "this matches the
                   spec" is a review result, so file it. An unreviewed increment does not ship.
     DESIGNATION — every feedback member derives something, or is waived (step 3)
     DISPOSITION — no live \`action\` derived from this warp's feedback remains (step 4)
     BLOCKS      — nothing UNRESOLVED holds a \`blocks\` relationship into the warp; same
                   resolved-set as the flag rules, so a bug tagged \`fixed\` stops blocking
   Otherwise 409 with error.offenders {uncovered:[{id,title,type}], undesignated:[{id,title}],
   pendingActions:[{id,title,feedbackIds,disposition}], blockers:[{id,title,type}]} —
   disposition is "address-now" | "undisposed".
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
  new instance + any non-warp other → other -class-of→ new (the existing node is the class) ·
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

Work a review end to end (open → cover → designate → dispose → ship; W = the warp under review):

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
  # 6. ship = close (the gate): 409 lists offenders until fully-actioned:
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

Catching up after time away (T = the \`now\` you stored last session, epoch ms):

  curl -s "${base}/api/projects/PROJ/activity?since=T"     # 1. what happened, project-wide
  curl -s "${base}/api/nodes/NODE_ID/diff?since=T"         # 2. per interesting node: content diff,
                                                           #    tag changes, edges ±, new annotations
  # 3. store the diff's \`now\` as your next \`since\` — the loop never misses or re-reads anything.

Watch what the human is doing and react:

  curl -N ${base}/api/events?projectId=PROJ

Point at what you mean, on their screen:

  curl -s -X POST ${base}/api/ui/focus -H "Content-Type: application/json" \\
    -d '{"view":"graph","projectId":"PROJ","nodeId":"NEW_ID"}'
`
}

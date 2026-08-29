<!-- GENERATED FILE — DO NOT EDIT.
     Written by scripts/gen-design.mjs from the Spectre board. Edit the nodes, not this file. -->

# Spectre — Design

> **This document is generated.** It is the Spectre board, exported through the app's own
> markdown export and curated for a first read. Regenerate it with `npm run gen:design`
> (the app must be running). Anything you type into this file is lost on the next run —
> the source of truth is the board, and the board is the app.

Spectre is a desktop canvas for shaping software with AI agents. This board is the tool describing itself: every spec below is a live node in the app it documents, and people and agents work it through the same operations.

115 nodes — 2 pillars · 10 principles · 5 areas · 21 components · 74 features · 3 skills.

## How to read this

The board holds more than a design document should. This export is curated by layer, and
says what it did to each one:

- **In full** — pillar, principle, area, component. The commitments, the geography and the architecture:
  standing prose describing what the system *is*.
- **Lead section only** — feature, instance. Each spec opens with its summary; the
  acceptance criteria and build notes below it stay on the board. 64 specs are cut here,
  and each one says how much it left behind.
- **Listed, not reproduced** — skill. 3 of them: a skill body is an
  instruction manual for an agent, not a description of this app.

**What is not here.** 178 nodes on the board are deliberately absent, because a design
document is not a work log:

- 95 `feedback` nodes — review notes on built work — the record of a conversation
- 23 `question` nodes — an open unknown — the answer belongs in a spec once it exists
- 19 `bug` nodes — the implementation diverging from a correct spec — a work item
- 18 `idea` nodes — non-binding sparks; explorable, never enforcing
- 12 `warp` nodes — a delivery schedule, not a design — it says when, and when goes stale
- 9 `flaw` nodes — a design known to be wrong — tracked on the board until it is fixed
- 2 `action` nodes — a transient instruction, deleted when it is carried out

Relationship lines below name only nodes that are in this document. 124 edges pointing
into the layers above are not listed — they are still on the board.

Nodes marked `Done` **are** here: built work is still the design. So is unbuilt work —
read the `%` on a heading before assuming a section describes something that exists.

Every heading carries its node id. The whole spec behind any of them, or any node this
document leaves out, is one read away:

```bash
curl -s http://127.0.0.1:4820/api/nodes/<id>/document        # one node and everything under it
curl -s http://127.0.0.1:4820/api/projects/pr_73a19765b0/document   # the entire board, nothing curated
```

## Contents

- [Human-Agent Parity](#human-agent-parity) · `pillar`
- [The Database Is Ground Truth](#the-database-is-ground-truth) · `pillar`
- [Everything Is A Node](#everything-is-a-node) · `principle`
- [Production is measured, not estimated](#production-is-measured-not-estimated) · `principle`
- [Recorded, Not Prevented](#recorded-not-prevented) · `principle`
- [Represent Before Acting](#represent-before-acting) · `principle`
- [Specs Are Present Tense](#specs-are-present-tense) · `principle`
- [The Board Is The Interface](#the-board-is-the-interface) · `principle`
- [User-Defined Vocabulary](#user-defined-vocabulary) · `principle`
- [Agent & Human Interfaces](#agent-human-interfaces) · `area` · 37 members
- [Canvas](#canvas) · `area` · 18 members
- [Graph Model](#graph-model) · `area` · 22 members
- [Storage & Sync](#storage-sync) · `area` · 6 members
- [User Workflows](#user-workflows) · `area` · 15 members
- [Chart a warp](#chart-a-warp) · `skill`
- [Grill the graph](#grill-the-graph) · `skill`
- [Record the decision](#record-the-decision) · `skill`


Chapters are the areas — the product geography — plus anything the board has not placed in
one yet, which is why a few features and a component stand at the top level. Sub-headings are
not listed: there are too many to be navigation. Search the file, or ask the board.


---

# Human-Agent Parity

`pillar` · `nd_5891913c51` · tags: core

> - shapes → Agent interaction system
> - shapes → Backlog
> - shapes → Feature usage analytics
> - shapes → Node diff API
> - shapes → REST Agent API
> - shapes → Usage endpoint

## Commitment

One service core. The UI calls it over IPC, agents call it over REST — same operations, same validation, same events. If a human can do it on the canvas, an agent can do it with `curl`.


---

# The Database Is Ground Truth

`pillar` · `nd_9461edc13a` · tags: core

> - shapes → An oversized body is flagged, not refused
> - shapes → Cross-project node sharing
> - shapes → Graph Canvas
> - shapes → Progress Is Computed, Never Stored

## Commitment

One authoritative copy. The database holds the spec — content, structure, history — and it is the
only thing anything reads as true.

Markdown is how the spec leaves. Any node, any container, or the whole board renders to a document
you can keep, grep, or hand to someone who has never heard of this tool. That export is load-bearing,
not a convenience: it is what makes the single copy safe to depend on.

Your words are yours. Nothing here is a format you cannot walk away from.


---

# Everything Is A Node

`principle` · `nd_205a030d23`

> - shapes → Cross-project node sharing
> - shapes → Feature-to-method mapping
> - shapes → Graph Canvas

Ideas, pillars, features, bugs, questions — and warps — are all nodes in one graph. Sub-features are `derives` edges. Warp membership is a `member` edge.


---

# Production is measured, not estimated

`principle` · `nd_88c714f1f5` · tags: metrics, process

> - shapes → Chart a warp
> - shapes → Progress roll-up engine

**We do not ask developers for estimates. We measure production.**

An estimate requested from the person who will do the work is a commitment extracted under
uncertainty, and it damages two things at once:

- **The number.** It is padded against blame, or shaved to please, and either way it stops being
  information. Nobody involved believes it, yet it gets written down and planned against.
- **The work.** Once a number exists it becomes a target, and the work bends to hit the target
  rather than to be right. Scope gets quietly trimmed near the deadline; quality is the variable
  nobody names.

It also interrupts. Estimation pulls people out of the work to perform a ritual whose output is
worse than the data already sitting in the activity log.

## What we do instead

Flow is measured, not predicted by opinion. Throughput, cycle time per stage, the rate at which
new warps are discovered — all of it is already recorded, attributed and timestamped, and none of
it requires anyone to guess.

## What this forbids

- Asking "how long will this take?" as a planning input.
- Story points, t-shirt sizes, or any other human-supplied size on a node.
- Treating a forecast as a commitment. A forecast is a distribution with a date attached to a
  confidence, and it moves as evidence arrives.

## What this permits

Structural measures derived from the graph itself — member counts, how cohesive a warp's members
are, how far they reach outside it. Those are observations about what has been *built*, not
predictions offered by a person, so they carry none of the incentive problem. They must still
earn their place by predicting observed cycle time before anything relies on them.

## The honest limit

Measured forecasting needs history. Early in a phase there is not enough of it, and the correct
answer is to say so and decline to give a date — not to quietly fall back on someone's gut.


---

# Recorded, Not Prevented

`principle` · `nd_d437b9655b` · tags: agents, core

> - shapes → Agent interaction system
> - shapes → An oversized body is flagged, not refused
> - shapes → Call instrumentation at the registry
> - shapes → Referral: send a node to another project's graph

## Commitment

Everyone proves who they are. A user is a person or an agent, both hold a real identity, and every
mutation carries the one that made it.

Nothing else is gated. Actions are made safe by being recorded, not by being refused — every change
keeps enough history to be undone, so the answer to a mistake is a rollback rather than a permission
someone should have been denied.

An agent is a peer, not a proxy. It authenticates as itself, it is attributed as itself, and it
stands beside people in the feed.


---

# Represent Before Acting

`principle` · `nd_ae4f4dbf3b` · tags: agents, core · Blocked

> - shapes → Agent interaction system
> - shapes → Record the decision

## Rule

Work lands on the board before it happens. Claim the item (assignee = you), move the node to its in-progress state, then execute. No invisible work, ever.

Claiming is the system's concurrency control: a visible claim is what stops two agents — or an agent and a human — colliding on the same territory.


---

# Specs Are Present Tense

`principle` · `nd_f4ddaf342a` · tags: core

> - shapes → Record the decision

## Rule

The spec graph describes what IS. Version-suffixed spec nodes ("v2", "2a") are an anti-pattern - increments belong to warps; history lives in revisions, activity, and folded records.

Decision (faykarta, verbatim): "We shouldnt really have v2 of things in the spec graph... we should have just updated the spec graph to reflect the most up to date spec. It's possible we would support some kind of legacy feature, but semantically that is the other way round, where we would copy the old info into a legacy ticket, so that it can be supported going forwards."

## Practice

- Evolving a capability = editing its living spec node (the diff is the version history).
- Increment-shaped work is planned in warps and folded into living specs on ship.
- Legacy support inverts: copy the OLD behaviour into an explicit legacy node so it can be owned going forward; the living spec stays current.


---

# The Board Is The Interface

`principle` · `nd_523971a0f7` · tags: agents, core

> - shapes → Agent interaction system

## Rule

An agent interaction is judged by board state after the agent exits — never by its transcript. Chat context dies; the board survives. Any agent must be resumable by a successor from the board alone (crash-only design).

**Implications**

- Leave durable residue while working: annotations for findings, comments for decisions, progress as it moves.
- Exit clean: anything still in the agent's head gets filed as items, questions or backlog nodes before it stops.

Born from the 2026-08-15 outage: an agent died mid-flight and its successor recovered entirely from review items and the activity feed.


---

# User-Defined Vocabulary

`principle` · `nd_3eee7fa935` · tags: core

> - shapes → Cross-project node sharing
> - shapes → Progress roll-up engine
> - shapes → Tag-first status model

## Rule

Where a fixed enum and a user vocabulary compete, prefer the vocabulary. The app may *recognize* conventions (a `done` tag dims a node, a `blocked` tag rings it red) but must not *enforce* them.

Born from faykarta's build note: statuses should be tags - filtering, querying and status levels become user-defined instead of baked-in.


---

# Agent & Human Interfaces

`area` · `nd_eaf600d6c2` · 37 members · 49%

## Charter

The two surfaces through which users reach the graph, kept at parity. The Agent API surface: REST, llms.txt, the SSE event stream, scope/impact/diff, ui.focus. The Human UI surface: the app's views. Features about talking TO the system — from either side of the parity pillar — live here.


## Agent event triggers

`feature` · `nd_74eef0ddcb` · tags: agents · 0%

> - derived from → Agent interaction system

### Summary

The engine wakes agents on events, and reaches agents already running in Claude Code. The board stops being a place agents visit and becomes a thing that summons them.

*Lead section only — 3 further sections in the full spec, fetched by the id above.*


## Context pack endpoint

`feature` · `nd_c6baf80636` · tags: agents, api · 0%

> - depends on → Agent API surface
> - derived from → Agent interaction system
> - what changed vs what matters — the two orientation calls → Node diff API

### Summary

`GET /api/nodes/:id/context` returns everything an agent needs to work a node and nothing else: the node, its spec, edges with neighbour titles and summarised specs, the shaping pillars/principles, blocking questions, and open review items targeting it. The standard **Orient** call in the canonical flow.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Agent handbook: canonical flow in llms.txt

`feature` · `nd_3c000df334` · tags: agents, docs · 0%

> - derived from → Agent interaction system

### Summary

The canonical flow (summon → orient → claim → work → verify → close → exit clean), its deviations, and the output rules written into `/llms.txt` so every agent onboards into the same contract. The handbook ships with the app: a capability undocumented there does not exist for agents.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Claims and staleness

`feature` · `nd_6b4df2d644` · tags: agents, workflow · 0%

> - derived from → Agent interaction system

### Summary

Claiming = assignee set + node moved to in-progress. A claim whose owner has produced no activity for N minutes (default 30) is stale: flagged in the UI and reclaimable by any actor in one action. No first-class claim object until real contention demands one.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Actor registry (optional)

`feature` · `nd_08c4a65e37` · tags: agents · 0%

> - a registered actor kind would sharpen the human/agent split → Call instrumentation at the registry
> - derived from → Agent interaction system

### Summary

Actors remain free-form strings, but may optionally register: `{name, kind: human|agent, standing brief?}`. Registration buys trigger routing (fire on assignee), sturdier loop guards, and richer attribution in the UI. Unregistered actors keep working exactly as today — registration is never required.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## SSE Event Stream

`feature` · `nd_04bad1e0e7` · tags: agents, done · 100% · Done

> - depends on → Agent API surface
> - derived from → REST Agent API

### Summary

`GET /api/events` server-sent events so agents react to humans in real time (and vice versa).


## A graph, or any part of one, exports as a single markdown document

`feature` · `nd_53d8af8b6f` · tags: done · 100% · Done

> - depends on → Agent API surface
> - depends on → Human UI surface
> - relates to → An oversized body is flagged, not refused

### Summary

One generator turns a graph - or a district, a selection, or a query - into ONE readable
markdown document. Owner request, 2026-08-22: *"we need a way to export an entire graph or
selection as a single document"*, for a HUMAN reader (the thing you send someone), not an
agent dump.

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## The sidebar footer copies the agent handoff on click

`feature` · `nd_539f19bf58` · tags: done · 100% · Done

> - depends on → Human UI surface

### Summary

The sidebar footer is ONE copy target, not two. A single click puts the whole agent handoff on
the clipboard:

    Ozmo Spectre API: http://127.0.0.1:4820
    Agent guide (read this first): curl http://127.0.0.1:4820/llms.txt

That block is what a human actually pastes into an agent's prompt. Line 1 is the address for an
agent that fetches rather than shells out; line 2 runs verbatim, and `/llms.txt` teaches the agent
the rest of the system by itself — ontology, endpoints, the review process, curl recipes. A bare
`host:port` is NOT that: the base URL 404s and says nothing about the API, so copying it alone
left the human to type the rest.

The footer still READS as two lines — the live dot with `API 127.0.0.1:<port>`, and the indented
`agents: GET /llms.txt` beneath it. Only the clickable surface merged; the block is unchanged at
rest.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Node diff: realise the idea properly

`feature` · `nd_6b6ac8ee96` · 0%


faykarta: "Node Diff feature is an awesome idea but I dont think we are maximising it. We should plan to revisit this idea in the future to properly think it through and do it justice"

Today: a unified content diff plus metadata/edge/annotation changes since a timestamp. Unexplored: diffs as first-class review evidence (the Increment panel showing what changed inline), agent catch-up flows, cross-node diffs for a whole warp, and a visual diff of the graph itself (what was linked, unlinked, restaged between two points in time). Worth a design session of its own.


## Feature usage analytics

`feature` · `nd_6dc6e641f1` · tags: agents, usage · 0%

> - derives → Call instrumentation at the registry
> - derives → Feature-to-method mapping
> - derives → Usage endpoint
> - derives → Usage ledger
> - derives → Usage lens
> - shaped by → Human-Agent Parity
> - the feature nobody remembered - the reason this exists → Impact analysis

### Summary

Which features actually get used, by whom, and which have not been touched in a month. Every call
through the method registry is counted — human and agent, read and write — and rolled up onto the
feature nodes that own those methods, so effort follows real usage instead of memory.

*Lead section only — 3 further sections in the full spec, fetched by the id above.*


## Call instrumentation at the registry

`feature` · `nd_f8e6cea6c9` · tags: agents, usage · 0%

> - a registered actor kind would sharpen the human/agent split → Actor registry (optional)
> - depends on → Method registry
> - derived from → Feature usage analytics
> - shaped by → Recorded, Not Prevented

### Summary

`call(method, payload, ctx)` records every dispatch - method, actor, surface, outcome, duration -
around the handler it invokes. One wrapper, every method, both surfaces, reads and writes alike.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Usage endpoint

`feature` · `nd_19c0de84fb` · tags: agents, api, usage · 0%

> - depends on → Agent API surface
> - derived from → Feature usage analytics
> - shaped by → Human-Agent Parity

### Summary

`GET /api/projects/:id/usage` and `GET /api/nodes/:id/usage` - the three questions the lens
answers, in JSON. If a human can see what is dormant, an agent can ask.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## A person is authenticated, not asserted

`feature` · `nd_16cc4672da` · tags: building, server · 45%

> - depends on → Storage that survives concurrent writers
> - required by → Presence is drawn, never stored
> - required by → The thin client rides the agent API

Today identity is the `X-Actor` header: a string the caller picks. Every mutation is
attributed to it, the activity feed colours by it, and nothing verifies it.

That is the right trade for agents on loopback — the attribution-instead-of-access-control
decision is deliberate and documented. It stops being right the moment two humans share a board,
because attribution that anyone can forge is decoration.

### What has to change

- a **user** is a real record, not a header value
- a session proves who you are, and `X-Actor` becomes derived rather than supplied
- **agents keep working.** An agent acting on someone's behalf must remain first-class — the whole
  design rests on humans and agents using one API. An agent gets a credential of its own and its
  own name in the feed; it does not borrow a human's.
- existing single-user boards must keep working without anyone logging in

Note the collision with the recently-shipped skills targets: an allowlist of filesystem roots is
already reachable through an unauthenticated API, which is survivable only because that API is
loopback-only. A served Spectre makes that a genuine privilege question.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## A prompt is a skill only the human invokes

`feature` · `nd_c9c32fcfa8` · tags: agents, needs-verification, skills · 90%

`disable-model-invocation: true` is the whole difference.

A skill is chosen by the model matching its `description`. A prompt is chosen by the human typing
`/name`. Same file format, same frontmatter contract, same install path - so the app carries one
node type and a toggle, never two parallel surfaces.

### What the toggle actually changes

- **Frontmatter**: adds `disable-model-invocation: true`.
- **The description field stops being load-bearing.** For a skill it is the only retrieval
  mechanism and a bad one makes the skill dead weight. For a prompt it is a label.
- **Arguments become the point.** `argument-hint` and `$ARGUMENTS` are what make a prompt reusable
  rather than merely saved - "review PR 412" and "review PR 87" must be one node with a
  parameter, not two nodes.
- **Copy to clipboard** is offered regardless of install. Some prompts belong in a chat box.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Agent interaction system

`feature` · `nd_82eed4c25a` · tags: agents, core, designed · 0%

> - derives → Actor registry (optional)
> - derives → Agent event triggers
> - derives → Agent handbook: canonical flow in llms.txt
> - derives → Claims and staleness
> - derives → Context pack endpoint
> - shaped by → Human-Agent Parity
> - shaped by → Recorded, Not Prevented
> - shaped by → Represent Before Acting
> - shaped by → The Board Is The Interface
> - the surface this constitution governs → REST Agent API

### Summary

The constitution for every agent tier: how agents connect, what they receive, the canonical flow of an interaction, its known deviations, and its permitted outputs. Tiers: session agents (today), triggered agents (derived), resident daemons (later). Designed with faykarta, 2026-08-15.

*Lead section only — 6 further sections in the full spec, fetched by the id above.*


## Fog is visible on the canvas and per district

`feature` · `nd_4e6c1feb27` · tags: canvas, fog · 0%

> - depends on → Fog classifier
> - required by → Lenses are a control group, and certainty is one of them

Thick fog should be somewhere you can point at.

- a shipped **Fog** flag rule so fog nodes carry a treatment everywhere nodes render, added
  through the `FLAGS_VERSION` mechanism that exists to append a default rule exactly once
- district health already counts non-dim flag rules per area and paints them on the hull label —
  so districts read `USER WORKFLOWS · 3 fog` for free once the rule exists
- a **fog lens**: a canvas mode that dims what is settled and lifts what is not, so the unlit
  parts of the map are the parts that stand out

The three classes get three distinguishable treatments — and distinguishable by **shape or
weight, not by colour alone**, since the palette audit already found `idea` and `question`
separable only by hue.


## Impact analysis

`feature` · `nd_fa2d6d05ff` · tags: done, ontology · 100% · Done

> - depends on → Agent API surface
> - derived from → Areas and components
> - the feature nobody remembered - the reason this exists → Feature usage analytics

### Summary

Blast radius as a graph walk - perturbation propagation made queryable.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Install targets are declared, not typed

`feature` · `nd_277711228a` · tags: agents, needs-verification, skills · 90%

A target is a named root the app may write skills into. The set is explicit and small.

### Why this is a security boundary, not a preference

`PATCH /api/settings` is unauthenticated on loopback, and the API sets permissive CORS. An
allowlist of filesystem roots reachable through that surface means any local process - including
any web page the human happens to visit - could add a root and write arbitrary files anywhere on
disk.

Two consequences, both required:

1. Target management is **deliberate registry verbs** (`skills.addTarget` / `skills.removeTarget`)
   that validate, log an activity row and emit an event - never a raw settings key. The change
   becomes auditable in the feed instead of a silent blob mutation.
2. The API's origin policy is tightened first. Adding filesystem reach to an origin-open,
   unauthenticated API is the wrong order of operations.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Node diff API

`feature` · `nd_7a5a1177fb` · tags: agents, api, done · 100% · Done

> - depends on → Agent API surface
> - shaped by → Human-Agent Parity
> - what changed vs what matters — the two orientation calls → Context pack endpoint

### Summary

Agents can ask "what changed on this node since I last saw it" in one call: GET /api/nodes/:id/diff?since=<epoch ms>.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Presence is drawn, never stored

`feature` · `nd_bd30ba1214` · tags: canvas, server · 0%

> - depends on → A person is authenticated, not asserted
> - depends on → Every mutation is recorded and reversible
> - depends on → The thin client rides the agent API
> - depends on → Write coalescing at the edges
> - relates to → Progress Is Computed, Never Stored
> - required by → Conflicts are detected, merged where they can be, marked where they cannot

Each person on the board is an arrow with their name, moving live.

### The hard rule

**It never touches the database or the vault.** Presence is ephemeral, lossy and latest-wins. It
rides its own channel, it is not an activity row, it is not a node, and a server restart simply
clears it.

The reason is concrete: a cursor at 30Hz through `nodes.update` would rewrite a markdown file
thirty times a second, emit thirty SSE events, and — with `sql.js` — re-serialise the entire
database thirty times a second.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Referral: send a node to another project's graph

`feature` · `nd_67b96e6a47` · tags: agents, done · 100% · Done

> - derived from → Cross-project node sharing
> - shaped by → Recorded, Not Prevented

### Summary

`POST /api/nodes/:id/refer {toProjectId, note?, type?, title?}` hands a node to another project.
An agent working in Dice finds something that belongs to Spec Engine, and sends it over.

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## REST Agent API

`feature` · `nd_045d979a05` · tags: agents, done, mvp · 100% · Done

> - depends on → Agent API surface
> - derives → SSE Event Stream
> - shaped by → Human-Agent Parity
> - the surface this constitution governs → Agent interaction system

### Summary

Everything the UI can do, over HTTP on localhost. `X-Actor` header attributes work. `/llms.txt` teaches agents the ropes.


## Scope loading (district context)

`feature` · `nd_65b6093875` · tags: done, ontology · 100% · Done

> - depends on → Agent API surface
> - derived from → Areas and components

### Summary

The agent context-budget boundary: load one district, not the whole project.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Skills are authored in the graph and installed to a branch

`feature` · `nd_7b657975e9` · tags: agents, skills · 0%

A Skills page lists the Claude Code skills that belong to a project, lets them be read and
edited in place, and installs them to a branch.

### Source of truth

A skill is a **node**, not a file the app merely browses. Its body lives in the vault at
`<Project>/Skills/<Title>.md`, so a skill gets everything every other node gets: links, tags,
reviews, warps, activity, diffs. A skill can `depend` on the component it operates, be `shaped`
by a principle, and sit in an area — which is the whole point of putting it in the graph rather
than leaving it as loose markdown in a dotfolder.

Installing **renders** a `SKILL.md` out to `.claude/skills/<slug>/SKILL.md`. The rendered file
is a build output. The node is the original.

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## Spectre opens in a browser

`feature` · `nd_f1fa484df9` · tags: done, server · 100% · Done · Blocked

> - depends on → The renderer talks to one seam, not to Electron
> - depends on → The thin client rides the agent API

A second front end onto a served Spectre: the same board, the same canvas, in a browser, on a
machine that is not the one holding the vault. The desktop app carries on untouched — that is what
makes the dual-run migration literal, and it fails the moment the thin client needs the desktop app
to change.

### What it is

- the same React renderer, built for the web, with `rpc()` pointed at a served Spectre and the host
  capabilities set to the served implementation
- graph, inspector, backlog, warps, reviews, activity — every view that only calls `rpc()`, which is
  nearly all of them
- live on the same events, arriving over `GET /api/events` instead of an IPC push and driving the
  same `handleEvent` (`src/renderer/src/store.ts:797`)
- attributed to a real person, once a person is authenticated rather than asserted

*Lead section only — 5 further sections in the full spec, fetched by the id above.*


## The Agentic page shows every skill and prompt beside what is installed

`feature` · `nd_0e488f7040` · tags: agents, needs-verification, skills · 90%

The page is a **matrix**, not an editor with a list bolted on.

Rows are skills and prompts. Columns are install targets. Each cell is a pip carrying one of six
states, computed from three hashes - what the node renders to, what is on disk, and what we last
wrote:

| state | disk vs last | disk vs rendered | offered action |
|---|---|---|---|
| `missing` | no file | - | Install |
| `clean` | same | same | - |
| `ahead` | same | differs | Install |
| `modified` | differs | differs | Diff / Adopt / Force |
| `converged` | differs | same | Install (restamps) |
| `unmanaged` | no node | file exists | Import |

### Why a matrix

There are 13 skills copied across 16 repos in the Ozmo fleet, and `warp-plan` has **already
drifted** - ozmo-preprod carries a different hash from the other 15. Nobody can currently see
that. Authoring is the smaller half of this feature; fan-out is the problem.

The header action that pays for the page is **install everything that is ahead**.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## The fog API reports the frontier and carries the prose

`feature` · `nd_e522dc7917` · tags: agents, fog · 0%

> - depends on → Fog classifier
> - relates to → An oversized body is flagged, not refused
> - required by → Chart a warp
> - required by → Grill the graph

`GET /api/projects/:id/fog` — one call that answers "what do we not know, and what can I
pick up right now?"

Returns counts by class and by type; a per-area rollup so districts can be ranked by fog density;
the **frontier** (takeable now) and the **blocked** set separately; the **unlocated** list, because
fog in no area makes every density figure a lie; and `signals` — meta-observations like *no
prerequisite order is recorded between any two decisions*.

`?bodies=1` includes each item's markdown so an agent can **digest** a district's uncertainty in a
single call instead of N+1 fetches. That is the point of carrying the prose: the classification
says what kind of fog it is, the prose is what it actually says.

Also `GET /api/nodes/:id/fog` for a single container — an area or a warp — so scope and impact
gain a sibling that answers the same question about uncertainty.


## Agent API surface

`component` · `nd_0d45c8e5f8` · 0%

> - required by → A graph, or any part of one, exports as a single markdown document
> - required by → Context pack endpoint
> - required by → Impact analysis
> - required by → Node diff API
> - required by → REST Agent API
> - required by → SSE Event Stream
> - required by → Scope loading (district context)
> - required by → Usage endpoint

### Job

The one HTTP surface agents drive the app through — the same powers the human has, over the wire. REST CRUD on projects, nodes, connections and relationships; the verb endpoints (complete, fold/prune, answer, convert); llms.txt as the self-describing handbook; the SSE event stream for reacting live; scope (one district as one payload), impact (blast radius) and diff (what changed since T); search; settings; and ui.focus for pointing at the human's screen. Attribution rides on X-Actor.


## Human UI surface

`component` · `nd_1cf4b9a9bf` · 0%

> - required by → A graph, or any part of one, exports as a single markdown document
> - required by → Backlog
> - required by → Graph Canvas
> - required by → The sidebar footer copies the agent handoff on click
> - required by → Usage lens

### Job

The app's views — the human half of the parity pillar. The graph canvas, Lists (the decomposition tree), the Backlog, the Warps stage board, the review lens (stage board + inbox), the activity feed, and Settings (flag rules, appearance, type order). Direct manipulation with the same powers the API exposes: every gesture is a call an agent could also make.

### What the surface owes the graph

Every view is a thin renderer over the same registry the API exposes — no view may know something
the API cannot answer, and no gesture may do something an agent cannot. Two disciplines fall out
of that and belong here rather than in any one view:

- **One rendering of a body, never two.** The shared markdown editor shows the CodeMirror editor
  OR the rendered preview, switched by its read/edit toggle. The preview writes its HTML
  imperatively (so mermaid and code highlighting can hydrate over real DOM), which means the two
  hosts must be distinct React elements: reconciled into one node, the editor would mount
  underneath leftover preview HTML and the panel would show the spec twice.
- **Submitting is idempotent at the source.** Anything that POSTs from a keystroke (thread
  comments, link annotations, feedback capture) latches in flight with a REF and clears its field
  BEFORE the round trip, restoring the text only on failure. A React state flag is not readable
  until the next render, so two invocations in the same tick both pass it — which is exactly what
  a double-posted comment looks like in the activity log: two identical rows, milliseconds apart.


## Method registry

`component` · `nd_02c2f0727d` · 0%

> - required by → Call instrumentation at the registry
> - required by → Feature-to-method mapping

### Job

The single dispatch table every operation passes through. `src/main/registry.ts` maps method
names to service functions, and both adapters are thin wrappers over one function,
`call(method, payload, ctx)` — IPC for the UI, REST for agents. This is where Human-Agent Parity
stops being a promise and becomes a structural fact: a capability exists for both surfaces the
moment it is registered here, or it exists for neither.

It owns three things:

- **The method vocabulary.** Registering a method is what makes it callable. A REST route or an
  IPC channel adds reach, never capability.
- **The context.** Every call carries who is asking (`actor`, free-form and unvalidated) and
  which side of the parity line they arrived on.
- **The only complete view of what the system does.** Nothing else in the app sees every
  operation, human and agent, read and write, in one place — which is why measurement,
  rate limiting, tracing and any future audit all belong here rather than scattered
  across call sites.

A handful of HTTP routes deliberately bypass it — `/api/health`, `/api`, `/llms.txt`,
`/api/events`, `/api/debug/screenshot`. They serve the connection itself rather than the graph,
so they are outside the vocabulary by design, and anything that reasons about "every call" has to
account for them explicitly.


## Review sweep

`component` · `nd_d2b6f14227` · tags: review · 0%

> - required by → Review Process

### Job

Bring agents into a review as participants rather than spectators.

- `review.sweep.requested` fires on the event stream, carrying the warp; a ready prompt copies for pasting into any agent.
- The sweep files **feedback only** - observations, never verdicts. Designation, disposition and closing stay with whoever is running the review.
- Coverage is the sweep's natural job: confirmation counts, so an agent can record "this matches the spec" against members it has checked, leaving human attention for judgment.
- Six angles as a checklist, never as filed items: completeness, fidelity, integrity, consequence, record, harvest. They report through the findings and the closing summary.


## Fog classifier

`component` · `nd_1459e0c04d` · tags: fog · 0%

> - required by → Fog is visible on the canvas and per district
> - required by → Lenses are a control group, and certainty is one of them
> - required by → The fog API reports the frontier and carries the prose

One function, one truth: given a project, which nodes are fog and of what class.

Derives class from type, resolution state and edges — never from a tag alone, so fog cannot rot by
someone forgetting to label. Reuses the gate's resolution predicate (Done union Pruned, plus
`answered` and waived) so fog and closure can never disagree about what "settled" means.

Also computes, per item: whether it is blocked by something unresolved, which area and warp
contain it, its age, and its sharpness tag.

Lives beside `warpClosure` and is exported for both the API and the renderer's lens.


## Skill install engine

`component` · `nd_42de8741c5` · tags: agents, needs-verification, skills · 90%

> - relates to → An oversized body is flagged, not refused

Renders a node to `SKILL.md` and writes it to a target. Owns discovery, drift and adoption.

### The job

- **discover** - scan each target's `.claude/skills` one level deep. **Must exclude
  `.claude/worktrees/`**: the Ozmo monorepo nests 16 agent worktrees (~13 GB) inside `.claude`,
  and a naive recursive walk hits all of it.
- **render** - node to SKILL.md. Vault frontmatter (`id`, `type`, `links`) must never leak into
  the rendered file.
- **drift** - three-hash comparison per (node x target).
- **install** - validated slug, atomic temp+rename, per-target try/catch so one locked file never
  aborts a batch of sixteen.
- **adopt** - pull a hand-edited disk file back into its node. Without this, `modified` has only a
  destructive resolution.

### Safety

Targets cross the wire as **ids, never paths** - a payload carrying a raw path is a 400. Slugs are
**rejected, never sanitized**: a silently-corrected slug orphans an install directory. The path is
re-verified with `startsWith` after composition. Roots are never created. Forced overwrites back
the old file into the vault trash first - "nothing is ever hard-deleted" applies to other people's
files too.

`withWatcherPaused` must **not** be used: install writes land outside the vault, and pausing would
stop folding Obsidian edits for no benefit. Target directories are **not** watched - 16 chokidar
watchers on git repos is a Windows handle farm.


## Storage that survives concurrent writers

`component` · `nd_c914918096` · tags: done, server · 100% · Done

> - required by → A person is authenticated, not asserted
> - required by → Backup and migrate the existing board
> - required by → Every mutation is recorded and reversible

`sql.js` cannot be the storage engine for a served board.

It keeps the whole database in memory and `export()` re-serialises the entire file on every write
(`src/main/db.ts:712`). Measured earlier in a different context: 500 position writes cost 251ms as
individual statements against a 10.4MB file. That is per-write whole-file cost, and it does not
improve with more callers — it degrades.

It also closes and reopens the connection on export, which silently dropped `foreign_keys` and
orphaned rows for a whole day before anyone noticed. The re-assertion in `persistNow` is a patch on
a shape that a server should not inherit.

### What it must provide instead

- concurrent readers and writers without whole-file rewrites
- real transactions across the writes a single verb makes (a node create touches nodes, edges,
  tags, activity and revisions)
- the same schema and the same migration discipline — the guarded `ALTER TABLE` pattern in
  `db.ts:154` is good and should survive
- an answer for `deleteProject`, which deliberately deletes every dependent row explicitly because
  cascades are not load-bearing today

The engine choice is a question, not a decision — see the linked questions.

### Built

- The storage seam is `src/main/driver.ts`: `exec` / `run` / `all` / `get` / `persist` / `close`,
  and a `DriverName` of `sqljs` or `native`. `db.ts` keeps the schema, the guarded `ALTER TABLE`
  migrations and the 400ms persistence policy; it no longer owns the driver.
- `openDriver(name, file)` selects at open time. Default `sqljs`; `OZMO_DB_DRIVER=native`
  (or `better-sqlite3`) selects the native driver. An unrecognised value warns and falls back.
- The native driver runs `journal_mode = wal` and `synchronous = NORMAL`, caches prepared
  statements, and drops the cache on any non-transactional `exec` because DDL invalidates a plan.
  `OZMO_DB_JOURNAL=delete` disables WAL for filesystems without shared memory (SMB, NFS).
- `persist()` is a PASSIVE checkpoint on the same 400ms cadence sql.js re-serialised on;
  `close()` is a TRUNCATE checkpoint followed by `journal_mode = delete`, so the file left
  behind is one sql.js opens without knowing the native driver ran. A `process.once('exit')`
  hook guarantees that even when the app quits through `flushDb()` rather than `closeDb()`.
- MUST remain true while both drivers are in play: either driver opens the file the other left.

### Measured

On the live board (12.89MB, 1940 nodes, Electron 34.5.8, `npm run db:bench`):

- node drag, durable per write: sql.js 128.071 ms, native+WAL 0.344 ms
- node drag, N writes in one transaction: sql.js 1.004 ms/write, native+WAL 0.042 ms/write
- one persist (whole-file re-serialise): sql.js 142.367 ms, native ~0
- a whole verb, 100 node creates across six tables: sql.js 136.012 ms each, native 1.270 ms each

### Verified

- `npm run db:parity` — 21/21. Both drivers run the real `db.ts` against copies of the same
  database and are diffed on row counts, node type histogram, migration stamps, tables and
  indexes, and the `nodes` columns after the guarded ALTERs. Flush cost: sql.js 40.9ms, native 4ms.
- `npm run smoke` — the full agent API suite passes with the app running on the native driver
  against the real board, including the row-level orphan and pair-uniqueness checks.
- Test/Acceptance: parity green, smoke green on both drivers, and a file written by one driver
  opens and verifies under the other.

Canon: src/main/driver.ts, src/main/driver-native.ts, src/main/driver-sqljs.ts, scripts/db-parity.mjs, scripts/db-bench.mjs


## The renderer talks to one seam, not to Electron

`component` · `nd_d51fa1e661` · tags: done, server · 100% · Done

> - depends on → The thin client rides the agent API
> - required by → Spectre opens in a browser

`rpc()` (`src/renderer/src/api.ts:40`) is one function over `window.ozmo.call`, which is Electron
IPC (`src/preload/index.ts:11`) into a generic dispatcher (`src/main/ipc.ts:11`) onto the one method
registry (`src/main/registry.ts:142`). Sixty-four of the registry's sixty-seven methods already have
a REST route, so for everything that goes through `rpc()` the hope holds: replace its body with
`fetch`, and every component that calls it is already transport-agnostic.

`rpc()` is not the only thing the renderer uses. `api.ts:46` exports `bridge()`, which hands
components the raw Electron object, and the places that reach past `rpc()` do not degrade — they
assume.

### What assumes Electron

- `src/renderer/src/main.tsx:9` — `window.ozmo.onEvent`. Events are pushed from the main process
  (`src/main/index.ts:100`); over a network the same events arrive on SSE. Replaceable inside the
  seam, and the only one on this list that is.
- `src/renderer/src/components/SettingsView.tsx:114` — `pickFolder()` chooses the vault root from a
  native directory dialog. It picks a path on the CLIENT's disk to configure the SERVER's vault. A
  remote client browsing the server's filesystem is a different feature, not a port of this one.
- `src/renderer/src/components/SettingsView.tsx:845` — `pickFolder()` again, for
  `skills.addTarget`. Same shape, heavier consequence: that root is where `SKILL.md` gets written.
- `src/renderer/src/components/SettingsView.tsx:141` — `relaunch()` restarts the host process. From
  a thin client that closes the desktop human's window.
- `src/renderer/src/components/SettingsView.tsx:110` — the vault path and API port are edited as
  plain text fields. They configure the host machine, not the board, and a remote viewer editing
  them is not a smaller version of the same gesture.
- `src/renderer/src/components/ExportDialog.tsx:83` — `saveDocument()`. Two destinations behind one
  call (`src/main/ipc.ts:49`): `toVault` writes into the server's vault and remotes cleanly, the
  other opens a native Save dialog and writes the caller's disk, which in a browser is a download
  and not the same code path at all.
- `src/renderer/src/components/ExportDialog.tsx:87` — `revealFile()` in the success toast, on a
  path that after a vault write belongs to the server.
- `src/renderer/src/components/AgenticView.tsx:524` — `revealFile(inst.absPath)` for an installed
  skill file, with the same absolute server path shown as a tooltip at `AgenticView.tsx:527`.
- `src/renderer/src/components/Inspector.tsx:735` — `openInObsidian(id)`, which resolves the node's
  `file_path` and launches an `obsidian://` URL (`src/main/ipc.ts:74`). It needs the vault mounted
  on the machine doing the looking.
- `src/renderer/src/components/MarkdownEditor.tsx:229` — `openExternal(href)`. The honest
  one-liner: `window.open` in a browser.

Eight of those ten need somewhere to go. So `rpc()` is not the only seam, and pretending otherwise
costs more than admitting it. It is close, though: a handful of verbs, not a second renderer.

### The job

Two seams, both explicit.

- `rpc()` is the transport for the registry, and its body is the only thing that differs between
  desktop and served.
- `bridge()` gives way to a `host` object of the same shape with two implementations, one Electron
  and one served. Nothing else imports `window.ozmo`, and an import that does is a lint failure
  rather than a discovery.

Capabilities are declared, not assumed. `host.can('revealFile')` is false in a browser and the
Reveal button is not rendered — not rendered and inert, not rendered and silently doing nothing. A
capability that cannot be honoured is either absent or replaced by the browser's equivalent:
`saveDocument` without `toVault` becomes a download, `openExternal` becomes `window.open`,
`openInObsidian` and `pickFolder` have no equivalent and disappear.

Vault path, API port and relaunch are host settings. They belong to whoever is sitting at the
machine; a served client shows them read-only or not at all.

### Why this rather than two renderers

The decision to build a thin client alongside the desktop app names the cost: every view is built
twice, or the renderer becomes genuinely transport-agnostic. A declared capability set is what
*genuinely* means here. It is enforceable, it is small, and it turns each new Electron-only
affordance into a deliberate act instead of an accident the other client finds later.

### Built

- `src/renderer/src/host.ts` is the seam: `call` and `subscribe` are the transport, and every
  other member is a HOST CAPABILITY declared on `can`.
- `host-electron.ts` delegates to `window.ozmo` with every capability true. `host-web.ts` is
  `POST /api/rpc` plus an `EventSource`, and refuses the host capabilities by name.
- `bridge()` is REMOVED. It handed components the raw Electron object and was the hole in the
  seam. `rpc()` now goes through `host().call`, and the eight call sites that reached past it ask
  `host().can.<x>` and omit the affordance.
- `can` gates the UI, not the call. A viewer in a browser is not a desktop user who has lost
  reveal-in-folder; it was never theirs. `HostUnavailable` is the backstop, and it names the host.
- `boot.tsx` holds everything both clients do. `main.tsx` and `main.web.tsx` are three lines each,
  deliberately: a second difference between them shows up as a diff.
- The link reports its own health. `LinkStatus` is connected / reconnecting / offline / resync,
  and the store answers `resync` by refetching the graph and saying so. MUST NOT go silent: a
  client that reconnects into an unreplayable gap and says nothing shows a stale board with
  confidence.

### What is absent in a browser, and why

Each of these addresses the machine the core runs on, not the board:

- `pickFolder` — the vault root, and the skill target roots that `SKILL.md` is written into
- `saveToVault` — the server's disk (`saveToDisk` remains, as a download)
- `revealFile`, `openInObsidian` — a filesystem the viewer is not sitting at
- `relaunch` — the desktop human's window
- `configureHost` — the vault path and API port fields

### Verified

- Both clients photographed against the same core: the desktop shows the API port field and the
  Vault card, the browser shows neither, and the rest of Settings is identical.
- Test/Acceptance: `grep -rn "window.ozmo" src/renderer/src` returns only `host-electron.ts`.

Canon: src/renderer/src/host.ts, src/renderer/src/host-electron.ts, src/renderer/src/host-web.ts, src/renderer/src/boot.tsx


## The thin client rides the agent API

`component` · `nd_8fba3b7590` · tags: done, server · 100% · Done

> - depends on → A person is authenticated, not asserted
> - required by → Presence is drawn, never stored
> - required by → Spectre opens in a browser
> - required by → The renderer talks to one seam, not to Electron

The registry is transport-agnostic by design (`src/main/registry.ts:24`), REST already covers it,
and SSE already carries every event (`src/main/server.ts:96`). The thin client needs no protocol of
its own. It needs the gaps in the one that exists.

### What the agent API already provides

- every registry method as a route, with identical errors: `ApiError.data` rides the response body
  exactly as it rides the IPC result (`src/main/ipc.ts:18`), so `RpcError` carries the same
  structured payload either way — the gate's offender lists, a 409's connection
- `GET /api/events` (`src/main/server.ts:96`), optionally filtered by project, with a 25s heartbeat
- graph, scope, fog, impact and `document.build` — the whole board, already shaped for a reader that
  is not inside the process

### What is missing

- **`app.info` has no route.** `store.boot()` asks for it first (`src/renderer/src/store.ts:422`),
  so a browser client cannot boot at all. `nodes.fold` and `nodes.unfold` are IPC-only as well.
  Three methods out of sixty-seven, found by trying to be a third client: exactly the parity bug the
  decision predicted the new client would surface.
- **`app.info` describes the host, not the board** — version, port, vaultPath, humanName, platform
  (`src/shared/types.ts:224`). Served, `vaultPath` and `platform` are the server's and mean nothing
  to the viewer, and `humanName` is the identity question wearing a different hat.
- **The server binds loopback only** (`src/main/server.ts:399`) and rejects any non-loopback
  `Origin` before routing (`src/main/server.ts:38`). Both are deliberate and correct for an
  unauthenticated API that can write files through the skills allowlist. A client on another machine
  cannot connect until a person is authenticated rather than asserted, and widening the bind before
  that is the order that breaks things.
- **SSE has no resume.** A dropped stream loses every event in the gap and the client cannot ask for
  them: events carry no id and the stream honours no `Last-Event-ID`. Over IPC the gap cannot happen
  — the process either has the window or it does not. Over wifi it is ordinary. Events already carry
  `at`; the stream needs a sequence, and a reconnect either replays the gap or refetches the graph
  and says which it did.
- **Attribution is a header.** IPC derives the actor from settings (`src/main/ipc.ts:13`); REST
  takes whatever `X-Actor` claims (`src/main/server.ts:18`). The thin client is the first caller
  that cannot be trusted by virtue of being on loopback.

### The rule

Anything the thin client needs is added to the registry, where it reaches every adapter at once. A
route that exists for the browser and not for agents is the same parity bug pointing the other way,
and a third client is worth building partly because it makes both directions visible.

### Built

- `POST /api/rpc` takes `{method, payload}` and returns IPC's envelope: `{ok:true,data}` or
  `{ok:false,error:{message,status,data}}`, with the real HTTP status on the response.
- The envelope nesting matches IPC exactly. REST's error handler MERGES `ApiError.data` into the
  error body; the renderer's `RpcError` reads it nested. A client MUST NOT have to swap error
  parsing when it swaps transport.
- The resource routes are unchanged and remain the agent surface. Two audiences, two ergonomics,
  one registry: an agent reads `/llms.txt` and writes `POST /api/nodes/:id/waive`; a client
  already written against `rpc()` wants the dispatcher.
- `GET /api/info` routes `app.info`, which `store.boot()` asks for first. `nodes.fold` /
  `nodes.unfold` were already routed as aliases of waive/unwaive.

### The event stream carries resume

- Every event gets a monotonic sequence id from ONE recorder, so all clients agree what event N
  is. Connections subscribe to the recorder, never to the bus.
- Frames are `data: {json}` FIRST, then `id: <n>`. Both orders are legal SSE; this one is
  required. `/llms.txt` has pointed agents at this stream for as long as it has existed, and the
  obvious reader for it checks the frame starts with `data: `. An id in front breaks every such
  reader silently — connected, delivering, never parsed. Our own smoke suite was written that way
  and caught it.
- A reconnect carrying `Last-Event-ID` (header, or `?lastEventId=`) is replayed from a 500-event
  ring buffer. WHEN the gap is older than the buffer, or the id is ahead of the server's sequence
  (a restart), the stream emits `event: resync` — a named event, so a client that does not know
  about it ignores it rather than parsing it as a mutation.
- MUST NOT carry presence when presence lands: it is throttled, lossy and latest-wins, and
  buffering 500 cursor frames to replay is exactly backwards.

### Verified

- `npm run smoke:client` — 15/15, in CI beside the agent suite via `ci-smoke.mjs`. Covers the
  envelope on success and failure, a real HTTP status rather than 200 with `ok:false`, `data:`
  still first, monotonic ids, replay from `Last-Event-ID`, and resync beyond the buffer.
- Test/Acceptance: both suites green; the exit code of `ci-smoke.mjs` is the worst of the two, so
  a suite that stops running cannot look like a suite that passes.

Canon: src/main/server.ts, scripts/smoke-client.mjs, scripts/ci-smoke.mjs


## Write coalescing at the edges

`component` · `nd_9e45b63ec3` · tags: server · 0%

> - required by → Presence is drawn, never stored

One name, three mechanisms — chosen by what a lost update costs.

**Throttle** presence to ~10–20Hz, latest-wins, drop freely. The next frame corrects any loss, so
buffering is pure latency.

**Coalesce** positions after a drag into one batched write. Losing them costs a human's hand-built
layout, so they must land — but they need not land thirty times. This wants the `nodes.positions`
batch endpoint already specced on the layout warp, and it is the same finding: `updateNode`
rewrites a markdown file and emits an event *per node*, so a 60-node tidy is 60 vault writes.

**Debounce** body edits, and pair it with conflict detection. A lost body edit is somebody's
writing; a silently overwritten one is worse, because nobody finds out. Last-write-wins is the
default that multi-user systems back into by accident — it must be chosen deliberately or rejected
deliberately.

The app already has the shape in miniature: settings autosave coalesces at 400ms, and the vault
watcher suppresses self-writes by content hash. Both are precedents worth reusing rather than
reinventing.


---

# Canvas

`area` · `nd_45ed1d6d50` · 18 members · 41%

## Charter

The spatial surface where the graph is seen and shaped. Rendering and appearance (type colours, shapes, rendering modes, inner glyphs), selection, find and highlight, filter chips, district hulls, and the in-place gestures for creating and linking nodes. If it is about how the board looks or how you manipulate it directly, it lives here.


## Customisable node colours and shapes

`feature` · `nd_b176cda362` · tags: canvas, done, settings · 100% · Done

> - derives → Rendering modes and inner glyphs

### Summary

Node type appearance (colour, shape, size) becomes customisable in Settings. Shipped defaults unchanged.

Decision (faykarta, verbatim): "Can we get the colours and shapes to be customisable in the settings page? the defaults are fine."

*Lead section only — 3 further sections in the full spec, fetched by the id above.*


## Rendering modes and inner glyphs

`feature` · `nd_2e5d64cc3f` · tags: canvas, done, settings · 100% · Done

> - derived from → Customisable node colours and shapes

### Summary

Node appearance grows two layers: a fill mode for the outer shape (solid or outline), and an optional inner glyph - a second smaller mark inside the node with its own colour and fill, including text symbols.

Decision (faykarta, verbatim): "we keep the shape that we currently have, but make it possible to have rendering modes, so we can do outlines or solid shapes. But then offer a optional inner shape, again with outlines of solid, but a different colour and I would like some other symbols in there like ? and ! particularly. I would also like a variation for Triangle which is upside down."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Box select on the canvas

`feature` · `nd_5d1e13592d` · 0%


faykarta: "Need a way to box select nodes. Would like it to allow add to selection. Probably on shift"

Drag a marquee on empty canvas to select everything inside it; shift adds to the existing selection rather than replacing it. Composes with the type/flag/relationship filters (select what is visible) and with the unified selection model.


## Flag filter chips

`feature` · `nd_352f00ff10` · tags: canvas, done, navigation · 100% · Done


### Summary

Filter any view by flag rules. Chips carry live counts and light up in the rule's color the moment at least one node is flagged.

Decision (faykarta, verbatim): "We should be able to filter based on flags, it should indicate if there are flagged items with a counter. ie. Blocked flag can be dimmed and greyed, but then when there is at least 1 blocked item the filter button should light up based on the flag rules."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## A selection can be tidied without disturbing the rest

`feature` · `nd_afb56286c9` · tags: canvas · 0%

> - depends on → Positions save in one call

A "tidy" button that settles ONLY the selected nodes, leaving every other position exactly
where the human put it.

This is the only layout operation in the warp with **zero mental-map cost**, which is what makes
it worth building when a global re-layout is not. The human chooses the region; the tool arranges
that region; nothing else moves.

Pinned nodes inside the selection stay pinned and act as anchors.

Depends on positions saving in one call — a tidy over 60 nodes must not be 60 round trips.


## A warp collapses like an area

`feature` · `nd_b3c64bbdec` · tags: canvas · 0%


Container collapse already exists and already works — it is simply denied to warps.

`GraphView.tsx:306` gates `member` collapse on `areaIds.has(r.targetId)`, so a 70-member warp
cannot be collapsed at all. Areas and warps are the same containment verb pointing at different
kinds of container; only one of them gets the machinery.

### Why this is first

It is the single biggest measured win available on the canvas, and it is close to one condition:

| state | Dice crossings |
|---|---|
| today | 4238 |
| best force re-tune | 3627 |
| area collapse (shipped) | 229 |
| **+ warp collapse** | **28** |

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Canvas districts

`feature` · `nd_a86ff4777b` · tags: done, ontology · 100% · Done

> - derived from → Areas and components

### Summary

Areas become visible geography on the canvas.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Create linked nodes from selection

`feature` · `nd_66194e92f7` · tags: canvas, done, workflow · 100% · Done


### Summary

Creating a node from a selection auto-links it to everything selected, with edge types inferred from the type pairs. Double-click quick-add stays for unlinked capture; this is the linked path.

Example: warp + 2 features selected, create a bug -> bug becomes `member` of the warp and `blocks` each feature.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Drag from a node to free space, can create a new node with a link, different but ergonomic way to create nodes

`feature` · `nd_095c6a9d0c` · tags: canvas, done, workflow · 100% · Done


### Summary

Shift-drag from a node and let go over **open canvas**: quick-add opens at the drop point with the
source node already staged as a link. It is the create-a-neighbour gesture — the node you want and
the edge you want in one motion, without leaving the canvas to find the + button.

Dropping on ANOTHER node still opens the link popover (that path is unchanged). Dropping back on the
source cancels, as it always did.

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## Find and highlight (Ctrl+F)

`feature` · `nd_c277d66f51` · tags: canvas, done, navigation · 100% · Done


### Summary

Ctrl+F opens a find bar over the graph. Fuzzy search where a node matches only if ALL tokens match; matches light up, everything else dims.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Graph Canvas

`feature` · `nd_139c67fcae` · tags: canvas, done, mvp · 100% · Done

> - depends on → Human UI surface
> - preview lives in the inspector → Obsidian-grade spec preview
> - shaped by → Everything Is A Node
> - shaped by → The Database Is Ground Truth

### Summary

Force-directed canvas of the whole project. Type-shaped nodes, directed edges, drag-to-pin, shift-drag to link.

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## Hide filter: take flagged nodes out of the view

`feature` · `nd_7741e5fa0b` · tags: canvas, done, workflow · 100% · Done


### Summary

Every chip row in the filter bar subtracts. Chips start lit, a click takes that bucket out of the
view, ctrl-click shows only it. Types, links, flags and tags all behave the same way, so "hide the
finished work" is the same gesture as "hide the questions".

*Lead section only — 3 further sections in the full spec, fetched by the id above.*


## Keyboard control

`feature` · `nd_81d56551d6` · tags: accessibility, canvas · 0%


### Summary

First-class keyboard operation of the graph. Living spec - hotkeys accumulate here.

Decision (faykarta, verbatim): "I wanna do a round of hot keys to facilitate keyboard users. eg. ctrl-A to select all nodes in the graph. ctrl-p to toggle pin."

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## Lenses are a control group, and certainty is one of them

`feature` · `nd_780e7571f0` · tags: canvas, fog, layout, needs-verification · 90%

> - depends on → Fog classifier
> - depends on → Fog is visible on the canvas and per district

Lenses become a first-class control group, and the first new one arranges the canvas by
**certainty**: settled work in the core, the frontier at the rim.

### Lenses get a home

Filters live top-left; controls live bottom-right. A lens is neither — it does not remove nodes
the way a filter does, and it is not a one-shot action the way `fit` and `re-layout` are. It is a
**mode the canvas is in**, and modes belong with the controls, where the user already looks to
change how the view behaves.

So the bottom-right group gains a lens switcher beside pin / fit / re-layout / + node. At most one
lens is active at a time — two lenses both claiming position or opacity would fight, and the
resulting picture would mean nothing.

Lens *parameters* stay top-left with the filters (the fog class chips are a filter over the lens's
output, not part of the switch itself).

*Lead section only — 8 further sections in the full spec, fetched by the id above.*


## Noisy relationships are off by default

`feature` · `nd_a1c26a1264` · tags: canvas · 0%


The cheapest mess reduction on the board, and it needs no layout work at all.

Hiding feedback alone **halves** Engine-Math's crossings. Feedback is commentary about the work
rather than the work — it already never feeds a roll-up — yet it draws at full weight and
`member` edges wire every node to its container on top of that.

### What changes

- feedback and `member` relationship chips default to OFF (they remain one click away; the
  relationship filters are already visual-only lenses, so nothing about the graph changes)
- a **hide-resolved** toggle: done ∪ pruned nodes leave the view

Both are disclosure, not layout. Neither moves a single node.


## The canvas can be navigated by keyboard

`feature` · `nd_6aef57cfd2` · tags: a11y, canvas · 0%

There is currently **no keyboard navigation of the graph at all** — no `tabIndex`, no
`onKeyDown` on the canvas. Every row in the shortcut table is a pointer gesture except Ctrl+K and
Ctrl+F.

The canvas is the app's primary surface, which makes it the app's primary accessibility gap. At
minimum: focus a node, move focus along its connections, activate the focused node, and reach the
inspector without a mouse.

Pairs naturally with the focus+context lens — "move to a neighbour" and "show me the
neighbourhood" are the same traversal.


## The canvas focuses on one node and its neighbourhood

`feature` · `nd_b2a4d3f205` · tags: canvas · 0%


A focus+context lens: pick a node, see it and everything within k hops, dim or drop the rest.

Measured 2-hop neighbourhood sizes across the real projects are **20–57 nodes median** — a
readable screen, from graphs of 200 to 530.

The tiers already exist server-side. `/api/nodes/:id/scope` and `/api/nodes/:id/impact` return
exactly this shape, and impact is already tiered — the rings the lens would draw are the tiers the
API already computes. This is largely a renderer for data the app already produces.


## Positions save in one call

`component` · `nd_4b8f8190d0` · tags: canvas · 0%

> - required by → A selection can be tidied without disturbing the rest

`nodes.positions` — a batch endpoint that writes many x/y pairs in one transaction.

### Why this is not optional

`updateNode` calls `refreshNodeFile` (rewriting the markdown frontmatter) and `emitEvent` on
**every** call, and there is no batch path. So any tidy of N nodes is N vault writes, N events and
an SSE refetch storm.

Measured against a copy of the live 10.4MB spec.db with the repo's own sql.js:

- 500 positions as individual statements: **251ms**
- the same 500 inside one `tx()`: **31ms**
- `persistNow()`: 20.3ms

Positions are not spec content. Writing markdown files because a node moved four pixels is the
wrong shape, and it is what makes every other layout idea in this warp expensive.

Unblocks the tidy verb and anything else that places more than one node.


---

# Graph Model

`area` · `nd_7102a29008` · 22 members · 80%

## Charter

The ontology itself, independent of any view: node types and the axes they answer, connections carrying typed relationships, taxonomy (class-of), decomposition (derives), grouping (member, into warps and areas), placement rules, and the verb family — fold, prune, answer, convert, complete. State-as-tags belongs here too: what a node IS and how its state is represented.


## Feedback Never Feeds A Roll-Up

`principle` · `nd_f2cea6b98f` · tags: progress, review

> - shapes → Closure engine
> - shapes → Feedback nodes
> - shapes → Progress roll-up engine

### Rule

Feedback members are dropped before any roll-up is computed: `computeProgress` skips a `member`
relationship whose source is a feedback node when it builds the member index
(`src/main/services.ts:534`). A warp's number is the mean over its WORK, and observations are
not work.

### Why

Feedback is the material of a review, not a line item in a deliverable. If observations counted,
filing them would move the warp backwards — a thorough review would look like regression, and
the honest reviewer would be punished with a falling percentage on the board. Worse, feedback
carries `hasProgress: false` and almost never matches the Done rule, so every observation would
enter the mean as a zero.

Two consequences fall out of this and both are intended:

- A warp whose only members are feedback is **memberless** for progress purposes, and takes
  stage-implied progress instead of reading 0.
- The board's member lists and counts apply the same exclusion (`listWarps`,
  services.ts:1999-2003), so what a warp says it contains and what it counts stay the same set.

### Where feedback does count

In the review's own meter, which is separate math with a separate meaning. `warpClosure`
(services.ts:2336) answers "is this review finished?" over five requirements — coverage,
designation, disposition, blocks, completion — and feedback is central to the first three.
Progress asks how much of the increment is built; closure asks whether it has been examined and
settled. One number cannot answer both, so there are two.

An action designated address-now DOES member the warp, and actions are work, so it lands in the
roll-up: an increment with an outstanding fix is not finished. Completing the action removes the
node, and the mean recovers.


## Progress Is Computed, Never Stored

`principle` · `nd_dac0046a07` · tags: core, progress

> - relates to → Presence is drawn, never stored
> - shaped by → The Database Is Ground Truth
> - shapes → Progress roll-up engine

### Rule

A roll-up is derived on read and never written down. `computeProgress` stamps `progressComputed`
onto the in-memory graph payload on its way out (`src/main/services.ts:433`); no column, no file,
no cache holds it.

### Why

A stored roll-up is a second copy of something the graph already knows, and second copies go
stale silently. Member a node into a warp, waive a finding, edit a Done flag rule, and every
container above it is wrong until something remembers to recompute — and the wrongness looks
exactly like a correct number. Deriving it costs one pass over nodes and edges that were loaded
anyway, so the cheap thing and the honest thing are the same thing.

It also keeps the arithmetic in one place. There is one ladder, in one function, and every
surface quotes it: the canvas ring, the backlog bar, the warp board card, the review room's
percentage, the exported document's meta line. The renderer never re-derives a node's progress —
`Inspector.tsx:646` reads the server's number and says so. A lens may aggregate what it was
given (the review room averages a type group for its accordion header), but it never recomputes
what a node is worth.

### What this forbids

- A `progress` column that means "rolled up" rather than "set by a person".
- Recomputing a percentage in the renderer, an agent, or an export.
- Trusting any progress number that did not arrive on a graph payload.


## State is a tag first, and a field only once the tag has proven itself

`principle` · `nd_80366cc0cb`

State is carried by TAGS. A node type does not get a first-class state
field until the tag carrying that state has proven itself in use.

- A state a node needs is FIRST expressed as a tag. No schema change, no
  migration, no field that every other type must ignore.
- A tag is a candidate for promotion to a first-class field on ONE node type
  when it is in consistent use on that type, its vocabulary has stopped
  changing, and something needs to enforce or query it in a way a free tag
  cannot.
- Promotion is PER NODE TYPE. Different types need different state, and a field
  added to all of them is a field wrong for most of them.
- Prose MUST NOT carry state. A `Status:` line in a node body duplicates what a
  tag holds and goes stale silently, because nothing validates prose.

### Vocabulary in use

- `done` - the thing exists and works.
- `building` - in flight.
- `fixed` - a defect no longer reproduces.
- `answered` - a question has an answer.
- `accepted` - a threat is knowingly borne.
- `locked` - a pillar or principle whose direction is settled.
- `experimental` / `maturing` / `stable` - how far a component can be depended
  on; absence means experimental.

Absence of a state tag means the default state for that type: not implemented,
unanswered, open, experimental.

### What promotion would decide

- Which types gain a field, and what its enum is.
- Whether the field replaces the tag or the tag becomes its projection.
- What the API refuses once a state is a field rather than free text.

- Test/Acceptance: a state can be added to one node type and used across a
  project without a schema change.


## Action nodes

`feature` · `nd_483f2be1e9` · tags: done, ontology · 100% · Done

> - leads to → leads-to links and inverse readings

### Summary

A new node type for transient imperative work. An action describes a **delta** - "update X", "refactor Y", "pay down Z" - and actioning it brings spec and implementation into sync, after which the action is REMOVED. The end-state nodes carry the truth.

Decision (faykarta, verbatim): "rather than a child feature it feels like an 'action' node, which will be removed once the feature and specs are updated. So paying down means actioning the 'action' and therefore the spec and implementation is updated and in sync."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## leads-to links and inverse readings

`feature` · `nd_918318a8f6` · tags: done, ontology · 100% · Done

> - leads from → Action nodes

### Summary

A new `leads-to` edge type models pipelines and sequences - and every edge type gains an inverse reading. One arrow, two verbs.

Decision (faykarta, verbatim): "We also need a new link type to help model pipeline features, which is 'leads-to'. ALL link types, while drawn with a single direction are actually two way. ie. 'leads-to' corresponds to 'leads-from'."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Prune operation

`feature` · `nd_ad519faf5c` · tags: done, ontology · 100% · Done


### Summary

First-class negative resolution for record nodes: prune = keep the node, dim it, and attach the why. Completes the records-vs-instructions model: instructions are completed (removed), records are resolved - positively (done/fixed/answered tags) or negatively (pruned).

Decision (faykarta, verbatim): "I need to be able to prune nodes. This means they are essentially archived, but with a note saying what happened and why."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Feature-to-method mapping

`feature` · `nd_d3e9f8995e` · tags: ontology, usage · 0%

> - depends on → Method registry
> - derived from → Feature usage analytics
> - shaped by → Everything Is A Node

### Summary

The bridge from "`impact.get` was called forty times" to "the Impact analysis feature was used".
The method registry is a class, each method an instance under it, and a feature `depends` on the
methods it is made of - so the mapping is graph data that a human drags and an agent curls.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## A memberless warp takes its progress from its stage

`feature` · `nd_35e3df0f7a` · tags: done, progress, warps · 100% · Done

> - depends on → Progress roll-up engine
> - derived from → Warp Process

### Summary

A warp with no work members has nothing to average, so its stage speaks for it. `STAGE_PROGRESS`
(`src/shared/types.ts:792-794`) maps the lifecycle to a number:

| stage | progress |
| --- | --- |
| concept | 5 |
| design | 20 |
| implement | 50 |
| test | 70 |
| review | 85 |
| ship | 95 |
| done | 100 |
| not_needed | 100 |

`computeProgress` reaches this branch only when the warp has no explicit progress and no work
members (`src/main/services.ts:562-565`). Feedback members do not count as members here, so a
warp carrying nothing but observations reads from its stage.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Addresses link type

`feature` · `nd_3c9ee31d56` · tags: canvas, done, process · 100% · Done


### Summary

A new directed edge type `addresses`: warp → node, meaning "this warp is aimed at this thing" — distinct from `member`, which is work scheduled on the board. Requested by faykarta in Build review: round 1: "we need a link type for things being addressed in a warp."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Area and component types

`feature` · `nd_ad9d73d879` · tags: done, ontology · 100% · Done

> - derived from → Areas and components

### Summary

The two node types plus their machinery.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Areas and components

`feature` · `nd_9f4ede8b2a` · tags: ontology · 100%

> - derives → Area and component types
> - derives → Canvas districts
> - derives → Impact analysis
> - derives → Placement guide
> - derives → Scope loading (district context)

### Summary

Two new axes complete the ontology: **areas** (WHERE - high-level, stable groupings of features; product geography) and **components** (HOW - one-of-one parts that do a defined job; the architecture layer, perpendicular to instances' one-of-many).

Decision (faykarta): approved the full analysis; adopted leans: `member` extends to areas (one belonging verb - warps group in time, areas in space); feature-component realization uses plain `depends`; hull rendering included; placement guidance is convention-only (recognize, never enforce).

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## class-of relationships (taxonomies)

`feature` · `nd_d3b64f01c4` · tags: done, ontology · 100% · Done

> - required by → Progress roll-up engine

### Summary

A new relationship type for classification: a class node (Runes, Seals, Elements, Inlays) with instances that are all subject to the class's rules. Classification is NOT decomposition - derives breaks a thing into parts; class-of says what kind of thing it is.

Decision (faykarta, verbatim): "when we have runes as a class of things in the game, we then need to design each rune type, of which there can be 10s or 100s. they are all runes and subject to the same rules. same for seals, elements, inlays etc..."

*Lead section only — 3 further sections in the full spec, fetched by the id above.*


## Cross-project connections

`feature` · `nd_c795fbdb75` · tags: done, ontology · 100% · Done

> - derived from → Cross-project node sharing
> - relates to → Progress roll-up engine

### Summary

A connection may join nodes in different projects. This is the foundation the other sharing features
stand on, and on its own it delivers **cross-project dependency tracking**: "Dice depends on the Spec
Engine REST API" is an ordinary `depends` relationship.

*Lead section only — 6 further sections in the full spec, fetched by the id above.*


## Cross-project node sharing

`feature` · `nd_44b5d02067` · tags: done, ontology · 100% · Done

> - derives → Cross-project connections
> - derives → Referral: send a node to another project's graph
> - derives → Shared canon: reference a node from another project
> - shaped by → Everything Is A Node
> - shaped by → The Database Is Ground Truth
> - shaped by → User-Defined Vocabulary

### Summary

A node can be referenced from more than one project, so shared thinking is shared rather than copied.
Optional throughout: a project that shares nothing behaves exactly as it does today.

*Lead section only — 8 further sections in the full spec, fetched by the id above.*


## Fold verb

`feature` · `nd_4ffc425784` · tags: core, done · 100% · Done


### Summary

`fold` is how a record leaves active circulation without leaving the graph: its value is absorbed into a durable node and the record stays as dimmed provenance pointing at where it went.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Node decomposition (child nodes)

`feature` · `nd_501954448a` · tags: done, lists, workflow · 100% · Done

> - required by → Progress roll-up engine

### Summary

Any node can be broken down into child nodes. Children are full nodes - they just help decompose complex ideas - and the list view shows them nested under their parent.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Node type conversion (ideas are seeds)

`feature` · `nd_8651eb91b1` · tags: done, ontology · 100% · Done


### Summary

Any node can convert to another type in place - same id, same links, same spec content, same history. Ideas are seeds: an explored idea becomes a feature, a principle, an action - without losing its identity.

From faykarta's idea (verbatim title): "Idea is a seed - can be converted to any other type."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Placement guide

`feature` · `nd_87bf1fe1ce` · tags: done, ontology · 100% · Done

> - derived from → Areas and components

### Summary

The altitude decision guide - so humans and agents file things where they belong.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Shared canon: reference a node from another project

`feature` · `nd_2a55f7b63f` · tags: done, ontology · 100% · Done

> - derived from → Cross-project node sharing

### Summary

A node can be shared by its owning project, discovered by others in the commons, and pulled in as a
**reference**: a real local node showing the owner's spec read-only. One writer, many viewers, no drift.

*Lead section only — 6 further sections in the full spec, fetched by the id above.*


## Tag-first status model

`feature` · `nd_a271846fd2` · tags: core, done, workflow · 100% · Done

> - required by → An oversized body is flagged, not refused
> - shaped by → User-Defined Vocabulary

### Summary

Node statuses die; tags carry state. Warps get a first-class **Stage** (shipped separately in 2a with the one-board Warps view). Flags - like Blocked - are user-composable highlight rules configured in Settings.

Per faykarta: this tool does not track tasks like Jira. It tracks the Spec; Warps define the Increments.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Threat and flaw types

`feature` · `nd_62f76cd3de` · tags: core, done · 100% · Done


### Summary

The HEALTH axis distinguishes what is wrong by what fixes it.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Progress roll-up engine

`component` · `nd_84c7e71bf4` · tags: core, done, progress · 100% · Done

> - depends on → Node decomposition (child nodes)
> - depends on → class-of relationships (taxonomies)
> - relates to → Cross-project connections
> - required by → A memberless warp takes its progress from its stage
> - shaped by → Feedback Never Feeds A Roll-Up
> - shaped by → Production is measured, not estimated
> - shaped by → Progress Is Computed, Never Stored
> - shaped by → User-Defined Vocabulary

### Job

Answer "how far along is this?" for every node in the graph, once per graph read, from
relationships that already exist. `computeProgress` (`src/main/services.ts:526-586`) runs inside
`graphInternal` immediately after the flag rules and stamps `progressComputed` on every node it
was handed. Nothing else in the app derives a percentage.

### The ladder

First match wins, per node:

1. **Explicit `progress`** (services.ts:557) — a number set by hand or by the API beats every
   roll-up below it, including an explicit `0`.
2. **A warp with work members** — the rounded mean over its members' effective progress
   (services.ts:559-561).
3. **A warp without them** — its stage implies the number (services.ts:562-565).
4. **An area with work members** — the same rounded mean (services.ts:565-569). An area has no
   slider (`hasProgress: false`, `src/shared/types.ts:670`), but the API can still set explicit
   progress on one and rule 1 still wins.
5. **A feature with `derives` children** — the mean over those children, whatever type they are
   (services.ts:570-572).
6. **Any node at all with `class-of` instances** — the mean over the instances
   (services.ts:573-579). This branch is not gated on type: a feature, a pillar, an instance that
   classifies other instances — anything holding outgoing `class-of` inherits their mean. It sits
   BELOW the warp, area and feature branches, so a feature that both derives children and
   classifies instances reads from its children only.
7. **Everything else** — 100 if the node matches the Done flag rule, 0 otherwise
   (services.ts:580). Tags imply no progress beyond done-ness.

### What the numbers are actually made of

- **The Done fallback is the human's own rule.** The terminal 100 comes from whatever the Done
  flag rule matches in Settings — the shipped one fires on `done`, `fixed`, `answered`,
  `adopted`, `wontfix`, and on a warp at stage `done` or `not_needed`
  (`src/shared/types.ts:526-545`). Rewriting that rule rewrites the bottom of this ladder, which
  is `User-Defined Vocabulary` reaching all the way into the arithmetic.
- **Every level rounds and every member counts once.** `Math.round` is applied at each roll-up
  and the mean is unweighted, so a warp holding one 100% feature and one 100%-of-forty-children
  feature reads 100 — subtree size buys no extra weight, deliberately: a container reports over
  the things a person put in it, not over the graph's shape underneath.
- **`hasProgress` is a display flag, not a model flag.** `progressComputed` is stamped on every
  node of every type; `hasProgress` (`src/shared/types.ts:616`) only decides whether a bar or a
  slider is drawn. A pillar carries a number nobody shows.
- **Recursion is guarded, not forbidden.** A node re-entered while its own value is still being
  computed reads as its Done fallback and the walk unwinds (services.ts:554). Only `derives` and
  `class-of` are held acyclic; a warp may member another warp, so a member cycle is reachable and
  the guard is what keeps the graph payload from hanging.
- **The scope is the union, not the project.** Flags and progress are computed over local nodes
  plus the foreign endpoints of cross-project connections before the list is split
  (services.ts:425-437), so a feature whose `derives` child lives in another project still rolls
  up correctly. `member` and `addresses` cannot cross a project boundary at all
  (services.ts:1756-1772) — precisely so no roll-up ever depends on work another project owns.

### Corrections against DESIGN.md §7

The document is the intent; the code above is the behaviour. Three places read differently:

- §7 says "classes roll up from their instances". There is no `class` node type — the branch is
  untyped and applies to anything with outgoing `class-of`.
- §7 gives areas the member mean flatly. Areas also honour explicit progress set through the API,
  and an area with no members falls through to the Done fallback rather than to a mean.
- §7 abbreviates the stage table as "concept 5 -> ship 95, done/not_needed 100". The full table
  lives in `src/shared/types.ts:792-794`: concept 5, design 20, implement 50, test 70, review 85,
  ship 95, done 100, not_needed 100.


---

# Storage & Sync

`area` · `nd_afe5322769` · 6 members · 29%

## Charter

Where the spec lives at rest and how every surface stays agreed: the Obsidian vault, markdown files and frontmatter, the file watcher, revisions, the database, and rendering parity with Obsidian (the preview renders what Obsidian renders). Files are the spec; this district keeps disk, database and board telling the same story.


## Usage ledger

`feature` · `nd_93f79b689c` · tags: usage · 0%

> - derived from → Feature usage analytics

### Summary

Aggregated counters, not an event log: one row per day per (project, method, surface, actor),
incremented in memory and flushed on a timer. A whole history of usage costs tens of rows a day.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## An oversized body is flagged, not refused

`feature` · `nd_fda559d4ef` · tags: flags, storage · 0%

> - depends on → Tag-first status model
> - relates to → A graph, or any part of one, exports as a single markdown document
> - relates to → Conflicts are detected, merged where they can be, marked where they cannot
> - relates to → Skill install engine
> - relates to → The fog API reports the frontier and carries the prose
> - shaped by → Recorded, Not Prevented
> - shaped by → The Database Is Ground Truth

Node bodies and annotation bodies are unbounded today: `setContent` validates that content is a
string and writes it (`src/main/services.ts:818-821`), and `addAnnotation` validates only that the
body is non-empty (`src/main/services.ts:1639`). That was harmless while markdown lived in the
vault and the database held structure. It stops being harmless once the database is the only copy,
merge runs over `node_revisions`, and payloads carry prose.

The answer is not a cap. It is a **flag with a ceiling far above it**: a body over 8KB is marked,
never refused; a body over 256KB is refused with a 413, because at that size nothing authored it on
purpose.

### What the corpus actually weighs

1715 nodes across six projects, 3113 revisions, every one written inside a single month.

    scope              n     p50    p90    p99     max    >8KB   >16KB
    all projects    1715     981   3130   8711   34500      19       1
    Spectre          281     734   2825   9541   14493       3       0

By type, the tail is not evenly spread:

    type          n    p50    p90     max   >8KB
    skill         3   9541  11527   11527      2
    warp         53   2773   7478   16023      4
    feature     361   1570   4020   14493      7
    component   116   1393   3549   10939      3
    feedback    386    449   1548    3306      0
    instance    327    741   1664    6022      0

Edge annotations are a different animal entirely: 58 of them, median **145 bytes**, largest **178**.
Node annotations run larger — 742 of them, median 459, largest single comment 6909, largest thread
14434 bytes over eight comments.

*Lead section only — 7 further sections in the full spec, fetched by the id above.*


## Obsidian-grade spec preview

`feature` · `nd_40f911652d` · tags: canvas, done, specs · 100% · Done

> - preview lives in the inspector → Graph Canvas

### Summary

The spec preview must render what Obsidian renders. From faykarta's note: markdown isn't rendering properly - checklists, formatting and technical diagrams need full support.

*Lead section only — 3 further sections in the full spec, fetched by the id above.*


## Backup and migrate the existing board

`component` · `nd_be2580eab8` · tags: server · 0%

> - depends on → Storage that survives concurrent writers

The current board is not a fresh start: five projects, ~1,500 nodes, five vaults and
a decade of activity rows. Cutover has to preserve all of it.

### What has to move

- `spec.db` — written by `sql.js`, which produces a real SQLite file, so the format should carry
  over to a native driver unchanged. **Verify rather than assume**; a format that is 99% compatible
  is worse than one that is not.
- the vaults — markdown, whose destination depends on the still-open vault question
- `settings.json` per user data dir, which now has to become per-user rather than per-machine

### What has to be true before cutover

- a **backup that has been restored at least once**. An untested backup is a belief, not a backup.
- the row-level orphan check that smoke ends with must pass against the migrated database
- the migration must be re-runnable: a first attempt that half-completes cannot leave the board
  unusable

### The cheap safety property

`sql.js` and a native driver read the same file format, so the old app can be kept as a read-only
fallback during cutover — which makes the migration reversible for as long as nobody writes.


## Conflicts are detected, merged where they can be, marked where they cannot

`component` · `nd_7735cf674e` · tags: server · 0% · Blocked

> - depends on → Every mutation is recorded and reversible
> - depends on → Presence is drawn, never stored
> - relates to → An oversized body is flagged, not refused

Detect at commit, merge what does not overlap, mark what does.

### The three states

**clean** — nobody else touched it since you opened the editor. Write it.

**auto-merged** — someone did, but your changes and theirs touch different lines. Three-way merge
against the common ancestor from `node_revisions`, write the result, and **tell both people it
happened**. A silent auto-merge is the failure mode described below.

**conflicted** — overlapping lines. Nothing is lost and nothing is silently chosen: both versions
are kept, the node carries a marker, and a human resolves it.

### The marker should reuse the flag machinery

A `conflicted` tag plus a shipped flag rule gives a ring on the canvas, a chip in every list, a
count on the district hull and a `flags` entry in the graph payload that agents already read —
without inventing a new visual language. The flag system was built for exactly this: composable
highlight rules over a condition.

### The honest risk: a clean merge can still be wrong

Two people editing adjacent lines produces a textually clean merge that neither of them wrote and
neither reviewed. Git has this problem and calls it a semantic conflict — the tool is confident and
the result is nonsense.

The mitigation is not cleverer merging, it is **never merging silently**: an auto-merge must be
visible to at least the person who committed second, with a one-click view of what the other person
changed. Confidence is the danger, not the algorithm.

### What conflicts are worth recording

Every one, with the node, both actors, whether it auto-merged, and how many lines overlapped. That
is the evidence that decides whether locking is ever needed — and it costs nothing to collect while
the answer is still unknown.


## Every mutation is recorded and reversible

`component` · `nd_2fea17a84d` · tags: server · 0%

> - depends on → Storage that survives concurrent writers
> - required by → Conflicts are detected, merged where they can be, marked where they cannot
> - required by → Presence is drawn, never stored

No locks. Instead: an append-only record of every mutation, and the ability to roll one back.

### Why the registry makes this cheap

Every mutation in this app already funnels through one place — `call()` in `src/main/registry.ts`.
IPC and REST are both thin adapters over it, which means a single wrapper captures **every** write
from **every** caller, human or agent, with no per-verb work and no way to bypass it.

That is the same choke point a previously-specced feature wanted for usage instrumentation
(`nd_f8e6cea6c9`), so the two should share a wrapper rather than each growing one.

### What a transaction has to carry

The method and payload, the authenticated user, a timestamp, and **enough state to reverse it**.
That last part is the design problem: an inverse operation is small but must be written per verb;
a before/after snapshot is uniform but heavy. `node_revisions` already stores body snapshots and
`GET /api/nodes/:id/diff` already reconstructs change, so part of this exists — for bodies.
Structural changes (edges, relationships, stage) have no equivalent.

### What it is not

It is not conflict *detection* — see the linked question. A log records a silent overwrite
faithfully and tells nobody it happened. Rollback without detection is a fire extinguisher with no
smoke alarm.


---

# User Workflows

`area` · `nd_2e551e1dab` · 15 members · 39%

## Charter

How work moves through the system, for every user — "user" means human or agent alike. This district holds the process specs: the review process (feedback digested into actions while a warp sits in Review), the warp process (deliverables moving through the stage pipeline), backlog and prioritisation, the question workflow (ask, answer, graduate), and curation. If it describes a loop someone runs rather than a thing someone renders or stores, it lives here.


## Question answering workflow

`feature` · `nd_58b87c1152` · tags: done, ontology, workflow · 100% · Done

> - required by → Grill the graph
> - required by → Record the decision

### Summary

Answering questions becomes a first-class operation with a full lifecycle: open -> answered (record persists, dimmed) -> graduated into durable spec or cleaned up.

Decision (faykarta, verbatim): "I need to be able to answer questions. Once answered they should stay around in an answered state until they are cleaned up or actioned ie. tuned into a principle."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## The review page shows what the gate will refuse before the close is pressed

`feature` · `nd_700399954c` · tags: done · 100% · Done

> - depends on → Review room

### Summary

The offender lists are rendered only inside `{refusal && ...}` - after a 409 comes back. Until
the human presses Close they see one number (`{pct}% actioned`) and no statement of what is
outstanding, even though the client mirror has already computed every offender.

Pressing a button to find out why the button will not work is the wrong way round.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Usage lens

`feature` · `nd_a8b2a1f097` · tags: usage, workflow · 0%

> - depends on → Human UI surface
> - derived from → Feature usage analytics

### Summary

The Activity view gains a second lens. The feed answers "what happened"; usage answers "what gets
used" - and it opens with the features nobody has touched in thirty days.

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Archive

`feature` · `nd_4adb323937` · tags: process · 0%


### Summary

One searchable page for everything the graph has retired. The system is careful never to destroy anything - records fold, specs supersede, actions complete, warps ship - but until now there was no door to any of it.

Decision (faykarta): "perhaps we want an Archive page? which can be searched?" - yes, and general rather than review-specific: closed reviews are one kind of history, not the only kind.

*Lead section only — 4 further sections in the full spec, fetched by the id above.*


## A stage column copies the ids of every warp in it

`feature` · `nd_b8f908ccf3` · tags: agents, done, workflow · 100% · Done

Each stage column on the Warps board carries a quiet `⧉ ids` chip in its header. Click it
and every warp id in that column lands on the clipboard, one per line.

### Why

The board is where a human decides *these are the ones*. What follows is almost always handing
that set to an agent — and until now that meant opening each card and copying its id one at a
time. The column already knows the set; it just wouldn't say it.

Newline-separated because the destination is a prompt or a shell loop, not prose.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Backlog

`feature` · `nd_d01bb297ed` · tags: done, process · 100% · Done

> - depends on → Human UI surface
> - shaped by → Human-Agent Parity

### Summary

A first-class Backlog view listing every actionable node (feature | bug | question | idea) in the project that is not yet a member of any warp and is not already done — the pool of unassigned work, ordered by explicit priority. Requested by faykarta in Build review: round 1: "we need a backlog feature for prioritising items that are not yet assigned to a warp."

*Lead section only — 2 further sections in the full spec, fetched by the id above.*


## Feedback nodes

`feature` · `nd_fbb41e94b0` · tags: done, process · 100% · Done

> - shaped by → Feedback Never Feeds A Roll-Up

### Summary

Feedback is the observation type of the review pipeline: anyone files it against the node under review, it threads, and it ends folded.

*Lead section only — 1 further section in the full spec, fetched by the id above.*


## Review Process

`feature` · `nd_8ff5a08f09` · tags: done, process · 100% · Done

> - depends on → Closure engine
> - depends on → Digestion verbs
> - depends on → Feedback capture
> - depends on → Inbox and routing
> - depends on → Review room
> - depends on → Review sweep
> - depends on → Synthesis and disposition

### Summary

How built work gets reviewed. The review is not a thing, it is a PHASE: REVIEW is a stage of a
warp, which is a node — so feedback attaches to the warp itself, and the graph already knows the
rest: contain (member), spawn (derives), gate (blocks), retire (waive). There are no review
rows, item statuses or verdict enums — verbs on the graph.

*Lead section only — 7 further sections in the full spec, fetched by the id above.*


## Warp Process

`feature` · `nd_f06f589aa3` · tags: core, done, warps · 100% · Done

> - derives → A memberless warp takes its progress from its stage
> - required by → Chart a warp

### Summary

How deliverables move. A warp is a grouping of work in TIME — sprint-like, aimed at goals — and
its whole lifecycle is the `stage` field. This tool does not track tasks like Jira: it tracks the
Spec; warps define the Increments. Increment-shaped work is planned in warps and folded into
living specs on ship (see the principle "Specs Are Present Tense").

*Lead section only — 6 further sections in the full spec, fetched by the id above.*


## Closure engine

`component` · `nd_5f0cac844d` · tags: review · 0%

> - required by → Review Process
> - shaped by → Feedback Never Feeds A Roll-Up

### Job

Decide whether a review is finished, and be the single authority everything else quotes.

`warpClosure(warp)` returns five offender lists; the review is complete only when all five are empty:

- **uncovered** - work members no feedback is about. Coverage counts any bare feedback-to-node connection, a feedback membering the node, or a feedback deriving it. Deliberately label-agnostic: waiving relabels that same connection, so matching on the label would let a waive destroy the coverage it was recording.
- **undesignated** - feedback members with no derived work that have not been waived.
- **pendingActions** - live `action` nodes derived from this warp's feedback, each stamped address-now or undisposed.
- **blockers** - unresolved sources of `blocks` into the warp, minus anything already named under pendingActions.
- **incomplete** - COMPLETABLE members that are not resolved, minus anything already named under pendingActions or blockers. Completable types: `feature instance component bug question idea action threat flaw warp` (a warp may member another warp). Standing types - pillar, principle, area - are exempt because they never "done", and feedback is exempt because DESIGNATION already carries it. One node, one requirement.

"Unresolved" is the same set the flag rules use (Done or Pruned), so a defect tagged `fixed` stops blocking, a member tagged `done` stops holding the door, and a sub-warp clears at stage `done` through the Done rule's stage condition - nobody marks anything complete by hand.

### Why completion is separate from coverage

They ask different questions over different member sets. Coverage asks "was this reviewed?" and runs over `work` (members minus feedback and action). Completion asks "was this finished?" and runs over the completable members INCLUDING actions.

That difference is the whole point. Actions are coverage-exempt and are completed by REMOVAL, and `pendingActions` only reaches actions DERIVED FROM THIS WARP'S FEEDBACK - so before COMPLETION existed, an action membered directly onto a warp appeared in no offender list at all, and a warp built out of action members shipped reviewed by nobody and finished by nobody. Observed 2026-08-22; closed the same day on the owner's ruling that *a warp can only be complete if linked completable things are also complete*.

### Enforcement

The gate fires when a warp is restaged to ship or done AND it is in Review or still carries open feedback - so a send-back cannot walk around it. Refusal is a 409 carrying the five lists. Backward restaging is always free. `not_needed` bypasses, auto-waiving what remains with an abandonment note.

### What the gate CANNOT decide

Whether the increment is HOLLOW. Five satisfied requirements over members that do not add up to the thing the warp promised is a passing gate and a failed warp. That judgment is the human's, and no requirement should be added that pretends otherwise.

### Consumers

The gate (authority), the room's percentage and coverage/completion marks (a client mirror - fast, occasionally stale, never the truth), the warp board card tooltip, and agents reading the 409 body.

`computeClosure` in `src/renderer/src/lib/review.ts` mirrors this math line for line and MUST be changed in the same commit; the two `COMPLETABLE_TYPES` sets are duplicated deliberately (different modules, no shared import) and diverging them silently is the failure mode to watch.

Canon: `src/main/services.ts` (warpClosure, offenderSummary); `src/renderer/src/lib/review.ts`; `src/main/llms.ts`


## Inbox and routing

`component` · `nd_f62a1f04b9` · tags: review · 0%

> - required by → Review Process

### Job

Hold observations that belong to no increment yet, and get them where they belong.

- The inbox is **untriaged only**: feedback with no warp membership. Anything already assigned lives in its warp's room and nowhere else, so the inbox always means "not yet placed".
- **Send to warp** - per row and across a selection, offering open warps; assigning members it and the row leaves.
- The **closed-review guard** refuses feedback joining a warp past its Review stage, in the service layer, so the API and the UI refuse identically. New observations about shipped work stay in the inbox for the next increment.
- Agents query the same set in one call (`GET /nodes?type=feedback&unassigned=1`); the inbox is not a human-only view.


## Review room

`component` · `nd_65c2d53517` · tags: review · 0%

> - required by → Review Process
> - required by → The review page shows what the gate will refuse before the close is pressed

### Job

Let a reviewer read what they are reviewing and act on it without leaving.

Four panels, fixed 2x2, each scrolling independently:

- **Increment** (top-left) - the warp first, then an accordion per node type with generated stats (count, mean progress, coverage, flag counts) and a coverage mark per row. Pass sits here.
- **Content** (top-right) - the selected node's full spec, editor or preview, never both.
- **Feedback** (bottom-left) - threads, capture, designation, waive.
- **Actions** (bottom-right) - the synthesized work with provenance and disposition, then the percentage actioned and Close or Send back. Nothing else: the other panels already carry the detail, and the gate's refusal names the offenders at the moment they matter.

Selection is local to the room - nothing navigates away. Every row carries a copyable id and API URL, because handing a finding to an agent is the point.


## Synthesis and disposition

`component` · `nd_678a902a93` · tags: review · 0%

> - required by → Review Process

### Job

Turn observations into decisions, and say when each decision gets done.

- **Synthesis**: actions derive from feedback, many-to-many. One action may carry five parents ("these concerns, one fix"); one observation may spawn three. Provenance is the `derives` edge, so "why does this work exist" is a graph walk rather than a memory. The gesture is the multi-select create-linked flow.
- **Disposition** is a separate, deliberate choice - never a side effect of designating:
  - **address-now**: the action members the warp and `blocks` it. It holds the gate and counts 0% in the roll-up, because an increment with an outstanding fix is not finished.
  - **address-later**: the work is institutionalised - converted into persistent work (feature, flaw, question) and ranked in the backlog. It stops being an action, so it stops holding the door. Transient instructions must not rot.
- An undisposed action holds the gate: neither completed nor converted is not a decision.


## Digestion verbs

`component` · `nd_7370e19b95` · tags: review · 0%

> - required by → Review Process

### Job

Settle a finding: give it a lasting shape or dismiss it, always reversibly.

- **designate** (`convert`) - the finding becomes what it actually is: bug, flaw, threat, question. It keeps its identity, its thread and its membership; it leaves the feedback math as an institutional record. Never a one-click side effect: designation confirms, naming the consequence.
- **waive** (`nodes.waive`, formerly fold) - the observation needed nothing, or its value went elsewhere: prunes the node, writes the rationale as an annotation, links `waived into` whatever absorbed it. `unwaive` restores it and keeps the trail.
- **pass** (`nodes.pass`) - the coverage shortcut: files "Pass - Feedback Waived" against a member with the typed text as its body, members it on the warp, links it and waives it, atomically. Reviewing sixteen members should not mean sixteen ceremonies.


## Feedback capture

`component` · `nd_f0da713744` · tags: review · 0%

> - required by → Review Process

### Job

Get an observation into the graph with as little friction as possible, and keep it editable while the review is open.

- Title plus markdown body, filed by human or agent through the same path (`nodes.create` with `linkTo`).
- A **sticky filing target**: the observation covers a chosen member, independent of whatever the reader is browsing. Filing without a target is allowed; filing that silently loses one is not - the coverage link is created in the same call as the node.
- Threads are node annotations, attributed. Every keystroke-driven post latches in a ref and clears its field before the round trip: state-based guards cannot be read within the same tick and let double-posts through.
- Titles and bodies stay editable until the review closes; after that the closed-review guard refuses new material.


---

# Chart a warp

`skill` · `nd_b73a179ad5` · tags: agents, planning, process, skills, warps · 0%

> - depends on → Grill the graph
> - depends on → Record the decision
> - depends on → The fog API reports the frontier and carries the prose
> - depends on → Warp Process
> - shaped by → Production is measured, not estimated

*Body not reproduced: a skill is an instruction an agent follows, not a description of this app. Fetch it by the id above.*


---

# Grill the graph

`skill` · `nd_e49c112a15` · tags: agents, planning, process, skills · 0%

> - depends on → Question answering workflow
> - depends on → The fog API reports the frontier and carries the prose
> - leads to → Record the decision
> - required by → Chart a warp

*Body not reproduced: a skill is an instruction an agent follows, not a description of this app. Fetch it by the id above.*


---

# Record the decision

`skill` · `nd_b75c6484bc` · tags: agents, decisions, process, skills · 0%

> - depends on → Question answering workflow
> - leads from → Grill the graph
> - required by → Chart a warp
> - shaped by → Represent Before Acting
> - shaped by → Specs Are Present Tense

*Body not reproduced: a skill is an instruction an agent follows, not a description of this app. Fetch it by the id above.*

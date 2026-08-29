# Ozmo Spectre — The Agentic Human Canvas

![The Spectre canvas](docs/spec.png)

A desktop canvas for shaping software **with AI agents**. Specs live as markdown in your Obsidian
vault; the graph of ideas → pillars/principles → features → warps → bugs/questions lives in SQLite;
and everything a human can do in the UI, an agent can do over a local REST API — attributed, live,
and on the same board. See [DESIGN.md](DESIGN.md) for the full design — which is not written by
hand: it is the board itself, exported by `npm run gen:design`.

## Run

```bash
npm install
npm run dev          # desktop app (electron-vite, watching)
npm run build        # production bundles into out/ — main, preload, renderer AND the web client
npm run smoke        # end-to-end agent API test (needs the app running)
npm run smoke:client # thin-client surface: /api/rpc, event resume, the served bundle, the gate
npm run smoke:accounts # onboarding decisions, against the shipped provider (own scratch db)
npm run gen:design   # regenerate DESIGN.md from the board (needs the app running)
```

First launch creates the vault at `Documents/OzmoSpecVault` (change in Settings), seeds a small
self-describing starter project, and starts the agent API on **http://127.0.0.1:4820**.

## Two clients, one core

Every capability lives in one method registry (`src/main/registry.ts`). Three adapters sit on it:
Electron IPC, the REST resource routes agents read about in `/llms.txt`, and `POST /api/rpc` — the
dispatcher a client wants. That is what makes a second front end a *client* rather than a fork.

**The desktop app** is the core: it owns the database, the vault and the API, and its renderer
talks over IPC.

**The browser client** is the same renderer, built for the web, talking to a running Spectre over
HTTP. The core serves it:

```
http://127.0.0.1:4820/app          # after npm run build (or npm run build:web)
```

To develop it against a desktop Spectre:

```bash
npm run dev:web                    # vite on 5174
# → http://localhost:5174/app/?api=http://127.0.0.1:4820   (remembered after the first visit)
```

What the browser client does *not* have is deliberate and named: the folder pickers, reveal-in-
folder, Open in Obsidian, relaunch, and the vault/port settings all address the machine the core
runs on. They are **absent, not broken** — every one is a flag on the host seam
(`src/renderer/src/host.ts`), and a component asks before drawing the affordance. A view that
reaches past that seam is the thing that would quietly turn one codebase into two.

Both clients are live on the same events. Over the network that stream carries a sequence id, so a
client whose link drops reconnects with `Last-Event-ID` and either gets the gap replayed or is told
to resync — never silently handed a stale board.

## Who is on the board

The board is by invitation. A person onboards by claiming a **display name** — the name their
work is attributed to — and it is PENDING until the owner decides. A pending viewer sees a waiting
screen and nothing else: the gate refuses every read at the server, so no project name, no count
and no event crosses the wire.

- The **first** name on a fresh board claims it and becomes the owner.
- **Approving and rejecting happen in the desktop app**, at the machine holding the board — never
  over the network, and the owner's own name cannot be claimed remotely. Without that, anyone who
  knew the owner's name could approve themselves and every other refusal would be decoration.
- A rejected row is KEPT. A rejection that leaves no trace is a name asked for again unnoticed.
- Accounts live behind a provider seam (`src/main/account.ts`). The local provider stores them in
  the board's own database; **Atlas services on this machine** become a second provider, and the
  seam is what makes that a swap rather than a rewrite.

**Agents are unaffected.** A caller with no session token is served exactly as before, on loopback
— every agent in the fleet is one of those. The carve-out is named rather than implied
(`agentsUnauthenticated`, default on, refused through the settings API), and while it is on:

> **the gate is a workflow gate, not a security boundary.** The boundary is the loopback bind.

Nor is an approved display name authentication — it is an allowlist. It stops the unknown and the
accidental; it does not stop someone who knows an approved name from typing it. Closing that is
`A person is authenticated, not asserted`, and it is not closed yet.

## Storage

SQLite, one file, in `.ozmo/` inside the vault. Two drivers run the same schema behind one seam
(`src/main/driver.ts`):

```bash
npm run dev                        # sql.js (wasm) — the default
OZMO_DB_DRIVER=native npm run dev  # better-sqlite3 — real pages, WAL

npm run db:backup                  # verified snapshot + manifest
npm run db:restore                 # PROVE the snapshot restores (scratch dir by default)
npm run db:parity                  # both drivers through the real db.ts, diffed
npm run db:bench                   # what the difference costs
```

`sql.js` re-serialises the whole database on every write, which is a fair trade for one local
process and the wrong shape for a served board: on the live 12.9MB board a node create costs 136ms
against 1.3ms native. The native driver is opt-in until it has run against a real board long enough
to trust, and both drivers read and write the same file — which is what keeps a cutover reversible.

## Point an agent at it

```bash
curl http://127.0.0.1:4820/llms.txt
```

That one URL teaches an agent the whole system: ontology, endpoints, the review process, and curl
recipes. Agents send `X-Actor: <name>` and appear in the shared activity feed next to you. They can
subscribe to `/api/events` (SSE), and even see the canvas via `/api/debug/screenshot` or point at a
node on your screen via `POST /api/ui/focus`.

## Skills and prompts

The **Agentic** page is where the instructions agents follow are authored. A skill is a node like
any other — body in the vault, links, tags, reviews — and *installing* it renders a
`SKILL.md` into a declared repo's `.claude/skills/`. The node is the original; the installed file
is a build output.

A **prompt** is the same node with `disable-model-invocation` set: a skill the model never picks on
its own and you invoke with `/name`. One type, one folder, one install path, one toggle.

Install writes files and nothing else — no checkout, no commit, no branch switch — so a skill lands
on whatever branch the target is currently on, and `git status` is where you find out. Targets are
an explicit allowlist managed through `skills.addTarget`, never through the settings API: the API
is unauthenticated on loopback, so a filesystem allowlist reachable that way would be an
arbitrary-write primitive.

The page is a matrix of skills against targets, because the real problem is fan-out rather than
authoring — the same skill copied into a dozen repos drifts, and nothing else shows you that.

## Layout

```
src/shared    domain model + type metadata (single source of truth)
src/main      electron main: sqlite behind a driver seam, vault fs + watcher,
              services, method registry, REST API + SSE + /api/rpc, IPC
src/renderer  react ui: force-graph canvas, lists, warp boards, review rooms,
              activity feed, inspector with markdown editor
              host.ts + host-electron.ts + host-web.ts — the transport and
              capability seam; the ONLY thing the two clients differ by
scripts       smoke.mjs — full agent API exercise
              smoke-client.mjs — the thin-client surface
              ci-smoke.mjs — both suites against a throwaway instance
              db-*.mjs — backup, restore, driver parity, benchmark
              gen-design.mjs — DESIGN.md, exported and curated from the board
```

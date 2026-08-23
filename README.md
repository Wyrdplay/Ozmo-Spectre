# Ozmo Spectre — The Agentic Human Canvas

![The Spectre canvas](docs/spec.png)

A desktop canvas for shaping software **with AI agents**. Specs live as markdown in your Obsidian
vault; the graph of ideas → pillars/principles → features → warps → bugs/questions lives in SQLite;
and everything a human can do in the UI, an agent can do over a local REST API — attributed, live,
and on the same board. See [DESIGN.md](DESIGN.md) for the full design.

## Run

```bash
npm install
npm run dev        # dev (add: npx electron-vite dev -w to hot-restart main)
npm run build      # production bundles into out/
npm run smoke      # end-to-end API test (needs the app running)
```

First launch creates the vault at `Documents/OzmoSpecVault` (change in Settings), seeds a small
self-describing starter project, and starts the agent API on **http://127.0.0.1:4820**.

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
src/main      electron main: sqlite (sql.js), vault fs + watcher, services,
              method registry, REST API + SSE, IPC
src/renderer  react ui: force-graph canvas, lists, warp boards, review rooms,
              activity feed, inspector with markdown editor
scripts       smoke.mjs — full API exercise
```

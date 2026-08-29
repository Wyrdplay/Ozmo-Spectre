/* The THIN CLIENT's surface, end to end against a running Ozmo Spectre.
   (npm run dev first; npm run build:web for the served-bundle checks.)

   smoke.mjs covers the agent API — the resource routes an agent reads about in
   /llms.txt. This covers the three things a NETWORK CLIENT needs that an agent
   never asks for, and that nothing else would notice breaking:

     1. POST /api/rpc  — the dispatcher, with IPC's envelope down to the nesting
     2. GET /api/events — event ids, Last-Event-ID replay, and an honest resync
     3. GET /app       — the bundle the core serves, with reachable assets
     4. the account gate — onboarding, refusal, and what leaks past it

   It leaves ONE artefact on the board under test: a pending account named
   "Smoke Probe". That is deliberate and bounded — see the gate section.

   Kept separate from smoke.mjs deliberately: that file is the agent surface and
   is already 1600 lines. This one answers "can a browser be a first-class
   client", which is a different question with a different failure mode. */

const BASE = process.env.OZMO_BASE ?? 'http://127.0.0.1:4820'
const H = { 'Content-Type': 'application/json', 'X-Actor': 'smoke-client' }

let failures = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const rpc = async (method, payload, token) => {
  const headers = token ? { ...H, 'X-Ozmo-Session': token } : H
  const res = await fetch(`${BASE}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, payload }) })
  let json
  try {
    json = JSON.parse(await res.text())
  } catch {
    json = null
  }
  return { status: res.status, json }
}

console.log(`smoke-client → ${BASE}`)

// ---------------------------------------------------------------- dispatcher
{
  const info = await rpc('app.info')
  ok('rpc: app.info answers in the IPC envelope',
    info.status === 200 && info.json?.ok === true && typeof info.json?.data?.apiBase === 'string',
    JSON.stringify(info.json))

  const projects = await rpc('projects.list')
  ok('rpc: projects.list returns the board',
    projects.json?.ok === true && Array.isArray(projects.json.data) && projects.json.data.length > 0,
    JSON.stringify(projects.json).slice(0, 200))

  // The renderer's RpcError reads `error.message` / `error.status` / `error.data`.
  // REST's own error handler MERGES ApiError.data into the body instead; if this
  // route ever grew that shape, every client error message would become
  // "unknown error" and nothing would throw.
  const bad = await rpc('nodes.get', { id: 'nd_definitely_not_here' })
  ok('rpc: a failure carries a real HTTP status, not 200 with ok:false',
    bad.status >= 400 && bad.status < 500, `status ${bad.status}`)
  ok('rpc: the error envelope is IPC-shaped (ok:false + nested error.message/status)',
    bad.json?.ok === false && typeof bad.json?.error?.message === 'string' && typeof bad.json?.error?.status === 'number',
    JSON.stringify(bad.json))

  const unknown = await rpc('no.such.method')
  ok('rpc: an unknown method is a 404 that names it',
    unknown.status === 404 && /no\.such\.method/.test(unknown.json?.error?.message ?? ''),
    JSON.stringify(unknown.json))

  // Attribution still rides the header, exactly as the resource routes do.
  const focus = await rpc('ui.focus', { view: 'graph' })
  ok('rpc: a write verb goes through and is attributed', focus.json?.ok === true, JSON.stringify(focus.json))
}

// -------------------------------------------------------------- event stream
/** Read an SSE stream for `ms`, returning the raw frames. */
async function listen(ms, headers = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const frames = []
  try {
    const res = await fetch(`${BASE}/api/events`, { headers: { ...H, ...headers }, signal: ac.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        frames.push(buf.slice(0, i))
        buf = buf.slice(i + 2)
      }
    }
  } catch {
    /* the abort is how this ends */
  }
  clearTimeout(timer)
  return frames
}

const idOf = (frame) => {
  const line = frame.split('\n').find((l) => l.startsWith('id:'))
  return line ? Number(line.slice(3).trim()) : null
}
const dataOf = (frame) => {
  const line = frame.split('\n').find((l) => l.startsWith('data:'))
  if (!line) return null
  try {
    return JSON.parse(line.slice(5).trim())
  } catch {
    return null
  }
}

{
  // Listen, provoke two events, and see what the stream said about them.
  const listening = listen(2500)
  await new Promise((r) => setTimeout(r, 300))
  await rpc('ui.focus', { view: 'lists' })
  await rpc('ui.focus', { view: 'graph' })
  const frames = await listening

  const evented = frames.filter((f) => dataOf(f)?.type === 'ui.focus')
  ok('events: the stream delivers', evented.length >= 2, `${evented.length} ui.focus frames`)

  // ORDER MATTERS, and not for style. /llms.txt has pointed agents at this
  // stream for as long as it has existed, and the ten-line reader for it checks
  // the frame starts with `data: `. An id in front breaks every one of those
  // silently — connected, delivering, never parsed.
  ok('events: `data:` is still the first line of every frame',
    evented.every((f) => f.startsWith('data: ')), JSON.stringify(evented[0]?.slice(0, 60)))
  ok('events: every frame carries a monotonic id',
    evented.every((f) => Number.isFinite(idOf(f))) &&
      evented.every((f, i, a) => i === 0 || idOf(f) > idOf(a[i - 1])),
    JSON.stringify(evented.map(idOf)))

  const lastId = idOf(evented[evented.length - 1])

  // Replay: a client that dropped after `lastId - 1` must be handed the one it
  // missed. Over IPC this gap cannot happen; over wifi it is ordinary, and a
  // client that reconnects into silence shows a stale board with confidence.
  const prior = idOf(evented[evented.length - 2])
  const replayed = await listen(1200, { 'Last-Event-ID': String(prior) })
  const replayedIds = replayed.map(idOf).filter((n) => Number.isFinite(n))
  ok('events: Last-Event-ID replays the gap and nothing before it',
    replayedIds.includes(lastId) && replayedIds.every((n) => n > prior),
    JSON.stringify(replayedIds))

  // ...and when it cannot, it SAYS SO. A partial replay presented as a whole
  // one is the failure this exists to prevent.
  const far = await listen(1200, { 'Last-Event-ID': String(lastId + 100000) })
  ok('events: an id beyond the buffer answers resync, not silence',
    far.some((f) => f.startsWith('event: resync')), JSON.stringify(far.slice(0, 2)))
}

// ------------------------------------------------------------ served bundle
{
  const page = await fetch(`${BASE}/app`, { redirect: 'manual' })
  const html = page.status === 200 ? await page.text() : ''
  if (page.status === 503) {
    console.log('  – /app: no web build in this tree (npm run build:web) — skipping served-bundle checks')
  } else {
    ok('served client: GET /app is the page itself, not a redirect', page.status === 200, `status ${page.status}`)
    ok('served client: it is the WEB entry, not the electron one', html.includes('main.web') || html.includes('/app/assets/'),
      html.slice(0, 200))

    // A bundle built with the default base writes absolute `/assets/...`, which
    // under /app is a 404 — a blank page from a build that succeeded.
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/'))
    ok('served client: it references at least one asset', assets.length > 0, JSON.stringify(assets))
    const statuses = await Promise.all(assets.map(async (u) => (await fetch(BASE + u)).status))
    ok('served client: every referenced asset is reachable from the core',
      statuses.every((s) => s === 200), JSON.stringify(assets.map((u, i) => `${u} → ${statuses[i]}`)))
  }
}


// ------------------------------------------------------------------ the gate
/* Onboarding over the wire. The owner's verbs are NOT here on purpose — they
   are at-the-machine only, and smoke-accounts.mjs drives them directly. */
{
  const anon = await rpc('session.current')
  ok('gate: session.current answers without a session at all',
    anon.json?.ok === true && anon.json.data?.state === 'none', JSON.stringify(anon.json))

  // Every agent in the fleet is a caller with no session. If this is off, the
  // rest of this section is testing a different configuration and should say so.
  const carveOut = anon.json?.data?.agentsUnauthenticated === true
  const board = await rpc('projects.list')
  ok(carveOut
      ? 'gate: an agent with no session still reads the board (the carve-out is on)'
      : 'gate: with the carve-out off, an agent with no session is refused',
    carveOut ? board.json?.ok === true : board.json?.ok === false, JSON.stringify(board.json).slice(0, 160))

  // ONE fixed name, not a fresh one per run. Requesting a display name creates
  // an account on the board under test, and there is no delete verb — by
  // design, because a rejection that leaves no trace is a name that gets asked
  // for again unnoticed. A timestamped probe would therefore add a pending row
  // to the owner's People card every single run. A fixed one RESUMES the same
  // row, so this suite costs the board exactly one account, ever, which the
  // owner can reject once and be done with.
  const name = 'Smoke Probe'
  const asked = await rpc('session.request', { displayName: name })
  ok('gate: a newcomer is filed as pending and handed a token',
    asked.json?.data?.session?.state === 'pending' && typeof asked.json?.data?.token === 'string',
    JSON.stringify(asked.json).slice(0, 200))
  const token = asked.json?.data?.token

  const refused = await rpc('projects.list', undefined, token)
  ok('gate: a pending viewer gets NO board', refused.json?.ok === false && refused.status === 403, JSON.stringify(refused.json))
  ok('gate: and is told which state they are in, so the client can show a door not an error',
    refused.json?.error?.data?.accountState === 'pending', JSON.stringify(refused.json?.error))

  // app.info is open because a client cannot boot without it. That makes it the
  // one place board data could leak past the gate by accident.
  const info = await rpc('app.info', undefined, token)
  ok('gate: app.info is reachable while pending', info.json?.ok === true)
  ok('gate: but TRIMMED — no vault path, no owner name',
    info.json?.data?.vaultPath === '' && info.json?.data?.humanName === '', JSON.stringify(info.json?.data))

  // The stream is board data too, and it is the leak that is easiest to forget.
  const stream = await fetch(`${BASE}/api/events?session=${encodeURIComponent(token)}`)
  ok('gate: a pending viewer is refused the event stream', stream.status === 403, `status ${stream.status}`)
  try { await stream.body?.cancel() } catch { /* nothing to close */ }

  const owner = await rpc('accounts.list', undefined, token)
  ok('gate: deciding who is on the board is refused over the network', owner.json?.ok === false && owner.status === 403,
    JSON.stringify(owner.json))

  // A token that no longer resolves must be told apart from having no token at
  // all: one shows a sign-in screen, the other is an agent going about its day.
  const stale = await rpc('projects.list', undefined, 'not-a-real-token-at-all')
  ok('gate: a stale token is 401 and says to sign in again, rather than being read as an agent',
    stale.status === 401 && /sign in again/i.test(stale.json?.error?.message ?? ''), JSON.stringify(stale.json))

  const out = await rpc('session.signOut', { token }, token)
  ok('gate: sign out succeeds', out.json?.ok === true, JSON.stringify(out.json))
  const after = await rpc('projects.list', undefined, token)
  ok('gate: and the token is dead immediately', after.json?.ok === false, JSON.stringify(after.json).slice(0, 120))
}

console.log(failures === 0 ? '\nall client smoke checks passed ✓' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

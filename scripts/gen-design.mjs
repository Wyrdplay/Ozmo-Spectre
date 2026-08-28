/* DESIGN.md is not written by hand. It is generated from the Spectre board.
 *
 *   node scripts/gen-design.mjs        (npm run gen:design)
 *
 * WHY THIS EXISTS
 * The pillar "The Database Is Ground Truth" says markdown is how the spec LEAVES:
 * any node, any container, or the whole board renders to a document you can keep,
 * grep, or hand to someone who has never heard of this tool. A hand-maintained
 * DESIGN.md is a second copy of the board, and a second copy drifts — this file
 * has already been caught describing a four-category ship gate while the code had
 * five. Generating it deletes that failure mode instead of policing it.
 *
 * WHY IT CURATES INSTEAD OF DUMPING
 * `GET /api/projects/:id/document` will happily hand you all 283 nodes with every
 * body attached: ~235KB across 100+ chapters, most of it bugs, feedback, questions
 * and warps. That is a data dump, not a design document — the reader it is aimed at
 * (someone arriving at a public repo) would bounce off it. So this script picks the
 * node set and then decides, per layer, how much of each spec to show:
 *
 *   EXPANDED (full body)   pillar, principle, area, component
 *                          — the WHY, the WHERE and the HOW. Standing prose: it
 *                            describes what the system IS, and it is the part that
 *                            stops being true if you only read titles.
 *   EXCERPTED (lead only)  feature, instance
 *                          — the WHAT. Many, individually long, each already opening
 *                            with a summary section. The lead section is the gist;
 *                            the rest is acceptance criteria and implementation notes
 *                            that belong to whoever builds it, not to a first read.
 *   INDEXED (no body)      skill
 *                          — the METHOD. A skill body is an instruction manual written
 *                            for an agent to follow, not design prose about the app.
 *   EXCLUDED               idea, bug, flaw, threat, question, feedback, action, warp,
 *                          and anything flagged Pruned — the transient layers. A design
 *                          document is not a work log.
 *
 * Nothing is dropped in silence. Every exclusion above is counted from the live board
 * and printed in the document's header, every excerpt says how much it left behind, and
 * every node carries the id you need to pull its full spec with one call.
 *
 * DETERMINISM
 * Same board, same bytes — the file must not churn in git for no reason. The export API
 * is already deterministic (order is typeOrder → rank → title, link lines are sorted)
 * except for one line: it stamps today's date into its preamble. This script discards
 * that preamble and writes its own, which contains no clock reading.
 *
 * The node set is pulled LIVE from the graph. Nothing here is a hardcoded list of nodes,
 * so a node added to the board today is in the document after the next run.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.OZMO_BASE ?? 'http://127.0.0.1:4820'
const PROJECT = process.env.OZMO_PROJECT ?? 'pr_73a19765b0'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.OZMO_DESIGN_OUT ?? path.join(ROOT, 'DESIGN.md')

/** How much of each layer's spec the document shows. Order matters for the header. */
const EXPANDED = ['pillar', 'principle', 'area', 'component']
const EXCERPTED = ['feature', 'instance']
const INDEXED = ['skill']
const INCLUDED_TYPES = [...EXPANDED, ...EXCERPTED, ...INDEXED]

/** Why each omitted type is omitted — printed, so the document argues its own shape. */
const EXCLUDED_TYPES = {
  warp: 'a delivery schedule, not a design — it says when, and when goes stale',
  idea: 'non-binding sparks; explorable, never enforcing',
  bug: 'the implementation diverging from a correct spec — a work item',
  flaw: 'a design known to be wrong — tracked on the board until it is fixed',
  threat: 'an uncertainty endangering a plan — a risk register, not a design',
  question: 'an open unknown — the answer belongs in a spec once it exists',
  feedback: 'review notes on built work — the record of a conversation',
  action: 'a transient instruction, deleted when it is carried out'
}

const die = (msg) => {
  console.error(`gen-design: ${msg}`)
  process.exit(1)
}

const api = async (method, route, body) => {
  let res
  try {
    res = await fetch(BASE + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor': 'gen-design' },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    die(
      `cannot reach Ozmo Spectre at ${BASE} (${e.message}).\n` +
        '  DESIGN.md is generated from the live board — start the app (npm run dev) and re-run.'
    )
  }
  const text = await res.text()
  if (!res.ok) die(`${method} ${route} → ${res.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return die(`${method} ${route} returned non-JSON: ${text.slice(0, 200)}`)
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const isPruned = (n) => (n.flags ?? []).includes('Pruned')

/**
 * Split a rendered document into per-node sections.
 *
 * A section starts at a heading whose next couple of lines are the export's meta line
 * (`` `type` · `nd_...` ``) and runs to the next such heading. The blank lines and the
 * `---` rule that belong to the NEXT chapter sit at the tail of the previous section's
 * range, so they are held back and re-emitted verbatim: truncating a body must never
 * eat the separator that follows it.
 */
function sectionise(lines, byId) {
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i])
    if (!h) continue
    const meta = lines.slice(i + 1, i + 3).join('\n').match(/^`([a-z]+)`[^\n]*`(nd_[0-9a-f]+)`/m)
    if (!meta) continue
    if (!byId.has(meta[2])) continue
    heads.push({ start: i, level: h[1].length, id: meta[2] })
  }
  return heads.map((h, k) => {
    let end = k + 1 < heads.length ? heads[k + 1].start : lines.length
    // hold back trailing separator/blank lines (and the "Also in this document" rule)
    let tail = end
    while (tail > h.start + 1 && (lines[tail - 1].trim() === '' || lines[tail - 1].trim() === '---')) tail--
    return { ...h, end, bodyEnd: tail }
  })
}

/**
 * Where a node's own prose starts inside its section: past the heading, the meta line,
 * the `Also under:` cross-reference and the quoted relationship list.
 */
function bodyStart(lines, s) {
  let i = s.start + 1
  while (i < s.bodyEnd) {
    const l = lines[i]
    if (l.trim() === '' || l.startsWith('`') || l.startsWith('> -') || /^\*Also under:/.test(l)) i++
    else break
  }
  return i
}

/**
 * Cut a body down to its opening section.
 *
 * The export re-levels a body so its shallowest heading sits one below the node's, and
 * every spec in this vault opens the same way (`Summary`, then `Design`, then
 * `Acceptance`). So: find the body's own top heading level, and cut before the SECOND
 * heading at that level. A body with fewer than two such headings is already a lead and
 * is kept whole. Fenced code is skipped — a `# comment` in a shell block is not a heading.
 *
 * Returns the kept lines and how many sections were left on the board, so the document
 * can say so rather than presenting an excerpt as a whole spec.
 */
function leadSection(body) {
  const marks = []
  let fenced = false
  let top = 7
  for (let i = 0; i < body.length; i++) {
    if (/^\s*(```|~~~)/.test(body[i])) { fenced = !fenced; continue }
    if (fenced) continue
    const m = /^(#{1,6})\s+\S/.exec(body[i])
    if (!m) continue
    marks.push({ i, level: m[1].length })
    top = Math.min(top, m[1].length)
  }
  const atTop = marks.filter((m) => m.level === top)
  if (atTop.length < 2) return { kept: body, omitted: 0 }
  return { kept: body.slice(0, atTop[1].i), omitted: atTop.length - 1 }
}

async function main() {
  const project = await api('GET', `/api/projects/${PROJECT}`)
  const graph = await api('GET', `/api/projects/${PROJECT}/graph`)
  const nodes = graph.nodes.filter((n) => n.projectId === PROJECT)
  if (!nodes.length) die(`project ${PROJECT} has no nodes`)

  // --- the node set, pulled live. No node list is hardcoded anywhere in this script.
  const kept = nodes.filter((n) => INCLUDED_TYPES.includes(n.type) && !isPruned(n))
  const prunedFromKeptTypes = nodes.filter((n) => INCLUDED_TYPES.includes(n.type) && isPruned(n))
  const excludedByType = {}
  for (const n of nodes) {
    if (INCLUDED_TYPES.includes(n.type)) continue
    excludedByType[n.type] = (excludedByType[n.type] ?? 0) + 1
  }
  const countOf = (t) => kept.filter((n) => n.type === t).length

  // one call, one set: cross-references and "(not in this document)" markers are only
  // truthful if every node the reader can reach was scoped in the same request.
  const doc = await api('POST', `/api/projects/${PROJECT}/document?format=json&contents=0`, {
    nodeIds: kept.map((n) => n.id)
  })

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const lines = doc.markdown.split('\n')
  const sections = sectionise(lines, byId)
  if (sections.length !== doc.stats.nodes) {
    // the export renders every scoped node exactly once; if that stops being true the
    // rewrite below is operating on something it does not understand, so stop rather
    // than quietly publishing a document with a hole in it.
    die(`the export reports ${doc.stats.nodes} nodes but ${sections.length} sections were found`)
  }

  // --- rewrite: keep every heading, meta line and relationship list; trim the prose
  //     of the layers this document only summarises or indexes.
  const out = []
  let firstStart = sections.length ? sections[0].start : lines.length
  // walk back over the `---` rule that opens the first chapter, so it survives
  while (firstStart > 0 && (lines[firstStart - 1].trim() === '' || lines[firstStart - 1].trim() === '---')) firstStart--
  const preambleTail = lines.slice(firstStart, sections.length ? sections[0].start : lines.length)

  let excerpted = 0
  let indexed = 0
  let outwardLinks = 0
  for (let k = 0; k < sections.length; k++) {
    const s = sections[k]
    const node = byId.get(s.id)
    // Relationship lines to nodes the curation left out are dropped, not marked. The export
    // marks them `(not in this document)` because a partial export must not make a node look
    // unconnected — but here every one of them points into a layer this document has already
    // said, in its header, that it excludes, and 100+ dead ends is noise a first reader has to
    // wade through. They are counted and the count is printed; the edge is still on the board.
    const head = lines.slice(s.start, bodyStart(lines, s)).filter((l) => {
      if (l.startsWith('> - ') && l.includes('*(not in this document)*')) { outwardLinks++; return false }
      return true
    })
    const body = lines.slice(bodyStart(lines, s), s.bodyEnd)
    const tail = lines.slice(s.bodyEnd, s.end)
    out.push(...head)
    if (INDEXED.includes(node.type) && body.length) {
      indexed++
      out.push(`*Body not reproduced: a ${node.type} is an instruction an agent follows, not a description of this app. Fetch it by the id above.*`)
    } else if (EXCERPTED.includes(node.type) && body.length) {
      const { kept: lead, omitted } = leadSection(body)
      out.push(...lead)
      if (omitted) {
        excerpted++
        out.push(`*Lead section only — ${plural(omitted, 'further section')} in the full spec, fetched by the id above.*`)
      }
    } else {
      out.push(...body)
    }
    out.push(...tail)
  }

  // --- the header. Generated-file notice, the shape, and every omission with its count.
  const chapters = sections.filter((s) => s.level === 1).map((s) => byId.get(s.id))
  const h = []
  h.push('<!-- GENERATED FILE — DO NOT EDIT.')
  h.push('     Written by scripts/gen-design.mjs from the Spectre board. Edit the nodes, not this file. -->')
  h.push('')
  h.push(`# ${project.name} — Design`)
  h.push('')
  h.push('> **This document is generated.** It is the Spectre board, exported through the app\'s own')
  h.push('> markdown export and curated for a first read. Regenerate it with `npm run gen:design`')
  h.push('> (the app must be running). Anything you type into this file is lost on the next run —')
  h.push('> the source of truth is the board, and the board is the app.')
  h.push('')
  if (project.description) h.push(project.description, '')
  h.push(
    `${plural(kept.length, 'node')} — ` +
      INCLUDED_TYPES.filter((t) => countOf(t)).map((t) => plural(countOf(t), t)).join(' · ') +
      '.'
  )
  h.push('')
  h.push('## How to read this')
  h.push('')
  h.push('The board holds more than a design document should. This export is curated by layer, and')
  h.push('says what it did to each one:')
  h.push('')
  h.push(`- **In full** — ${EXPANDED.join(', ')}. The commitments, the geography and the architecture:`)
  h.push('  standing prose describing what the system *is*.')
  h.push(`- **Lead section only** — ${EXCERPTED.join(', ')}. Each spec opens with its summary; the`)
  h.push(`  acceptance criteria and build notes below it stay on the board. ${excerpted} spec${excerpted === 1 ? '' : 's'} ${excerpted === 1 ? 'is' : 'are'} cut here,`)
  h.push('  and each one says how much it left behind.')
  h.push(`- **Listed, not reproduced** — ${INDEXED.join(', ')}. ${indexed} of them: a skill body is an`)
  h.push('  instruction manual for an agent, not a description of this app.')
  h.push('')
  // built from what the board actually holds, not from the reasons table — a node type
  // added to the ontology tomorrow is excluded by default, and must still be declared here
  // rather than disappearing between a curation rule and a document that claims to be whole.
  const omissions = Object.entries(excludedByType)
    .map(([t, c]) => [t, c, EXCLUDED_TYPES[t] ?? 'not one of the layers this document reproduces'])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (omissions.length || prunedFromKeptTypes.length) {
    const total = omissions.reduce((a, [, c]) => a + c, 0) + prunedFromKeptTypes.length
    h.push(`**What is not here.** ${plural(total, 'node')} on the board ${total === 1 ? 'is' : 'are'} deliberately absent, because a design`)
    h.push('document is not a work log:')
    h.push('')
    for (const [t, c, why] of omissions) h.push(`- ${c} \`${t}\` ${c === 1 ? 'node' : 'nodes'} — ${why}`)
    if (prunedFromKeptTypes.length) {
      h.push(`- ${plural(prunedFromKeptTypes.length, 'pruned node')} of the types above — abandoned; the board keeps them, this does not`)
    }
    h.push('')
    if (outwardLinks) {
      h.push(`Relationship lines below name only nodes that are in this document. ${plural(outwardLinks, 'edge')} pointing`)
      h.push('into the layers above are not listed — they are still on the board.')
      h.push('')
    }
    h.push('Nodes marked `Done` **are** here: built work is still the design. So is unbuilt work —')
    h.push('read the `%` on a heading before assuming a section describes something that exists.')
    h.push('')
  }
  h.push('Every heading carries its node id. The whole spec behind any of them, or any node this')
  h.push('document leaves out, is one read away:')
  h.push('')
  h.push('```bash')
  h.push(`curl -s ${BASE}/api/nodes/<id>/document        # one node and everything under it`)
  h.push(`curl -s ${BASE}/api/projects/${PROJECT}/document   # the entire board, nothing curated`)
  h.push('```')
  h.push('')
  if (doc.stats.unplaced) {
    h.push(`> ${plural(doc.stats.unplaced, 'node')} could not be placed under a chapter and ${doc.stats.unplaced === 1 ? 'is' : 'are'} listed at the end.`)
    h.push('')
  }
  if (doc.stats.unknown) {
    h.push(`> ${plural(doc.stats.unknown, 'requested node')} could not be found on the board.`)
    h.push('')
  }
  h.push('## Contents')
  h.push('')
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section'
  for (const c of chapters) {
    const members = countMembers(sections, c.id)
    h.push(`- [${c.title}](#${slug(c.title)}) · \`${c.type}\`${members ? ` · ${plural(members, 'member')}` : ''}`)
  }
  h.push('')
  h.push('')
  h.push('Chapters are the areas — the product geography — plus anything the board has not placed in')
  h.push('one yet, which is why a few features and a component stand at the top level. Sub-headings are')
  h.push('not listed: there are too many to be navigation. Search the file, or ask the board.')

  const markdown = [...h, ...preambleTail, ...out].join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n'
  fs.writeFileSync(OUT, markdown, 'utf8')

  const kb = (Buffer.byteLength(markdown) / 1024).toFixed(1)
  console.log(`gen-design: ${path.relative(ROOT, OUT)} — ${kb}KB · ${kept.length} nodes · ${chapters.length} chapters`)
  console.log(`  full: ${EXPANDED.join(', ')} · excerpted: ${excerpted} · listed only: ${indexed}`)
  console.log(`  excluded: ${Object.entries(excludedByType).map(([t, c]) => `${c} ${t}`).join(', ') || 'nothing'}`)
}

/** Direct + nested sections rendered beneath a chapter, for the contents line. */
function countMembers(sections, chapterId) {
  const i = sections.findIndex((s) => s.id === chapterId)
  if (i < 0) return 0
  let n = 0
  for (let k = i + 1; k < sections.length && sections[k].level > sections[i].level; k++) n++
  return n
}

await main()

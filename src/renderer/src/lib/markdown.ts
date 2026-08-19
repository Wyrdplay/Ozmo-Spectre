import { marked } from 'marked'
import type { Tokens, TokenizerAndRendererExtension } from 'marked'
import DOMPurify from 'dompurify'
import type { HLJSApi } from 'highlight.js'
import '../markdown.css'

/* ────────────────────────────────────────────────────────────────────────────
   Obsidian-grade markdown pipeline.

   renderMarkdown(src)      – markdown → sanitized HTML (sync). Handles
                              wikilinks, ==highlight==, callouts, footnotes,
                              %%comments%%, task checkboxes (data-task="N"),
                              and marks ```mermaid fences as placeholder divs.
   hydrateMarkdown(el)      – async post-pass over a container whose innerHTML
                              was set from renderMarkdown: renders mermaid SVGs
                              (lazy import, dark theme) and syntax-highlights
                              code fences (lazy highlight.js).
   toggleTask(src, n)       – flips the Nth task marker in markdown SOURCE,
                              using the exact same line-classification walk the
                              renderer uses to number checkboxes, so DOM
                              data-task indices and source markers always map
                              one-to-one.

   Sanitization: DOMPurify runs LAST over the fully assembled HTML, so every
   transform above (including callout boxes and the footnote section) is
   sanitized. Mermaid source travels encodeURIComponent'd inside data-mermaid;
   mermaid itself runs with securityLevel "strict".
──────────────────────────────────────────────────────────────────────────── */

marked.setOptions({ gfm: true, breaks: false })

/* ── ==highlight== as a marked inline extension.
      Runs inside the tokenizer, so code spans and fences are naturally
      untouched (the codespan tokenizer consumes `…==…` before we ever see
      it, and fenced blocks never reach inline tokenization). */
const obsidianHighlight: TokenizerAndRendererExtension = {
  name: 'obsidianHighlight',
  level: 'inline',
  start(src: string): number | undefined {
    const i = src.indexOf('==')
    return i === -1 ? undefined : i
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const m = /^==([^\n=][^\n]*?)==/.exec(src)
    if (!m) return undefined
    const token: Tokens.Generic = { type: 'obsidianHighlight', raw: m[0], text: m[1], tokens: [] }
    token.tokens = this.lexer.inlineTokens(m[1])
    return token
  },
  renderer(token: Tokens.Generic): string {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* ── code fence renderer: mermaid fences become placeholder divs (hydrated
      later); everything else keeps a language-* class for highlight.js. The
      fallback <pre> inside the mermaid div means consumers that never hydrate
      (or a failed hydration) still show the source, never an empty blob. */
marked.use({
  extensions: [obsidianHighlight],
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
      if (language === 'mermaid') {
        return (
          `<div class="mermaid-block" data-mermaid="${encodeURIComponent(text)}">` +
          `<pre class="mermaid-src"><code>${escapeHtml(text)}</code></pre></div>\n`
        )
      }
      const cls = language ? ` class="language-${escapeHtml(language)}"` : ''
      return `<pre><code${cls}>${escapeHtml(text)}\n</code></pre>\n`
    }
  }
})

/* ── shared line classification ──────────────────────────────────────────────
   One walk used by BOTH the renderer (to inject checkbox HTML with sequential
   data-task indices) and toggleTask (to find the Nth marker in the source).
   Sharing it is what makes the preview↔source checkbox mapping airtight. */

const TASK_RE = /^((?:\s{0,3}>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[( |x|X)\](?= )/
const CALLOUT_LINE_RE = /^(\s{0,3}(?:>\s?)+)\[!([A-Za-z][\w-]*)\]([+-])?(?:[ \t]+(.*))?$/
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/
const FENCE_OPEN_RE = /^(\s*(?:>\s?)*\s*)(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^\s*(?:>\s?)*\s*(`{3,}|~{3,})\s*$/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s/
const WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g
const CALLOUT_KINDS = ['note', 'tip', 'info', 'warning', 'danger', 'quote']

interface LineVisit {
  raw: string
  /** %%comment%%-stripped text; equals raw inside fences / indented code */
  text: string
  /** line opens, closes or sits inside a fenced code block */
  fenced: boolean
  /** heuristic: 4+ space indented code outside any list context */
  indentedCode: boolean
  /** footnote definition line (outside fences) */
  def: RegExpExecArray | null
}

/** Strip Obsidian %%comments%% from one line, skipping inline code spans.
    Comments may span lines: `inComment` carries the open state across. */
function stripLineComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let out = ''
  let i = 0
  let inC = inComment
  while (i < line.length) {
    if (inC) {
      const close = line.indexOf('%%', i)
      if (close === -1) return { text: out, inComment: true }
      i = close + 2
      inC = false
      continue
    }
    const ch = line[i]
    if (ch === '`') {
      const ticks = /^`+/.exec(line.slice(i))![0]
      const end = line.indexOf(ticks, i + ticks.length)
      if (end === -1) {
        out += ticks
        i += ticks.length
        continue
      }
      out += line.slice(i, end + ticks.length)
      i = end + ticks.length
      continue
    }
    if (ch === '%' && line[i + 1] === '%') {
      inC = true
      i += 2
      continue
    }
    out += ch
    i++
  }
  return { text: out, inComment: inC }
}

/** Apply `fn` only to the parts of a line outside inline code spans. */
function mapOutsideCodeSpans(line: string, fn: (seg: string) => string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const tick = line.indexOf('`', i)
    if (tick === -1) {
      out += fn(line.slice(i))
      break
    }
    const ticks = /^`+/.exec(line.slice(tick))![0]
    const end = line.indexOf(ticks, tick + ticks.length)
    if (end === -1) {
      out += fn(line.slice(i, tick)) + ticks
      i = tick + ticks.length
      continue
    }
    out += fn(line.slice(i, tick)) + line.slice(tick, end + ticks.length)
    i = end + ticks.length
  }
  return out
}

function walkLines(source: string): LineVisit[] {
  const lines = source.split('\n')
  const visits: LineVisit[] = []
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let inComment = false
  let inList = false
  let inIndented = false
  let prevBlank = true
  for (const raw of lines) {
    if (inFence) {
      const close = FENCE_CLOSE_RE.exec(raw)
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) inFence = false
      visits.push({ raw, text: raw, fenced: true, indentedCode: false, def: null })
      prevBlank = false
      continue
    }
    if (inComment) {
      const r = stripLineComments(raw, true)
      inComment = r.inComment
      visits.push({ raw, text: r.text, fenced: false, indentedCode: false, def: null })
      if (r.text.trim() === '') prevBlank = true
      continue
    }
    const fo = FENCE_OPEN_RE.exec(raw)
    if (fo && !(fo[2][0] === '`' && fo[3].includes('`'))) {
      inFence = true
      fenceChar = fo[2][0]
      fenceLen = fo[2].length
      inIndented = false
      visits.push({ raw, text: raw, fenced: true, indentedCode: false, def: null })
      prevBlank = false
      continue
    }
    const r = stripLineComments(raw, false)
    inComment = r.inComment
    const text = r.text
    if (text.trim() === '') {
      visits.push({ raw, text, fenced: false, indentedCode: false, def: null })
      prevBlank = true
      continue
    }
    const content = text.replace(/^(\s{0,3}>\s?)+/, '')
    const indent = /^ */.exec(content)![0].length
    if (inIndented && indent >= 4) {
      visits.push({ raw, text: raw, fenced: false, indentedCode: true, def: null })
      prevBlank = false
      continue
    }
    inIndented = false
    if (indent >= 4 && !inList && prevBlank) {
      inIndented = true
      visits.push({ raw, text: raw, fenced: false, indentedCode: true, def: null })
      prevBlank = false
      continue
    }
    if (LIST_ITEM_RE.test(content)) inList = true
    else if (indent < 4 && prevBlank) inList = false
    visits.push({ raw, text, fenced: false, indentedCode: false, def: FOOTNOTE_DEF_RE.exec(text) })
    prevBlank = false
  }
  return visits
}

/* ── preprocessing: source → marked-ready markdown + footnote section ─────── */

const wikilinkReplacer = (_m: string, target: string, alias?: string): string => {
  const label = (alias ?? target).trim()
  return `<a href="#wikilink" data-wikilink="${encodeURIComponent(target.trim())}">${label}</a>`
}

function preprocess(source: string): { text: string; footnotes: string } {
  const cleaned = source.replace(/\u0007/g, '').replace(/\r\n?/g, '\n')
  const visits = walkLines(cleaned)

  const defs = new Map<string, string>()
  for (const v of visits) if (v.def && !defs.has(v.def[1])) defs.set(v.def[1], v.def[2])

  const refOrder: string[] = []
  const transformSeg = (seg: string): string => {
    let s = seg.replace(WIKILINK_RE, wikilinkReplacer)
    s = s.replace(FOOTNOTE_REF_RE, (m, id: string) => {
      if (!defs.has(id)) return m
      const first = !refOrder.includes(id)
      if (first) refOrder.push(id)
      const n = refOrder.indexOf(id) + 1
      const anchorId = first ? ` id="md-fnref-${n}"` : ''
      return `<sup class="md-fn-ref"><a${anchorId} href="#md-fn-${n}" data-fn="${n}">${n}</a></sup>`
    })
    return s
  }

  let taskIdx = 0
  const out: string[] = []
  for (const v of visits) {
    if (v.fenced || v.indentedCode) {
      out.push(v.raw)
      continue
    }
    if (v.def) continue // definition lines are lifted out; rendered as the footnote section
    const line = v.text
    const co = CALLOUT_LINE_RE.exec(line)
    if (co) {
      out.push(`${co[1]}\u0007callout:${co[2].toLowerCase()}:${co[3] ?? ''}:${encodeURIComponent(co[4] ?? '')}\u0007`)
      continue
    }
    const t = TASK_RE.exec(line)
    if (t) {
      const rest = line.slice(t[0].length)
      const checked = t[2] !== ' '
      const input = `<input type="checkbox" data-task="${taskIdx++}"${checked ? ' checked' : ''} disabled>`
      // a bare tag followed only by whitespace would trip marked's block-HTML
      // rule and swallow following lines — pad empty task text with a space entity
      out.push(t[1] + input + (rest.trim() ? mapOutsideCodeSpans(rest, transformSeg) : '&#32;'))
      continue
    }
    out.push(mapOutsideCodeSpans(line, transformSeg))
  }

  let footnotes = ''
  if (refOrder.length) {
    const items = refOrder
      .map((id, i) => {
        const n = i + 1
        const bodyMd = mapOutsideCodeSpans(defs.get(id) ?? '', (seg) => seg.replace(WIKILINK_RE, wikilinkReplacer))
        const body = marked.parseInline(bodyMd, { async: false }) as string
        return `<li id="md-fn-${n}">${body} <a href="#md-fnref-${n}" class="md-fn-back" data-fnref="${n}">↩</a></li>`
      })
      .join('')
    footnotes = `<section class="md-footnotes"><ol>${items}</ol></section>`
  }

  return { text: out.join('\n'), footnotes }
}

/* ── DOM pass: restructure callout blockquotes (runs pre-sanitize) ────────── */

const CALLOUT_SENTINEL_RE = /^\u0007callout:([a-z][\w-]*):([+-]?):([^\u0007]*)\u0007\n?/

function transformCallouts(root: ParentNode): void {
  for (const bq of Array.from(root.querySelectorAll('blockquote'))) {
    const firstP = bq.firstElementChild
    if (!firstP || firstP.tagName !== 'P') continue
    const tn = firstP.firstChild
    if (!tn || tn.nodeType !== 3) continue
    const m = CALLOUT_SENTINEL_RE.exec(tn.nodeValue ?? '')
    if (!m) continue
    const rawType = m[1]
    const kind = CALLOUT_KINDS.includes(rawType) ? rawType : 'note'
    const title = decodeURIComponent(m[3])
    tn.nodeValue = (tn.nodeValue ?? '').slice(m[0].length)
    if (!tn.nodeValue) tn.remove()
    if (!firstP.hasChildNodes()) firstP.remove()

    const box = document.createElement('div')
    box.className = `md-callout md-callout-${kind}`
    const head = document.createElement('div')
    head.className = 'md-callout-title'
    const icon = document.createElement('span')
    icon.className = 'md-callout-icon'
    head.appendChild(icon)
    const label = document.createElement('span')
    label.className = 'md-callout-label'
    if (title) label.innerHTML = marked.parseInline(title, { async: false }) as string
    else label.textContent = rawType.charAt(0).toUpperCase() + rawType.slice(1)
    head.appendChild(label)
    box.appendChild(head)

    const body = document.createElement('div')
    body.className = 'md-callout-content'
    while (bq.firstChild) body.appendChild(bq.firstChild)
    if (body.hasChildNodes()) box.appendChild(body)
    bq.replaceWith(box)
  }
}

function domTransform(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  transformCallouts(tpl.content)
  return tpl.innerHTML
}

const PURIFY_OPTS = {
  ADD_ATTR: ['data-wikilink', 'data-mermaid', 'data-task', 'data-fn', 'data-fnref']
}

/** Render markdown to sanitized HTML. `[[Wikilinks]]` become clickable node
    links; see the module header for the full Obsidian feature set. Mermaid and
    code-fence coloring need a follow-up `hydrateMarkdown(container)` call
    (markdown containers rendered without it still show plain code blocks). */
export function renderMarkdown(src: string): string {
  const { text, footnotes } = preprocess(src)
  let html = marked.parse(text, { async: false }) as string
  if (footnotes) html += footnotes
  html = domTransform(html)
  return DOMPurify.sanitize(html, PURIFY_OPTS)
}

/** Flip the Nth task marker (`- [ ]` ⇄ `- [x]`) in markdown source. N matches
    the data-task index the renderer emitted, because both sides classify lines
    with the same walkLines pass. Returns the new source, or null if no Nth
    task exists. */
export function toggleTask(source: string, index: number): string | null {
  const lines = source.split('\n')
  const visits = walkLines(source)
  let seen = 0
  for (let i = 0; i < visits.length; i++) {
    const v = visits[i]
    if (v.fenced || v.indentedCode || v.def) continue
    const m = TASK_RE.exec(v.text)
    if (!m) continue
    if (seen++ < index) continue
    const raw = lines[i]
    const flip = (s: string, bracket: number): string => {
      const rep = s[bracket + 1] === ' ' ? 'x' : ' '
      return s.slice(0, bracket + 1) + rep + s.slice(bracket + 2)
    }
    const rm = TASK_RE.exec(raw)
    if (rm) {
      lines[i] = flip(raw, rm[1].length)
    } else {
      // raw line differs from the comment-stripped text (e.g. a %%…%% before
      // the marker) — flip the first bracket we can find
      const b = /\[( |x|X)\]/.exec(raw)
      if (!b) return null
      lines[i] = flip(raw, b.index)
    }
    return lines.join('\n')
  }
  return null
}

/* ── hydration: mermaid + highlight.js (lazy, idempotent) ─────────────────── */

type MermaidApi = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidApi> | null = null
let mermaidSeq = 0

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        themeVariables: {
          darkMode: true,
          background: 'transparent',
          fontSize: '13px',
          primaryColor: '#202a3d',
          primaryTextColor: '#e6eaf2',
          primaryBorderColor: '#2e3850',
          secondaryColor: '#1a2130',
          tertiaryColor: '#141926',
          lineColor: '#8b94a7'
        }
      })
      return mermaid
    })
  }
  return mermaidPromise
}

function showMermaidError(block: HTMLElement, src: string, message: string): void {
  block.textContent = ''
  const pre = document.createElement('pre')
  pre.className = 'mermaid-src'
  const code = document.createElement('code')
  code.textContent = src
  pre.appendChild(code)
  block.appendChild(pre)
  const err = document.createElement('div')
  err.className = 'mermaid-error'
  err.textContent = `mermaid: ${message.split('\n')[0].slice(0, 200)}`
  block.appendChild(err)
  block.setAttribute('data-hydrated', 'error')
}

async function hydrateMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>('.mermaid-block:not([data-hydrated])')
  )
  if (!blocks.length) return
  for (const b of blocks) b.setAttribute('data-hydrated', 'pending') // claim before any await
  let mermaid: MermaidApi
  try {
    mermaid = await loadMermaid()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    for (const b of blocks) showMermaidError(b, decodeURIComponent(b.getAttribute('data-mermaid') ?? ''), msg)
    return
  }
  for (const block of blocks) {
    const src = decodeURIComponent(block.getAttribute('data-mermaid') ?? '')
    const id = `mmd-${++mermaidSeq}`
    try {
      const { svg } = await mermaid.render(id, src)
      block.innerHTML = svg
      block.setAttribute('data-hydrated', 'ok')
    } catch (err) {
      // mermaid can leave a temp node behind on parse failure — clean it up
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
      showMermaidError(block, src, err instanceof Error ? err.message : String(err))
    }
  }
}

let hljsPromise: Promise<HLJSApi> | null = null

function loadHljs(): Promise<HLJSApi> {
  if (!hljsPromise) {
    hljsPromise = import('highlight.js/lib/common').then((m) => m.default)
  }
  return hljsPromise
}

async function hydrateCodeBlocks(container: HTMLElement): Promise<void> {
  const codes = Array.from(container.querySelectorAll<HTMLElement>('pre > code:not([data-hl])')).filter(
    (c) => !c.closest('.mermaid-block')
  )
  if (!codes.length) return
  for (const c of codes) c.setAttribute('data-hl', 'pending') // claim before any await
  let hljs: HLJSApi
  try {
    hljs = await loadHljs()
  } catch {
    return
  }
  for (const code of codes) {
    const cls = Array.from(code.classList).find((c) => c.startsWith('language-'))
    const lang = cls?.slice('language-'.length).toLowerCase()
    const text = code.textContent ?? ''
    try {
      if (lang && hljs.getLanguage(lang)) {
        code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        code.setAttribute('data-hl', lang)
      } else if (text.trim()) {
        const auto = hljs.highlightAuto(text)
        if (auto.language && auto.relevance >= 5) {
          code.innerHTML = auto.value
          code.setAttribute('data-hl', `auto-${auto.language}`)
        } else {
          code.setAttribute('data-hl', 'plain')
        }
      } else {
        code.setAttribute('data-hl', 'plain')
      }
    } catch {
      code.setAttribute('data-hl', 'plain')
    }
  }
}

/** Post-render pass: render mermaid placeholder blocks to SVG and syntax-
    highlight code fences inside `container`. Idempotent — already-processed
    blocks are skipped, so calling it twice (or racing the auto-hydrate
    observer) is safe. Never throws: per-block errors degrade to the source
    code plus a one-line error. */
export async function hydrateMarkdown(container: HTMLElement): Promise<void> {
  await Promise.all([hydrateMermaidBlocks(container), hydrateCodeBlocks(container)])
}

/* ── auto-hydration: any .md container that gains un-hydrated blocks gets the
      same treatment, so consumers that only call renderMarkdown (review item
      bodies, warp goals) still get mermaid SVGs and code colors. Checkbox
      ENABLING is not done here — only MarkdownEditor, which can persist the
      toggle, removes the disabled attribute. */
let autoHydrateStarted = false

function startAutoHydrate(): void {
  if (autoHydrateStarted || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  autoHydrateStarted = true
  let scheduled = false
  const scan = (): void => {
    scheduled = false
    document.querySelectorAll<HTMLElement>('.md').forEach((el) => {
      if (el.querySelector('.mermaid-block:not([data-hydrated]), pre > code:not([data-hl])')) {
        void hydrateMarkdown(el)
      }
    })
  }
  const observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(scan)
  })
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
}

startAutoHydrate()

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

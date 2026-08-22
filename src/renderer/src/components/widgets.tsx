import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  WARP_STAGE_META, orderedNodeTypes, relStyle, typeStyle,
  type EdgeType, type EdgeTypeMeta, type FlagRule, type NodeType, type NodeTypeMeta, type SpecNode, type WarpStage
} from '@shared/types'
import { UNFLAGGED, UNTAGGED, mutateSettings, useStore, type FilterSectionId } from '@/store'

// ---------------------------------------------------------------------------
// Merged type/relationship styles — settings.styleOverrides applied over the
// shipped NODE_TYPES/EDGE_TYPES defaults. Renderer code reads visuals through
// THESE (or typeStyle/relStyle directly), never the base tables.

/** Merged node-type meta lookup, live against settings.styleOverrides. */
export function useTypeStyles(): (t: NodeType) => NodeTypeMeta {
  const overrides = useStore((s) => s.settings?.styleOverrides)
  return useMemo(() => (t: NodeType) => typeStyle(t, overrides), [overrides])
}

/** Merged relationship meta lookup (colour overrides), live against settings. */
export function useRelStyles(): (t: EdgeType) => EdgeTypeMeta {
  const overrides = useStore((s) => s.settings?.styleOverrides)
  return useMemo(() => (t: EdgeType) => relStyle(t, overrides), [overrides])
}

/** Node types in display order — settings.typeOrder over NODE_TYPE_ORDER. */
export function useOrderedTypes(): NodeType[] {
  const typeOrder = useStore((s) => s.settings?.typeOrder)
  return useMemo(() => orderedNodeTypes(typeOrder), [typeOrder])
}

export function TypeDot({ type, size = 9 }: { type: NodeType; size?: number }): React.JSX.Element {
  const styleOf = useTypeStyles()
  return <span className="type-dot" style={{ background: styleOf(type).color, width: size, height: size }} />
}

export function TypeChip({ type }: { type: NodeType }): React.JSX.Element {
  const meta = useTypeStyles()(type)
  return (
    <span className="chip" style={{ background: meta.color + '22', color: meta.color, borderColor: meta.color + '44' }}>
      {meta.label}
    </span>
  )
}

/** Plain colored chip — review/process statuses (review items keep their own status field). */
export function StatusChip({ status, color }: { status: string; color?: string }): React.JSX.Element {
  const c = color ?? '#8b94a7'
  return (
    <span className="chip" style={{ background: c + '1c', color: c, borderColor: c + '3a' }}>
      {status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Flags — composable highlight rules from Settings. The server computes which
// rules fire per node (node.flags = rule names); these helpers turn that into
// visuals: ring → colored left edge on rows/cards (dashed ring on canvas),
// dim → the done look, badge → named chip (dot on canvas).

export const FLAG_RING_FALLBACK = '#f87171'
export const FLAG_BADGE_FALLBACK = '#8b94a7'

/** Flag rules from settings, keyed by rule name (what node.flags carries). */
export function useFlagRules(): Map<string, FlagRule> {
  const flags = useStore((s) => s.settings?.flags)
  return useMemo(() => new Map((flags ?? []).map((f) => [f.name, f])), [flags])
}

export interface FlagDecor {
  /** first ring rule's color, if any ring rule fired */
  ringColor: string | null
  dim: boolean
  badges: FlagRule[]
  /** every fired rule name — tooltip fodder */
  names: string[]
}

/**
 * `undim` (rule names, from undimFlagNames): a node matching any actively-filtered
 * dim-treatment rule renders full-strength — the user filtered for it to SEE it.
 */
export function flagDecor(nodeFlags: string[] | undefined, rules: Map<string, FlagRule>, undim?: Set<string>): FlagDecor {
  const decor: FlagDecor = { ringColor: null, dim: false, badges: [], names: [] }
  let undimmed = false
  for (const name of nodeFlags ?? []) {
    const r = rules.get(name)
    if (!r) continue
    decor.names.push(r.name)
    if (undim?.has(r.name)) undimmed = true
    if (r.treatment === 'ring' && !decor.ringColor) decor.ringColor = r.color ?? FLAG_RING_FALLBACK
    else if (r.treatment === 'dim') decor.dim = true
    else if (r.treatment === 'badge') decor.badges.push(r)
  }
  if (undimmed) decor.dim = false
  return decor
}

// ── flag-rule filtering ─────────────────────────────────────────────────────
// The store keeps flagFilters as rule IDS (stable across renames); node.flags
// carries rule NAMES — these helpers do the id→rule→name join against settings.

/** Rule NAMES whose nodes are hidden, joined from the stored rule ids, plus the
 *  UNFLAGGED bucket when unflagged nodes are hidden too. Empty = nothing hidden. */
export function hiddenFlagNames(hiddenFlags: string[], rules: FlagRule[] | undefined): Set<string> {
  const names = new Set<string>()
  for (const r of rules ?? []) if (hiddenFlags.includes(r.id)) names.add(r.name)
  if (hiddenFlags.includes(UNFLAGGED)) names.add(UNFLAGGED)
  return names
}

/** Dim-treatment rules whose matches should render at full strength: a dim rule
 *  that is the ONLY flag bucket left visible. Soloing "Done" is a request to
 *  READ the finished work, and dimming every node on an otherwise empty screen
 *  serves nothing. Any other combination keeps dim meaning what it always did. */
export function undimFlagNames(hiddenFlags: string[], rules: FlagRule[] | undefined): Set<string> {
  const names = new Set<string>()
  const buckets = [...(rules ?? []).map((r) => r.id), UNFLAGGED]
  for (const r of rules ?? []) {
    if (r.treatment !== 'dim' || hiddenFlags.includes(r.id)) continue
    if (buckets.every((b) => b === r.id || hiddenFlags.includes(b))) names.add(r.name)
  }
  return names
}

/**
 * SUBTRACTIVE, like the type chips: a node is hidden when ANY bucket it belongs
 * to is hidden. Carrying a visible flag does not rescue it — subtraction is the
 * more specific instruction, and a node reappearing because it happens to also
 * be Blocked is the surprising outcome, not the useful one.
 *
 * A node with no flags belongs to the UNFLAGGED bucket, so "hide everything
 * except Done" can actually empty the screen.
 */
export function nodeMatchesFlagFilter(nodeFlags: string[] | undefined, hidden: Set<string>): boolean {
  if (!hidden.size) return true
  const flags = nodeFlags ?? []
  if (!flags.length) return !hidden.has(UNFLAGGED)
  return !flags.some((f) => hidden.has(f))
}

/** The same subtraction one level below the flags (flags are the curated face of
 *  tags; these are the vocabulary itself). Untagged nodes are their own bucket. */
export function nodeMatchesTagFilter(nodeTags: string[] | undefined, hidden: Set<string>): boolean {
  if (!hidden.size) return true
  const tags = nodeTags ?? []
  if (!tags.length) return !hidden.has(UNTAGGED)
  return !tags.some((t) => hidden.has(t))
}

/** Colorless (dim-treatment) rules light up in this neutral bright (--text). */
export const FLAG_FILTER_NEUTRAL = '#e6eaf2'

/** Move list[from] so it lands at display index `to` (indices over the ORIGINAL list; to may be list.length). */
export function moveByIndex<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, item)
  return next
}

/**
 * Flag-rule filter chips — one per settings rule (settings order) with a live
 * project-wide count of nodes carrying that flag. Count 0: greyed + inert.
 * Count ≥1: lit in the rule's color. Click toggles the filter in the store;
 * ctrl/cmd-click solos (consistent with the type chips). A chip that is
 * actively filtered stays clickable even at count 0 so it can be deselected.
 * `reorderable` (graph toolbar): chips drag-to-reorder in place, persisting the
 * settings flags array order itself — rule order drives evaluation everywhere.
 */
export function FlagFilterChips({ reorderable }: { reorderable?: boolean }): React.JSX.Element | null {
  const rules = useStore((s) => s.settings?.flags)
  const nodes = useStore((s) => s.graph.nodes)
  const hiddenFlags = useStore((s) => s.hiddenFlags)
  const toggleFlagFilter = useStore((s) => s.toggleFlagFilter)
  const soloFlagFilter = useStore((s) => s.soloFlagFilter)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const n of nodes) for (const f of n.flags ?? []) c.set(f, (c.get(f) ?? 0) + 1)
    c.set(UNFLAGGED, nodes.filter((n) => !(n.flags ?? []).length).length)
    return c
  }, [nodes])
  if (!rules?.length) return null

  const commitDrop = (): void => {
    const from = dragId ? rules.findIndex((r) => r.id === dragId) : -1
    setDragId(null)
    setDropIdx(null)
    if (from < 0 || dropIdx == null) return
    const next = moveByIndex(rules, from, dropIdx)
    if (next.every((r, i) => r.id === rules[i].id)) return
    // same autosave channel as the Settings cards: optimistic, flushed on drop,
    // pending-safe against concurrent settings.updated events
    mutateSettings({ flags: next }, { flush: true })
  }

  const canDrag = !!reorderable && rules.length > 1
  return (
    <span
      className="flag-filter-chips"
      onDragOver={(e) => { if (dragId) e.preventDefault() }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); commitDrop() } }}
    >
      {rules.map((r, i) => {
        const count = counts.get(r.name) ?? 0
        const hidden = hiddenFlags.includes(r.id)
        const inert = count === 0 && !hidden
        const c = r.color ?? FLAG_FILTER_NEUTRAL
        return (
          <button
            key={r.id}
            className={[
              'filter-chip',
              inert ? 'off inert' : '',
              hidden ? 'off' : '',
              dragId === r.id ? 'dragging' : '',
              dragId && dropIdx === i ? 'drop-left' : '',
              dragId && i === rules.length - 1 && dropIdx === rules.length ? 'drop-right' : ''
            ].filter(Boolean).join(' ')}
            style={inert ? undefined : { color: c, background: c + '1a' }}
            draggable={canDrag}
            onDragStart={(e) => {
              if (!canDrag) return
              setDragId(r.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => { setDragId(null); setDropIdx(null) }}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              setDropIdx(e.clientX < rect.left + rect.width / 2 ? i : i + 1)
            }}
            onClick={(e) => {
              if (inert) return
              if (e.ctrlKey || e.metaKey) soloFlagFilter(r.id)
              else toggleFlagFilter(r.id)
            }}
            title={`${hidden ? 'show' : 'hide'} ${r.name} nodes (ctrl-click to show only these${canDrag ? ' · drag to reorder' : ''})`}
          >
            {r.name} {count ? `· ${count}` : ''}
          </button>
        )
      })}
      {/* the absence is a bucket too, or "show only Done" would quietly leave every
          unflagged node on screen — and hiding it is the fastest way to see just
          the nodes the flag rules have something to say about */}
      {(() => {
        const count = counts.get(UNFLAGGED) ?? 0
        const hidden = hiddenFlags.includes(UNFLAGGED)
        if (!count && !hidden) return null
        return (
          <button
            className={['filter-chip', hidden ? 'off' : ''].filter(Boolean).join(' ')}
            style={{ color: FLAG_FILTER_NEUTRAL, background: FLAG_FILTER_NEUTRAL + '1a' }}
            onClick={(e) => (e.ctrlKey || e.metaKey ? soloFlagFilter(UNFLAGGED) : toggleFlagFilter(UNFLAGGED))}
            title={`${hidden ? 'show' : 'hide'} nodes carrying no flag (ctrl-click to show only these)`}
          >
            unflagged {count ? `· ${count}` : ''}
          </button>
        )
      })()}
    </span>
  )
}

/** Raw tag chips shown before the "more" expander. A 200-tag project must not
 *  bury the canvas under its own vocabulary — the long tail hides behind one click. */
export const TAG_CHIP_CAP = 20

/**
 * Raw tag filter chips — the TAGS section's second row, under the flag chips
 * (flags are the curated face of tags; this is the vocabulary itself). Every
 * distinct tag in the project with its live count, ordered by count desc then
 * alphabetically, capped at TAG_CHIP_CAP behind a "+N more" expander. Click
 * toggles, ctrl/cmd-click solos — the flag chips' semantics exactly. An ACTIVE
 * tag always renders even when it falls past the cap: a filter you cannot see
 * is a filter you cannot switch off.
 */
export function TagFilterChips(): React.JSX.Element | null {
  const nodes = useStore((s) => s.graph.nodes)
  const hiddenTags = useStore((s) => s.hiddenTags)
  const toggleTagFilter = useStore((s) => s.toggleTagFilter)
  const soloTagFilter = useStore((s) => s.soloTagFilter)
  const [expanded, setExpanded] = useState(false)
  const ranked = useMemo(() => {
    const c = new Map<string, number>()
    for (const n of nodes) for (const t of n.tags ?? []) c.set(t, (c.get(t) ?? 0) + 1)
    return [...c.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [nodes])
  if (!ranked.length) return null

  const head = expanded ? ranked : ranked.slice(0, TAG_CHIP_CAP)
  const tail = expanded ? [] : ranked.slice(TAG_CHIP_CAP)
  // a HIDDEN tag always renders even past the cap: a filter you cannot see is a
  // filter you cannot switch off, and now that hiding empties the view it matters more
  const shown = [...head, ...tail.filter((r) => hiddenTags.includes(r.tag))]
  const buried = tail.filter((r) => !hiddenTags.includes(r.tag)).length
  const untagged = nodes.filter((n) => !(n.tags ?? []).length).length
  const untaggedHidden = hiddenTags.includes(UNTAGGED)

  return (
    <span className="tag-filter-chips">
      {shown.map(({ tag, count }) => {
        const hidden = hiddenTags.includes(tag)
        return (
          <button
            key={tag}
            className={`filter-chip tag ${hidden ? 'off' : ''}`}
            onClick={(e) => (e.ctrlKey || e.metaKey ? soloTagFilter(tag) : toggleTagFilter(tag))}
            title={`${hidden ? 'show' : 'hide'} nodes tagged "${tag}" (ctrl-click to show only these)`}
          >
            {tag} · {count}
          </button>
        )
      })}
      {(untagged > 0 || untaggedHidden) && (
        <button
          className={`filter-chip tag ${untaggedHidden ? 'off' : ''}`}
          onClick={(e) => (e.ctrlKey || e.metaKey ? soloTagFilter(UNTAGGED) : toggleTagFilter(UNTAGGED))}
          title={`${untaggedHidden ? 'show' : 'hide'} nodes carrying no tag (ctrl-click to show only these)`}
        >
          untagged · {untagged}
        </button>
      )}
      {buried > 0 && (
        <button className="filter-chip more" title={`show the remaining ${buried} tags`} onClick={() => setExpanded(true)}>
          +{buried} more…
        </button>
      )}
      {expanded && ranked.length > TAG_CHIP_CAP && (
        <button className="filter-chip more" title={`back to the top ${TAG_CHIP_CAP} tags`} onClick={() => setExpanded(false)}>
          less
        </button>
      )}
    </span>
  )
}

/**
 * One labelled, collapsible section of the graph filter bar. Collapsed renders
 * the header alone — so `count` (the section's ACTIVE filters) rides the header
 * in both states: a folded section can never hide a live filter. `onDragOver`/
 * `onDrop` land on the section box for the chip-reorder drop target.
 */
export function FilterSection({ id, label, count, hint, onDragOver, onDrop, children }: {
  id: FilterSectionId
  label: string
  /** filters currently constraining the view from this section; 0 renders no badge */
  count: number
  hint: string
  onDragOver?: React.DragEventHandler<HTMLDivElement>
  onDrop?: React.DragEventHandler<HTMLDivElement>
  children: React.ReactNode
}): React.JSX.Element {
  const collapsed = useStore((s) => s.collapsedFilterSections.includes(id))
  const toggleFilterSection = useStore((s) => s.toggleFilterSection)
  return (
    <div className={`filter-section ${collapsed ? 'collapsed' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
      <button
        className="filter-section-head"
        onClick={() => toggleFilterSection(id)}
        title={`${hint} — click to ${collapsed ? 'show' : 'hide'}`}
      >
        <span className="chev">{collapsed ? '▸' : '▾'}</span>
        <span className="label">{label}</span>
        {count > 0 && (
          <span className="active-count" title={`${count} active filter${count === 1 ? '' : 's'} in this section`}>
            {count}
          </span>
        )}
      </button>
      {!collapsed && <div className="filter-section-body">{children}</div>}
    </div>
  )
}

/** Row/card style for fired ring rules (colored left edge) — spread into style. */
export function flagRowStyle(decor: FlagDecor): React.CSSProperties | undefined {
  return decor.ringColor ? { boxShadow: `inset 3px 0 0 ${decor.ringColor}` } : undefined
}

/**
 * Chips for a node's fired flag rules. Default: badge-treatment rules only
 * (ring shows as a colored edge, dim as opacity). `all` renders every fired
 * rule — used where naming the state matters (inspector).
 */
export function FlagChips({ flags, all }: { flags?: string[]; all?: boolean }): React.JSX.Element | null {
  const rules = useFlagRules()
  const fired = (flags ?? []).map((n) => rules.get(n)).filter((r): r is FlagRule => !!r)
  const shown = all ? fired : fired.filter((r) => r.treatment === 'badge')
  if (!shown.length) return null
  return (
    <span className="flag-chips">
      {shown.map((r) => {
        const c = r.color ?? (r.treatment === 'ring' ? FLAG_RING_FALLBACK : FLAG_BADGE_FALLBACK)
        return (
          <span key={r.id} className="chip" title={`flag: ${r.name}`} style={{ background: c + '1c', color: c, borderColor: c + '3a' }}>
            {r.name}
          </span>
        )
      })}
    </span>
  )
}

/** Warp stage as a coloured chip (warps only — stage is null on other types). */
export function StageChip({ stage }: { stage: string | null }): React.JSX.Element {
  const meta = WARP_STAGE_META[(stage ?? 'concept') as WarpStage] ?? WARP_STAGE_META.concept
  return (
    <span className="chip" style={{ background: meta.color + '1c', color: meta.color, borderColor: meta.color + '3a' }}>
      {meta.label}
    </span>
  )
}

/** Clipboard write + a transient `copied` flag for the "copied ✓" flash (auto-clears). */
export function useCopyFlash(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = (text: string): void => {
    navigator.clipboard.writeText(text).catch(() => undefined)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1200)
  }
  return { copied, copy }
}

/** Quiet mono chip showing an id — click copies it, flashes "copied ✓". */
export function IdChip({ id, short }: { id: string; short?: boolean }): React.JSX.Element {
  const { copied, copy } = useCopyFlash()
  return (
    <button
      className={`id-chip ${copied ? 'copied' : ''}`}
      title={`click to copy the id — ${id}`}
      onClick={(e) => { e.stopPropagation(); copy(id) }}
    >
      {copied ? 'copied ✓' : short ? id.replace(/^nd_/, '') : id}
    </button>
  )
}

/**
 * The handoff pair: the id chip plus "copy the API URL for this node".
 *
 * The review room is where a human finds a problem and an agent fixes it, so
 * every row has to be quotable — an id to paste into a prompt, and the address
 * an agent can GET without being told the shape of the API (faykarta: "Cannot
 * copy ticket ids on Review page" / "Feedback doesnt have a link id or address
 * that I can copy and paste?"). Same IdChip the graph inspector uses, so the
 * gesture is identical wherever an id appears.
 */
export function IdAndUrl({ id, short }: { id: string; short?: boolean }): React.JSX.Element {
  const info = useStore((s) => s.info)
  const { copied, copy } = useCopyFlash()
  const url = `${info?.apiBase ?? 'http://127.0.0.1:4820'}/api/nodes/${id}`
  return (
    <span className="id-and-url">
      <IdChip id={id} short={short} />
      <button
        className={`id-chip url ${copied ? 'copied' : ''}`}
        title={`click to copy the API URL — ${url}`}
        onClick={(e) => { e.stopPropagation(); copy(url) }}
      >
        {copied ? 'copied ✓' : '⧉ url'}
      </button>
    </span>
  )
}

const ACTOR_COLORS = ['#38bdf8', '#4ade80', '#facc15', '#f472b6', '#c084fc', '#fb923c', '#5eead4']
export function actorColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return ACTOR_COLORS[h % ACTOR_COLORS.length]
}

export function ActorBadge({ name }: { name: string }): React.JSX.Element {
  const c = actorColor(name)
  return (
    <span className="actor" style={{ color: c }}>
      <span className="avatar" style={{ background: c }}>{name.slice(0, 1).toUpperCase()}</span>
      {name}
    </span>
  )
}

export function ProgressBar({ value, color }: { value: number; color?: string }): React.JSX.Element {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  )
}

export function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    const t = draft.trim().toLowerCase()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }
  return (
    <div className="tags-editor input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          <button onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)) }}>×</button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={tags.length ? '' : 'add tags…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
          if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
        }}
        onBlur={commit}
      />
    </div>
  )
}

export function Modal({ children, onClose, width }: { children: React.ReactNode; onClose: () => void; width?: number }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined}>{children}</div>
    </div>
  )
}

export function Confirm({ title, body, confirmLabel = 'Delete', onConfirm, onClose }: {
  title: string; body: string; confirmLabel?: string; onConfirm: () => void; onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose}>
      <h2>{title}</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>{body}</div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={() => { onConfirm(); onClose() }}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}

/** Search-select over the current project's nodes. */
export function NodePicker({ placeholder, exclude, filter, onPick, autoFocus }: {
  placeholder?: string
  exclude?: Set<string>
  filter?: (n: SpecNode) => boolean
  onPick: (n: SpecNode) => void
  autoFocus?: boolean
}): React.JSX.Element {
  const nodes = useStore((s) => s.graph.nodes)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const matches = nodes
    .filter((n) => !exclude?.has(n.id))
    .filter((n) => !filter || filter(n))
    .filter((n) => !q || n.title.toLowerCase().includes(q.toLowerCase()) || n.tags.some((t) => t.includes(q.toLowerCase())))
    .slice(0, 8)
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        className="input"
        placeholder={placeholder ?? 'search nodes…'}
        value={q}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
      />
      {open && matches.length > 0 && (
        <div className="ctx-menu" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 50 }}>
          {matches.map((n) => (
            <button key={n.id} onClick={() => { onPick(n); setQ(''); setOpen(false) }}>
              <TypeDot type={n.type} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.msg}
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => { e.stopPropagation(); t.action!.run(); dismiss(t.id) }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

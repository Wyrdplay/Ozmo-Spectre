import React, { useEffect, useState } from 'react'
import { mutateSettings, overlaySettings, useStore } from '@/store'
import { RpcError, rpc } from '@/api'
import { Confirm, moveByIndex } from './widgets'
import {
  EDGE_TYPES, INNER_TEXT_GLYPHS, NODE_SHAPES, NODE_TYPES, RELATIONSHIP_TYPES, WARP_STAGES, WARP_STAGE_META,
  defaultFlags, isTextGlyph, newId,
  orderedNodeTypes, relStyle, typeStyle,
  type AppSettings, type EdgeType, type FlagCondition, type FlagRule, type FlagTreatment, type InnerGlyph,
  type NodeFill, type NodeShape, type NodeStyleOverride, type NodeType, type NodeTypeMeta, type Project,
  type SkillTarget, type SkillTargetConfig, type StyleOverrides,
  type WarpStage
} from '@shared/types'
import { INNER_GLYPH_RATIO, TEXT_GLYPH_FONT_RATIO, shapeGeometry, type ShapeGeom } from '@shared/shapes'

/** The explicit-Save slice — the relaunch-flavoured settings. Everything else
 *  on this page (appearance, connection colours, flags) autosaves on change
 *  through mutateSettings and derives straight from store settings. */
interface SaveForm {
  vaultPath: string
  apiPort: number
  humanName: string
}
const pickForm = (s: AppSettings | null): SaveForm | null =>
  s ? { vaultPath: s.vaultPath, apiPort: s.apiPort, humanName: s.humanName } : null

export function SettingsView(): React.JSX.Element {
  const info = useStore((s) => s.info)
  const settings = useStore((s) => s.settings)
  const projects = useStore((s) => s.projects)
  const projectId = useStore((s) => s.projectId)
  const toast = useStore((s) => s.toast)
  const [form, setForm] = useState<SaveForm | null>(() => pickForm(settings))
  const [needsRelaunch, setNeedsRelaunch] = useState(false)
  const [confirmDelProject, setConfirmDelProject] = useState(false)
  const [copied, setCopied] = useState(false)

  // re-sync only when the UPSTREAM values of THESE fields change — a
  // settings.updated for flags/styles (agent PATCH, autosave echo) must not
  // clobber an in-progress vault-path/port/name edit
  useEffect(() => {
    setForm(pickForm(useStore.getState().settings))
  }, [settings?.vaultPath, settings?.apiPort, settings?.humanName])

  if (!form || !settings) return <div className="empty">loading…</div>

  const save = async (): Promise<void> => {
    try {
      // ONLY the explicit-Save fields go over the wire — the other cards have
      // already persisted themselves on change, and a patch this narrow can
      // never null out styleOverrides/typeOrder/flags (top-level merge)
      const res = await rpc<{ settings: AppSettings; relaunchRequired: boolean }>('settings.update', { ...form })
      useStore.setState({ settings: overlaySettings(res.settings) })
      if (res.relaunchRequired) setNeedsRelaunch(true)
      else toast('settings saved', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const project = projects.find((p) => p.id === projectId)
  const apiBase = info ? `http://127.0.0.1:${info.port}` : ''

  return (
    <>
      <div className="view-header">
        <h1>Settings</h1>
      </div>
      <div className="view-body">
        <div className="settings">
          <div className="settings-card">
            <h2>Agent API</h2>
            <div className="api-url-row">
              <code style={{ fontSize: 13 }}>{apiBase}</code>
              <button
                className="btn sm"
                onClick={() => {
                  navigator.clipboard.writeText(apiBase)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                }}
              >
                {copied ? 'copied ✓' : 'copy'}
              </button>
            </div>
            <div className="hint">
              Agents learn the whole surface from <code>{apiBase}/llms.txt</code> — node types, workflow,
              review process, curl recipes. They should send <code>X-Actor: their-name</code> so their work is
              attributed. Live event stream at <code>/api/events</code>. Bound to localhost only.
            </div>
            <div className="field">
              <label>API port (relaunch to apply)</label>
              <input
                className="input"
                style={{ maxWidth: 140 }}
                type="number"
                value={form.apiPort}
                onChange={(e) => setForm({ ...form, apiPort: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="settings-card">
            <h2>Vault</h2>
            <div className="hint">
              Spec markdown lives here — point Obsidian at it. The database sits in <code>.ozmo/</code> inside.
              Changing the vault re-homes the app on relaunch (existing files are not moved).
            </div>
            <div className="api-url-row">
              <input className="input" value={form.vaultPath} onChange={(e) => setForm({ ...form, vaultPath: e.target.value })} />
              <button
                className="btn sm"
                onClick={async () => {
                  const p = await window.ozmo.pickFolder()
                  if (p) setForm({ ...form, vaultPath: p })
                }}
              >
                browse…
              </button>
            </div>
          </div>

          <div className="settings-card">
            <h2>You</h2>
            <div className="field">
              <label>display name (attribution in notes, comments, activity)</label>
              <input
                className="input"
                style={{ maxWidth: 260 }}
                value={form.humanName}
                onChange={(e) => setForm({ ...form, humanName: e.target.value })}
              />
            </div>
          </div>

          {/* Save covers ONLY the three fields above — appearance, connection
              colours and flags below save themselves the moment they change */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={save}>Save</button>
            {needsRelaunch && (
              <button className="btn" style={{ color: 'var(--warn)' }} onClick={() => window.ozmo.relaunch()}>
                ↻ Relaunch to apply
              </button>
            )}
          </div>

          <AppearanceCard settings={settings} />

          <ConnectionColoursCard settings={settings} />

          <FlagsCard flags={settings.flags} />

          <SkillTargetsCard settings={settings} projects={projects} />

          {project && (
            <div className="settings-card" style={{ borderColor: '#3d2430' }}>
              <h2 style={{ color: 'var(--danger)' }}>Danger zone</h2>
              <div className="hint">
                Delete <b>{project.name}</b> ({project.nodeCount ?? 0} nodes). The database rows are removed;
                the project folder is moved to the vault trash, not destroyed.
              </div>
              <div>
                <button className="btn danger" onClick={() => setConfirmDelProject(true)}>Delete project…</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmDelProject && project && (
        <Confirm
          title={`Delete project "${project.name}"?`}
          body="All nodes, links, reviews and activity are removed from the database. Markdown files move to .ozmo/trash inside the vault."
          onConfirm={async () => {
            try {
              await rpc('projects.delete', { id: project.id })
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e))
            }
          }}
          onClose={() => setConfirmDelProject(false)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Node appearance — per-type colour/shape/size overrides plus display order,
// stored as settings.styleOverrides + settings.typeOrder. Everything renders
// through typeStyle()/relStyle()/orderedNodeTypes(), so every change restyles
// the canvas, chips, pickers and lists live. The cards read store settings
// directly and persist on change via mutateSettings (debounced, coalesced;
// drag-drops and resets flush on the spot) — there is no Save button for
// them and no parallel form copy to go stale. Vault folders never change.

/** One shapeGeometry as SVG — the preview twin of the canvas painters in
 *  GraphView (same geometry module, same fill/outline rules). `hubAlpha` is the
 *  ring hub's solid-fill opacity: the warp outer ring uses the canvas's soft
 *  0.35 disc, an inner ring glyph fills its hub fully (◉). */
function GeomEl({ g, color, fill, strokeW, hubAlpha = 0.35 }: {
  g: ShapeGeom; color: string; fill: NodeFill; strokeW: number; hubAlpha?: number
}): React.JSX.Element {
  const outline = fill === 'outline'
  const paint = outline
    ? { fill: 'none', stroke: color, strokeWidth: strokeW, strokeLinejoin: 'round' as const }
    : { fill: color }
  if (g.kind === 'circle') return <circle cx={g.cx} cy={g.cy} r={g.r} {...paint} />
  if (g.kind === 'rect') return <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={g.rx} {...paint} />
  if (g.kind === 'polygon') return <polygon points={g.points.map((p) => `${p.x},${p.y}`).join(' ')} {...paint} />
  // ring: outer circle always strokes; the hub fills when solid, strokes when outline
  return (
    <>
      <circle cx={g.cx} cy={g.cy} r={g.r} fill="none" stroke={color} strokeWidth={strokeW} />
      {outline
        ? <circle cx={g.cx} cy={g.cy} r={g.innerR} fill="none" stroke={color} strokeWidth={strokeW} />
        : <circle cx={g.cx} cy={g.cy} r={g.innerR} fill={color} opacity={hubAlpha} />}
    </>
  )
}

/** Tiny SVG of a node exactly as the canvas draws it — outer fill mode and the
 *  inner glyph included. The live preview dot beside each appearance row. */
function ShapePreview({ style }: { style: NodeTypeMeta }): React.JSX.Element {
  const c = 13
  // scale the type's radius into preview space so small/default/large read at a glance
  const r = Math.max(4.5, Math.min(11, 3.5 + style.radius * 0.42))
  const inner = style.inner
  const ir = r * INNER_GLYPH_RATIO
  return (
    <svg className="style-preview" width={26} height={26} viewBox="0 0 26 26" aria-hidden>
      <GeomEl g={shapeGeometry(style.shape, c, c, r)} color={style.color} fill={style.fill ?? 'solid'} strokeW={Math.max(1, r * 0.18)} />
      {inner && (isTextGlyph(inner.glyph) ? (
        <text
          x={c} y={c} textAnchor="middle" dominantBaseline="central" fill={inner.color}
          fontFamily="Inter, system-ui, sans-serif" fontWeight={700} fontSize={ir * TEXT_GLYPH_FONT_RATIO}
        >
          {inner.glyph}
        </text>
      ) : (
        <GeomEl g={shapeGeometry(inner.glyph, c, c, ir)} color={inner.color} fill={inner.fill} strokeW={Math.max(0.8, ir * 0.28)} hubAlpha={1} />
      ))}
    </svg>
  )
}

const SIZE_LABELS = ['small', 'default', 'large'] as const
type SizeLabel = (typeof SIZE_LABELS)[number]

/** The stored radius read back as a size preset (any agent-PATCHed number maps to the nearest bucket). */
function sizeOf(t: NodeType, overrides?: StyleOverrides): SizeLabel {
  const r = overrides?.nodes?.[t]?.radius
  const base = NODE_TYPES[t].radius
  if (r == null || r === base) return 'default'
  return r < base ? 'small' : 'large'
}

/** small/large map to radii scaled from the TYPE's own baseline (a large instance stays smaller than a large pillar). */
function radiusFor(t: NodeType, size: SizeLabel): number | undefined {
  const base = NODE_TYPES[t].radius
  if (size === 'small') return Math.max(5, Math.round(base * 0.7))
  if (size === 'large') return Math.round(base * 1.45)
  return undefined
}

/** Drop empty branches; undefined when nothing is overridden (= shipped defaults). */
function normalizeOverrides(o: StyleOverrides): StyleOverrides | undefined {
  const nodes = o.nodes && Object.keys(o.nodes).length ? o.nodes : undefined
  const relationships = o.relationships && Object.keys(o.relationships).length ? o.relationships : undefined
  if (!nodes && !relationships) return undefined
  return { ...(nodes ? { nodes } : {}), ...(relationships ? { relationships } : {}) }
}

function AppearanceCard({ settings }: { settings: AppSettings }): React.JSX.Element {
  const order = orderedNodeTypes(settings.typeOrder)
  const [dragType, setDragType] = useState<NodeType | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  const patchNode = (t: NodeType, patch: Partial<NodeStyleOverride>): void => {
    const nodes = { ...(settings.styleOverrides?.nodes ?? {}) }
    const entry: NodeStyleOverride = { ...(nodes[t] ?? {}), ...patch }
    for (const k of Object.keys(entry) as (keyof NodeStyleOverride)[]) {
      if (entry[k] === undefined) delete entry[k]
    }
    if (Object.keys(entry).length) nodes[t] = entry
    else delete nodes[t]
    mutateSettings({ styleOverrides: normalizeOverrides({ ...settings.styleOverrides, nodes }) })
  }

  const commitDrop = (): void => {
    const from = dragType ? order.indexOf(dragType) : -1
    const to = dropIdx
    setDragType(null)
    setDropIdx(null)
    if (from < 0 || to == null) return
    const next = moveByIndex(order, from, to)
    // reorders persist on drop, like the toolbar chips
    if (!next.every((t, i) => t === order[i])) mutateSettings({ typeOrder: next }, { flush: true })
  }

  const anyNodeOverride = !!settings.styleOverrides?.nodes && Object.keys(settings.styleOverrides.nodes).length > 0
  const dirty = anyNodeOverride || !!settings.typeOrder

  return (
    <div
      className="settings-card"
      onDragOver={(e) => { if (dragType) e.preventDefault() }}
      onDrop={(e) => { if (dragType) { e.preventDefault(); commitDrop() } }}
    >
      <h2>Node appearance</h2>
      <div className="hint">
        Colour, shape, size and fill (solid or stroke-only outline) per node type, plus display order —
        drag the grip to reorder (the order drives the graph toolbar chips, the quick-add picker and the
        Lists sections). The <b> inner</b> row adds an optional second glyph inside the node — any shape,
        or a bold symbol — with its own colour and fill. Changes save themselves and apply everywhere
        live — no Save needed. Vault folders never change. Heads-up: the warp progress arc only draws on
        the <b> ring</b> shape — overriding warp away from it hides the arc until you reset — and an
        inner glyph on a warp replaces the progress number inside the ring.
      </div>
      {order.map((t, i) => {
        const merged = typeStyle(t, settings.styleOverrides)
        const override = settings.styleOverrides?.nodes?.[t]
        const inner = merged.inner
        return (
          <div
            key={t}
            className={[
              'style-row stacked',
              dragType === t ? 'dragging' : '',
              dragType && dropIdx === i ? 'drop-before' : '',
              dragType && i === order.length - 1 && dropIdx === order.length ? 'drop-after' : ''
            ].filter(Boolean).join(' ')}
            onDragOver={(e) => {
              if (!dragType) return
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              setDropIdx(e.clientY < rect.top + rect.height / 2 ? i : i + 1)
            }}
          >
            <div className="style-row-main">
              <span
                className="grip"
                title="drag to reorder"
                draggable
                onDragStart={(e) => {
                  setDragType(t)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => { setDragType(null); setDropIdx(null) }}
              >
                ⋮⋮
              </span>
              <ShapePreview style={merged} />
              <span className="style-label" title={merged.hint}>{merged.label}</span>
              <input
                type="color"
                className="flag-color"
                title={`${merged.label} colour`}
                value={merged.color}
                onChange={(e) => patchNode(t, { color: e.target.value })}
              />
              <select
                className="input"
                style={{ width: 'auto' }}
                title={`${merged.label} canvas shape`}
                value={merged.shape}
                onChange={(e) => {
                  const shape = e.target.value as NodeShape
                  patchNode(t, { shape: shape === NODE_TYPES[t].shape ? undefined : shape })
                }}
              >
                {NODE_SHAPES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                className="input"
                style={{ width: 'auto' }}
                title={`${merged.label} size`}
                value={sizeOf(t, settings.styleOverrides)}
                onChange={(e) => patchNode(t, { radius: radiusFor(t, e.target.value as SizeLabel) })}
              >
                {SIZE_LABELS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                className="input"
                style={{ width: 'auto' }}
                title={`${merged.label} fill — solid, or a stroke-only outline (same glow, same click area)`}
                value={merged.fill ?? 'solid'}
                onChange={(e) => {
                  const fill = e.target.value as NodeFill
                  patchNode(t, { fill: fill === 'solid' ? undefined : fill })
                }}
              >
                <option value="solid">solid</option>
                <option value="outline">outline</option>
              </select>
              <div className="spacer" />
              {override && (
                <button
                  className="btn sm ghost"
                  title={`Reset ${merged.label} to the shipped look`}
                  onClick={() => {
                    const nodes = { ...(settings.styleOverrides?.nodes ?? {}) }
                    delete nodes[t]
                    // explicit reset — lands immediately (may null out styleOverrides entirely)
                    mutateSettings({ styleOverrides: normalizeOverrides({ ...settings.styleOverrides, nodes }) }, { flush: true })
                  }}
                >
                  reset
                </button>
              )}
            </div>
            <div className="style-row-sub">
              <span className="style-sub-label">inner</span>
              <select
                className="input"
                style={{ width: 'auto' }}
                title={`${merged.label} inner glyph — a second mark inside the node (on a warp it replaces the progress number)`}
                value={inner?.glyph ?? 'none'}
                onChange={(e) => {
                  const v = e.target.value
                  patchNode(t, {
                    inner: v === 'none'
                      ? undefined
                      : {
                          glyph: v as InnerGlyph,
                          color: inner?.color ?? '#e6eaf2',
                          // fill is meaningless for text symbols — normalize like the sanitizer does
                          fill: isTextGlyph(v as InnerGlyph) ? 'solid' : inner?.fill ?? 'solid'
                        }
                  })
                }}
              >
                <option value="none">none</option>
                <optgroup label="shapes">
                  {NODE_SHAPES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </optgroup>
                <optgroup label="symbols">
                  {INNER_TEXT_GLYPHS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </optgroup>
              </select>
              {inner && (
                <input
                  type="color"
                  className="flag-color"
                  title={`${merged.label} inner glyph colour`}
                  value={inner.color}
                  onChange={(e) => patchNode(t, { inner: { ...inner, color: e.target.value } })}
                />
              )}
              {inner && !isTextGlyph(inner.glyph) && (
                <select
                  className="input"
                  style={{ width: 'auto' }}
                  title={`${merged.label} inner glyph fill`}
                  value={inner.fill}
                  onChange={(e) => patchNode(t, { inner: { ...inner, fill: e.target.value as NodeFill } })}
                >
                  <option value="solid">solid</option>
                  <option value="outline">outline</option>
                </select>
              )}
            </div>
          </div>
        )
      })}
      {dirty && (
        <div>
          <button
            className="btn sm ghost"
            title="Shipped colours, shapes, sizes and order for every type"
            onClick={() => mutateSettings({
              styleOverrides: normalizeOverrides({ ...settings.styleOverrides, nodes: undefined }),
              typeOrder: undefined
            }, { flush: true })}
          >
            ↺ reset all to defaults
          </button>
        </div>
      )}
    </div>
  )
}

function ConnectionColoursCard({ settings }: { settings: AppSettings }): React.JSX.Element {
  const patchRel = (t: EdgeType, color: string | undefined, flush = false): void => {
    const relationships = { ...(settings.styleOverrides?.relationships ?? {}) }
    if (color) relationships[t] = { color }
    else delete relationships[t]
    mutateSettings(
      { styleOverrides: normalizeOverrides({ ...settings.styleOverrides, relationships }) },
      flush ? { flush: true } : undefined
    )
  }
  return (
    <div className="settings-card">
      <h2>Connection colours</h2>
      <div className="hint">
        Per relationship type — lines, arrowheads, chevrons, link menus and the inspector all follow, live,
        saved as you pick. <b> relates</b> is the bare connection (no typed relationships). Shapes
        don&apos;t apply to lines.
      </div>
      {(Object.keys(EDGE_TYPES) as EdgeType[]).map((t) => {
        const merged = relStyle(t, settings.styleOverrides)
        const overridden = !!settings.styleOverrides?.relationships?.[t]
        return (
          <div key={t} className="style-row">
            <svg className="style-preview" width={34} height={14} viewBox="0 0 34 14" aria-hidden>
              <line
                x1={2} y1={7} x2={t === 'relates' ? 32 : 25} y2={7}
                stroke={merged.color} strokeWidth={2}
                strokeDasharray={merged.dashed ? '4 3' : undefined}
              />
              {t !== 'relates' && <polygon points="32,7 24,3.2 24,10.8" fill={merged.color} />}
            </svg>
            <span className="style-label" title={merged.hint}>{merged.label}</span>
            <input
              type="color"
              className="flag-color"
              title={`${merged.label} colour`}
              value={merged.color}
              onChange={(e) => patchRel(t, e.target.value)}
            />
            <div className="spacer" />
            {overridden && (
              <button className="btn sm ghost" title="Reset to the shipped colour" onClick={() => patchRel(t, undefined, true)}>
                reset
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flags — composable highlight rules. A rule fires when ANY condition holds:
// "has tag X" or "has an incoming edge of type Y" (edges from nodes that match
// the Done rule are ignored — a fixed bug stops blocking). Saves on change;
// every open view recomputes immediately, no relaunch. Rows mid-typing (blank
// name/tag) stay local until they are well-formed — mutateSettings holds the
// flush so the server sanitizer can't bounce an in-progress row out.

const TREATMENTS: { value: FlagTreatment; label: string; hint: string }[] = [
  { value: 'ring', label: 'ring', hint: 'colored dashed ring on the canvas, colored edge on rows/cards' },
  { value: 'dim', label: 'dim', hint: 'fades the node — the "done" look' },
  { value: 'badge', label: 'badge', hint: 'named chip on rows/cards, dot on the canvas' }
]

function FlagsCard({ flags }: { flags: FlagRule[] }): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const commit = (next: FlagRule[], flush = false): void =>
    mutateSettings({ flags: next }, flush ? { flush: true } : undefined)
  const patchRule = (id: string, patch: Partial<FlagRule>): void =>
    commit(flags.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  const patchCondition = (rule: FlagRule, idx: number, cond: FlagCondition): void =>
    patchRule(rule.id, { conditions: rule.conditions.map((c, i) => (i === idx ? cond : c)) })

  const commitDrop = (): void => {
    const from = dragId ? flags.findIndex((f) => f.id === dragId) : -1
    const to = dropIdx
    setDragId(null)
    setDropIdx(null)
    if (from < 0 || to == null) return
    const next = moveByIndex(flags, from, to)
    // reorders persist on drop, like the toolbar chips
    if (!next.every((f, i) => f.id === flags[i].id)) commit(next, true)
  }

  return (
    <div
      className="settings-card"
      onDragOver={(e) => { if (dragId) e.preventDefault() }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); commitDrop() } }}
    >
      <h2>Flags</h2>
      <div className="hint">
        Composable highlight rules over the graph. A rule fires when <b>any</b> condition holds — a tag,
        or an incoming link of a type (links from nodes that match the <b>Done</b> rule are ignored, so a
        fixed bug stops blocking). The Done rule also defines done-ness for the backlog and progress.
        Drag the grips to reorder — rule order is chip order and evaluation order everywhere. Edits save
        themselves as you type.
      </div>
      {flags.map((rule, i) => (
        <div
          key={rule.id}
          className={[
            'flag-rule',
            dragId === rule.id ? 'dragging' : '',
            dragId && dropIdx === i ? 'drop-before' : '',
            dragId && i === flags.length - 1 && dropIdx === flags.length ? 'drop-after' : ''
          ].filter(Boolean).join(' ')}
          onDragOver={(e) => {
            if (!dragId) return
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            setDropIdx(e.clientY < rect.top + rect.height / 2 ? i : i + 1)
          }}
        >
          <div className="flag-rule-head">
            <span
              className="grip"
              title="drag to reorder"
              draggable
              onDragStart={(e) => {
                setDragId(rule.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => { setDragId(null); setDropIdx(null) }}
            >
              ⋮⋮
            </span>
            <input
              className="input"
              style={{ maxWidth: 150, fontWeight: 600 }}
              value={rule.name}
              onChange={(e) => patchRule(rule.id, { name: e.target.value })}
            />
            <select
              className="input"
              style={{ width: 'auto' }}
              value={rule.treatment}
              title={TREATMENTS.find((t) => t.value === rule.treatment)?.hint}
              onChange={(e) => patchRule(rule.id, { treatment: e.target.value as FlagTreatment })}
            >
              {TREATMENTS.map((t) => (
                <option key={t.value} value={t.value} title={t.hint}>{t.label}</option>
              ))}
            </select>
            {rule.treatment !== 'dim' && (
              <input
                type="color"
                className="flag-color"
                title="treatment color"
                value={rule.color ?? (rule.treatment === 'ring' ? '#f87171' : '#8b94a7')}
                onChange={(e) => patchRule(rule.id, { color: e.target.value })}
              />
            )}
            <div className="spacer" />
            <button
              className="btn sm ghost"
              title="Delete this rule"
              onClick={() => commit(flags.filter((f) => f.id !== rule.id))}
            >
              ✕
            </button>
          </div>
          {rule.conditions.map((c, i) => (
            <div key={i} className="flag-cond-row">
              <span className="flag-cond-when">{i === 0 ? 'when' : 'or'}</span>
              <select
                className="input"
                style={{ width: 'auto' }}
                value={c.kind}
                onChange={(e) => {
                  const kind = e.target.value
                  patchCondition(rule, i,
                    kind === 'tag' ? { kind: 'tag', tag: '' }
                      : kind === 'stage' ? { kind: 'stage', stage: 'done' }
                      : { kind: 'incoming-edge', edgeType: 'blocks' })
                }}
              >
                <option value="tag">has tag</option>
                <option value="incoming-edge">has incoming link</option>
                <option value="stage">warp is at stage</option>
              </select>
              {c.kind === 'tag' ? (
                <input
                  className="input"
                  style={{ maxWidth: 150 }}
                  placeholder="tag…"
                  value={c.tag}
                  onChange={(e) => patchCondition(rule, i, { kind: 'tag', tag: e.target.value.trim().toLowerCase() })}
                />
              ) : c.kind === 'stage' ? (
                <select
                  className="input"
                  style={{ width: 'auto' }}
                  title="Warps only — every other type carries no stage, so this condition is inert on them"
                  value={c.stage}
                  onChange={(e) => patchCondition(rule, i, { kind: 'stage', stage: e.target.value as WarpStage })}
                >
                  {WARP_STAGES.map((st) => (
                    <option key={st} value={st}>{WARP_STAGE_META[st].label}</option>
                  ))}
                </select>
              ) : (
                <>
                  <select
                    className="input"
                    style={{ width: 'auto' }}
                    value={c.edgeType}
                    onChange={(e) => patchCondition(rule, i, { kind: 'incoming-edge', edgeType: e.target.value as EdgeType, ...(c.sourceType ? { sourceType: c.sourceType } : {}) })}
                  >
                    {/* relationship types only — a bare connection carries no direction, so
                        an incoming "relates" can never fire */}
                    {RELATIONSHIP_TYPES.map((t) => (
                      <option key={t} value={t}>{EDGE_TYPES[t].label}</option>
                    ))}
                  </select>
                  <select
                    className="input"
                    style={{ width: 'auto' }}
                    title="Narrow to sources of one node type — e.g. blocks from threats ring Threatened, blocks from anything ring Blocked"
                    value={c.sourceType ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      patchCondition(rule, i, { kind: 'incoming-edge', edgeType: c.edgeType, ...(v ? { sourceType: v as NodeType } : {}) })
                    }}
                  >
                    <option value="">from any type</option>
                    {orderedNodeTypes(null).map((t) => (
                      <option key={t} value={t}>from {NODE_TYPES[t].plural.toLowerCase()}</option>
                    ))}
                  </select>
                </>
              )}
              <button
                className="btn sm ghost"
                title="Remove condition"
                onClick={() => patchRule(rule.id, { conditions: rule.conditions.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          {rule.conditions.length === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>no conditions — this rule never fires</div>
          )}
          <div>
            <button
              className="btn sm"
              onClick={() => patchRule(rule.id, { conditions: [...rule.conditions, { kind: 'tag', tag: '' }] })}
            >
              + condition
            </button>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn sm"
          onClick={() => commit([...flags, { id: newId('fl'), name: 'New flag', treatment: 'badge', color: '#38bdf8', conditions: [{ kind: 'tag', tag: '' }] }])}
        >
          + new rule
        </button>
        {flags.length === 0 && (
          <button className="btn sm ghost" onClick={() => commit(defaultFlags(), true)}>restore defaults</button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skill targets — the roots the app may INSTALL skills into. This list is the
// app's write surface on the user's disk, so it is the one card here that does
// NOT autosave: `settings.update` refuses skillTargets outright (the settings
// API is unauthenticated on loopback), and changes go through the explicit
// skills.addTarget / skills.removeTarget verbs, which validate the root, write
// an activity row and emit an event. The two neighbouring settings — include
// the global root, and which project adopts imported skills — name no path and
// ride the ordinary settings patch, but still land on an explicit click rather
// than a debounce, because this card is about where files get written.

/** Read verbs the skills layer may expose, newest name first. Unknown-method
 *  404s fall through to the next; all-404 means the skills layer is not wired
 *  up in this build yet, and the card renders the configured list without live
 *  status rather than pretending it knows what is on disk. */
const SKILL_TARGET_VERBS = ['skills.targets', 'skills.overview', 'skills.list']

async function fetchSkillTargets(): Promise<SkillTarget[] | null> {
  for (const verb of SKILL_TARGET_VERBS) {
    try {
      const res = await rpc<SkillTarget[] | { targets?: SkillTarget[] }>(verb)
      const list = Array.isArray(res) ? res : res?.targets
      if (Array.isArray(list)) return list
    } catch (e) {
      if (e instanceof RpcError && e.status === 404) continue
      throw e
    }
  }
  return null
}

/** Display-only join — the renderer has no `path`, and the server's resolved
 *  absSkillsDir supersedes this the moment live status arrives. */
function joinSkillsDir(root: string, skillsDir?: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  const dir = (skillsDir ?? '.claude/skills').replace(/[\\/]+/g, sep)
  return root.replace(/[\\/]+$/, '') + sep + dir
}

function SkillTargetsCard({ settings, projects }: { settings: AppSettings; projects: Project[] }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const targets: SkillTargetConfig[] = settings.skillTargets ?? []
  const [live, setLive] = useState<SkillTarget[] | null>(null)
  const [probing, setProbing] = useState(true)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<SkillTargetConfig | null>(null)
  const idKey = targets.map((t) => t.id).join(',')

  useEffect(() => {
    let cancelled = false
    setProbing(true)
    fetchSkillTargets()
      .then((rows) => { if (!cancelled) setLive(rows) })
      .catch(() => { if (!cancelled) setLive(null) })
      .finally(() => { if (!cancelled) setProbing(false) })
    return () => { cancelled = true }
  }, [idKey, nonce])

  const liveById = new Map((live ?? []).map((t) => [t.id, t]))

  /** The two path-free skill settings. They go over the wire as an ordinary
   *  patch (updateSettings accepts them — neither can name a directory), but
   *  never through mutateSettings: nothing on this card is debounced. */
  const patchSkillSetting = async (p: Partial<AppSettings>): Promise<void> => {
    try {
      // an absent value must reach the server as explicit null — updateSettings
      // keys off `'x' in patch`, so the key has to survive the wire (same
      // convention the store's autosave flush uses)
      const wire: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(p)) wire[k] = v ?? null
      const res = await rpc<{ settings: AppSettings }>('settings.update', wire)
      useStore.setState({ settings: overlaySettings(res.settings) })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const verbMissing = (e: unknown): boolean => e instanceof RpcError && e.status === 404

  const addTarget = async (): Promise<void> => {
    const root = await window.ozmo.pickFolder()
    if (!root) return
    setBusy(true)
    try {
      await rpc('skills.addTarget', { root })
      setNonce((n) => n + 1)
      toast('skill target added', 'info')
    } catch (e) {
      toast(verbMissing(e)
        ? 'the skills layer is not wired up in this build yet — target unchanged'
        : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeTarget = async (t: SkillTargetConfig): Promise<void> => {
    try {
      await rpc('skills.removeTarget', { id: t.id })
      setNonce((n) => n + 1)
      toast(`removed ${t.label}`, 'info')
    } catch (e) {
      toast(verbMissing(e)
        ? 'the skills layer is not wired up in this build yet — target unchanged'
        : e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="settings-card">
      <h2>Skill targets</h2>
      <div className="hint">
        Roots the app may install skills into — each writes to <code>&lt;root&gt;/.claude/skills</code>.
        <b> Installing writes to whatever branch that root is currently checked out on</b>, so a target
        sitting on a feature branch takes the files there, not on <code>main</code>. Check the branch on
        each row before you install.
      </div>
      <div className="hint">
        This list is deliberately not editable through the settings API: it is a list of directories the app
        writes into, and that API is unauthenticated on loopback. Add and remove go through the skills
        verbs, which validate the root and record the change in activity.
      </div>
      {targets.length === 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
          no targets — installs have nowhere to land until you add one
        </div>
      )}
      {targets.map((t) => {
        const l = liveById.get(t.id)
        const off = t.enabled === false
        return (
          // reusing the flag-rule block (a bordered settings sub-panel) — no new CSS
          <div key={t.id} className="flag-rule" style={off ? { opacity: 0.55 } : undefined}>
            <div className="flag-rule-head">
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{t.label}</span>
              {off && <span className="badge" title="declared but not written to">off</span>}
              {l?.kind === 'global' && <span className="badge" title="the user-wide skills root">global</span>}
              {probing && !l && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>checking…</span>}
              {l && (!l.exists
                ? <span className="badge" style={{ color: 'var(--warn)' }} title="the root is not on disk right now">missing</span>
                : l.isGitRepo
                  ? <span className="badge" style={{ color: 'var(--accent)' }} title="installs land on THIS branch">{l.branch ?? 'detached'}</span>
                  : <span className="badge" title="not a git checkout">no repo</span>)}
              {l?.exists && !l.writable && (
                <span className="badge" style={{ color: 'var(--danger)' }} title="the app cannot write here">read-only</span>
              )}
              <div className="spacer" />
              <button className="btn sm ghost" title="Stop managing this root" onClick={() => setConfirmRemove(t)}>✕</button>
            </div>
            <div style={{ color: 'var(--text-faint)', fontSize: 11, wordBreak: 'break-all' }}>
              {l?.absSkillsDir ?? joinSkillsDir(t.root, t.skillsDir)}
            </div>
          </div>
        )
      })}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn sm" disabled={busy} onClick={() => void addTarget()}>+ add target…</button>
        <button className="btn sm ghost" disabled={probing} onClick={() => setNonce((n) => n + 1)}>recheck</button>
        {!probing && live === null && (
          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>live status unavailable in this build</span>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={settings.skillsIncludeGlobal !== false}
          onChange={(e) => void patchSkillSetting({ skillsIncludeGlobal: e.target.checked })}
        />
        include the global <code>~/.claude/skills</code> root
      </label>
      <div className="hint">
        The global root is a fixed location the app already knows — this only turns it on and off, it can
        never point anywhere else, which is why it is safe through the settings API when the target list
        itself is not. Skills installed there are visible to every agent session on this machine, not just
        to one repo. If you remove the global row above, this switch will not bring it back — add it again
        like any other target.
      </div>
      <div className="field">
        <label>home project for imported skills</label>
        <select
          className="input"
          style={{ width: 'auto' }}
          title="Skills imported from disk belong to no repo — they land in this project"
          value={settings.skillsHomeProjectId ?? ''}
          onChange={(e) => void patchSkillSetting({ skillsHomeProjectId: e.target.value || undefined })}
        >
          <option value="">— none —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {confirmRemove && (
        <Confirm
          title={`Stop managing "${confirmRemove.label}"?`}
          body="The app stops installing into this root. Nothing already on disk is deleted — the skill files stay exactly where they are."
          onConfirm={() => removeTarget(confirmRemove)}
          onClose={() => setConfirmRemove(null)}
        />
      )}
    </div>
  )
}

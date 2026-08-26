import React from 'react'
import { useStore } from '@/store'
import { FOG_CLASSES, FOG_CLASS_META, type FogForm, type FogSource, type FogStats } from '@/lib/fog'
import { BAND_META, FRONTIER_BAND, type CertaintyRing } from '@/lib/lens'
import { FilterSection } from './widgets'
import '../fog.css'
import '../lens.css'

/**
 * The ring the canvas draws around a lifted node, at chip size. The row of
 * chips IS the legend: the same three forms, in the same order, right where
 * they are switched on — so nothing has to be looked up somewhere else.
 *
 * r = 4.4 → circumference ≈ 27.6, which is why `split` uses 8.5/5.3: two equal
 * bold arcs with two equal gaps, exactly as the draw loop paints them.
 */
function RingSwatch({ form, color }: { form: FogForm; color: string }): React.JSX.Element {
  const dash = form === 'dotted' ? '1 2.2' : form === 'split' ? '8.5 5.3' : undefined
  const width = form === 'dotted' ? 1 : form === 'split' ? 2 : 2.6
  return (
    <svg className="fog-swatch" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <circle
        cx="6" cy="6" r="4.4" fill="none"
        stroke={color} strokeWidth={width}
        strokeDasharray={dash} strokeLinecap={form === 'dotted' ? 'round' : 'butt'}
      />
    </svg>
  )
}

/**
 * The fog lens's PARAMETERS — the class chips and the report readout.
 *
 * Parameters stay top-left with the filters even though the on/off switch moved
 * to the controls: these chips are a filter over the lens's output, not part of
 * switching it on. They are only mounted while the fog lens is the active one,
 * so nothing here has to ask whether it is.
 *
 * `stats` is computed by the canvas from the SAME index it paints from, so the
 * numbers on these chips can never disagree with the rings on screen.
 */
export function FogParams({ stats, source }: { stats: FogStats; source: FogSource }): React.JSX.Element {
  const hidden = useStore((s) => s.hiddenFogClasses)
  const toggleFogClass = useStore((s) => s.toggleFogClass)
  const soloFogClass = useStore((s) => s.soloFogClass)
  const report = useStore((s) => s.fog)
  const unavailable = useStore((s) => s.fogUnavailable)
  const loading = useStore((s) => s.fogLoading)
  const refreshFog = useStore((s) => s.refreshFog)

  /** what the lens is actually lifting right now — the canvas leaves the map
   *  alone when this is 0, so the panel has to say why rather than leaving a
   *  switched-on lens looking like it does nothing */
  const lit = FOG_CLASSES.reduce((sum, c) => (hidden.includes(c) ? sum : sum + stats.byClass[c]), 0)

  return (
    <div className="fog-section-body">
      <div className="fog-class-chips">
        {FOG_CLASSES.map((c) => {
          const meta = FOG_CLASS_META[c]
          const off = hidden.includes(c)
          return (
            <button
              key={c}
              className={`filter-chip fog-class ${off ? 'off' : ''}`}
              style={{ color: meta.color, background: meta.color + '1a' }}
              onClick={(e) => (e.ctrlKey || e.metaKey ? soloFogClass(c) : toggleFogClass(c))}
              title={`${meta.hint} (ctrl-click to solo — the other classes stay on the canvas, unlit)`}
            >
              <RingSwatch form={meta.form} color={meta.color} />
              {meta.label} <span className="n">{stats.byClass[c]}</span>
            </button>
          )
        })}
      </div>

      {lit === 0 && (
        <div className="fog-note">
          {stats.total === 0
            ? 'No fog here — nothing unknown, undecided or unabsorbed is open. The canvas is unchanged.'
            : 'Every class is switched off, so there is nothing to lift. The canvas is unchanged.'}
        </div>
      )}

      {lit > 0 && (
        <div className="fog-readout">
          {/* every figure here is folded from the SAME index the canvas
              paints, so the readout can never contradict the rings on screen
              — the report's own totals would drift by a beat whenever it is
              a refresh behind the graph. Only the signals, which are about
              the shape of the pile rather than about any node, come straight
              from the report. */}
          {source === 'report' && (
            <>
              <span title="nothing unresolved is holding these down — takeable right now">
                <span className="n">{stats.frontier}</span> takeable
              </span>
              <span className="sep">·</span>
              <span title="something unresolved is holding these down"><span className="n">{stats.blocked}</span> held down</span>
              <span className="sep">·</span>
            </>
          )}
          <span title="carries the `hazy` tag — real, but not phraseable yet">
            <span className="n">{stats.hazy}</span> hazy
          </span>
          <span className="sep">·</span>
          {/* LOUD when it dominates. The realistic first reading of a real
              project is almost all fog outside every district, which makes the
              per-district haze look like it is not working — it is: there is
              nothing there to shade. Whispering that figure would let the
              empty districts read as the answer. */}
          <span
            className={stats.unlocated * 2 >= stats.total ? 'loud' : undefined}
            title="fog in no district — counted apart, because folding it in would make every district density a lie"
          >
            <span className="n">{stats.unlocated}</span> outside every district
          </span>
          {/* signals are ABSENT, not zero, when they have nothing to say —
              their absence is the good news, so nothing renders for one that
              is not there */}
          {report?.signals?.slice(0, 3).map((sig) => (
            <span key={sig.kind} className="signal" title={sig.detail}>
              {sig.kind.replace(/-/g, ' ')} ({sig.count})
            </span>
          ))}
        </div>
      )}

      {lit > 0 && stats.unlocated === stats.total && stats.total > 0 && (
        <div className="fog-note">
          None of it sits in a district yet, so there is no density to shade — put fog in an area and the
          hulls start carrying it.
        </div>
      )}

      {/* A missing report is a missing EXTRA, never a broken page: the lens is
          already drawing from the local derivation, and this line says exactly
          which one you are looking at rather than implying a precision it
          does not have. */}
      {source === 'local' && (
        <div className="fog-note">
          {unavailable ? (
            <>
              <span className="em">local reading.</span> This build has no fog report yet — classes are derived from
              node type, so blocked-ness and waived feedback are not accounted for.{' '}
              <button className="fog-retry" onClick={() => void refreshFog()} disabled={loading}>
                {loading ? 'checking…' : 'retry'}
              </button>
            </>
          ) : (
            <><span className="em">local reading.</span> Waiting on the fog report…</>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The certainty lens's parameters — which, honestly, are a LEGEND.
 *
 * The lens has no knobs: every node is somewhere, and switching a ring off
 * would leave its nodes with nowhere to stand. What the panel owes the reader
 * instead is the key to the picture — the rings in order with their live
 * counts, straight from the layout the canvas drew, so the two can never
 * disagree — plus the two properties that are invisible on screen and matter
 * most: it writes nothing, and it is not a layout.
 */
export function CertaintyParams({ rings, source }: { rings: CertaintyRing[] | null; source: FogSource }): React.JSX.Element {
  return (
    <div className="fog-section-body">
      <div className="lens-legend">
        {(rings ?? []).map((ring) => (
          <React.Fragment key={ring.band}>
            <div
              className={`lens-legend-row ${ring.count === 0 ? 'empty' : ''}`}
              style={{ color: BAND_META[ring.band].color }}
              title={BAND_META[ring.band].hint}
            >
              <span className="pip" />
              <span className="name">{BAND_META[ring.band].label}</span>
              <span className="n">{ring.count}</span>
            </div>
            {/* the one boundary worth naming — inside it the spec answers */}
            {ring.band === FRONTIER_BAND && (
              <div className="lens-legend-frontier" title="Beyond this line the spec does not say. It is the whole point of the lens.">
                the frontier
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      <div className="fog-note">
        Radius is certainty; every node keeps its bearing, so the map you built is still the map. Ring
        width scales with how many land in it, which is what keeps the rim legible.
      </div>
      <div className="fog-note">
        <span className="em">Nothing is written.</span> Switch the lens off and everything slides home. Positions
        are frozen while it is on — dragging a node here would save a place it does not live.
      </div>
      {source === 'local' && (
        <div className="fog-note">
          <span className="em">local reading.</span> No fog report yet, so the outer rings are derived from node
          type alone — waived feedback and blocked-ness are not accounted for.
        </div>
      )}
    </div>
  )
}

/**
 * The lens section of the graph filter bar: whatever the ACTIVE lens has to
 * say, in the place filters live.
 *
 * The switch itself is bottom-right with the controls, because a lens is a mode
 * rather than a filter. Its parameters stayed here, because they are exactly
 * what the rest of this bar is: a way to narrow or read what the canvas is
 * already showing. With no lens on, the section says where the switch is rather
 * than disappearing — a control the user cannot find is a feature they do not
 * have.
 */
export function LensSection({ stats, source, rings }: {
  stats: FogStats
  source: FogSource
  /** the certainty layout's own rings, or null when that lens is not on */
  rings: CertaintyRing[] | null
}): React.JSX.Element {
  const lens = useStore((s) => s.lens)
  const hiddenFogClasses = useStore((s) => s.hiddenFogClasses)
  return (
    <FilterSection
      id="lens"
      label="lens"
      count={lens === 'fog' ? hiddenFogClasses.length : 0}
      hint="the active lens and its parameters — a lens changes how the canvas is painted, never what is on it"
    >
      {lens === null && (
        <div className="fog-note">
          No lens. Switch one on in the canvas controls, bottom right — <span className="em">fog</span> lifts what
          the spec has not absorbed; <span className="em">certainty</span> arranges by it, settled in the core and
          the frontier at the rim.
        </div>
      )}
      {lens === 'fog' && <FogParams stats={stats} source={source} />}
      {lens === 'certainty' && <CertaintyParams rings={rings} source={source} />}
    </FilterSection>
  )
}

import React from 'react'
import { useStore } from '@/store'
import { LENSES } from '@/lib/lens'
import '../lens.css'

/**
 * The lens switcher, in the bottom-right control group.
 *
 * It lives with the controls rather than with the filters because a lens is
 * neither: a filter takes nodes OFF the canvas, an action (fit, re-layout)
 * happens once and is over. A lens is a MODE the canvas is in, and modes belong
 * where the user already looks to change how the view behaves.
 *
 * A radio group, not a row of toggles — the exclusivity is in the CONTROL, not
 * only in the store: pressing one lens replaces the other, and pressing the
 * active one switches the lens off. A third lens is one entry in LENSES.
 */
export function LensSwitch(): React.JSX.Element {
  const lens = useStore((s) => s.lens)
  const setLens = useStore((s) => s.setLens)

  return (
    <div className="lens-switch" role="radiogroup" aria-label="canvas lens">
      <span
        className="lens-switch-label"
        title="A lens is a mode the canvas is in — at most one at a time. Its parameters live top-left, with the filters."
      >
        lens
      </span>
      {LENSES.map((l) => {
        const on = lens === l.id
        return (
          <button
            key={l.id}
            role="radio"
            aria-checked={on}
            className={`btn sm lens-btn ${on ? 'on' : 'ghost'}`}
            title={on ? `${l.hint}\n\nClick again to switch the lens off.` : l.hint}
            onClick={() => setLens(on ? null : l.id)}
          >
            <span className="glyph" aria-hidden>{l.glyph}</span>
            {l.label}
          </button>
        )
      })}
    </div>
  )
}

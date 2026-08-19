import React from 'react'
import { useStore } from '@/store'
import { GROUP_LABELS, SHORTCUTS, chordLabel, type ShortcutGroup } from '@/lib/shortcuts'

// The canvas help, behind a '?' (faykarta: the hint line had grown into
// clutter). Every row comes from the shortcut table the key handlers match on,
// so a binding added there shows up here on its own.

const GROUP_ORDER: ShortcutGroup[] = ['selection', 'navigation', 'editing', 'filters']

export function HelpPanel({ note }: { note?: string }): React.JSX.Element {
  const open = useStore((s) => s.helpOpen)
  const toggle = useStore((s) => s.toggleHelp)

  return (
    <div className={`graph-help ${open ? 'open' : ''}`}>
      {open && (
        <div className="help-body">
          <div className="help-head">
            <span>Gestures &amp; keys</span>
            <button className="help-close" title="close" onClick={() => toggle()}>✕</button>
          </div>
          {GROUP_ORDER.map((g) => {
            const rows = SHORTCUTS.filter((s) => s.group === g)
            if (!rows.length) return null
            return (
              <div key={g} className="help-group">
                <div className="help-group-head">{GROUP_LABELS[g]}</div>
                {rows.map((s) => (
                  <div key={s.id} className="help-row">
                    <span className="help-keys">{s.keys ? chordLabel(s.keys) : s.gesture}</span>
                    <span className="help-what">{s.what}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
      <div className="help-foot">
        {note && <span className="help-note">{note}</span>}
        <button
          className={`btn sm ${open ? '' : 'ghost'} help-btn`}
          title={open ? 'Hide the gesture and key help' : 'Gestures and keyboard shortcuts'}
          onClick={() => toggle()}
        >
          ?
        </button>
      </div>
    </div>
  )
}

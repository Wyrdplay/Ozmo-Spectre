import React, { useMemo, useState } from 'react'
import { useStore } from '@/store'
import { Modal, TypeDot } from './widgets'

export function Palette(): React.JSX.Element {
  const nodes = useStore((s) => s.graph.nodes)
  const setPalette = useStore((s) => s.setPalette)
  const selectNode = useStore((s) => s.selectNode)
  const setView = useStore((s) => s.setView)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const [q, setQ] = useState('')
  const [hot, setHot] = useState(0)

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const pool = [...nodes].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!needle) return pool.slice(0, 9)
    return pool
      .filter((n) => n.title.toLowerCase().includes(needle) || n.tags.some((t) => t.includes(needle)))
      .slice(0, 9)
  }, [q, nodes])

  const go = (id: string): void => {
    setPalette(false)
    setView('graph')
    selectNode(id)
    setFocusNode(id)
  }

  return (
    <Modal onClose={() => setPalette(false)} width={520}>
      <input
        className="input"
        placeholder="Jump to a node…"
        value={q}
        autoFocus
        onChange={(e) => {
          setQ(e.target.value)
          setHot(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHot((h) => Math.min(h + 1, matches.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHot((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter' && matches[hot]) {
            go(matches[hot].id)
          }
        }}
      />
      <div className="palette-results">
        {matches.map((n, i) => (
          <button key={n.id} className={`palette-item ${i === hot ? 'hot' : ''}`} onClick={() => go(n.id)} onMouseEnter={() => setHot(i)}>
            <TypeDot type={n.type} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
            <span className="meta">{n.type === 'warp' ? `${n.stage ?? 'concept'}${n.tags.length ? ' · ' : ''}` : ''}{n.tags.join(', ')}</span>
          </button>
        ))}
        {matches.length === 0 && <div className="empty" style={{ padding: 20 }}>no matches</div>}
      </div>
    </Modal>
  )
}

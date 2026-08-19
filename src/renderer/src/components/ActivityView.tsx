import React, { useEffect } from 'react'
import { useStore } from '@/store'
import { ActorBadge, actorColor } from './widgets'
import { timeAgo } from '@/lib/markdown'

export function ActivityView(): React.JSX.Element {
  const activity = useStore((s) => s.activity)
  const refreshActivity = useStore((s) => s.refreshActivity)
  const select = useStore((s) => s.select)
  const selectNode = useStore((s) => s.selectNode)
  const setView = useStore((s) => s.setView)
  const setFocusNode = useStore((s) => s.setFocusNode)

  useEffect(() => {
    refreshActivity()
  }, [refreshActivity])

  const jump = (subjectKind: string, subjectId: string): void => {
    if (subjectKind === 'node') {
      selectNode(subjectId)
      setView('graph')
      setFocusNode(subjectId)
    } else if (subjectKind === 'edge') {
      select({ kind: 'edge', id: subjectId })
      setView('graph')
    } else if (subjectKind === 'review' || subjectKind === 'reviewItem') {
      // legacy rows from the retired review tables — their subjects are gone;
      // the lens is the closest landing (new review activity is subjectKind node)
      setView('reviews')
    }
  }

  return (
    <>
      <div className="view-header">
        <h1>Activity</h1>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          everything humans and agents did, in one stream
        </span>
      </div>
      <div className="view-body">
        <div className="activity-feed">
          {activity.length === 0 && (
            <div className="empty">
              <div className="big">≋</div>
              <h3>Quiet so far</h3>
              <div>Every create, edit, link, comment and verdict lands here — attributed.</div>
            </div>
          )}
          {activity.map((a) => (
            <div
              key={a.id}
              className="activity-row"
              style={{ borderLeftColor: actorColor(a.actor) + '88' }}
              onClick={() => jump(a.subjectKind, a.subjectId)}
            >
              <ActorBadge name={a.actor} />
              <span className="summary">{a.summary}</span>
              <span className="when">{timeAgo(a.at)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

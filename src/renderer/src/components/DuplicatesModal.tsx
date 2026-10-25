import React, { useCallback, useEffect, useState } from 'react'
import type { DuplicateCandidate } from '@shared/types'
import { useStore } from '@/store'
import { rpc, RpcError } from '@/api'
import { Modal, TypeDot } from './widgets'

interface MergeResult { keptId: string; archivedId: string; referenceId: string | null; linksMoved: number; dropped: string[]; merged: boolean }

/** The same guarded write the rest of Refine uses: a locked board refuses before the wire. */
async function rpcW<T>(method: string, payload?: unknown): Promise<T> {
  const lock = useStore.getState().session?.readOnly
  if (lock) throw new RpcError(lock.message, 403, { readOnly: true })
  return rpc<T>(method, payload)
}

/**
 * POSSIBLE DUPLICATES — the groups of live nodes that say the same thing, for
 * the project you are in (main/duplicates.ts). Per group, choose the one to keep
 * and merge the others into it — each copy goes to the archive, its links move
 * onto the one kept (or onto a reference to it, in the copy's own project) — or
 * say they are not duplicates, which is remembered and never asked again.
 */
export function DuplicatesModal({ projectId, onClose }: { projectId: string; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const lock = useStore((s) => s.session?.readOnly ?? null)
  const [clusters, setClusters] = useState<DuplicateCandidate[][] | null>(null)
  const [keep, setKeep] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await rpc<{ clusters: DuplicateCandidate[][] }>('duplicates.clusters', { projectId })
      setClusters(r.clusters)
      setKeep({})
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setClusters([])
    }
  }, [projectId, toast])
  useEffect(() => { void load() }, [load])

  // the default to keep: the one in this project, else the first
  const kept = (i: number, c: DuplicateCandidate[]): string => keep[i] ?? (c.find((d) => d.projectId === projectId) ?? c[0]).id

  const merge = async (i: number, c: DuplicateCandidate[]): Promise<void> => {
    const keepId = kept(i, c)
    setBusy(i)
    let moved = 0
    const dropped: string[] = []
    try {
      for (const d of c) {
        if (d.id === keepId) continue
        const r = await rpcW<MergeResult>('nodes.mergeDuplicate', { keepId, dupId: d.id })
        moved += r.linksMoved
        dropped.push(...r.dropped)
      }
      toast(`merged ${c.length - 1} into "${c.find((d) => d.id === keepId)?.title}" — ${moved} link${moved === 1 ? '' : 's'} moved` +
        (dropped.length ? `; ${dropped.length} could not move (see the Activity)` : '') + ' · the copies are in the Archive', 'info')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async (i: number, c: DuplicateCandidate[]): Promise<void> => {
    setBusy(i)
    try {
      await rpcW('duplicates.dismiss', { ids: c.map((d) => d.id) })
      setClusters((cs) => cs?.filter((_, n) => n !== i) ?? cs)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const open = (d: DuplicateCandidate): void => {
    onClose()
    void useStore.getState().go({ projectId: d.projectId, graphId: d.graphId, nodeId: d.id })
  }

  return (
    <Modal onClose={onClose} width={720}>
      <h2>Possible duplicates</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Nodes in or touching this project whose titles say the same thing. Keep one: the others go to the
        Archive (restorable), their links move onto the one kept — or, in another project that still uses
        it, onto a reference to it. Instances of one class, and an action designated from a feedback, are
        alike on purpose and never listed.
      </div>
      {!clusters && <div style={{ color: 'var(--text-faint)' }}>Looking…</div>}
      {clusters && clusters.length === 0 && <div style={{ color: 'var(--text-dim)' }}>No duplicates found here.</div>}
      {clusters && clusters.length > 0 && (
        <div className="dup-clusters">
          {clusters.map((c, i) => (
            <div key={c.map((d) => d.id).join()} className="dup-cluster">
              {c.map((d) => (
                <label key={d.id} className="dup-row">
                  <input type="radio" name={`keep-${i}`} checked={kept(i, c) === d.id}
                    onChange={() => setKeep((k) => ({ ...k, [i]: d.id }))} title="Keep this one" />
                  <TypeDot type={d.type} />
                  <span className="dup-title" title={d.title}>{d.title}</span>
                  <span className="dup-path" title={d.path}>{d.path}</span>
                  <button className="btn sm ghost" onClick={(e) => { e.preventDefault(); open(d) }}>Open</button>
                </label>
              ))}
              <div className="dup-actions">
                <span className="dup-why">{c.some((d) => d.reason === 'same title') ? 'same title' : 'similar title'}</span>
                <span className="spacer" />
                <button className="btn sm ghost" disabled={busy !== null || !!lock} onClick={() => void dismiss(i, c)}
                  title="They only look alike — never ask about this group again">
                  Not duplicates
                </button>
                <button className="btn sm primary" disabled={busy !== null || !!lock} onClick={() => void merge(i, c)}
                  title={lock ? lock.message : 'Keep the chosen one; merge the others into it'}>
                  {busy === i ? 'Merging…' : `Keep the chosen one, merge ${c.length - 1}`}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

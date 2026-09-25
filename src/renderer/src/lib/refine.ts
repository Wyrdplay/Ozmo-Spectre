/**
 * REFINE — the pure half of the Refine panel: the queue, the options a card
 * offers, the draft that survives a closed window, and the clipboard hand-off.
 *
 * Kept out of the component so each piece reads (and can be reasoned about)
 * on its own; the component is only the flow.
 */
import type { FogItem, FogReport } from '@shared/types'

/**
 * The queue, in the order the fog report already ranks it: takeable first
 * (leverage, sharpness, class, age), then blocked (nearest to takeable first).
 * Review-held items are left to the review room — Refine never touches them.
 */
export function refineQueue(report: FogReport | null, areaId: string | null): FogItem[] {
  if (!report) return []
  const takeable = report.takeable ?? report.frontier ?? []
  return [...takeable, ...report.blocked]
    .filter((i) => !i.inReview)
    .filter((i) => !areaId || i.areaId === areaId)
}

/**
 * The picks a card offers: the bullet or numbered items under an `## Options`
 * heading in the item's body, when an agent (or a person) wrote them. A
 * convention, not a schema — no section, no picks, and the free text is always
 * there. A trailing "(recommended)" marks the suggested one.
 */
export interface RefineOption { text: string; recommended: boolean }

export function parseOptions(body: string | undefined): RefineOption[] {
  if (!body) return []
  const heading = /^#{2,3}[ \t]+Options[ \t]*$/im.exec(body)
  if (!heading) return []
  const rest = body.slice(heading.index + heading[0].length)
  const next = /^#{1,3}[ \t]/m.exec(rest)
  const section = next ? rest.slice(0, next.index) : rest
  const out: RefineOption[] = []
  for (const line of section.split('\n')) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const rec = /\((?:recommended|rec)\)\s*$/i.test(m[1]) || /★\s*$/.test(m[1])
    const text = m[1].replace(/\s*\((?:recommended|rec)\)\s*$/i, '').replace(/\s*★\s*$/, '').trim()
    if (text) out.push({ text, recommended: rec })
    if (out.length === 9) break // one digit key each
  }
  return out
}

/** The body without its Options section — the card shows the options as picks, not twice. */
export function bodyWithoutOptions(body: string | undefined): string {
  if (!body) return ''
  const heading = /^#{2,3}[ \t]+Options[ \t]*$/im.exec(body)
  if (!heading) return body
  const rest = body.slice(heading.index + heading[0].length)
  const next = /^#{1,3}[ \t]/m.exec(rest)
  return (body.slice(0, heading.index) + (next ? rest.slice(next.index) : '')).trim()
}

// ---------------------------------------------------------------------------
// Drafts — per project, in this browser only. A convenience: the pass must
// render correctly with no storage at all (private windows, blocked storage).

export interface RefineDraft {
  /** fog node id → the response typed so far */
  responses: Record<string, string>
  /** ids deliberately skipped this pass */
  skipped: string[]
  /** the id the pass was standing on */
  at: string | null
  areaId: string | null
  updatedAt: number
}

const draftKey = (projectId: string): string => `spectre.refine.draft.${projectId}`

export function loadDraft(projectId: string): RefineDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(projectId))
    if (!raw) return null
    const d = JSON.parse(raw) as RefineDraft
    if (!d || typeof d !== 'object' || typeof d.responses !== 'object' || !Array.isArray(d.skipped)) return null
    return d
  } catch {
    return null
  }
}

export function saveDraft(projectId: string, d: RefineDraft): void {
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify(d))
  } catch { /* storage is a convenience, never a requirement */ }
}

export function clearDraft(projectId: string): void {
  try {
    localStorage.removeItem(draftKey(projectId))
  } catch { /* ignore */ }
}

/** How much of a draft is real work — what the resume offer names. */
export const draftSize = (d: RefineDraft | null): number =>
  d ? Object.values(d.responses).filter((r) => r.trim()).length : 0

/**
 * Copy text, falling back to a hidden textarea where the async clipboard is
 * refused (a board served over plain http to another machine is not a secure
 * context). Resolves false when neither worked, so the caller can say so.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

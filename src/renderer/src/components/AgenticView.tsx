import React, { useEffect, useMemo, useState } from 'react'
import {
  slugify,
  type InstalledSkill, type NodeDetail, type SkillDriftState, type SkillRow, type SkillTarget
} from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import { Confirm, IdAndUrl, Modal, TagsEditor, useCopyFlash } from './widgets'
import { MarkdownEditor } from './MarkdownEditor'
import '../agentic.css'

// ---------------------------------------------------------------------------
// Drift vocabulary. Six states, and at ~16 columns the eye has to sort them
// WITHOUT reading a tooltip — so each one is a distinct SHAPE first and a
// colour second (the same reason the canvas gives every node type a shape).
//
//   missing    hollow faint circle  · nothing there, and that is often correct
//   clean      small teal dot       · quiet on purpose; the majority state
//   ahead      amber ▲              · the node moved on — push it (directional)
//   modified   red ◆                · someone hand-edited the file — LOUD
//   converged  teal ring            · hand-edited INTO agreement; install restamps
//   unmanaged  slate ■              · a file with no node behind it
//
// The two "fine" states (clean, converged) share teal, the two "you have work"
// states (ahead, modified) are the only warm colours on the grid. Scanning a
// 13×16 matrix therefore means scanning for WARMTH, and a drifted `warp-plan`
// column shows up as one red diamond in a field of teal dots.

/**
 * What a CELL can say. The six real states come from the server; `unknown` is a
 * presentation-only seventh meaning "the payload carried no state for this
 * pair". It exists because the alternative is inventing one: a page about drift
 * must never assert `missing` (a positive claim that a file is not there) for a
 * cell nothing actually evaluated — e.g. a target skipped for an unusable
 * slug, or a row from an older/sparser payload.
 */
type CellState = SkillDriftState | 'unknown'

interface DriftMeta {
  label: string
  color: string
  hint: string
}

const DRIFT: Record<CellState, DriftMeta> = {
  missing: { label: 'missing', color: '#4a5468', hint: 'no SKILL.md in this target' },
  clean: { label: 'clean', color: '#2dd4bf', hint: 'installed and identical to the node' },
  ahead: { label: 'ahead', color: '#facc15', hint: 'the node has moved on since the last install — install to catch this target up' },
  modified: { label: 'modified', color: '#f87171', hint: 'the file on disk was hand-edited and no longer matches — diff, adopt, or force' },
  converged: { label: 'converged', color: '#5eead4', hint: 'hand-edited on disk INTO agreement with the node — installing just restamps it' },
  unmanaged: { label: 'unmanaged', color: '#94a3b8', hint: 'a SKILL.md on disk that no node claims — import it to manage it' },
  unknown: { label: 'not scanned', color: '#5b6478', hint: 'the scan reported nothing for this pair — the app does not know, and will not guess' }
}

const DRIFT_ORDER: SkillDriftState[] = ['ahead', 'modified', 'converged', 'clean', 'missing', 'unmanaged']

/** One drift mark. Shape carries the state; colour reinforces it. */
function Pip({ state, size = 13 }: { state: CellState; size?: number }): React.JSX.Element {
  const c = DRIFT[state].color
  const s = size
  const k = s / 14
  const body = ((): React.JSX.Element => {
    switch (state) {
      case 'clean':
        return <circle cx={7 * k} cy={7 * k} r={3.4 * k} fill={c} />
      case 'converged':
        return (
          <>
            <circle cx={7 * k} cy={7 * k} r={4.4 * k} fill="none" stroke={c} strokeWidth={1.5 * k} />
            <circle cx={7 * k} cy={7 * k} r={1.1 * k} fill={c} />
          </>
        )
      case 'ahead':
        return <path d={`M${7 * k} ${2.2 * k}L${12.2 * k} ${11 * k}H${1.8 * k}Z`} fill={c} />
      case 'modified':
        return <path d={`M${7 * k} ${1.8 * k}L${12.2 * k} ${7 * k}L${7 * k} ${12.2 * k}L${1.8 * k} ${7 * k}Z`} fill={c} />
      case 'unmanaged':
        return <rect x={2.6 * k} y={2.6 * k} width={8.8 * k} height={8.8 * k} rx={1.4 * k} fill={c} />
      case 'unknown':
        // deliberately almost nothing: a faint hairline reads as "no
        // information", where any dot or ring would read as a finding
        return <path d={`M${4.6 * k} ${7 * k}H${9.4 * k}`} stroke="#39415e" strokeWidth={1.2 * k} strokeLinecap="round" />
      case 'missing':
      default:
        return <circle cx={7 * k} cy={7 * k} r={3.4 * k} fill="none" stroke={c} strokeWidth={1.2 * k} />
    }
  })()
  return (
    <svg className="pip" width={s} height={s} viewBox={`0 0 ${14 * k} ${14 * k}`} aria-hidden>
      {body}
    </svg>
  )
}

/**
 * The state of one (row × target) cell — WHAT THE SERVER SAID, or `unknown`.
 *
 * There is deliberately no cleverness here. Defaulting an unanswered cell to
 * `missing` would paint a positive claim ("there is no file there") over a
 * question the scan never answered, and defaulting a node-less row to
 * `unmanaged` would paint sixteen grey squares asserting a file exists in
 * fifteen places it does not. Both are the exact lie this page exists to catch.
 */
function cellState(row: SkillRow, targetId: string): CellState {
  const s = row.drift?.[targetId]
  return s && DRIFT[s] ? s : 'unknown'
}

/** Reads `skillOptions` tolerantly — the frontmatter blob is whatever YAML held. */
function optString(options: Record<string, unknown> | null | undefined, key: string): string {
  const v = options?.[key]
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ')
  if (typeof v === 'object') return ''
  return String(v)
}

function optBool(options: Record<string, unknown> | null | undefined, key: string): boolean {
  const v = options?.[key]
  return v === true || v === 'true'
}

/** Copy-to-clipboard for a row — offered whether or not it is installed anywhere:
 *  some prompts belong in a chat box, not in `.claude/skills`. */
function CopyBody({ nodeId, slug, label }: { nodeId: string | null; slug: string; label?: string }): React.JSX.Element {
  const { copied, copy } = useCopyFlash()
  const toast = useStore((s) => s.toast)
  const grab = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!nodeId) {
      copy(slug)
      return
    }
    try {
      const d = await rpc<{ content: string }>('nodes.getContent', { id: nodeId })
      copy(d.content ?? '')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <button
      className={`id-chip ${copied ? 'copied' : ''}`}
      title={nodeId ? 'copy the body to the clipboard — paste it straight into a chat' : 'copy the slug (this one lives only on disk)'}
      onClick={grab}
    >
      {copied ? 'copied ✓' : (label ?? '⧉')}
    </button>
  )
}

/** Branch chip — install writes land on whatever branch the root is checked out on. */
function BranchChip({ target }: { target: SkillTarget }): React.JSX.Element | null {
  if (!target.isGitRepo) return null
  const branch = target.branch ?? 'detached'
  const forks = branch !== 'main' && branch !== 'master'
  return (
    <span
      className={`chip branch ${forks ? 'forks' : ''}`}
      title={forks
        ? `checked out on "${branch}" — installing here writes the file on THAT branch and forks this root's skills tree from main; it only comes back through main`
        : `checked out on "${branch}" — installs write files here and stop (no commit, no checkout, no branch switch)`}
    >
      ⎇ {branch}
    </span>
  )
}

// ---------------------------------------------------------------------------

interface Draft {
  slug: string
  description: string
  allowedTools: string
  model: string
  argumentHint: string
}

/** The selected row's editor: identity, the skill⇄prompt toggle, options, body, targets. */
function SkillDetail({ row, targets, installed, initialTab, onChanged }: {
  row: SkillRow
  targets: SkillTarget[]
  installed: InstalledSkill[]
  /** which tab to open on — Targets answers the question most visits are asking
   *  ("where is this installed, what is stale"); the +New flow asks for Spec */
  initialTab?: 'targets' | 'spec'
  onChanged: () => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const detailVersion = useStore((s) => s.detailVersion)
  const projects = useStore((s) => s.projects)
  const skillsHomeProjectId = useStore((s) => s.settings?.skillsHomeProjectId)
  const projectId = useStore((s) => s.projectId)

  /** the node we may WRITE to — a reference resolves to the node it points at,
   *  because setContent/update refuse a reference and the 400 reads as a bug */
  const [node, setNode] = useState<NodeDetail | null>(null)
  const [viaReference, setViaReference] = useState<NodeDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState<Draft>({ slug: row.slug, description: row.description, allowedTools: '', model: '', argumentHint: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [tab, setTab] = useState<'targets' | 'spec'>(initialTab ?? 'targets')
  /** the read-only sheet: a unified diff, or the rendered SKILL.md preview */
  const [sheet, setSheet] = useState<{ title: string; text: string } | null>(null)
  const [forcing, setForcing] = useState<SkillTarget | null>(null)
  const [removing, setRemoving] = useState<SkillTarget | null>(null)
  const [importTo, setImportTo] = useState<string>(skillsHomeProjectId ?? projectId ?? '')

  const nodeId = row.nodeId
  useEffect(() => {
    let cancelled = false
    if (!nodeId) {
      setNode(null)
      setViaReference(null)
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const d = await rpc<NodeDetail>('nodes.get', { id: nodeId })
        let editable = d
        let ref: NodeDetail | null = null
        if (d.referencesNodeId) {
          ref = d
          editable = await rpc<NodeDetail>('nodes.get', { id: d.referencesNodeId })
        }
        if (cancelled) return
        setNode(editable)
        setViaReference(ref)
      } catch (e) {
        if (!cancelled) {
          setNode(null)
          setViaReference(null)
          toast(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [nodeId, detailVersion, toast])

  // form state syncs when the NODE changes, never on every refetch — a
  // background refresh must not yank a half-typed description out from under
  // the cursor
  const editId = node?.id ?? null
  useEffect(() => {
    if (!node) {
      setDraft({ slug: row.slug, description: row.description, allowedTools: '', model: '', argumentHint: '' })
      return
    }
    setDraft({
      slug: node.slug ?? row.slug,
      description: node.description ?? row.description ?? '',
      allowedTools: optString(node.skillOptions, 'allowed-tools'),
      model: optString(node.skillOptions, 'model'),
      argumentHint: optString(node.skillOptions, 'argument-hint')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId])

  const promptOnly = node ? optBool(node.skillOptions, 'disable-model-invocation') : row.promptOnly
  const readOnly = !node

  /** Node-field writes. slug/description/skillOptions are FIELDS on the node
   *  (the spine put them there), so this is the ordinary node update path — the
   *  skills.* verbs are for the filesystem side only. */
  const saveMeta = async (patch: Record<string, unknown>, what: string): Promise<void> => {
    if (!node) return
    setBusy(what)
    try {
      await rpc('nodes.update', { id: node.id, ...patch })
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const saveOption = async (key: string, value: string | boolean | null): Promise<void> => {
    if (!node) return
    const next: Record<string, unknown> = { ...(node.skillOptions ?? {}) }
    if (value === null || value === '' || value === false) delete next[key]
    else next[key] = value
    await saveMeta({ skillOptions: next }, key)
  }

  const install = async (target: SkillTarget, force?: boolean): Promise<void> => {
    if (!node) return
    setBusy(`install:${target.id}`)
    try {
      // per-target failures come back INSIDE results (one locked file never
      // aborts a batch), so a resolved promise is not the same as a written file
      const res = await rpc<{ results?: { targetId: string; ok: boolean; error?: string }[] }>(
        'skills.install', { nodeId: node.id, targets: [target.id], ...(force ? { force: true } : {}) })
      const r = res.results?.find((x) => x.targetId === target.id)
      if (r && !r.ok) toast(`${target.label}: ${r.error ?? 'install failed'}`)
      else toast(`${draft.slug} → ${target.label}`, 'info')
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const uninstall = async (target: SkillTarget): Promise<void> => {
    if (!node) return
    setBusy(`uninstall:${target.id}`)
    try {
      await rpc('skills.uninstall', { nodeId: node.id, targets: [target.id] })
      toast(`removed ${draft.slug} from ${target.label}`, 'info')
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const adopt = async (target: SkillTarget): Promise<void> => {
    if (!node) return
    setBusy(`adopt:${target.id}`)
    try {
      await rpc('skills.adopt', { nodeId: node.id, targetId: target.id })
      toast(`adopted ${target.label}'s copy into the node`, 'info')
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const showDiff = async (target: SkillTarget): Promise<void> => {
    if (!node) return
    setBusy(`diff:${target.id}`)
    try {
      const d = await rpc<{ unified?: string; diff?: string }>('skills.diff', { nodeId: node.id, targetId: target.id })
      setSheet({
        title: `${row.slug} — ${target.label} (disk → what an install would write)`,
        text: d.unified ?? d.diff ?? '(no differences reported)'
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * skills.render — the exact SKILL.md an install would write. Target-independent
   * (same bytes everywhere, only the path differs), and the ONLY way to see the
   * rendered file before a first install: a `missing` target has nothing to diff
   * against.
   */
  const preview = async (): Promise<void> => {
    if (!node) return
    setBusy('preview')
    try {
      const r = await rpc<{ filename: string; markdown: string }>('skills.render', { nodeId: node.id })
      setSheet({ title: `${r.filename} — as an install would write it`, text: r.markdown })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const importFrom = async (target: SkillTarget): Promise<void> => {
    setBusy(`import:${target.id}`)
    try {
      await rpc('skills.import', { targetId: target.id, slug: row.slug, ...(importTo ? { projectId: importTo } : {}) })
      toast(`imported ${row.slug} from ${target.label}`, 'info')
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const installedFor = (targetId: string): InstalledSkill | undefined =>
    installed.find((i) => i.targetId === targetId && i.slug === row.slug)

  const actionable = targets.filter((t) => {
    const st = cellState(row, t.id)
    return st === 'ahead' || st === 'modified' || st === 'converged'
  }).length

  return (
    <div className="agentic-detail">
      <div className="agentic-detail-head">
        {/* the SLUG is the identity: it names the installed directory across
            every target, and a retitle must never silently orphan sixteen of them */}
        <div className="slug-line">
          <code className="slug">{draft.slug || row.slug}</code>
          <span className={`chip kind ${promptOnly ? 'prompt' : 'skill'}`}>{promptOnly ? 'prompt' : 'skill'}</span>
        </div>
        <div className="sub-line">
          <span className="owner" title="the project whose graph owns this node">{row.projectName || 'no project'}</span>
          {node && <span className="title-echo" title="the node's title — the slug, not this, names the install directory">{node.title}</span>}
          {node && <IdAndUrl id={node.id} short />}
          <CopyBody nodeId={node?.id ?? null} slug={row.slug} label="⧉ body" />
        </div>
        {/* the description rides the HEAD, visible from both tabs: for a skill it
            is the entire retrieval mechanism, and the one field that decides
            whether a skill ever fires should not live behind a tab */}
        <div className={`desc-line ${promptOnly ? 'muted' : ''}`} title={draft.description || undefined}>
          {draft.description || <span className="none">{promptOnly ? 'no label yet' : 'no description — a skill without one never fires'}</span>}
        </div>
      </div>

      {(viaReference || (readOnly && !loading)) && (
        <div className="detail-notes">
          {viaReference && (
            <div className="agentic-note info">
              This row is a <strong>reference</strong> — edits go to the original node in <strong>{row.projectName}</strong>,
              because a reference refuses writes.
            </div>
          )}
          {readOnly && !loading && (
            <div className="agentic-note warn">
              <strong>On disk only.</strong> No node claims <code>{row.slug}</code>, so there is nothing here to edit —
              the file is the only copy. <em>Import</em> it below to give it a node, and it becomes editable like the rest.
            </div>
          )}
        </div>
      )}

      {/* TABS, not one long column. With sixteen targets a single scroll puts
          the drift actions — the reason this page exists — a full screen below
          the fold, under a markdown editor most visits never touch. Targets
          leads; authoring is one click away and is what the ＋New flow opens on. */}
      <div className="tabs">
        <button className={`tab ${tab === 'targets' ? 'active' : ''}`} onClick={() => setTab('targets')}>
          Targets
          {actionable ? <span className="badge" title={`${actionable} installed cop${actionable === 1 ? 'y' : 'ies'} out of step with this node`}>{actionable}</span> : null}
        </button>
        <button className={`tab ${tab === 'spec' ? 'active' : ''}`} onClick={() => setTab('spec')}>Spec</button>
      </div>

      <div className="agentic-detail-body">
        {loading && <div className="agentic-note">loading the node…</div>}

        {tab === 'targets' && (
          <>
            <div className="targets-head">
              <label>Where this is installed</label>
              <span className="spacer" />
              {node && (
                <button
                  className="btn sm ghost"
                  disabled={busy === 'preview'}
                  title="see the exact SKILL.md an install would write — identical bytes for every target, only the path differs"
                  onClick={() => void preview()}
                >
                  Preview SKILL.md
                </button>
              )}
            </div>
            <div className="hint branch-honesty">
              Install writes <code>SKILL.md</code> and stops — no commit, no checkout, no branch switch. The file lands on
              whichever branch each root is <strong>currently checked out on</strong>; a lab worktree forks a skills tree that
              is otherwise identical across every branch, and it only returns through <code>main</code>.
            </div>
            {readOnly && projects.length > 0 && (
              <div className="import-to">
                <span>import into</span>
                <select className="input" value={importTo} onChange={(e) => setImportTo(e.target.value)}>
                  <option value="">(the app decides)</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            <div className="target-list">
              {targets.length === 0 && (
                <div className="agentic-note">
                  No install targets are declared yet. Targets are a security boundary, not a preference — they are added with
                  the <code>skills.addTarget</code> verb (Settings), never by writing a settings key.
                </div>
              )}
              {targets.map((t) => {
                const state = cellState(row, t.id)
                const inst = installedFor(t.id)
                const canInstall = !!node && (state === 'missing' || state === 'ahead' || state === 'converged')
                return (
                  <div key={t.id} className={`target-row ${state}`}>
                    <div className="target-id">
                      <Pip state={state} size={12} />
                      <span className="target-label" title={t.absSkillsDir}>{t.label}</span>
                      <span className="chip kind-chip">{t.kind}</span>
                      <BranchChip target={t} />
                      {inst?.bundled && (
                        <span className="chip bundled" title="this directory holds files besides SKILL.md (scripts/, references/). The app manages SKILL.md ONLY — the rest of the bundle is yours and is never written or removed">
                          bundle
                        </span>
                      )}
                      {!t.exists && <span className="chip miss" title={`${t.absSkillsDir} does not exist — the app never creates roots`}>no dir</span>}
                      {t.exists && !t.writable && <span className="chip miss" title="not writable — installs here will fail">read-only</span>}
                    </div>
                    <div className="target-state" title={DRIFT[state].hint}>{DRIFT[state].label}</div>
                    <div className="target-actions">
                      {canInstall && (
                        <button className="btn sm" disabled={busy === `install:${t.id}` || !t.writable} onClick={() => void install(t)}>
                          {state === 'converged' ? 'Restamp' : 'Install'}
                        </button>
                      )}
                      {state === 'modified' && node && (
                        <>
                          <button className="btn sm ghost" disabled={busy === `diff:${t.id}`} onClick={() => void showDiff(t)}>Diff</button>
                          <button className="btn sm ghost" disabled={busy === `adopt:${t.id}`} onClick={() => void adopt(t)}>Adopt</button>
                          <button className="btn sm danger" onClick={() => setForcing(t)}>Force</button>
                        </>
                      )}
                      {state === 'converged' && node && (
                        <button className="btn sm ghost" disabled={busy === `diff:${t.id}`} onClick={() => void showDiff(t)}>Diff</button>
                      )}
                      {state === 'unmanaged' && (
                        <button className="btn sm" disabled={busy === `import:${t.id}`} onClick={() => void importFrom(t)}>Import</button>
                      )}
                      {inst && (
                        <button className="btn sm ghost" title={inst.absPath} onClick={() => void window.ozmo.revealFile(inst.absPath)}>Reveal</button>
                      )}
                      {inst && node && (
                        <button className="btn sm ghost" title={`delete ${inst.absPath}`} onClick={() => setRemoving(t)}>Remove</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {tab === 'spec' && readOnly && !loading && (
          <div className="agentic-note">
            Nothing to edit: this slug exists only as a file. <em>Import</em> it on the Targets tab and it gets a node —
            body, tags, links, activity, the lot.
          </div>
        )}

        {tab === 'spec' && !readOnly && node && (
          <>
            <div className="agentic-field">
              <div className="seg" role="group" aria-label="skill or prompt">
                <button
                  className={!promptOnly ? 'on' : ''}
                  disabled={busy === 'disable-model-invocation'}
                  onClick={() => promptOnly && void saveOption('disable-model-invocation', null)}
                  title="the model picks this on its own by matching the description"
                >
                  Skill
                </button>
                <button
                  className={promptOnly ? 'on' : ''}
                  disabled={busy === 'disable-model-invocation'}
                  onClick={() => !promptOnly && void saveOption('disable-model-invocation', true)}
                  title="hidden from the model's automatic selection — you invoke it with /name"
                >
                  Prompt
                </button>
              </div>
              <div className="hint">
                {promptOnly
                  ? <>Adds <code>disable-model-invocation: true</code>. You invoke it by typing <code>/{draft.slug || 'name'}</code>.</>
                  : <>The model selects this on its own by matching the description below.</>}
              </div>
            </div>

            <div className="agentic-field">
              <label>Slug</label>
              <input
                className="input mono"
                value={draft.slug}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                onBlur={() => {
                  const v = draft.slug.trim()
                  if (v && v !== (node.slug ?? '')) void saveMeta({ slug: v }, 'slug')
                }}
              />
              <div className="hint">Names <code>.claude/skills/{draft.slug || '…'}/SKILL.md</code> in every target. Renaming it leaves the old directories behind.</div>
            </div>

            <div className={`agentic-field ${promptOnly ? 'muted' : ''}`}>
              <label>
                Description
                {promptOnly && <span className="tag-note">a label — nothing matches on it</span>}
                {!promptOnly && <span className="tag-note load-bearing">the only thing the model matches on</span>}
              </label>
              <textarea
                className="input"
                rows={promptOnly ? 2 : 3}
                value={draft.description}
                placeholder={promptOnly ? 'what this prompt is, for your own eyes' : 'when should the model reach for this? be concrete — this is the whole retrieval mechanism'}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                onBlur={() => {
                  if (draft.description !== (node.description ?? '')) void saveMeta({ description: draft.description }, 'description')
                }}
              />
            </div>

            <div className="agentic-field-row">
              <div className={`agentic-field ${promptOnly ? '' : 'muted'}`}>
                <label>
                  Argument hint
                  {promptOnly && <span className="tag-note load-bearing">what makes a prompt reusable</span>}
                </label>
                <input
                  className="input mono"
                  placeholder="[pr-number]"
                  value={draft.argumentHint}
                  onChange={(e) => setDraft((d) => ({ ...d, argumentHint: e.target.value }))}
                  onBlur={() => {
                    if (draft.argumentHint !== optString(node.skillOptions, 'argument-hint')) void saveOption('argument-hint', draft.argumentHint.trim())
                  }}
                />
              </div>
              <div className="agentic-field">
                <label>Model</label>
                <input
                  className="input mono"
                  placeholder="inherit"
                  value={draft.model}
                  onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                  onBlur={() => {
                    if (draft.model !== optString(node.skillOptions, 'model')) void saveOption('model', draft.model.trim())
                  }}
                />
              </div>
            </div>

            <div className="agentic-field">
              <label>Allowed tools</label>
              <input
                className="input mono"
                placeholder="Read, Grep, Bash(git status:*)"
                value={draft.allowedTools}
                onChange={(e) => setDraft((d) => ({ ...d, allowedTools: e.target.value }))}
                onBlur={() => {
                  if (draft.allowedTools !== optString(node.skillOptions, 'allowed-tools')) void saveOption('allowed-tools', draft.allowedTools.trim())
                }}
              />
            </div>

            <div className="agentic-field">
              <label>Tags</label>
              <TagsEditor tags={node.tags} onChange={(tags) => void saveMeta({ tags }, 'tags')} />
            </div>

            <div className="agentic-field grow">
              <label>Body</label>
              <div className="agentic-editor">
                <MarkdownEditor
                  nodeId={node.id}
                  value={node.content}
                  onSave={async (content) => {
                    try {
                      await rpc('nodes.setContent', { id: node.id, content })
                      onChanged()
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e))
                      throw e
                    }
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {sheet && (
        <Modal onClose={() => setSheet(null)} width={720}>
          <h2>{sheet.title}</h2>
          <pre className="agentic-diff">{sheet.text}</pre>
          <div className="actions">
            <button className="btn ghost" onClick={() => setSheet(null)}>Close</button>
          </div>
        </Modal>
      )}

      {removing && (
        <Confirm
          title={`Remove ${row.slug} from ${removing.label}?`}
          body={'Deletes the installed SKILL.md (and its directory, if the app put everything there). The node stays — this uninstalls the build output, it does not delete the skill. A bundle directory holding files the app did not write is left in place.'}
          confirmLabel="Remove"
          onConfirm={() => void uninstall(removing)}
          onClose={() => setRemoving(null)}
        />
      )}

      {forcing && (
        <Confirm
          title={`Overwrite ${row.slug} in ${forcing.label}?`}
          body={'That file was hand-edited on disk. Forcing replaces it with what the node renders to. The old file is backed into the vault trash first — nothing is hard-deleted — but the edit stops being live. Adopt instead if the disk version is the good one.'}
          confirmLabel="Overwrite"
          onConfirm={() => void install(forcing, true)}
          onClose={() => setForcing(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** New skill/prompt dialog — a skill is a node, so this is nodes.create with a slug. */
function NewSkill({ onClose, onCreated }: { onClose: () => void; onCreated: (nodeId: string) => void }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const projectId = useStore((s) => s.projectId)
  const homeProjectId = useStore((s) => s.settings?.skillsHomeProjectId)
  const toast = useStore((s) => s.toast)
  const [title, setTitle] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState(false)
  const [target, setTarget] = useState(homeProjectId ?? projectId ?? projects[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  const effectiveSlug = slugTouched ? slug : slugify(title || '')

  const create = async (): Promise<void> => {
    if (!title.trim() || !target || busy) return
    setBusy(true)
    try {
      const n = await rpc<{ id: string }>('nodes.create', {
        projectId: target,
        type: 'skill',
        title: title.trim(),
        slug: effectiveSlug,
        description: description.trim(),
        ...(prompt ? { skillOptions: { 'disable-model-invocation': true } } : {})
      })
      onCreated(n.id)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} width={480}>
      <h2>New {prompt ? 'prompt' : 'skill'}</h2>
      {projects.length === 0 ? (
        <div className="agentic-note warn">There are no projects yet — a skill is a node, so it needs one to live in.</div>
      ) : (
        <>
          <div className="agentic-field">
            <label>Title</label>
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Warp plan" />
          </div>
          <div className="agentic-field">
            <label>Slug</label>
            <input
              className="input mono"
              value={effectiveSlug}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }}
              placeholder="warp-plan"
            />
            <div className="hint">Names the install directory. It is the identity — the title is free to change later.</div>
          </div>
          <div className="agentic-field">
            <label>Description</label>
            <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="agentic-field">
            <label>Project</label>
            <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <label className="agentic-check">
            <input type="checkbox" checked={prompt} onChange={(e) => setPrompt(e.target.checked)} />
            <span>Prompt — hidden from the model, invoked with <code>/{effectiveSlug || 'name'}</code></span>
          </label>
        </>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void create()} disabled={!title.trim() || !target || busy}>Create</button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

/**
 * The Agentic page — a MATRIX. Rows are skills and prompts, columns are install
 * targets, cells are drift. Authoring is the smaller half: 13 skills copied
 * across 16 repos is a fan-out problem, and nothing before this page could show
 * that one of the sixteen had already drifted.
 *
 * Cross-project by design: `skills.list` is not project-scoped, so the table is
 * the same table whatever the sidebar has selected — the same category of thing
 * as the commons. Each row names the project that owns it.
 */
export function AgenticView(): React.JSX.Element {
  const skills = useStore((s) => s.skills)
  const skillsLoading = useStore((s) => s.skillsLoading)
  const skillsUnavailable = useStore((s) => s.skillsUnavailable)
  const refreshSkills = useStore((s) => s.refreshSkills)
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [stateFilter, setStateFilter] = useState<SkillDriftState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** the row just authored — it opens on Spec, since a brand-new skill is
   *  missing everywhere and its Targets tab has nothing to say yet */
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [installingAll, setInstallingAll] = useState(false)

  useEffect(() => {
    void refreshSkills()
  }, [refreshSkills])

  const targets = useMemo(() => (skills?.targets ?? []).filter((t) => t.enabled !== false), [skills])
  const allRows = useMemo(() => skills?.rows ?? [], [skills])
  const installed = useMemo(() => skills?.installed ?? [], [skills])

  /** live per-state totals across the whole grid — the legend doubles as a filter */
  const stateCounts = useMemo(() => {
    const c: Record<CellState, number> = { missing: 0, clean: 0, ahead: 0, modified: 0, converged: 0, unmanaged: 0, unknown: 0 }
    for (const r of allRows) for (const t of targets) c[cellState(r, t.id)]++
    return c
  }, [allRows, targets])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = allRows.filter((r) => {
      if (needle) {
        const hay = `${r.slug} ${r.title} ${r.description} ${r.projectName}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      if (stateFilter && !targets.some((t) => cellState(r, t.id) === stateFilter)) return false
      return true
    })
    return [...list].sort((a, b) => {
      // disk-only rows sink: they are the ones you IMPORT, not the ones you run
      if (!a.nodeId !== !b.nodeId) return a.nodeId ? -1 : 1
      return a.slug.localeCompare(b.slug)
    })
  }, [allRows, q, stateFilter, targets])

  const selectedRow = useMemo(
    () => rows.find((r) => (r.nodeId ?? `disk:${r.slug}`) === selected) ?? null,
    [rows, selected]
  )

  /**
   * Bulk install work, grouped per node. Only states where the disk copy is
   * UNTOUCHED are ever bulk-installable: `ahead` (the node moved on) and
   * `converged` (someone hand-edited a file into agreement — installing just
   * restamps it byte-identically and takes it off the board). `missing` is
   * excluded on purpose — a skill absent from a repo is usually absent
   * deliberately, and "install everywhere" is a decision, not a cleanup.
   * `modified` is excluded because it would destroy someone's edit.
   */
  const bulk = useMemo(() => {
    const group = (state: SkillDriftState): { row: SkillRow; targetIds: string[] }[] => {
      const out: { row: SkillRow; targetIds: string[] }[] = []
      for (const r of allRows) {
        if (!r.nodeId) continue
        const ids = targets.filter((t) => t.writable && cellState(r, t.id) === state).map((t) => t.id)
        if (ids.length) out.push({ row: r, targetIds: ids })
      }
      return out
    }
    const ahead = group('ahead')
    const converged = group('converged')
    const size = (g: { targetIds: string[] }[]): number => g.reduce((n, a) => n + a.targetIds.length, 0)
    return { ahead, converged, aheadCount: size(ahead), convergedCount: size(converged) }
  }, [allRows, targets])

  const runInstalls = async (groups: { row: SkillRow; targetIds: string[] }[], verb: string): Promise<void> => {
    if (!groups.length || installingAll) return
    setInstallingAll(true)
    let ok = 0
    const failed: string[] = []
    // one call per node, and one failure never aborts the batch: a single locked
    // file in one of sixteen repos must not strand the other fifteen
    for (const a of groups) {
      try {
        const res = await rpc<{ results?: { targetId: string; ok: boolean; error?: string }[] }>(
          'skills.install', { nodeId: a.row.nodeId, targets: a.targetIds })
        const results = res.results ?? []
        ok += results.length ? results.filter((r) => r.ok).length : a.targetIds.length
        for (const r of results) if (!r.ok) failed.push(`${a.row.slug} @ ${r.targetId}: ${r.error ?? 'failed'}`)
      } catch (e) {
        failed.push(`${a.row.slug}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setInstallingAll(false)
    void refreshSkills()
    if (failed.length) toast(`${verb} ${ok}, failed ${failed.length} — ${failed[0]}`)
    else toast(`${verb} ${ok} file${ok === 1 ? '' : 's'}`, 'info')
  }

  return (
    <>
      <div className="view-header">
        <h1>Agentic</h1>
        <span className="badge">{allRows.length}</span>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="filter by slug, title, project…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="spacer" />
        {bulk.convergedCount > 0 && (
          <button
            className="btn"
            disabled={installingAll}
            title={`rewrite ${bulk.convergedCount} file${bulk.convergedCount === 1 ? '' : 's'} that were hand-edited into agreement with their node — byte-identical content, but it restamps them so they stop reading as drifted`}
            onClick={() => void runInstalls(bulk.converged, 'restamped')}
          >
            Restamp converged · {bulk.convergedCount}
          </button>
        )}
        {bulk.aheadCount > 0 && (
          <button
            className="btn primary"
            disabled={installingAll}
            title={`write ${bulk.aheadCount} file${bulk.aheadCount === 1 ? '' : 's'} — every target whose copy is behind its node. Untouched files only; hand-edited ones are left alone`}
            onClick={() => void runInstalls(bulk.ahead, 'installed')}
          >
            {installingAll ? 'working…' : `Install ahead · ${bulk.aheadCount}`}
          </button>
        )}
        <button className="btn" onClick={() => setCreating(true)}>＋ New skill</button>
        <button className="btn ghost" title="rescan every target" onClick={() => void refreshSkills()}>↻</button>
      </div>

      <div className="agentic">
        {skillsUnavailable ? (
          <div className="empty agentic-offline">
            <div><strong>The skills API is not in the running build.</strong></div>
            <div>
              This window is serving a main process that predates <code>skills.list</code>, so there is nothing to scan yet.
              The page itself is fine — it will fill in the moment the endpoints exist. Nothing was written and nothing is broken.
            </div>
            <div><button className="btn" onClick={() => void refreshSkills()}>Try again</button></div>
          </div>
        ) : (
          <>
            <div className="agentic-matrix-pane">
              <div className="agentic-legend">
                {DRIFT_ORDER.map((s) => {
                  const active = stateFilter === s
                  const n = stateCounts[s]
                  return (
                    <button
                      key={s}
                      className={`filter-chip legend ${active ? 'sel' : ''} ${!n && !active ? 'inert' : ''}`}
                      style={{ color: DRIFT[s].color }}
                      title={`${DRIFT[s].hint} — click to show only rows with a ${s} cell`}
                      onClick={() => setStateFilter(active ? null : s)}
                    >
                      <Pip state={s} size={11} /> {DRIFT[s].label} {n ? `· ${n}` : ''}
                    </button>
                  )
                })}
                {stateCounts.unknown > 0 && (
                  <span
                    className="filter-chip legend inert"
                    style={{ color: DRIFT.unknown.color }}
                    title={DRIFT.unknown.hint}
                  >
                    <Pip state="unknown" size={11} /> {DRIFT.unknown.label} · {stateCounts.unknown}
                  </span>
                )}
                {stateFilter && (
                  <button className="filter-chip more" onClick={() => setStateFilter(null)}>clear</button>
                )}
              </div>

              <div className="agentic-matrix-scroll">
                {skillsLoading && !skills && <div className="agentic-note">scanning targets…</div>}
                {!skillsLoading && !allRows.length && (
                  <div className="empty" style={{ padding: '32px 16px' }}>
                    <div>No skills yet. A skill is a node — author it here and install it to the targets you have declared.</div>
                  </div>
                )}
                {allRows.length > 0 && (
                  <table className="agentic-matrix">
                    <thead>
                      <tr>
                        <th className="name-col">
                          <span>Skill / prompt</span>
                        </th>
                        {targets.map((t) => (
                          <th key={t.id} className="target-col" title={`${t.absSkillsDir}${t.branch ? ` — on ${t.branch}` : ''}`}>
                            <div className="vert">
                              <span className="t-label">{t.label}</span>
                              {t.branch && <span className="t-branch">⎇ {t.branch}</span>}
                            </div>
                          </th>
                        ))}
                        <th className="tail-col" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const key = r.nodeId ?? `disk:${r.slug}`
                        const rowAhead = targets.filter((t) => cellState(r, t.id) === 'ahead').length
                        return (
                          <tr
                            key={key}
                            className={`${selected === key ? 'sel' : ''} ${r.nodeId ? '' : 'diskonly'}`}
                            onClick={() => setSelected(key)}
                          >
                            <td className="name-col">
                              <div className="row-name">
                                <code className="slug">{r.slug}</code>
                                {r.promptOnly && <span className="chip kind prompt">prompt</span>}
                                {!r.nodeId && <span className="chip kind disk">on disk</span>}
                              </div>
                              <div className="row-sub">
                                <span className="proj">{r.projectName || '—'}</span>
                                <span className="desc" title={r.description}>{r.description || (r.nodeId ? '' : 'no node claims this slug')}</span>
                              </div>
                            </td>
                            {targets.map((t) => {
                              const st = cellState(r, t.id)
                              return (
                                <td key={t.id} className={`cell ${st}`} title={`${r.slug} @ ${t.label}${t.branch ? ` (${t.branch})` : ''} — ${DRIFT[st].label}: ${DRIFT[st].hint}`}>
                                  <Pip state={st} />
                                </td>
                              )
                            })}
                            <td className="tail-col">
                              {rowAhead > 0 && <span className="row-ahead" title={`${rowAhead} target${rowAhead === 1 ? '' : 's'} behind this node`}>{rowAhead}▲</span>}
                              <CopyBody nodeId={r.nodeId} slug={r.slug} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {!targets.length && allRows.length > 0 && (
                  <div className="agentic-note">
                    No install targets are declared, so the matrix has no columns — every row is still authorable and copyable.
                  </div>
                )}
              </div>
            </div>

            {selectedRow ? (
              <SkillDetail
                key={selectedRow.nodeId ?? `disk:${selectedRow.slug}`}
                row={selectedRow}
                targets={targets}
                installed={installed}
                initialTab={selectedRow.nodeId && selectedRow.nodeId === justCreated ? 'spec' : 'targets'}
                onChanged={() => void refreshSkills()}
              />
            ) : (
              <div className="agentic-detail empty-detail">
                <div className="empty" style={{ padding: '32px 16px' }}>
                  <div>Pick a row to read it, edit it, or install it.</div>
                  <div style={{ marginTop: 8 }}>Rows are skills and prompts; columns are the roots they install into; each mark is one file&apos;s drift.</div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {creating && (
        <NewSkill
          onClose={() => setCreating(false)}
          onCreated={(id) => { setSelected(id); setJustCreated(id); void refreshSkills() }}
        />
      )}
    </>
  )
}

import { create } from 'zustand'
import {
  edgeRelationships,
  type AppInfo, type AppSettings, type Project, type GraphPayload, type SpecNode, type WarpSummary,
  type ActivityEntry, type OzmoEvent, type NodeType, type EdgeType, type FlagRule
} from '@shared/types'
import { rpc } from './api'

export type View = 'graph' | 'lists' | 'backlog' | 'warps' | 'reviews' | 'activity' | 'settings'

/** THE selection — one model for single, multi and edge selection.
 *  Nodes: `ids` in selection order, `anchor` = the reference row for range
 *  extension (last toggled-in / last plain-clicked). A plain click is a
 *  selection of one. The inspector derives its mode purely from the count. */
export type Selection =
  | { kind: 'nodes'; ids: string[]; anchor: string }
  | { kind: 'edge'; id: string }

/** Preset link for quick-add: type/direction omitted = resolved by the type-pair matrix. */
export interface QuickAddLink {
  nodeId: string
  type?: EdgeType
  /** true = the NEW node is the edge source */
  outgoing?: boolean
}

export interface Toast {
  id: number
  msg: string
  kind: 'error' | 'info'
  /** optional one-click follow-up (Undo on a reversible verb). Toasts carrying
   *  one live longer — a 5s window is not enough to notice and reach for it. */
  action?: { label: string; run: () => void }
}

let toastSeq = 1
let graphRefreshTimer: ReturnType<typeof setTimeout> | null = null

// canvas container-collapse is per-machine UI state, persisted per project.
// A CONTAINER is a class (node with class-of instances) or an area (member
// district) — one set, one code path. The legacy per-class key migrates in.
const collapsedKey = (projectId: string): string => `ozmo.collapsedContainers.${projectId}`
const legacyCollapsedKey = (projectId: string): string => `ozmo.collapsedClasses.${projectId}`
const loadCollapsed = (projectId: string | null): string[] => {
  if (!projectId) return []
  try {
    const raw = localStorage.getItem(collapsedKey(projectId)) ?? localStorage.getItem(legacyCollapsedKey(projectId)) ?? '[]'
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const saveCollapsed = (projectId: string | null, ids: string[]): void => {
  if (!projectId) return
  try {
    localStorage.setItem(collapsedKey(projectId), JSON.stringify(ids))
  } catch { /* storage full/unavailable — collapse state just won't persist */ }
}

// the canvas '?' help panel: per-MACHINE UI state like the filter sections,
// collapsed by default (it replaced an always-on hint line)
const HELP_OPEN_KEY = 'ozmo.helpOpen'
const loadHelpOpen = (): boolean => {
  try {
    return localStorage.getItem(HELP_OPEN_KEY) === '1'
  } catch {
    return false
  }
}
const saveHelpOpen = (open: boolean): void => {
  try {
    localStorage.setItem(HELP_OPEN_KEY, open ? '1' : '0')
  } catch { /* storage full/unavailable — it just reopens collapsed */ }
}

/** The graph filter bar's three sections. */
export type FilterSectionId = 'types' | 'links' | 'tags'
const FILTER_SECTION_IDS: FilterSectionId[] = ['types', 'links', 'tags']

// filter-bar section collapse is per-MACHINE (not per project): the bar should
// look the same wherever you land. One key, the collapsed ids.
const FILTER_SECTIONS_KEY = 'ozmo.filterSections'
const loadFilterSections = (): FilterSectionId[] => {
  try {
    const arr = JSON.parse(localStorage.getItem(FILTER_SECTIONS_KEY) ?? '[]')
    return Array.isArray(arr) ? arr.filter((x): x is FilterSectionId => FILTER_SECTION_IDS.includes(x)) : []
  } catch {
    return []
  }
}
const saveFilterSections = (ids: FilterSectionId[]): void => {
  try {
    localStorage.setItem(FILTER_SECTIONS_KEY, JSON.stringify(ids))
  } catch { /* storage full/unavailable — the bar just reopens expanded */ }
}

// ---------------------------------------------------------------------------
// Settings autosave — appearance, connection colours and flags persist ON
// CHANGE (no Save button involved). A mutation applies to store.settings
// immediately (every view restyles live), coalesces into one pending patch,
// and flushes after a quiet 400ms (drag-drops and resets flush on the spot).
// Last write wins locally: until a flush lands, pending values overlay any
// incoming settings.updated payload, so an event arriving mid-debounce (agent
// PATCH, our own echo) can never bounce an edit back. Store truth after a
// flush arrives via the settings.updated echo, not the rpc response — the
// event stream is the single ordered source of remote state.

const AUTOSAVE_DEBOUNCE_MS = 400
type SettingsMutation = Partial<Pick<AppSettings, 'styleOverrides' | 'typeOrder' | 'flags'>>

let settingsPending: SettingsMutation = {}
let settingsInflight: SettingsMutation | null = null
let settingsTimer: ReturnType<typeof setTimeout> | null = null

/** Incoming settings (event echo / other writers) with unflushed local edits
 *  overlaid — pending edits take precedence until they land on the server. */
export const overlaySettings = (incoming: AppSettings): AppSettings => {
  const overlay = { ...(settingsInflight ?? {}), ...settingsPending }
  return Object.keys(overlay).length ? { ...incoming, ...overlay } : incoming
}

/** True while the flags array holds transient mid-typing state the server-side
 *  sanitizer would mutate or drop (empty/untrimmed rule name, blank tag) —
 *  flushing now would bounce the user's in-progress row out of the UI. */
const flagsUnready = (flags: FlagRule[] | undefined): boolean =>
  !!flags?.some((r) =>
    !r.name.trim() || r.name !== r.name.trim() ||
    r.conditions.some((c) => c.kind === 'tag' && !c.tag.trim()))

const flushSettings = async (): Promise<void> => {
  if (settingsTimer) {
    clearTimeout(settingsTimer)
    settingsTimer = null
  }
  if (settingsInflight || !Object.keys(settingsPending).length) return
  if ('flags' in settingsPending && flagsUnready(settingsPending.flags)) {
    // hold until the transient state resolves (next keystroke / row delete);
    // the re-armed check is a local no-op, no network involved
    settingsTimer = setTimeout(() => void flushSettings(), AUTOSAVE_DEBOUNCE_MS)
    return
  }
  const patch = settingsPending
  settingsInflight = patch
  settingsPending = {}
  // an absent styleOverrides/typeOrder must go over the wire as explicit null:
  // the key has to be PRESENT for updateSettings to treat it as a reset
  const wire: Record<string, unknown> = {}
  for (const k of Object.keys(patch) as (keyof SettingsMutation)[]) wire[k] = patch[k] ?? null
  try {
    await rpc('settings.update', wire)
    settingsInflight = null
    // anything typed during the flight flushes next
    if (Object.keys(settingsPending).length) void flushSettings()
  } catch (e) {
    // keep the edits pending — they retry together with the next mutation
    settingsInflight = null
    settingsPending = { ...patch, ...settingsPending }
    useStore.getState().toast(`settings save failed: ${e instanceof Error ? e.message : e}`)
  }
}

/** THE write path for the autosaving settings slices (styleOverrides,
 *  typeOrder, flags). Applies optimistically, debounces the persist;
 *  `flush: true` persists immediately (drag-drops, explicit resets). */
export const mutateSettings = (patch: SettingsMutation, opts?: { flush?: boolean }): void => {
  const cur = useStore.getState().settings
  if (!cur) return
  useStore.setState({ settings: { ...cur, ...patch } })
  settingsPending = { ...settingsPending, ...patch }
  if (settingsTimer) {
    clearTimeout(settingsTimer)
    settingsTimer = null
  }
  if (opts?.flush) void flushSettings()
  else settingsTimer = setTimeout(() => void flushSettings(), AUTOSAVE_DEBOUNCE_MS)
}

interface OzmoState {
  booted: boolean
  info: AppInfo | null
  settings: AppSettings | null
  projects: Project[]
  projectId: string | null
  view: View
  graph: GraphPayload
  graphVersion: number
  backlog: SpecNode[]
  warps: WarpSummary[]
  activity: ActivityEntry[]
  selection: Selection | null
  /** live canvas positions of the selected nodes (2+ selections), published by GraphView so
   *  the multi panel can place a linked node at the selection centroid */
  selectionPositions: Record<string, { x: number; y: number }>
  detailVersion: number
  /** review-node ids open as room tabs in the Reviews lens (UI state only) */
  openReviewIds: string[]
  activeReviewId: string | null
  typeFilters: Record<NodeType, boolean>
  /** relationship-type visibility on the canvas — 'relates' governs bare connections.
   *  VISUAL-ONLY: the simulation keeps every link so the layout stays stable while lensing. */
  relationshipFilters: Record<EdgeType, boolean>
  /** active flag-rule filters as rule IDS (stable across renames; node.flags carries
   *  rule names — views join id→rule→name via settings). empty = no flag filtering.
   *  several selected = union (any-of), intersected with type/text/find filters. */
  flagFilters: string[]
  /** active RAW tag filters (the TAGS filter section, canvas only) — same shape as
   *  flagFilters: empty = no tag filtering, several = union (any-of), intersected
   *  with the type/link/flag/find lenses. Project vocabulary, so reset on switch. */
  tagFilters: string[]
  /** filter-bar sections folded shut (types/links/tags) — per-machine UI state */
  collapsedFilterSections: FilterSectionId[]
  /** the canvas '?' help panel is showing — per-machine, collapsed by default */
  helpOpen: boolean
  quickAdd: { open: boolean; x?: number; y?: number; linkTo?: QuickAddLink[]; type?: NodeType }
  palette: boolean
  toasts: Toast[]
  focusNodeId: string | null
  /** inspector tab requested by ui.focus (agents pointing at a node's links/notes) — consumed once */
  focusTab: 'spec' | 'notes' | 'links' | null
  /** node flow requested by ui.focus (agents opening the answer/graduate/convert dialog for the human) — consumed once */
  focusModal: 'answer' | 'graduate' | 'convert' | null
  /** Ctrl+F find query. null = find closed; '' = bar open, no filter yet. Lives here so views share it. */
  findQuery: string | null
  /** container nodes (classes, areas) whose contents are collapsed on the
   *  canvas — per-machine UI state, persisted per project, pruned on refresh */
  collapsedContainerIds: string[]

  boot: () => Promise<void>
  setProject: (id: string) => Promise<void>
  setView: (v: View) => void
  refreshProjects: () => Promise<void>
  refreshGraph: () => Promise<void>
  refreshGraphSoon: () => void
  refreshBacklog: () => Promise<void>
  refreshWarps: () => Promise<void>
  refreshActivity: () => Promise<void>
  select: (sel: Selection | null) => void
  /** plain click: selection of exactly this node */
  selectNode: (id: string) => void
  /** shift/ctrl-click: toggle membership; toggled-in becomes the anchor */
  toggleSelectNode: (id: string) => void
  setSelectionPositions: (p: Record<string, { x: number; y: number }>) => void
  openReview: (id: string) => void
  closeReview: (id: string) => void
  setActiveReview: (id: string | null) => void
  toggleTypeFilter: (t: NodeType) => void
  soloTypeFilter: (t: NodeType) => void
  toggleRelationshipFilter: (t: EdgeType) => void
  soloRelationshipFilter: (t: EdgeType) => void
  toggleFlagFilter: (id: string) => void
  soloFlagFilter: (id: string) => void
  toggleTagFilter: (tag: string) => void
  soloTagFilter: (tag: string) => void
  /** fold/unfold one filter-bar section (persists per machine) */
  toggleFilterSection: (id: FilterSectionId) => void
  /** show/hide the canvas help panel (persists per machine) */
  toggleHelp: () => void
  showQuickAdd: (pos?: { x: number; y: number }, linkTo?: (string | QuickAddLink)[], type?: NodeType) => void
  hideQuickAdd: () => void
  setPalette: (open: boolean) => void
  toast: (msg: string, kind?: 'error' | 'info', action?: { label: string; run: () => void }) => void
  dismissToast: (id: number) => void
  setFocusNode: (id: string | null) => void
  setFindQuery: (q: string | null) => void
  /** collapse/expand one container (class or area) on the canvas */
  toggleContainerCollapse: (id: string) => void
  /** expand several containers at once (find cycling into hidden matches) */
  expandContainers: (ids: string[]) => void
  handleEvent: (evt: OzmoEvent) => void
}

const ALL_TYPES: Record<NodeType, boolean> = {
  idea: true, pillar: true, principle: true, feature: true, instance: true, component: true, bug: true, question: true, warp: true, area: true, action: true,
  feedback: true, threat: true, flaw: true
}

const ALL_RELS: Record<EdgeType, boolean> = {
  relates: true, derives: true, 'class-of': true, depends: true, shapes: true, blocks: true, member: true, addresses: true, 'leads-to': true
}

export const useStore = create<OzmoState>((set, get) => ({
  booted: false,
  info: null,
  settings: null,
  projects: [],
  projectId: null,
  view: 'graph',
  graph: { nodes: [], edges: [] },
  graphVersion: 0,
  backlog: [],
  warps: [],
  activity: [],
  selection: null,
  selectionPositions: {},
  detailVersion: 0,
  openReviewIds: [],
  activeReviewId: null,
  typeFilters: { ...ALL_TYPES },
  relationshipFilters: { ...ALL_RELS },
  flagFilters: [],
  tagFilters: [],
  collapsedFilterSections: loadFilterSections(),
  helpOpen: loadHelpOpen(),
  quickAdd: { open: false },
  palette: false,
  toasts: [],
  focusNodeId: null,
  focusTab: null,
  focusModal: null,
  findQuery: null,
  collapsedContainerIds: [],

  boot: async () => {
    try {
      const [info, settings, projects] = await Promise.all([
        rpc<AppInfo>('app.info'),
        rpc<AppSettings>('settings.get'),
        rpc<Project[]>('projects.list')
      ])
      const savedProject = localStorage.getItem('ozmo.projectId')
      const projectId = projects.find((p) => p.id === savedProject)?.id ?? projects[0]?.id ?? null
      set({ info, settings, projects, projectId, booted: true, collapsedContainerIds: loadCollapsed(projectId) })
      if (projectId) {
        await Promise.all([get().refreshGraph(), get().refreshWarps()])
      }
    } catch (e) {
      set({ booted: true })
      get().toast(`boot failed: ${e instanceof Error ? e.message : e}`, 'error')
    }
  },

  setProject: async (id) => {
    localStorage.setItem('ozmo.projectId', id)
    set({
      projectId: id, selection: null, selectionPositions: {}, backlog: [], warps: [], activity: [],
      openReviewIds: [], activeReviewId: null, focusNodeId: null, findQuery: null, flagFilters: [],
      // tags are project vocabulary — a filter on "canvas" means nothing in the next project
      tagFilters: [],
      relationshipFilters: { ...ALL_RELS },
      collapsedContainerIds: loadCollapsed(id)
    })
    await Promise.all([get().refreshGraph(), get().refreshWarps()])
  },

  setView: (v) => {
    set({ view: v })
    if (v === 'activity') get().refreshActivity()
    if (v === 'backlog') get().refreshBacklog()
    if (v === 'warps') get().refreshWarps()
    if (v === 'reviews') get().refreshGraph() // the lens reads review-stage warps + feedback straight from the graph
  },

  refreshProjects: async () => {
    const projects = await rpc<Project[]>('projects.list')
    const { projectId } = get()
    if (projectId && !projects.find((p) => p.id === projectId)) {
      const next = projects[0]?.id ?? null
      set({ projects, projectId: next, graph: { nodes: [], edges: [] }, selection: null })
      if (next) await get().setProject(next)
    } else {
      set({ projects })
    }
  },

  refreshGraph: async () => {
    const { projectId } = get()
    if (!projectId) return
    try {
      const graph = await rpc<GraphPayload>('graph.get', { projectId })
      set((s) => {
        // selection survives refreshes, minus ids that no longer exist
        let selection = s.selection
        if (selection?.kind === 'nodes') {
          const present = new Set(graph.nodes.map((n) => n.id))
          const ids = selection.ids.filter((id) => present.has(id))
          if (ids.length !== selection.ids.length) {
            selection = ids.length
              ? { kind: 'nodes', ids, anchor: ids.includes(selection.anchor) ? selection.anchor : ids[ids.length - 1] }
              : null
          }
        }
        // prune collapse state to nodes that still ARE containers: classes
        // (class-of sources) or areas with members (member targets)
        let collapsedContainerIds = s.collapsedContainerIds
        if (collapsedContainerIds.length) {
          const areas = new Set(graph.nodes.filter((n) => n.type === 'area').map((n) => n.id))
          const containers = new Set<string>()
          for (const e of graph.edges) {
            for (const r of edgeRelationships(e)) {
              if (r.type === 'class-of') containers.add(r.sourceId)
              else if (r.type === 'member' && areas.has(r.targetId)) containers.add(r.targetId)
            }
          }
          const pruned = collapsedContainerIds.filter((id) => containers.has(id))
          if (pruned.length !== collapsedContainerIds.length) {
            collapsedContainerIds = pruned
            saveCollapsed(projectId, pruned)
          }
        }
        return { graph, graphVersion: s.graphVersion + 1, selection, collapsedContainerIds }
      })
    } catch {
      /* project may have just been deleted */
    }
  },

  refreshGraphSoon: () => {
    if (graphRefreshTimer) return
    graphRefreshTimer = setTimeout(() => {
      graphRefreshTimer = null
      get().refreshGraph()
      if (get().view === 'warps') get().refreshWarps()
      if (get().view === 'backlog') get().refreshBacklog()
    }, 80)
  },

  refreshBacklog: async () => {
    const { projectId } = get()
    if (!projectId) return
    try {
      set({ backlog: await rpc<SpecNode[]>('backlog.list', { projectId }) })
    } catch { /* ignore */ }
  },

  refreshWarps: async () => {
    const { projectId } = get()
    if (!projectId) return
    try {
      set({ warps: await rpc<WarpSummary[]>('warps.list', { projectId }) })
    } catch { /* ignore */ }
  },

  refreshActivity: async () => {
    const { projectId } = get()
    if (!projectId) return
    try {
      set({ activity: await rpc<ActivityEntry[]>('activity.list', { projectId, limit: 200 }) })
    } catch { /* ignore */ }
  },

  select: (sel) => set({ selection: sel }),

  selectNode: (id) => set({ selection: { kind: 'nodes', ids: [id], anchor: id } }),

  toggleSelectNode: (id) =>
    set((s) => {
      const sel = s.selection
      if (sel?.kind === 'nodes') {
        if (sel.ids.includes(id)) {
          const ids = sel.ids.filter((x) => x !== id)
          return {
            selection: ids.length
              ? { kind: 'nodes' as const, ids, anchor: sel.anchor === id ? ids[ids.length - 1] : sel.anchor }
              : null
          }
        }
        return { selection: { kind: 'nodes' as const, ids: [...sel.ids, id], anchor: id } }
      }
      // from empty (or an edge selection): start a fresh node selection
      return { selection: { kind: 'nodes' as const, ids: [id], anchor: id } }
    }),

  setSelectionPositions: (p) => set({ selectionPositions: p }),

  openReview: (id) => {
    set((s) => ({
      openReviewIds: s.openReviewIds.includes(id) ? s.openReviewIds : [...s.openReviewIds, id],
      activeReviewId: id,
      view: 'reviews'
    }))
  },
  closeReview: (id) =>
    set((s) => {
      const openReviewIds = s.openReviewIds.filter((r) => r !== id)
      return { openReviewIds, activeReviewId: s.activeReviewId === id ? openReviewIds[openReviewIds.length - 1] ?? null : s.activeReviewId }
    }),
  setActiveReview: (id) => set({ activeReviewId: id }),

  toggleTypeFilter: (t) => set((s) => ({ typeFilters: { ...s.typeFilters, [t]: !s.typeFilters[t] } })),

  // ctrl-click a chip: show only that type; ctrl-click it again while solo: restore all
  soloTypeFilter: (t) =>
    set((s) => {
      const types = Object.keys(s.typeFilters) as NodeType[]
      const isSolo = s.typeFilters[t] && types.every((k) => k === t || !s.typeFilters[k])
      if (isSolo) return { typeFilters: { ...ALL_TYPES } }
      const typeFilters = {} as Record<NodeType, boolean>
      for (const k of types) typeFilters[k] = k === t
      return { typeFilters }
    }),

  toggleRelationshipFilter: (t) =>
    set((s) => ({ relationshipFilters: { ...s.relationshipFilters, [t]: !s.relationshipFilters[t] } })),

  // ctrl-click a relationship chip: show only that verb's connections; again while solo: restore all
  soloRelationshipFilter: (t) =>
    set((s) => {
      const types = Object.keys(s.relationshipFilters) as EdgeType[]
      const isSolo = s.relationshipFilters[t] && types.every((k) => k === t || !s.relationshipFilters[k])
      if (isSolo) return { relationshipFilters: { ...ALL_RELS } }
      const relationshipFilters = {} as Record<EdgeType, boolean>
      for (const k of types) relationshipFilters[k] = k === t
      return { relationshipFilters }
    }),

  toggleFlagFilter: (id) =>
    set((s) => ({
      flagFilters: s.flagFilters.includes(id) ? s.flagFilters.filter((x) => x !== id) : [...s.flagFilters, id]
    })),

  // ctrl-click a flag chip: filter to only that flag; ctrl-click again while solo: clear
  soloFlagFilter: (id) =>
    set((s) => ({
      flagFilters: s.flagFilters.length === 1 && s.flagFilters[0] === id ? [] : [id]
    })),

  toggleTagFilter: (tag) =>
    set((s) => ({
      tagFilters: s.tagFilters.includes(tag) ? s.tagFilters.filter((x) => x !== tag) : [...s.tagFilters, tag]
    })),

  // ctrl-click a tag chip: filter to only that tag; ctrl-click again while solo: clear
  soloTagFilter: (tag) =>
    set((s) => ({
      tagFilters: s.tagFilters.length === 1 && s.tagFilters[0] === tag ? [] : [tag]
    })),

  toggleFilterSection: (id) =>
    set((s) => {
      const collapsedFilterSections = s.collapsedFilterSections.includes(id)
        ? s.collapsedFilterSections.filter((x) => x !== id)
        : [...s.collapsedFilterSections, id]
      saveFilterSections(collapsedFilterSections)
      return { collapsedFilterSections }
    }),

  toggleHelp: () =>
    set((s) => {
      const helpOpen = !s.helpOpen
      saveHelpOpen(helpOpen)
      return { helpOpen }
    }),

  showQuickAdd: (pos, linkTo, type) =>
    set({
      quickAdd: {
        open: true, x: pos?.x, y: pos?.y,
        linkTo: linkTo?.length ? linkTo.map((l) => (typeof l === 'string' ? { nodeId: l } : { ...l })) : undefined,
        type
      }
    }),
  hideQuickAdd: () => set({ quickAdd: { open: false } }),
  setPalette: (open) => set({ palette: open }),

  toast: (msg, kind = 'error', action) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind, action }] }))
    setTimeout(() => get().dismissToast(id), action ? 12000 : 5000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setFocusNode: (id) => set({ focusNodeId: id }),

  setFindQuery: (q) => set({ findQuery: q }),

  toggleContainerCollapse: (id) =>
    set((s) => {
      const collapsedContainerIds = s.collapsedContainerIds.includes(id)
        ? s.collapsedContainerIds.filter((x) => x !== id)
        : [...s.collapsedContainerIds, id]
      saveCollapsed(s.projectId, collapsedContainerIds)
      return { collapsedContainerIds }
    }),

  expandContainers: (ids) =>
    set((s) => {
      const drop = new Set(ids)
      const collapsedContainerIds = s.collapsedContainerIds.filter((x) => !drop.has(x))
      if (collapsedContainerIds.length === s.collapsedContainerIds.length) return {}
      saveCollapsed(s.projectId, collapsedContainerIds)
      return { collapsedContainerIds }
    }),

  handleEvent: (evt) => {
    const s = get()
    if (evt.type === 'settings.updated') {
      // flag rules shape every computed graph payload — refresh so highlights
      // follow the new rules without a relaunch. Unflushed local edits stay
      // on top (overlay) so an event mid-debounce can't bounce them back.
      set({ settings: overlaySettings(evt.data as AppSettings) })
      s.refreshGraphSoon()
      return
    }
    if (evt.type.startsWith('project.')) {
      s.refreshProjects()
      if (evt.type === 'project.created' && evt.actor !== 'seed') return
    }
    if (evt.type === 'ui.focus') {
      const d = (evt.data ?? {}) as { view?: View; projectId?: string; nodeId?: string; edgeId?: string; warpId?: string; reviewId?: string; tab?: 'spec' | 'notes' | 'links'; modal?: 'answer' | 'graduate' | 'convert' }
      const apply = (): void => {
        if (d.view) s.setView(d.view)
        if (d.warpId) {
          // the stage board shows every warp — focusing one = board + inspector on that warp
          s.setView('warps')
          get().selectNode(d.warpId)
        }
        if (d.reviewId) s.openReview(d.reviewId)
        if (d.nodeId) {
          get().selectNode(d.nodeId)
          set({
            focusNodeId: d.nodeId,
            focusTab: ['spec', 'notes', 'links'].includes(d.tab ?? '') ? d.tab! : null,
            // agents can open the question/convert flows for the human — the inspector consumes this
            focusModal: ['answer', 'graduate', 'convert'].includes(d.modal ?? '') ? d.modal! : null
          })
          if (!d.view) s.setView('graph')
        }
        // point at a CONNECTION: selects it, opening the relationship editor
        if (d.edgeId && !d.nodeId) {
          get().select({ kind: 'edge', id: d.edgeId })
          if (!d.view) s.setView('graph')
        }
      }
      if (d.projectId && d.projectId !== s.projectId) {
        s.setProject(d.projectId).then(apply)
      } else {
        apply()
      }
      return
    }
    if (!evt.projectId || evt.projectId !== s.projectId) return

    if (/^(node|edge|annotation)\./.test(evt.type)) {
      s.refreshGraphSoon()
      set((st) => ({ detailVersion: st.detailVersion + 1 }))
      if (evt.type === 'node.deleted') {
        const gone = (evt.data as { id?: string })?.id
        if (gone) {
          set((st) => {
            const sel = st.selection
            if (sel?.kind !== 'nodes' || !sel.ids.includes(gone)) return {}
            const ids = sel.ids.filter((x) => x !== gone)
            return {
              selection: ids.length
                ? { kind: 'nodes', ids, anchor: sel.anchor === gone ? ids[ids.length - 1] : sel.anchor }
                : null
            }
          })
        }
      }
    }
    // review nodes ride the node.* events above; review.closed / review.sweep.requested
    // are semantic extras whose graph effects arrive via their paired node.updated
    if (evt.type === 'activity' && s.view === 'activity') {
      s.refreshActivity()
    }
  }
}))

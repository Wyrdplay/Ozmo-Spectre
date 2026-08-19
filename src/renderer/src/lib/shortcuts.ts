// THE shortcut table — one source for the key handlers AND the '?' help panel.
//
// The handlers match against these chords (`matches('pin-toggle', e)`), so the
// row below IS the binding: change the chord here and the app and its help move
// together. Adding a binding means adding a row — the panel picks it up with no
// second edit, which is the whole point (the hint line it replaced had to be
// hand-copied every time a gesture landed, and drifted).

export type ShortcutGroup = 'selection' | 'navigation' | 'editing' | 'filters'

export interface Shortcut {
  /** stable id the handlers match on */
  id: string
  group: ShortcutGroup
  /** the chord, lowercase, '+'-separated: 'ctrl+shift+a'. ctrl means ctrl OR cmd. */
  keys?: string
  /** a pointer gesture instead of a chord — documented, never matched */
  gesture?: string
  what: string
}

export const GROUP_LABELS: Record<ShortcutGroup, string> = {
  selection: 'Selection',
  navigation: 'Navigation',
  editing: 'Editing',
  filters: 'Filters & lenses'
}

export const SHORTCUTS: Shortcut[] = [
  // selection
  { id: 'select-one', group: 'selection', gesture: 'click', what: 'select a node (the inspector opens on it)' },
  { id: 'select-add', group: 'selection', gesture: 'shift-click', what: 'add or remove a node from the selection' },
  { id: 'select-hidden', group: 'selection', gesture: 'shift-click a count badge', what: 'select what a collapsed container hides' },
  { id: 'select-all', group: 'selection', keys: 'ctrl+a', what: 'select every VISIBLE node (type ∩ flag ∩ tag ∩ find)' },
  { id: 'select-all-deep', group: 'selection', keys: 'ctrl+shift+a', what: 'select those too, collapse-blind — members inside collapsed containers join' },
  { id: 'clear-selection', group: 'selection', keys: 'esc', what: 'clear a multi-selection · cancel a link in progress' },
  // navigation
  { id: 'pan', group: 'navigation', gesture: 'drag the background', what: 'pan the canvas' },
  { id: 'zoom', group: 'navigation', gesture: 'wheel', what: 'zoom' },
  { id: 'palette', group: 'navigation', keys: 'ctrl+k', what: 'jump to anything — the command palette' },
  { id: 'find', group: 'navigation', keys: 'ctrl+f', what: 'find on the canvas (enter / shift+enter cycles the matches)' },
  { id: 'context-menu', group: 'navigation', gesture: 'right-click', what: 'the node menu — file feedback, convert, links, delete' },
  // editing
  { id: 'new-node-here', group: 'editing', gesture: 'double-click', what: 'new node where you clicked' },
  { id: 'quick-add', group: 'editing', keys: 'ctrl+n', what: 'new node beside the selection' },
  { id: 'move-pin', group: 'editing', gesture: 'drag a node', what: 'move it (and pin it, when ⌖ pin is on)' },
  { id: 'pin-toggle', group: 'editing', keys: 'ctrl+p', what: 'pin or unpin the selection where it sits' },
  { id: 'link', group: 'editing', gesture: 'shift-drag between nodes', what: 'draw a connection' },
  { id: 'delete', group: 'editing', keys: 'delete', what: 'delete the selection (asks first)' },
  // filters
  { id: 'chip-toggle', group: 'filters', gesture: 'click a chip', what: 'toggle that type / relationship / flag / tag' },
  { id: 'chip-solo', group: 'filters', gesture: 'ctrl-click a chip', what: 'solo it — everything else off (again to restore)' },
  { id: 'chip-reorder', group: 'filters', gesture: 'drag a chip', what: 'reorder types and flag rules (persists to settings)' }
]

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]))

export function shortcut(id: string): Shortcut | undefined {
  return byId.get(id)
}

/** The chord as it should read in the UI — 'ctrl' renders as ⌘ on a Mac. */
export function chordLabel(keys: string): string {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '')
  return keys
    .split('+')
    .map((k) => (k === 'ctrl' ? (mac ? '⌘' : 'ctrl') : k))
    .join('+')
}

/**
 * Does this keyboard event fire the shortcut? Modifiers are exact — a chord
 * without `shift` does NOT fire while shift is held, which is what keeps
 * ctrl+a and ctrl+shift+a apart. `ctrl` matches ctrl or cmd.
 */
export function matches(id: string, e: KeyboardEvent): boolean {
  const s = byId.get(id)
  if (!s?.keys) return false
  const parts = s.keys.split('+')
  const key = parts[parts.length - 1]
  const want = { ctrl: parts.includes('ctrl'), shift: parts.includes('shift'), alt: parts.includes('alt') }
  if ((e.ctrlKey || e.metaKey) !== want.ctrl) return false
  if (e.shiftKey !== want.shift) return false
  if (e.altKey !== want.alt) return false
  const pressed = e.key.toLowerCase()
  const named: Record<string, string> = { esc: 'escape', del: 'delete', enter: 'enter' }
  return pressed === (named[key] ?? key)
}

/** True while the event came from somewhere text is being typed. */
export function inTextField(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement)?.closest?.('input, textarea, select, .cm-editor')
}
